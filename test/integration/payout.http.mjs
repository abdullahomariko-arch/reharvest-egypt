/**
 * Payout lifecycle, through real HTTP and Postgres.
 *
 * The claims being proved are all about money leaving: that approval alone
 * sends none, that the amount and bank account cannot be influenced by the
 * caller, that a duplicate submission cannot pay twice, and that a timeout
 * stays in a state which says "unknown" rather than one that invites a retry.
 */

import { createChecks, waitForHealthy, API_A } from './_harness.mjs';

const { check, finish } = createChecks();
const postgres = (await import('postgres')).default;
const { issueToken } = await import(new URL('../../apps/api/src/auth.ts', import.meta.url).href);
const { Keyring } = await import(new URL('../../packages/core/src/crypto.ts', import.meta.url).href);

await waitForHealthy(API_A);

const sqlc = postgres(process.env.DATABASE_URL, { max: 4 });
const RUN = Date.now().toString(36);

const FINANCE_1 = '00000000-0000-4000-8000-000000000041';
const FINANCE_2 = '00000000-0000-4000-8000-000000000042';
const SUPPLIER = '11111111-1111-4111-8111-111111111111';
const RH = '33333333-3333-4333-8333-333333333333';

const tokenFor = (id) => issueToken({ userId: id, partyId: RH, roles: ['finance'], displayName: 'F' }, process.env.AUTH_SIGNING_SECRET);
const prep = await tokenFor(FINANCE_1);
const appr = await tokenFor(FINANCE_2);

const call = async (tok, method, path, body) => {
  const r = await fetch(API_A + path, {
    method,
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

/** A payout with a real encrypted beneficiary, prepared by FINANCE_1. */
async function makePayout(tag, amountPiastres = 520000n) {
  const keyring = Keyring.fromEnv(process.env.FIELD_ENCRYPTION_KEYS);
  const benId = crypto.randomUUID();
  const sealed = await keyring.encrypt('1234509876', { recordId: benId, field: 'account_number' });

  await sqlc`INSERT INTO beneficiaries (id, party_id, channel, account_number_enc, account_number_iv,
                                        encryption_key_id, account_tail, bank_code, holder_name, effective_from)
             VALUES (${benId}, ${SUPPLIER}, 'bank', ${sealed.ciphertext}, ${sealed.iv}, ${sealed.keyId},
                     '9876', 'CIB', 'محطة فرز النوبارية', now() - interval '3 days')`;

  const [p] = await sqlc`
    INSERT INTO payments (direction, party_id, beneficiary_id, amount_piastres, method, state,
                          prepared_by, idempotency_key)
    VALUES ('outbound', ${SUPPLIER}, ${benId}, ${String(amountPiastres)}::bigint, 'bank', 'PENDING_APPROVAL',
            ${FINANCE_1}::uuid, ${'stl-' + RUN + '-' + tag})
    RETURNING id`;
  return { paymentId: p.id, beneficiaryId: benId };
}

const providerCalls = async (key) =>
  Number((await sqlc`SELECT count(*)::int c FROM provider_calls WHERE idempotency_key=${key}`)[0]?.c ?? 0);

console.log('\nAPPROVAL');
{
  const { paymentId } = await makePayout('a1');

  const self = await call(prep, 'POST', `/payouts/${paymentId}/approve`);
  check('the preparer cannot approve their own payout', self.status === 422 && self.body?.reasonCode === 'SELF_APPROVAL_FORBIDDEN',
    `${self.status} ${self.body?.reasonCode ?? ''}`);

  const ok = await call(appr, 'POST', `/payouts/${paymentId}/approve`);
  check('a second finance user can approve', ok.status === 200 && ok.body?.state === 'APPROVED');

  const [row] = await sqlc`SELECT state, submitted_at, provider_transaction_id FROM payments WHERE id=${paymentId}`;
  check('approval moves no money', row.state === 'APPROVED' && !row.submitted_at && !row.provider_transaction_id,
    'nothing submitted, no provider reference');
}

console.log('\nSUBMISSION');
{
  const { paymentId } = await makePayout('a2');

  const early = await call(appr, 'POST', `/payouts/${paymentId}/submit`);
  check('an unapproved payout cannot be submitted', early.status === 422 && early.body?.reasonCode === 'PAYOUT_NOT_APPROVED',
    `${early.status} ${early.body?.reasonCode ?? ''}`);

  await call(appr, 'POST', `/payouts/${paymentId}/approve`);
  const sent = await call(appr, 'POST', `/payouts/${paymentId}/submit`);
  check('an approved payout submits', sent.status === 200 && sent.body?.state === 'SUBMITTED_TO_PSP',
    `${sent.status} ${sent.body?.state ?? ''}`);

  check('the response reveals only the account tail', sent.body?.accountTail === '9876' &&
    !JSON.stringify(sent.body).includes('1234509876'), `tail=${sent.body?.accountTail}`);

  const [key] = await sqlc`SELECT idempotency_key FROM payments WHERE id=${paymentId}`;
  const [seen] = await sqlc`SELECT account_number, amount_piastres, idempotency_key FROM provider_calls
                             WHERE idempotency_key=${key.idempotency_key} LIMIT 1`;
  check('the provider received the server-held account number', seen?.account_number === '1234509876',
    'decrypted from the beneficiary row, never from a request');
  check('the provider received the database amount', String(seen?.amount_piastres) === '520000');
  check('the provider key is the settlement id, not a clock value', seen?.idempotency_key === key.idempotency_key);
  check('the provider received exactly one request', (await providerCalls(key.idempotency_key)) === 1);

  const again = await call(appr, 'POST', `/payouts/${paymentId}/submit`);
  check('a duplicate submission is refused', again.status === 422,
    `${again.status} ${again.body?.reasonCode ?? ''}`);
  check('the duplicate reached no provider', (await providerCalls(key.idempotency_key)) === 1,
    'still one request');
}

console.log('\nREQUEST BODY CANNOT INFLUENCE MONEY');
{
  const { paymentId } = await makePayout('a3');
  await call(appr, 'POST', `/payouts/${paymentId}/approve`);

  const tampered = await call(appr, 'POST', `/payouts/${paymentId}/submit`, {
    amountPiastres: '99999999',
    accountNumber: '0000000000',
    bankAccountNumber: '0000000000',
    beneficiaryId: crypto.randomUUID(),
    approvedBy: FINANCE_1,
    preparedBy: FINANCE_2,
  });

  const [key] = await sqlc`SELECT idempotency_key FROM payments WHERE id=${paymentId}`;
  const [seen] = await sqlc`SELECT account_number, amount_piastres FROM provider_calls WHERE idempotency_key=${key.idempotency_key} LIMIT 1`;

  check('submission still succeeded', tampered.status === 200);
  check('the injected amount was ignored', String(seen?.amount_piastres) === '520000', `provider saw ${seen?.amount_piastres}`);
  check('the injected account was ignored', seen?.account_number === '1234509876', `provider saw ${seen?.account_number}`);
}

console.log('\nTIMEOUT');
{
  const { paymentId } = await makePayout('timeout');
  await call(appr, 'POST', `/payouts/${paymentId}/approve`);

  // The fake provider hangs for this settlement, exactly as a real one may.
  const [key] = await sqlc`SELECT idempotency_key FROM payments WHERE id=${paymentId}`;
  await sqlc`INSERT INTO provider_behaviour (idempotency_key, behaviour) VALUES (${key.idempotency_key}, 'timeout')`;

  const res = await call(appr, 'POST', `/payouts/${paymentId}/submit`);
  const [row] = await sqlc`SELECT state, submitted_at FROM payments WHERE id=${paymentId}`;

  check('a timeout is reported as uncertain, not as failure', res.status === 502 &&
    res.body?.reasonCode === 'PROVIDER_UNREACHABLE', `${res.status} ${res.body?.reasonCode ?? ''}`);
  check('the payout stays SUBMITTED_TO_PSP', row.state === 'SUBMITTED_TO_PSP', `state=${row.state}`);
  check('submitted_at is recorded so it is visibly in flight', !!row.submitted_at);
  check('the guidance says reconcile, not retry', /reconcile/i.test(res.body?.correctionPath ?? ''),
    res.body?.correctionPath?.slice(0, 60));

  const retry = await call(appr, 'POST', `/payouts/${paymentId}/submit`);
  check('a blind resubmission is refused', retry.status === 422, `${retry.status}`);
}

console.log('\nPROVIDER RECONCILIATION');
{
  const { paymentId } = await makePayout('settle-ok');
  await call(appr, 'POST', `/payouts/${paymentId}/approve`);
  await call(appr, 'POST', `/payouts/${paymentId}/submit`);
  const [row] = await sqlc`SELECT provider_transaction_id FROM payments WHERE id=${paymentId}`;

  await call(appr, 'POST', '/payouts/settle', { providerTransactionId: row.provider_transaction_id, outcome: 'paid' });
  const [after] = await sqlc`SELECT state, cleared_at FROM payments WHERE id=${paymentId}`;
  check('a paid confirmation moves it to CLEARED', after.state === 'CLEARED' && !!after.cleared_at);

  const dup = await call(appr, 'POST', '/payouts/settle', { providerTransactionId: row.provider_transaction_id, outcome: 'failed' });
  const [unchanged] = await sqlc`SELECT state FROM payments WHERE id=${paymentId}`;
  check('a later contradicting callback cannot rewrite it', unchanged.state === 'CLEARED' && dup.body?.changed === false);

  const { paymentId: failId } = await makePayout('settle-fail');
  await call(appr, 'POST', `/payouts/${failId}/approve`);
  await call(appr, 'POST', `/payouts/${failId}/submit`);
  const [f] = await sqlc`SELECT provider_transaction_id FROM payments WHERE id=${failId}`;
  await call(appr, 'POST', '/payouts/settle', { providerTransactionId: f.provider_transaction_id, outcome: 'failed', failureReason: 'account closed' });
  const [failed] = await sqlc`SELECT state FROM payments WHERE id=${failId}`;
  check('a failed confirmation moves it to FAILED', failed.state === 'FAILED', `state=${failed.state}`);
}

await sqlc.end();
finish();
