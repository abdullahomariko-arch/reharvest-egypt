/**
 * Proves the audit endpoint is restricted rather than simply broken.
 *
 * Asserting only that an anonymous request gets 401 would pass identically
 * against an endpoint that refuses everyone, including the people who need it.
 * Both halves have to be checked.
 */

import { issueToken } from '../../apps/api/src/auth.ts';

const BASE = process.env.API_BASE ?? 'http://localhost:8787';
const SECRET = process.env.AUTH_SIGNING_SECRET!;

const fail = (m: string): never => {
  console.error(`FAIL: ${m}`);
  process.exit(1);
};

const anon = await fetch(`${BASE}/internal/audit-integrity`);
if (anon.status !== 401) fail(`anonymous request returned ${anon.status}, expected 401`);

// A buyer holds a perfectly valid token and still must not read it.
const buyerToken = await issueToken(
  {
    userId: '00000000-0000-4000-8000-000000000002',
    partyId: '22222222-2222-4222-8222-222222222221',
    roles: ['buyer'],
    displayName: 'Buyer',
  },
  SECRET,
);
const asBuyer = await fetch(`${BASE}/internal/audit-integrity`, {
  headers: { Authorization: `Bearer ${buyerToken}` },
});
if (asBuyer.status !== 403) fail(`a buyer token returned ${asBuyer.status}, expected 403`);

const opsToken = await issueToken(
  {
    userId: '00000000-0000-4000-8000-000000000004',
    partyId: '33333333-3333-4333-8333-333333333333',
    roles: ['ops_manager'],
    displayName: 'Ops',
  },
  SECRET,
);
const asOps = await fetch(`${BASE}/internal/audit-integrity`, {
  headers: { Authorization: `Bearer ${opsToken}` },
});
if (asOps.status !== 200) fail(`an ops token returned ${asOps.status}, expected 200`);

const body = (await asOps.json()) as { ok?: boolean; checked?: number };
if (body.ok !== true) fail(`the audit chain did not verify: ${JSON.stringify(body)}`);

console.log(`OK: anonymous 401, buyer 403, ops 200, chain verified over ${body.checked} entries.`);
