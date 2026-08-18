# Runbook

Everything needed to get ReHarvest running, and how to tell whether it is
actually working rather than merely starting.

## First run

```bash
npm install                 # workspaces; ~1 minute
npm test                    # 88 unit tests, no database needed
npm run typecheck           # repo + mobile
```

If `npm install` fails on a peer dependency, check `apps/mobile/package.json`
first — React and React Native versions must be the pair Expo SDK 52 ships
(React 18.3.1 / RN 0.76.5). A React 19 pin looks harmless and makes the install
impossible.

## Database

```bash
createdb reharvest
export DATABASE_URL="postgres://localhost:5432/reharvest"
npm run db:migrate          # all four migrations, in order
npm run test:db             # 10 invariant proofs — must print 10 PASS
npm run db:seed             # sample corridor + dev tokens
```

Migrations are ordered and not idempotent as a set — run them once, in order, on
an empty database. `0001_invariants.sql` creates the `reharvest_app` role and
revokes `UPDATE`/`DELETE` on `audit_log` and `weighings`; run it as the database
owner, then point the application's `DATABASE_URL` at `reharvest_app`.

`npm run test:db` is not optional. A CHECK constraint nobody exercised is a
comment. If any of the ten proofs stops passing, an invariant has regressed and
the deploy should stop.

## Running

```bash
cp .env.example .env        # fill in AUTH_SIGNING_SECRET and the Paymob keys
npm run dev:api             # :8787
```

The server validates configuration at boot and refuses to start with anything
missing. That is deliberate: a service that starts without an HMAC secret and
discovers it when the first webhook arrives has turned a config error into a
payment incident.

Generate the signing secret with `openssl rand -base64 48`. Anything under 32
characters is rejected.

### Health endpoints

Two, not one, and the difference matters to a load balancer:

| Endpoint | Touches the database | Used for |
|---|---|---|
| `/health` | no | restart decisions |
| `/ready` | yes | routing decisions |

Wiring a restart check to `/ready` means one database blip restarts every
healthy instance.

## Verifying a deploy

```bash
API_URL=https://api.example.com AUTH_SIGNING_SECRET=... npm run test:e2e
```

Sixteen checks over real HTTP: the full intake path, the refusals, the status
codes, and the two idempotency behaviours. Exits non-zero on any failure, so it
works as a deploy gate. Keys are namespaced per run, so it is safe to run
repeatedly against the same environment.

What it proves that the unit tests cannot:

- money and weight survive JSON as integer strings, not doubles
- a rule refusal is 422 with a correction path, so the app renders a block
  instead of retrying forever
- a lost race is 409, so the client refreshes instead of giving up
- a replayed order returns the original order rather than being refused for
  stock its own first attempt took
- a quarantined lot disappears from the buyer market entirely

## The mobile app

```bash
cd apps/mobile
npx expo start              # scan with Expo Go
npm run export              # web bundle, useful as a smoke test
```

`metro.config.js` carries the monorepo wiring. Without `watchFolders` Metro
cannot see `packages/core`; without `disableHierarchicalLookup` it resolves two
copies of React and the app white-screens with a confusing hook error.

Fonts live in `apps/mobile/assets/fonts` as TTF. React Native cannot load woff2,
so if the Arabic renders in the system face, check the conversion rather than the
stylesheet.

## Known limits before scaling

**The idempotency store is in-memory.** Correct for one instance, wrong for two:
instances behind a load balancer will not see each other's replays, so a retried
request can execute twice. Move it to Redis or a Postgres table before adding a
second instance. This is the single most important item on this list.

**Distance is a stub.** `distanceKm` returns 28 for everything. Road distance
belongs to the transport module, which is deliberately out of scope.

**Grade is hardcoded to B** in the wire mapping. It needs to come from the
inspection record.

**The payment service is wired to stub repositories** in `index.ts`. The service
itself is fully tested; the Postgres implementations behind `OrderRepo` and
`PaymentRepo` for the payment path still need writing.

## Before production

Four things need qualified Egyptian professionals, not a developer:

1. **NFSA** — food safety duties for a business handling produce
2. **ETA** — e-invoicing and tax treatment of a managed trading margin
3. **Legal** — the supplier and buyer contract forms
4. **CBE** — whether the trading structure needs a payment licence or can
   operate as merchant of record

The 87% loss-reduction figure in the original handoff is a synthetic model
output. It is useful for deciding what to build first and is not evidence of
anything. Do not put it in front of an investor as a result.
