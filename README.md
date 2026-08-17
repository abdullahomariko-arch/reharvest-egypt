# ReHarvest

A private B2B marketplace for Egyptian post-harvest produce — Grade B and surplus
matched to kitchens, sauce makers and processors that buy on usability rather than
appearance.

This repository is the control system underneath that marketplace. It exists
because the hard part is not matching supply to demand — a WhatsApp group already
does that. The hard part is being the party whose weights, grades, holds and
payments both sides trust enough to stop arguing about.

## Run it

```bash
pnpm install
pnpm test          # 59 acceptance tests, keyed to catalog domain IDs
pnpm typecheck
```

The test suite needs no database, no network and no fixtures. That is the point:
every rule lives in `packages/core` as pure functions, so a control can be proven
in milliseconds and the mobile app and the server run the identical code.

## Where to look first

| I want to understand… | Read |
|---|---|
| The whole design and all 54 controls | `docs/ARCHITECTURE.md` |
| Why money is never a float | `packages/core/src/money.ts` |
| Why "yes probably" can't buy tomatoes | `packages/core/src/state-machines.ts` |
| How a refusal is shaped | `packages/core/src/guard.ts` |
| What the rules actually prevent | `packages/core/src/controls.test.ts` |
| How money clears | `packages/payments/src/reconciliation.ts` |
| The four gates a webhook must survive | `apps/api/src/service/payment-service.ts` |
| What the app feels like | `apps/mobile/src/screens/WeighAndAcceptScreen.tsx` |
| How a buyer actually pays | `apps/mobile/src/screens/CheckoutScreen.tsx` |
| The design system | `apps/mobile/src/ui/theme.ts` + `ui/components.tsx` |
| The one rule with no override | `apps/mobile/src/screens/QualityCheckScreen.tsx` |

## Layout

```
apps/
  api/        Hono service — payment orchestration, webhooks, idempotency
  mobile/     Expo · React Native · Arabic-first RTL
              supplier · buyer · inspector — one binary, role-switched
  admin/      Ops console — approvals, matching, holds, settlement, audit  (next)
packages/
  core/       Money · Quantity · State machines · Invariants · Guard
  payments/   Paymob Intentions + disbursement · cleared-funds reconciliation
  db/         Postgres schema — append-only versioning, hash-chained audit
scripts/
  generate-controls.mjs    regenerates the typed control registry from the catalog
```

## The catalog is the contract

`packages/core/src/controls.data.json` is the 54-domain control specification from
the risk diagnostic. `controls.generated.ts` is compiled from it and must never be
edited by hand — change the catalog and rerun `pnpm gen:controls`, so the code and
the specification cannot drift apart.

A control with no failing-path test in `controls.test.ts` is not implemented, no
matter what the code says.

## Before this touches real money

The loss-reduction percentages in the diagnostic are synthetic model outputs, not
observed results. They rank work; they do not prove anything. Four things need a
qualified Egyptian professional before production: NFSA food-safety duties, ETA
e-invoicing and tax treatment, the legal form of the supplier and buyer contracts,
and whether this trading structure needs a CBE-regulated payment licence or can
operate as a merchant of record.
