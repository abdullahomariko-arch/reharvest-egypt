/**
 * Webhook atomicity, through real HTTP against a real Postgres.
 *
 * Scenario D1 — a valid signed webhook clears the order exactly once.
 * Scenario D2 — a duplicate delivery does not advance it twice.
 * Scenario D3 — an order left with a recorded-but-unattached payment (the state
 *               v10's non-atomic path could produce) is repaired by a retry
 *               rather than dismissed as a duplicate.
 */

let failures = 0;
const fail = (m) => { failures += 1; console.error('  FAIL:', m); };

const A = 'http://localhost:9001';
const S = process.env.AUTH_SIGNING_SECRET, H = process.env.PAYMOB_HMAC_SECRET, RUN = Date.now().toString(36);
const { issueToken } = await import(new URL('../../apps/api/src/auth.ts', import.meta.url).href);
const { webcrypto } = await import('node:crypto');
const postgres = (await import('postgres')).default;
const sqlc = postgres(process.env.DATABASE_URL, { max: 3 });

const tk = (u, p, r) => issueToken({ userId: u, partyId: p, roles: r, displayName: 'x' }, S);
const SUP = await tk('00000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', ['supplier', 'ops_agent']);
const INS = await tk('00000000-0000-4000-8000-000000000003', '33333333-3333-4333-8333-333333333333', ['inspector']);
const BUY = await tk('00000000-0000-4000-8000-000000000002', '22222222-2222-4222-8222-222222222221', ['buyer']);

const req = async (tok, m, p, body, key) => {
  const r = await fetch(A + p, { method: m, headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};

async function newOrder(tag) {
  const l = await req(SUP, 'POST', '/lots', { crop: 'tomato', grossGrams: '812500', containerCount: 25, packagingSpecId: 'plastic_standard', packagingSpecVersion: 2, pricePerKgPiastres: '875', collectBy: '2026-09-30T00:00:00Z' }, `d-${RUN}-${tag}-c`);
  await req(SUP, 'POST', `/lots/${l.body.lotId}/weighings`, { grossGrams: '812500', containerCount: 25, scaleId: 's1' }, `d-${RUN}-${tag}-w`);
  await req(INS, 'POST', `/lots/${l.body.lotId}/inspections`, { checks: { c: true }, freeze: false }, `d-${RUN}-${tag}-i`);
  const o = await req(BUY, 'POST', '/orders', { lotId: l.body.lotId, quantityGrams: '800000' }, `d-${RUN}-${tag}-o`);
  return o.body;
}

const FIELDS = ['amount_cents','created_at','currency','error_occured','has_parent_transaction','id','integration_id','is_3d_secure','is_auth','is_capture','is_refunded','is_standalone_payment','is_voided','order.id','owner','pending','source_data.pan','source_data.sub_type','source_data.type','success'];
async function sign(obj) {
  const cat = FIELDS.map(p => { const v = p.split('.').reduce((a, k) => a?.[k], obj); return v === null || v === undefined ? '' : (typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v)); }).join('');
  const k = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(H), { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']);
  const sg = await webcrypto.subtle.sign('HMAC', k, new TextEncoder().encode(cat));
  return [...new Uint8Array(sg)].map(b => b.toString(16).padStart(2, '0')).join('');
}
const mk = (order, txid, amount) => ({ amount_cents: Number(amount), created_at: '2026-08-19T10:00:00Z', currency: 'EGP', error_occured: false, has_parent_transaction: false, id: txid, integration_id: 1002, is_3d_secure: true, is_auth: false, is_capture: false, is_refunded: false, is_standalone_payment: true, is_voided: false, order: { id: 999, merchant_order_id: order }, owner: 42, pending: false, source_data: { pan: '1234', sub_type: 'wallet', type: 'wallet' }, success: true });
const post = async (obj, hmac) => { const r = await fetch(`${A}/webhooks/paymob?hmac=${hmac}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'TRANSACTION', obj }) }); return { status: r.status, body: await r.json().catch(() => null) }; };

console.log('SCENARIO D1 — valid webhook clears the order');
const o1 = await newOrder('d1');
{
  const obj = mk(o1.orderCode, 700001 + (Date.now() % 9000), o1.depositPiastres);
  const r = await post(obj, await sign(obj));
  const [row] = await sqlc`SELECT state FROM orders WHERE order_code=${o1.orderCode}`;
  console.log(`  HTTP ${r.status} outcome=${r.body?.outcome} order=${row.state}`);
  const ok = r.body?.outcome === 'order_advanced' && row.state === 'DEPOSIT_CLEARED';
  if (!ok) fail('valid webhook did not clear the order');
  console.log(`  RESULT: ${ok ? 'PASS' : 'FAIL'}`);
}

console.log('\nSCENARIO D2 — the identical delivery, twice, advances the order once');
{
  // A true duplicate: same order, same provider transaction id, same signature.
  const o = await newOrder('d2');
  const obj = mk(o.orderCode, 710001 + (Date.now() % 9000), o.depositPiastres);
  const h = await sign(obj);
  const r1 = await post(obj, h);
  const r2 = await post(obj, h);
  const [n] = await sqlc`SELECT count(*)::int c FROM audit_log
                          WHERE action='order.deposit_cleared'
                            AND subject_id=(SELECT id FROM orders WHERE order_code=${o.orderCode})`;
  const [rows] = await sqlc`SELECT count(*)::int c FROM payments WHERE provider_transaction_id=${String(obj.id)}`;
  console.log(`  first=${r1.body?.outcome} second=${r2.body?.outcome}  audit=${n.c} paymentRows=${rows.c}`);
  const ok = r1.body?.outcome === 'order_advanced' && r2.body?.outcome === 'ignored_duplicate' && n.c === 1 && rows.c === 1;
  if (!ok) fail('a duplicate delivery was not handled exactly once');
  console.log(`  RESULT: ${ok ? 'PASS' : 'FAIL'}`);
}

console.log('\nSCENARIO D3 — a stuck order (payment recorded, order not advanced) is repaired by a retry');
{
  const o = await newOrder('d3');
  const txid = 720001 + (Date.now() % 9000);
  // Reproduce exactly the state v10's non-atomic path could leave behind.
  const [ord] = await sqlc`SELECT id, buyer_id FROM orders WHERE order_code=${o.orderCode}`;
  await sqlc`INSERT INTO payments (direction, order_id, party_id, amount_piastres, method, state,
                                   provider_transaction_id, prepared_by, idempotency_key)
             VALUES ('inbound', ${ord.id}, ${ord.buyer_id}, ${o.depositPiastres}, 'wallet', 'RECEIVED',
                     ${String(txid)}, '00000000-0000-4000-8000-000000000000', ${'stuck-' + RUN})`;
  const [before] = await sqlc`SELECT state FROM orders WHERE order_code=${o.orderCode}`;
  console.log(`  order before retry: ${before.state} (payment already recorded)`);

  const obj = mk(o.orderCode, txid, o.depositPiastres);
  const r = await post(obj, await sign(obj));
  const [after] = await sqlc`SELECT state FROM orders WHERE order_code=${o.orderCode}`;
  console.log(`  retry outcome=${r.body?.outcome}  order after: ${after.state}`);
  const ok = after.state === 'DEPOSIT_CLEARED';
  if (!ok) fail('a stuck order was not repaired — the retry was dismissed as a duplicate');
  console.log(`  RESULT: ${ok ? 'PASS' : 'FAIL'}`);
}

await sqlc.end();
if (failures > 0) { console.error(`\n${failures} scenario(s) failed.`); process.exit(1); }
console.log('\nAll scenarios passed.');
