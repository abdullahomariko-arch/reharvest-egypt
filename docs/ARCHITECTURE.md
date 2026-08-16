# ReHarvest — architecture and control coverage

**Version 2.0 · August 2026 · supersedes the `reharvest-egypt` landing-page build**

---

## What changed, and why

The existing repository is a single 271-line React page with a four-line database
schema. It presents the business well. It does not run it. Nothing in it can
stop the failure the whole concept turns on: buying 800kg of perishable tomatoes
against a buyer who said "yes, probably" on WhatsApp.

The handoff package you generated is the more valuable half of the work. It names
54 control domains, and for each one a hard rule, a detection method, an evidence
requirement and six acceptance tests. That is a specification for software, not a
report. This build turns it into software.

The organising idea: **ReHarvest is not a marketplace with rules bolted on. It is
a rule engine that happens to sell tomatoes.** The moat is not matching supply to
demand — a WhatsApp group does that. The moat is being the party whose weights,
grades, holds and payments both sides trust enough to stop arguing about.

## Shape of the system

```
apps/
  api/        Hono service — payment orchestration, webhooks, idempotency
  mobile/     Expo · React Native · Arabic-first RTL
              supplier · buyer · inspector — one binary, role-switched
  admin/      Ops console — approvals, matching, holds, settlement, audit
packages/
  core/       Money · Quantity · State machines · Invariants · Guard
              ← every rule lives here, in one place, testable without a database
  payments/   Paymob adapter · reconciliation · disbursement
  db/         Postgres schema — append-only versioning, audit, idempotency
```

`core` has no database, no network and no framework. That is deliberate: it means
the 2,160 catalog cases can be replayed as unit tests in milliseconds, and it means
the mobile app and the server enforce *literally the same code*, not two drifting
interpretations of the same rule.

## The five decisions that shape everything else

**1. Money is `bigint` piastres. Never a float.**
`0.1 + 0.2` is not `0.3` in JavaScript. On one order that is a rounding artefact;
across a settlement ledger it is an unexplainable variance that costs a supplier
relationship. Prices, weights and totals are integers end to end, and the only
rounding point in the codebase is one explicit, tested function.

**2. Interest is not demand.**
The order state machine separates `INTEREST → QUOTED → CONDITIONAL →
DEPOSIT_PENDING → DEPOSIT_CLEARED → CONFIRMED`. Only the last two may authorise
spending money on produce, enforced by a single function that throws. This is the
number-one failure chain in your own diagnostic, and it is now structurally
impossible rather than discouraged.

**3. A refusal always carries a correction path.**
Every blocked action returns four things: what is wrong, which rule refused it,
what to do instead, and who — if anyone — may authorise an exception. A rule with
no exception path gets worked around outside the system, which is worse than a
governed one. Food safety is the deliberate exception to the exception: `D31` and
`D32` have no override at any level.

**4. Payments clear on bank lines, not screenshots.**
A callback arriving at our webhook endpoint is an unauthenticated HTTP request
from the internet. Before it may advance an order it survives four gates in order:
HMAC signature, replay check, reconciliation, then the state machine. They are
ordered cheapest-first, so a flood of forged callbacks costs one HMAC check each
and never touches the database.
Collection runs through Paymob's Intentions API (cards, Vodafone Cash and other
wallets, Aman kiosk cash, valU). Nothing moves an order forward until payer,
bank reference, amount and reversal status all match. Supplier payouts go through
Paymob's disbursement rail with a 24-hour cooldown on any changed beneficiary and
a mandatory second approver.

**5. Arabic first, offline first, sunlight first.**
The interface is designed for someone standing next to a scale, one-handed, on a
cheap Android phone, in direct sun. Nothing under 15pt, nothing under 56pt of touch
target, kraft-paper backgrounds instead of white to cut glare, and red reserved
exclusively for hard blocks so it never loses its force.

## Control coverage — all 54 domains

`✅ enforced` means there is working code and a failing-path test in this build.
`◻ specified` means the data model and state machine are in place and the rule is
written, awaiting its handler. `— planned` means P1/P2.

| ID | Domain | Module | Enforcing surface | Phase | This session |
|---|---|---|---|---|---|
| D01 | Supplier identity and KYB | Supplier Registry | Ops console + supplier onboarding | P0 | ✅ enforced |
| D02 | Supplier authority and ownership | Supplier Registry | Ops console + supplier onboarding | P0 | ◻ specified |
| D03 | Supplier reliability and fulfilment | Supplier Scorecard | Ops console | P1 | — planned |
| D04 | Supplier concentration and dependency | Exposure Limits | Ops console | P1 | — planned |
| D05 | Farm, plot, and crop source records | Source Registry | Supplier app | P0 | ◻ specified |
| D06 | Crop legality and food-use suitability | Eligibility Rules | Ops console | P0 | ◻ specified |
| D07 | Harvest maturity and timing | Harvest Window | Supplier app | P1 | — planned |
| D08 | Supply forecasting and quantity confidence | Supply Forecast | Ops console | P1 | — planned |
| D09 | Lot existence, reservation, and double-selling | Lot Ledger | Core service | P0 | ✅ enforced |
| D10 | Supplier price and term changes | Quote Control | Ops console | P1 | — planned |
| D11 | Climate, weather, and water shock | Agri Alerts | Ops console | P1 | — planned |
| D12 | Pest, disease, and field contamination shock | Agri Alerts | Ops console | P1 | — planned |
| D13 | Buyer identity and KYB | Buyer Registry | Ops console + buyer onboarding | P0 | ◻ specified |
| D14 | Demand authenticity and purchase intent | Demand Confirmation | Buyer app + core service | P0 | ✅ enforced |
| D15 | Buyer specification clarity | Specification Library | Ops console + buyer app | P0 | ◻ specified |
| D16 | Demand forecasting and seasonality | Demand Forecast | Ops console | P1 | — planned |
| D17 | Order confirmation and change control | Order Workflow | All surfaces | P0 | ✅ enforced |
| D18 | Buyer cancellation, no-show, and retention | Buyer Reliability | Ops console | P1 | — planned |
| D19 | Buyer concentration and channel dependency | Exposure Limits | Ops console | P1 | — planned |
| D20 | Buyer pricing and quote validity | Quote Control | Ops console | P1 | — planned |
| D21 | Unit economics and margin integrity | Margin Engine | Core service | P0 | ✅ enforced |
| D22 | Cost leakage and unauthorized spend | Spend Control | Ops console | P1 | — planned |
| D23 | Working capital and liquidity | Cash Planner | Ops console | P0 | ✅ enforced |
| D24 | Deposits and prepayment integrity | Payment Control | Payments service | P0 | ✅ enforced |
| D25 | Buyer credit and collections | Credit Ledger | Payments service | P1 | — planned |
| D26 | Supplier settlement and reconciliation | Settlement Ledger | Payments service | P0 | ✅ enforced |
| D27 | Refunds, claims, and dispute handling | Case Management | Ops console + buyer app | P1 | — planned |
| D28 | Payment fraud and beneficiary changes | Payment Control | Payments service | P0 | ✅ enforced |
| D29 | Quality grading and grade integrity | Quality Inspection | Inspector app | P0 | ◻ specified |
| D30 | Sampling and inspection integrity | Quality Inspection | Inspector app | P0 | ◻ specified |
| D31 | Food safety contamination | Food Safety | Inspector app + ops console | P0 | ✅ enforced |
| D32 | Pesticide residues, chemicals, and allergens | Food Safety | Inspector app + ops console | P0 | ◻ specified |
| D33 | Traceability and recall readiness | Traceability | Core service | P0 | ◻ specified |
| D34 | Weighing, tare, units, and measurement | Weight Capture | Inspector app | P0 | ✅ enforced |
| D35 | Sorting and packing process control | Batch Workflow | Ops console | P1 | — planned |
| D36 | Packaging, crates, labels, and materials | Packaging Control | Ops console | P1 | — planned |
| D37 | Storage capacity and allocation | Capacity Planner | Ops console | P1 | — planned |
| D38 | Storage conditions and usable life | Storage Monitoring | Ops console | P1 | — planned |
| D39 | Inventory accuracy, lot mixing, and status | Inventory Ledger | Core service | P0 | ✅ enforced |
| D40 | Waste, spoilage, and diversion | Waste Ledger | Ops console | P0 | ◻ specified |
| D41 | Labour availability, training, and human error | Workforce Control | Ops console | P2 | — planned |
| D42 | Equipment, scale, and tool readiness | Asset Control | Ops console | P1 | — planned |
| D43 | Hygiene, sanitation, and facility pests | Sanitation Control | Ops console | P1 | — planned |
| D44 | Contracts, legal status, and compliance obligations | Compliance Register | Ops console | P1 | — planned |
| D45 | Tax, invoicing, receipts, and record retention | Tax Records | Core service | P0 | ◻ specified |
| D46 | Insurance and business continuity | Continuity Planner | Ops console | P2 | — planned |
| D47 | Fraud, collusion, theft, and conflicts of interest | Integrity Monitoring | Platform | P0 | ✅ enforced |
| D48 | Marketplace bypass, side deals, and reputation | Relationship Governance | Ops console | P2 | — planned |
| D49 | Communication and acknowledgement | Communications Hub | Platform | P1 | — planned |
| D50 | Roles, permissions, and approval governance | Access Control | Platform | P0 | ◻ specified |
| D51 | Data quality and master-data integrity | Data Governance | Platform | P0 | ✅ enforced |
| D52 | Cybersecurity, privacy, and account abuse | Security Center | Platform | P1 | — planned |
| D53 | System reliability, offline work, and integrations | Reliability Console | Platform | P0 | ✅ enforced |
| D54 | Automated decisions, scoring, and calculation correctness | Decision Governance | Platform | P0 | ✅ enforced |

## Build order

**P0 — 28 domains — before the pilot takes a second order.** Party registry, demand
state machine, lot ledger, specification and inspection, food-safety hold/release,
weight capture, margin engine, cash and settlement, inventory and waste, platform
controls. 16 of these are enforced in code today.

**P1 — 23 domains — after the pilot proves the corridor.** Reliability scoring with
appeal, climate and pest alerts tied to commitment limits, forecast ranges, anomaly
graphs, compliance and tax registers, continuity drills.

**P2 — 3 domains — only once there is clean operating data.** Predictive shelf life,
dynamic pricing, automated risk scores — and those run in shadow mode before they
ever enforce anything.

## What I have not built, and why not

- **The transport module.** Your handoff explicitly scopes delivery out. Vehicles,
  drivers, routes and proof of delivery are a separate system with its own failure
  modes; mixing them in would have blurred the control boundaries you drew.
- **The admin console UI.** The schema, guard, state machines and payment service
  it sits on are done; the screens are the next session's work.
- **Order, lot and inspection HTTP routes.** Only the payment routes are wired.
  The services behind the rest exist; the endpoints do not.
- **The Figma design system.** The tokens in `apps/mobile/src/ui/theme.ts` are the
  source of truth and translate directly into Figma variables. Say the word and I
  will build the library and the screen set against them.
- **Anything predictive.** Correctly, per your own P2 gate.

## Before this touches real money

The 87% loss-reduction figure in your handoff is a synthetic model output, not
evidence. Treat it as a prioritisation aid and nothing else. Before production,
four things need a qualified Egyptian professional rather than a language model:
NFSA food-safety duties, ETA e-invoicing and tax treatment, the legal form of the
supplier and buyer contracts, and whether your specific trading structure needs a
CBE-regulated payment licence or can operate as a merchant of record. I can prepare
the questions for each; I should not be the one answering them.
