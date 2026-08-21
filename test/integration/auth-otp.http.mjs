/**
 * Mobile sign-in, through real HTTP.
 *
 * Replaces a hard-coded demo table that granted a session to anyone who knew a
 * phone number. These checks are about what the endpoint gives away and what it
 * refuses, not whether the happy path works.
 */

let failures = 0;
const check = (n, ok, d = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); if (!ok) failures += 1; };

const A = 'http://localhost:9001';
const postgres = (await import('postgres')).default;
const sqlc = postgres(process.env.DATABASE_URL, { max: 3 });

const post = async (p, body) => {
  const r = await fetch(A + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

const PHONE = '+201001234567';   // seeded supplier
const UNKNOWN = '+201009999999';

await sqlc`DELETE FROM otp_codes WHERE phone_e164 IN (${PHONE}, ${UNKNOWN})`;

console.log('\nREQUESTING A CODE');
const known = await post('/auth/request-code', { phone: PHONE });
const unknown = await post('/auth/request-code', { phone: UNKNOWN });
check('a registered number is accepted', known.status === 200);
check('an unregistered number answers identically', unknown.status === known.status &&
  JSON.stringify(unknown.body) === JSON.stringify(known.body), 'membership is not disclosed');

const [stored] = await sqlc`SELECT code_hash FROM otp_codes WHERE phone_e164=${PHONE} ORDER BY created_at DESC LIMIT 1`;
check('a code row exists for the registered number', !!stored);
check('the code is stored hashed, not in the clear', !!stored && /^[0-9a-f]{64}$/.test(stored.code_hash));

const [none] = await sqlc`SELECT count(*)::int c FROM otp_codes WHERE phone_e164=${UNKNOWN}`;
check('no row is written for an unregistered number', none.c === 0);

console.log('\nVERIFYING');
const wrong = await post('/auth/verify-code', { phone: PHONE, code: '000000' });
check('a wrong code is refused', wrong.status === 401, `status ${wrong.status}`);

/*
  Read the code the console provider logged, the way a developer would.
  The path is configurable because the server's log destination is a property of
  how it was started, not of the test.
*/
const logPath = process.env.OTP_LOG ?? '/tmp/otp.log';
const logged = (await import('node:fs')).readFileSync(logPath, 'utf8');
const code = [...logged.matchAll(/\[otp\] \+201001234567 -> (\d{6})/g)].pop()?.[1];
check('the development provider emitted a code', !!code);

if (code) {
  const ok = await post('/auth/verify-code', { phone: PHONE, code });
  check('the correct code issues a token', ok.status === 200 && !!ok.body?.token);
  check('the role comes from the party record', ok.body?.party?.roles?.includes('supplier'),
    `roles=${JSON.stringify(ok.body?.party?.roles)}`);

  // The token must actually work against a protected route.
  const lots = await fetch(`${A}/lots?mine=true`, { headers: { Authorization: `Bearer ${ok.body.token}` } });
  check('the issued token is accepted by the API', lots.status === 200, `status ${lots.status}`);

  const reuse = await post('/auth/verify-code', { phone: PHONE, code });
  check('the same code cannot be used twice', reuse.status === 401, 'single use');
}

console.log('\nRATE LIMITING');
let limited = false;
for (let i = 0; i < 8; i += 1) {
  const r = await post('/auth/request-code', { phone: PHONE });
  if (r.status === 429) { limited = true; break; }
}
check('repeated requests are rate limited', limited);

await sqlc`DELETE FROM otp_codes WHERE phone_e164 IN (${PHONE}, ${UNKNOWN})`;
await sqlc.end();
if (failures > 0) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
console.log('\nAll checks passed.');
