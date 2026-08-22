# Runbook

Everything needed to run ReHarvest, and how to tell whether it is actually
working rather than merely starting.

## What this is

| | |
|---|---|
| Files in the archive | 128 (166 tar entries — the remainder are directory records) |
| Migrations | 15, `0000`–`0014` |
| Unit tests | 149 across 42 suites |
| Integration suites | 8, needing a real Postgres and two API instances |
| Runtime | Compiled JavaScript. No TypeScript reaches the image |

Earlier revisions of this document said "all four migrations" and quoted a file
count that included directory entries. Both were wrong. The numbers above come
from `git archive HEAD | tar -t` and `ls packages/db/migrations`.

## Installing

There are two procedures and they are not interchangeable.

### Fresh installation

```bash
createdb reharvest
export DATABASE_URL=postgres://…/reharvest
export FIELD_ENCRYPTION_KEYS="v1:$(openssl rand -base64 32)"
export AUTH_SIGNING_SECRET="$(openssl rand -base64 48)"

npm ci
npm run db:migrate      # fresh mode: all 15, including 0009
npm run db:seed
```

`db:migrate` applies **every** migration, including `0009_encryption_mandatory`,
so a new database finishes with `account_number_iv` and `encryption_key_id` set
`NOT NULL`. A new database has no legacy rows, so there is nothing to backfill
and no reason to leave the constraint off.

Confirm it took:

```sql
SELECT attname, attnotnull FROM pg_attribute
 WHERE attrelid = 'beneficiaries'::regclass
   AND attname IN ('account_number_iv', 'encryption_key_id');
-- both must be t
```

A previous arrangement left 0009 out of `db:migrate` entirely, so a fresh
install quietly finished *without* mandatory encryption and nobody was told.

### Upgrading an existing database

```bash
npm run db:migrate:upgrade    # everything except 0009

npx tsx scripts/beneficiary-keys.ts status
# for each row listed:
npx tsx scripts/beneficiary-keys.ts backfill --id <uuid> --account <number>

npx tsx scripts/beneficiary-keys.ts verify     # prove every row opens
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/db/migrations/0009_encryption_mandatory.sql
```

0009 refuses to run while any beneficiary row is unencrypted, and names the
command that fixes it. That ordering matters: run first, it fails the deploy at
the worst moment, and the obvious workaround — dropping the constraint — leaves
plaintext rows behind permanently.

The account number is passed to `backfill` explicitly rather than read from the
column, because legacy rows hold a mixture of plaintext and the literal string
`enc:placeholder` from an early seed. Guessing which is which encrypts a
placeholder and then treats it as a real account.

## Configuration

The server validates all of this at boot and refuses to start if anything is
wrong. A misconfiguration discovered while money is moving is the worst possible
timing.

### Encryption keys — required

```
FIELD_ENCRYPTION_KEYS=v1:<base64>,v0:<base64>
```

Comma separated, first is active, each **exactly 32 bytes** (AES-256) after
base64 decoding. Generate with `echo "v1:$(openssl rand -base64 32)"`.

Losing these means losing every bank account number on the platform. They belong
in a secrets manager, not in the repository.

When rotating, put the new key first and keep the old one listed until
`npm run keys:rotate` reports nothing left to do. Removing a key that rows still
reference makes those rows unreadable; `rotate` reports them as `unreadable` and
exits non-zero rather than skipping them silently.

### OTP provider — required in production

```
OTP_DRIVER=http-sms
OTP_SMS_ENDPOINT=https://…
OTP_SMS_API_KEY=…
OTP_SMS_SENDER_ID=ReHarvest
```

`OTP_DRIVER=console` logs codes to stdout and is for development and CI only.
Production refuses to start with it, and refuses to start with `http-sms` if any
of the three settings are missing. Outside production the driver defaults to
`console`.

Deploying with real credentials is configuration, not a code change.

### Disbursement provider

```
DISBURSEMENT_DRIVER=paymob      # or 'fake' outside production
```

`fake` records payouts to the `provider_calls` table instead of sending them, so
tests can assert on what the provider actually received rather than on what the
API said it would send. Production refuses it.

### Everything else

```
DATABASE_URL
AUTH_SIGNING_SECRET             # minimum 32 characters
PAYMOB_SECRET_KEY / PAYMOB_PUBLIC_KEY / PAYMOB_HMAC_SECRET
PORT                            # default 8787
```

## Running the tests

```bash
npm test                  # 149 unit tests
npm run db:proof          # 10 SQL invariant proofs against a real Postgres

# Integration: two instances on one database. The concurrency scenarios are
# meaningless against a single process — a per-process cache looks correct
# until there are two of them.
PORT=9001 npx tsx apps/api/src/index.ts &
PORT=9002 npx tsx apps/api/src/index.ts &
OTP_LOG=/path/to/9001.log npm run test:integration
```

`test:integration` discovers and runs all 8 suites and exits non-zero on
failure. It previously only printed instructions and exited 0, which looks
exactly like a passing suite in a CI log.

| Suite | Covers |
|---|---|
| `idempotency.http` | key scoping, body hashing, two instances racing |
| `allocation.http` | partial accumulation, concurrent allocation of one payment |
| `webhook-atomicity.http` | repair after a failed order advance |
| `beneficiary.pg` | encryption, record binding, rotation, backfill, HTTP paths |
| `session-csrf.http` | cookie flags, CSRF, logout revocation |
| `ownership.http` | role and record ownership |
| `auth-otp.http` | mobile sign-in |
| `payout.http` | the full payout lifecycle |

## Payout lifecycle

| State | Meaning |
|---|---|
| `PENDING_APPROVAL` | a second person has not agreed yet |
| `APPROVED` | agreed, not yet sent |
| `SUBMITTED_TO_PSP` | sent, outcome unknown |
| `CLEARED` / `FAILED` | the provider told us what happened |

`POST /payouts/:id/submit` accepts **only the payout id**. Amount, supplier,
beneficiary, bank account, preparer and approver all come from Postgres. The
account number is decrypted at that moment, bound to that beneficiary row,
attributed to the settlement, and never returned beyond its last four digits.

A row with `submitted_at` set and a non-final state is **money in flight**.
Reconcile against the provider statement; do not resubmit. Without
`SUBMITTED_TO_PSP` a timeout is indistinguishable from "never sent", and the
natural response to that ambiguity pays the supplier twice.

## Bank details

Every read and write goes through `apps/api/src/repo/beneficiary.ts`. Nothing
else touches the table — not the seed, not the console, not the payout path.

Ordinary reads return the last four digits. `revealForPayout` is the only
decrypt path; it requires a finance role and a settlement id, and writes an audit
entry each time.

Ciphertext is bound to its row and field with AES-GCM additional authenticated
data. Without that binding, a complete encrypted value can be copied from one
beneficiary into another, decrypt cleanly, and send the money to the wrong
account with every check passing. That was demonstrated as a working attack and
there are regression tests for it at both the utility and database levels.

Changes supersede rather than overwrite. The 24-hour payout cooldown is computed
from that history, and an overwrite erases the very fact that a change happened —
which is what the fraud depends on.

## The audit log

Hash-chained and append-only, with `UPDATE` and `DELETE` revoked from the
application role. `/internal/audit-integrity` re-walks the chain and requires an
ops manager, finance or executive role.

Anything hashed must survive the Postgres round trip byte-identically. Three
separate defects came from ignoring that: jsonb reordering object keys,
timestamps gaining milliseconds, and `undefined` values hashed as `null` but
dropped entirely by jsonb. Appends are serialised with a transaction-scoped
advisory lock, because two instances writing concurrently otherwise read the same
chain tip and fork it.

An integrity check that reports tampering on an intact chain is worse than no
check at all, because it teaches people to ignore the alarm.

## Deployment

```bash
npm run build          # typecheck, then bundle to dist/server.js
docker build -f apps/api/Dockerfile -t reharvest-api .
```

Three stages: install, build, run. The runtime image contains compiled
JavaScript and production dependencies — no TypeScript, no compiler, no test
tooling. It does not rely on Node's strip-only TypeScript execution, which is a
development convenience with failure modes of its own.

The ops console is served by the same process at `/ops`. There is no second
deployment.

## Known gaps

**Docker and GitHub Actions are verified.** All five jobs passed on 21 August
2026 at commit `062cd7cf91e19a41f882bca63fb9b0b484324ead`. The Docker job built the
image, proved no TypeScript reached the runtime layer, started the container,
probed health and readiness, verified access controls, and authenticated a staff
session into the ops console. The complete green run is recorded at:

https://github.com/abdullahomariko-arch/reharvest-egypt/actions/runs/32463473376

**Distance is a fixed 28 km.** Road distance belongs to the transport module,
which is out of scope. It affects only market list sorting.

**Counterparty accounts are per-party, not per-person.** A supplier business has
one identity rather than one per employee. Staff console accounts are already
per-person.

## Professional advice still required

The software enforces rules; it cannot tell you which rules a regulator will
apply to you. Before real money moves, get qualified Egyptian advice on:

- NFSA food safety duties, and what inspection records must contain
- ETA e-invoicing and the tax treatment of a managed trading margin
- The legal form of the supplier and buyer contracts
- Whether the trading structure requires a CBE payment licence, or can operate
  as merchant of record under an existing provider's licence

These are not software questions, and no amount of testing substitutes for them.
