/**
 * Beneficiary repository, against a real Postgres.
 *
 * Tests the repository, not the Keyring utility. The utility being correct says
 * nothing about whether the repository binds the right record id, whether reads
 * leak the full number, or whether a value swapped between rows in the actual
 * database still opens.
 */

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures += 1;
};

const postgres = (await import('postgres')).default;
const { drizzle } = await import('drizzle-orm/postgres-js');
const { Keyring } = await import(new URL('../../packages/core/src/crypto.ts', import.meta.url).href);
const { createBeneficiaryRepository, BeneficiaryAccessDenied } =
  await import(new URL('../../apps/api/src/repo/beneficiary.ts', import.meta.url).href);

const client = postgres(process.env.DATABASE_URL, { max: 4 });
const db = drizzle(client);
const keyring = Keyring.fromEnv(process.env.FIELD_ENCRYPTION_KEYS);
const repo = createBeneficiaryRepository(db, keyring);

const PARTY_A = '11111111-1111-4111-8111-111111111111';
const PARTY_B = '11111111-1111-4111-8111-111111111112';
const FINANCE = { settlementId: 'STL-TEST', actorId: '00000000-0000-4000-8000-000000000004', actorRoles: ['finance'] };
const now = () => new Date().toISOString();

console.log('\nWRITING');
const a = await repo.record({ partyId: PARTY_A, channel: 'bank', accountNumber: '1234567890',
  holderName: 'محطة فرز النوبارية', bankCode: 'CIB', actorId: FINANCE.actorId, actorRoles: ['finance'], at: now() });
const b = await repo.record({ partyId: PARTY_B, channel: 'bank', accountNumber: '9999999999',
  holderName: 'مزارع كفر الدوار', bankCode: 'NBE', actorId: FINANCE.actorId, actorRoles: ['finance'], at: now() });

check('a write returns only the tail', a.accountTail === '7890' && !JSON.stringify(a).includes('1234567890'),
  `tail=${a.accountTail}`);
check('encryption metadata is populated', !!a.encryptionKeyId, `keyId=${a.encryptionKeyId}`);

const [rawA] = await client`SELECT account_number_enc, account_number_iv, encryption_key_id FROM beneficiaries WHERE id=${a.id}`;
check('the column holds ciphertext, not the number', !rawA.account_number_enc.includes('1234567890'));
check('the iv is stored', !!rawA.account_number_iv);

console.log('\nREADING');
const listed = await repo.listForParty(PARTY_A);
check('list exposes no full number', !JSON.stringify(listed).includes('1234567890'));
check('list exposes the tail', listed[0].accountTail === '7890');

const revealed = await repo.revealForPayout(a.id, FINANCE);
check('an authorised payout reveals the full number', revealed === '1234567890');

let denied = false;
try { await repo.revealForPayout(a.id, { ...FINANCE, actorRoles: ['buyer'] }); }
catch (e) { denied = e instanceof BeneficiaryAccessDenied; }
check('a buyer cannot reveal an account number', denied);

let noSettlement = false;
try { await repo.revealForPayout(a.id, { ...FINANCE, settlementId: '' }); }
catch (e) { noSettlement = e instanceof BeneficiaryAccessDenied; }
check('revealing requires a settlement id', noSettlement);

console.log('\nTHE SWAP ATTACK, IN THE DATABASE');
// Someone with write access copies B's complete encrypted value over A's row.
const [rawB] = await client`SELECT account_number_enc, account_number_iv, encryption_key_id FROM beneficiaries WHERE id=${b.id}`;
await client`UPDATE beneficiaries SET account_number_enc=${rawB.account_number_enc},
             account_number_iv=${rawB.account_number_iv}, encryption_key_id=${rawB.encryption_key_id}
             WHERE id=${a.id}`;

let swapRefused = false, leaked = null;
try { leaked = await repo.revealForPayout(a.id, FINANCE); }
catch { swapRefused = true; }
check('a value swapped between beneficiaries will not open', swapRefused,
  leaked ? `LEAKED ${leaked} — the payout would go to the wrong account` : 'refused');

// Put it back so the rotation test has a readable row.
await client`UPDATE beneficiaries SET account_number_enc=${rawA.account_number_enc},
             account_number_iv=${rawA.account_number_iv}, encryption_key_id=${rawA.encryption_key_id}
             WHERE id=${a.id}`;

console.log('\nSUPERSEDING');
const a2 = await repo.record({ partyId: PARTY_A, channel: 'bank', accountNumber: '5555444433',
  holderName: 'محطة فرز النوبارية', bankCode: 'CIB', actorId: FINANCE.actorId, actorRoles: ['finance'], at: now() });
const current = await repo.currentForParty(PARTY_A);
const [oldRow] = await client`SELECT superseded_at FROM beneficiaries WHERE id=${a.id}`;
check('the new account becomes current', current.id === a2.id && current.accountTail === '4433');
check('the old row is superseded, not overwritten', !!oldRow.superseded_at);
check('the old number is still readable for history', (await repo.revealForPayout(a.id, FINANCE)) === '1234567890');

console.log('\nROTATION');
const { randomBytes } = await import('node:crypto');
const newKey = 'v2:' + Buffer.from(randomBytes(32)).toString('base64');
const rotatedRing = Keyring.fromEnv(`${newKey},${process.env.FIELD_ENCRYPTION_KEYS}`);
const rotatedRepo = createBeneficiaryRepository(db, rotatedRing);

const before = await rotatedRepo.idsNeedingRotation();
check('rows under the old key are listed for rotation', before.length >= 2, `${before.length} rows`);

const results = [];
for (const id of before) results.push(await rotatedRepo.rotateRow(id));
const resealed = results.filter(r => r === 'rotated').length;
const unreadable = results.filter(r => r === 'unreadable').length;
check('rotation re-seals the rows it can open', resealed >= 2, `${resealed} rotated, ${unreadable} unreadable`);
check('an unreadable row is reported, not thrown', results.every(r => typeof r === 'string'));

const after = await rotatedRepo.idsNeedingRotation();
check('only unreadable rows remain', after.length === unreadable, `${after.length} left`);

check('the value still reads correctly after rotation',
  (await rotatedRepo.revealForPayout(a.id, FINANCE)) === '1234567890');

check('rotation preserved the binding — a swap still fails after re-sealing', await (async () => {
  const [rb] = await client`SELECT account_number_enc, account_number_iv, encryption_key_id FROM beneficiaries WHERE id=${b.id}`;
  const [ra] = await client`SELECT account_number_enc, account_number_iv, encryption_key_id FROM beneficiaries WHERE id=${a.id}`;
  await client`UPDATE beneficiaries SET account_number_enc=${rb.account_number_enc}, account_number_iv=${rb.account_number_iv}, encryption_key_id=${rb.encryption_key_id} WHERE id=${a.id}`;
  let refused = false;
  try { await rotatedRepo.revealForPayout(a.id, FINANCE); } catch { refused = true; }
  await client`UPDATE beneficiaries SET account_number_enc=${ra.account_number_enc}, account_number_iv=${ra.account_number_iv}, encryption_key_id=${ra.encryption_key_id} WHERE id=${a.id}`;
  return refused;
})());

check('running rotation again re-seals nothing', (await (async () => {
  let n = 0;
  for (const id of await rotatedRepo.idsNeedingRotation()) {
    if ((await rotatedRepo.rotateRow(id)) === 'rotated') n += 1;
  }
  return n;
})()) === 0);

console.log('\nBACKFILL');
/*
  Simulating a pre-0009 database.

  Migration 0009 makes the encryption metadata NOT NULL, so once it has run a
  legacy row cannot be created at all — which is the migration working. To
  exercise the backfill path the constraints are dropped for the duration of
  this section and restored immediately afterwards.
*/
const hasNotNull = (await client`
  SELECT attnotnull FROM pg_attribute
   WHERE attrelid = 'beneficiaries'::regclass AND attname = 'account_number_iv'`)[0]?.attnotnull;

if (hasNotNull) {
  await client`ALTER TABLE beneficiaries ALTER COLUMN account_number_iv DROP NOT NULL,
                                          ALTER COLUMN encryption_key_id DROP NOT NULL`;
}

const legacyId = crypto.randomUUID();
await client`INSERT INTO beneficiaries (id, party_id, channel, account_number_enc, account_tail, holder_name, effective_from)
             VALUES (${legacyId}, ${PARTY_B}, 'bank', 'enc:placeholder', '0000', 'legacy row', now())`;

const pending = await repo.idsNeedingBackfill();
check('a row with no metadata is flagged for backfill', pending.some(r => r.id === legacyId));

let refusedLegacy = false;
try { await repo.revealForPayout(legacyId, FINANCE); } catch { refusedLegacy = true; }
check('a legacy row cannot be paid before backfill', refusedLegacy);

await repo.backfillRow(legacyId, '8877665544');
const filled = await repo.byId(legacyId);
check('backfill encrypts and fixes the tail', filled.accountTail === '5544' && !!filled.encryptionKeyId);
check('the backfilled value reads back', (await repo.revealForPayout(legacyId, FINANCE)) === '8877665544');
check('the placeholder string is gone from the column', await (async () => {
  const [r] = await client`SELECT account_number_enc FROM beneficiaries WHERE id=${legacyId}`;
  return r.account_number_enc !== 'enc:placeholder';
})());

// Clean up so repeated runs stay deterministic.
await client`DELETE FROM beneficiaries WHERE id IN (${a.id}, ${a2.id}, ${b.id}, ${legacyId})`;

if (hasNotNull) {
  // Restore the constraint. Leaving it off would quietly weaken every later run.
  await client`ALTER TABLE beneficiaries ALTER COLUMN account_number_iv SET NOT NULL,
                                          ALTER COLUMN encryption_key_id SET NOT NULL`;
  const restored = (await client`
    SELECT attnotnull FROM pg_attribute
     WHERE attrelid = 'beneficiaries'::regclass AND attname = 'account_number_iv'`)[0]?.attnotnull;
  check('the NOT NULL constraint is restored after the test', restored === true);
}



/* ------------------------------------------------------------------ *
 * Through the running application, over HTTP.
 *
 * The repository being correct says nothing about whether the application
 * uses it. These checks go through the real endpoints: that a write encrypts,
 * that no read path returns a full number, and that the payout path can still
 * decrypt what was written.
 * ------------------------------------------------------------------ */

console.log('\nOVER HTTP');
{
  const API = process.env.API_A ?? 'http://localhost:9001';
  const { issueToken } = await import(new URL('../../apps/api/src/auth.ts', import.meta.url).href);
  const SECRET = process.env.AUTH_SIGNING_SECRET;

  const supplierToken = await issueToken(
    { userId: '00000000-0000-4000-8000-000000000001', partyId: PARTY_A, roles: ['supplier'], displayName: 'S' },
    SECRET,
  );
  const otherSupplier = await issueToken(
    { userId: '00000000-0000-4000-8000-000000000011', partyId: PARTY_B, roles: ['supplier'], displayName: 'S2' },
    SECRET,
  );
  const financeToken = await issueToken(
    { userId: '00000000-0000-4000-8000-000000000004', partyId: '33333333-3333-4333-8333-333333333333',
      roles: ['finance'], displayName: 'F' },
    SECRET,
  );

  const call = async (tok, method, path, body) => {
    const r = await fetch(API + path, {
      method,
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, text: await r.text() };
  };

  const ACCOUNT_HTTP = '7788990011';

  const created = await call(supplierToken, 'POST', '/beneficiaries', {
    channel: 'bank', accountNumber: ACCOUNT_HTTP, holderName: 'محطة فرز النوبارية', bankCode: 'CIB',
  });
  check('a supplier can record their own bank details', created.status === 201, `status ${created.status}`);
  check('the create response does not echo the account number', !created.text.includes(ACCOUNT_HTTP),
    'echoing it would put the number in a browser network log');

  const body = JSON.parse(created.text || '{}');
  check('the create response carries the tail', body.accountTail === '0011', `tail=${body.accountTail}`);

  const [stored] = await client`SELECT account_number_enc, account_number_iv, encryption_key_id
                                  FROM beneficiaries WHERE id=${body.id}`;
  check('the HTTP write was encrypted', !!stored.account_number_iv && !!stored.encryption_key_id &&
    !stored.account_number_enc.includes(ACCOUNT_HTTP), 'ciphertext, iv and key id all present');

  const list = await call(supplierToken, 'GET', '/beneficiaries');
  check('the list never returns a full number', !list.text.includes(ACCOUNT_HTTP));
  check('the list returns the tail', list.text.includes('"accountTail":"0011"'));

  const snoop = await call(otherSupplier, 'GET', `/beneficiaries?partyId=${PARTY_A}`);
  check('another supplier cannot list these details', snoop.status === 403, `status ${snoop.status}`);

  const impersonate = await call(otherSupplier, 'POST', '/beneficiaries', {
    partyId: PARTY_A, channel: 'bank', accountNumber: '0000000000', holderName: 'attacker',
  });
  check('another supplier cannot record details for this party', impersonate.status === 403,
    `status ${impersonate.status}`);

  const staffList = await call(financeToken, 'GET', `/beneficiaries?partyId=${PARTY_A}`);
  check('finance can list any party', staffList.status === 200);
  check('finance still sees only the tail', !staffList.text.includes(ACCOUNT_HTTP));

  // The payout path is the one place a full number may be read.
  const revealed = await repo.revealForPayout(body.id, FINANCE);
  check('the payout path can decrypt what HTTP wrote', revealed === ACCOUNT_HTTP);

  // Recording again supersedes rather than overwrites.
  const second = await call(supplierToken, 'POST', '/beneficiaries', {
    channel: 'bank', accountNumber: '5566778899', holderName: 'محطة فرز النوبارية', bankCode: 'CIB',
  });
  const [old] = await client`SELECT superseded_at FROM beneficiaries WHERE id=${body.id}`;
  check('a change supersedes the previous row', !!old.superseded_at,
    'the cooldown needs a change to measure from');

  const secondBody = JSON.parse(second.text || '{}');
  await client`DELETE FROM beneficiaries WHERE id IN (${body.id}, ${secondBody.id})`;
}

await client.end();
if (failures > 0) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
console.log('\nAll checks passed.');
