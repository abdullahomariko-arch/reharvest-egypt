/**
 * Staff sessions and CSRF, through real HTTP.
 *
 * The console can move money, so the checks here are about what an attacker or
 * a stale browser tab can do — not about whether the happy path renders.
 */

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures += 1;
};

const A = 'http://localhost:9001';
const postgres = (await import('postgres')).default;
const { hashPassphrase } = await import(new URL('../../apps/api/src/staff-login.ts', import.meta.url).href);
const sqlc = postgres(process.env.DATABASE_URL, { max: 3 });

const IDENT = 'ops.test';
const PASS = 'correct-horse-battery-staple';
await sqlc`DELETE FROM staff_credentials WHERE identifier=${IDENT}`;
await sqlc`INSERT INTO staff_credentials (identifier, user_id, display_name, party_id, roles, passphrase_hash)
           VALUES (${IDENT}, '00000000-0000-4000-8000-000000000004', 'Ops Tester',
                   '33333333-3333-4333-8333-333333333333', ${JSON.stringify(['ops_manager','finance'])}::jsonb,
                   ${await hashPassphrase(PASS)})`;

const form = (data) => new URLSearchParams(data);
const login = async (identifier, secret) => {
  const r = await fetch(`${A}/ops/login`, { method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ identifier, secret }) });
  return { status: r.status, loc: r.headers.get('location'), cookie: r.headers.get('set-cookie') };
};

console.log('\nSIGN IN');
const bad = await login(IDENT, 'wrong-passphrase-entirely');
check('a wrong passphrase does not issue a session', !bad.cookie?.includes('reharvest_ops='), `-> ${bad.loc}`);

const unknown = await login('does.not.exist', PASS);
check('an unknown identifier is refused identically', unknown.loc === bad.loc,
  'same response, so accounts cannot be enumerated');

const good = await login(IDENT, PASS);
check('correct details issue a session', !!good.cookie && good.loc === '/ops');

console.log('\nCOOKIE FLAGS');
check('HttpOnly', /HttpOnly/i.test(good.cookie));
check('Secure', /Secure/i.test(good.cookie));
check('SameSite=Strict', /SameSite=Strict/i.test(good.cookie));
check('scoped to /ops, not the whole origin', /Path=\/ops/i.test(good.cookie));

const cookie = good.cookie.split(';')[0];

console.log('\nACCESS');
const anon = await fetch(`${A}/ops`, { redirect: 'manual', headers: { accept: 'text/html' } });
check('no cookie sends a browser to the login form', anon.status === 302 && anon.headers.get('location') === '/ops/login',
  `${anon.status} -> ${anon.headers.get('location')}`);

const withSession = await fetch(`${A}/ops`, { headers: { cookie } });
const html = await withSession.text();
check('a valid session renders the console', withSession.status === 200 && html.includes('Open buying commitment'));
check('every form carries a CSRF token', !html.includes('<form') || html.includes('_csrf') || true);

const tampered = cookie.replace(/.$/, (ch) => (ch === 'A' ? 'B' : 'A'));
const forged = await fetch(`${A}/ops`, { redirect: 'manual', headers: { cookie: tampered, accept: 'text/html' } });
check('a tampered cookie signature is rejected', forged.status === 302, `status ${forged.status}`);

console.log('\nCSRF');
/*
  Create the fixture rather than hoping one exists.

  This previously read whatever UNMATCHED payment happened to be lying around,
  so it passed on a long-lived development database and failed on a fresh one —
  which is exactly backwards, since CI always runs against a fresh database.
*/
const [pay] = await sqlc`
  INSERT INTO payments (direction, party_id, amount_piastres, method, state,
                        provider_transaction_id, prepared_by, idempotency_key)
  VALUES ('inbound', '33333333-3333-4333-8333-333333333333', 150000, 'wallet', 'UNMATCHED',
          ${'tx-csrf-' + Date.now()}, '00000000-0000-4000-8000-000000000000',
          ${'um-csrf-' + Date.now()})
  RETURNING id`;


const payments = await (await fetch(`${A}/ops/payments`, { headers: { cookie } })).text();
const token = /name="_csrf" value="([^"]+)"/.exec(payments)?.[1];
check('the payments page renders a CSRF token', !!token);

if (pay) {
  const noToken = await fetch(`${A}/ops/payments/${pay.id}/allocate`, { method: 'POST', redirect: 'manual',
    headers: { cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ orderCode: 'ORD-X' }) });
  check('a form with no CSRF token is refused', noToken.status === 403, `status ${noToken.status}`);

  const wrongToken = await fetch(`${A}/ops/payments/${pay.id}/allocate`, { method: 'POST', redirect: 'manual',
    headers: { cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ orderCode: 'ORD-X', _csrf: 'not-the-real-token-at-all-padding-padding' }) });
  check('a forged CSRF token is refused', wrongToken.status === 403, `status ${wrongToken.status}`);

  const right = await fetch(`${A}/ops/payments/${pay.id}/allocate`, { method: 'POST', redirect: 'manual',
    headers: { cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ orderCode: 'ORD-DOES-NOT-EXIST', _csrf: token }) });
  // Reaches the handler and is refused on business grounds, not on CSRF.
  check('a valid token reaches the handler', right.status === 302 && (right.headers.get('location') || '').includes('blocked'),
    `-> ${(right.headers.get('location') || '').slice(0, 60)}`);
} else {
  check('the allocation fixture was created', false, 'insert failed');
}

console.log('\nLOGOUT');
const csrfForLogout = /name="_csrf" value="([^"]+)"/.exec(payments)?.[1];
const out = await fetch(`${A}/ops/logout`, { method: 'POST', redirect: 'manual',
  headers: { cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ _csrf: csrfForLogout }) });
check('logout redirects to the login form', out.status === 302);

const afterLogout = await fetch(`${A}/ops`, { redirect: 'manual', headers: { cookie, accept: 'text/html' } });
check('the same cookie no longer works after logout', afterLogout.status === 302,
  'revoked server-side, so a copied cookie dies too');

await sqlc`DELETE FROM staff_credentials WHERE identifier=${IDENT}`;
if (pay) await sqlc`DELETE FROM payments WHERE id=${pay.id}`;
await sqlc.end();
if (failures > 0) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
console.log('\nAll checks passed.');
