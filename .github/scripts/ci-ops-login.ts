/**
 * Proves a real staff session reaches the console in the built image.
 *
 * Checking that /ops returns 302 without a cookie only proves the guard exists.
 * It does not prove anyone can get past it — and a console nobody can sign into
 * is as broken as one with no guard at all.
 */

import postgres from 'postgres';
import { hashPassphrase } from '../../apps/api/src/staff-login.ts';

const BASE = process.env.OPS_BASE ?? 'http://localhost:8787';
const IDENT = 'ci.ops';
const PASS = 'ci-passphrase-long-enough';

const sql = postgres(process.env.DATABASE_URL!, { max: 2 });

const fail = (m: string): never => {
  console.error(`FAIL: ${m}`);
  process.exit(1);
};

await sql`DELETE FROM staff_credentials WHERE identifier = ${IDENT}`;
await sql`
  INSERT INTO staff_credentials (identifier, user_id, display_name, party_id, roles, passphrase_hash)
  VALUES (${IDENT}, '00000000-0000-4000-8000-000000000004', 'CI Ops',
          '33333333-3333-4333-8333-333333333333', '["ops_manager","finance"]'::jsonb,
          ${await hashPassphrase(PASS)})
`;

const login = await fetch(`${BASE}/ops/login`, {
  method: 'POST',
  redirect: 'manual',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ identifier: IDENT, secret: PASS }),
});

const setCookie = login.headers.get('set-cookie');
if (!setCookie) fail(`login issued no session (status ${login.status})`);
if (!/HttpOnly/i.test(setCookie!) || !/SameSite=Strict/i.test(setCookie!)) {
  fail('session cookie is missing HttpOnly or SameSite=Strict');
}

const cookie = setCookie!.split(';')[0];
const page = await fetch(`${BASE}/ops`, { headers: { cookie } });
const html = await page.text();

if (page.status !== 200) fail(`console returned ${page.status} for a valid session`);
if (!html.includes('Open buying commitment')) fail('console rendered without its dashboard content');
if (!html.includes('ReHarvest')) fail('console rendered without its layout');

console.log('OK: staff login issues a hardened cookie and the console renders.');

await sql`DELETE FROM staff_credentials WHERE identifier = ${IDENT}`;
await sql.end();
