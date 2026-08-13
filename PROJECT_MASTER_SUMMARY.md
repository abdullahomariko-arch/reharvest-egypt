# ReHarvest Egypt — Master Project Summary

## 1. The idea in one sentence

ReHarvest Egypt is a managed B2B procurement and delivery service that redirects edible processing-grade, Grade-B, and time-sensitive agricultural produce from verified suppliers to Egyptian food businesses that care about usability, consistency, and price more than cosmetic appearance.

The software supports the operation. The business itself depends on sourcing, quality control, logistics, payment control, and trusted relationships.

## 2. The market gap

Farms, packing stations, traders, and wholesale sources may have produce that is fresh and usable but undersized, irregular, surplus, close to its ideal selling window, or unsuitable for premium retail and export presentation. Restaurants, central kitchens, juice businesses, caterers, bakeries, and processors often do not require perfect-looking produce because they cook, blend, press, or process it.

ReHarvest organizes the gap between those two sides. It does not farm, export produce, operate a supermarket, or manufacture food during the pilot.

## 3. The recommended business model

Start as a **private, operator-managed marketplace**:

1. Confirm buyer demand before committing money.
2. Source suitable supply only for that confirmed demand.
3. Inspect and document the lot before loading.
4. Approve the complete landed economics.
5. Reserve, collect, deliver, and record every handoff.
6. Accept, partially accept, dispute, or divert the produce based on evidence.
7. Record final payment, loss, and contribution.

Do not begin as an open marketplace where anyone can list anything. Do not buy speculative inventory, rent a warehouse, purchase vehicles, or give uncontrolled credit during the pilot.

## 4. First pilot corridor

- **Crop:** sauce-grade tomatoes
- **Supply origin:** Beheira
- **Buyer area:** New Cairo
- **Best first buyers:** pizza and pasta kitchens, central kitchens, caterers, and sauce users
- **Order size:** approximately 500–3,500 kg
- **Supplier base:** one primary source plus at least one backup
- **Buyer base:** three to five recurring businesses
- **Infrastructure:** rented transport with one primary and two verified backup truck-driver pairs, reusable crates, calibrated scales, basic sorting, and an offline/WhatsApp backup
- **Operating principle:** no confirmed demand, no purchase

This corridor is deliberately narrow. Expansion should come only after repeat orders, stable quality, controlled losses, and positive contribution are proven.

## 5. Why each side should use ReHarvest

### Supplier value

- Faster movement of undervalued or time-sensitive produce
- Larger and more predictable collections
- Less time spent finding many small buyers
- Pickup, buyer coordination, and complaint handling managed by ReHarvest
- A documented transaction and payment trail

### Buyer value

- Produce selected for its intended use rather than its appearance
- One reliable point of contact instead of repeated market searching
- Agreed grade, quantity, price, and delivery window
- Quality evidence, measured weights, and a clear dispute route
- Potential savings when the complete delivered cost is below the buyer's alternative

## 6. What the current application contains

The current application is an interactive operator pilot, not a live multi-user marketplace.

### Overview

Shows the active corridor, demand pipeline, orders in movement, projected economics, redirected produce, decisions waiting, and the pilot control tower.

### Demand board

Records buyer, crop, intended use, quantity, price ceiling, location, delivery time, match status, and sourcing status. The `Post demand` form creates new pilot requests in local state.

### Matches

Displays verified demonstration lots, supplier, origin, crop, quantity, usable yield, farm-gate price, pickup window, match confidence, and estimated landed cost. An operator can reserve a lot and open a simulated order.

### Orders

Demonstrates reserved, in-transit, accepted, and delivered records, together with required evidence such as lot photographs, loaded weight, buyer acceptance, and final loss and margin.

### Diagnostics

Displays a reproducible 100,000-scenario stress test, protected outcome distribution, largest financial shocks, automatic operating gates, and the staged integration roadmap. The event rates are illustrative assumptions for control design, not forecasts of actual Egyptian market performance.

### Delivery resilience

Displays a separate reproducible 2,000,000-scenario paired stress test and a searchable library of 1,000 practical delivery failures across 25 domains. The route-release console begins blocked and enforces 15 evidence gates. Its core redundancy rule requires one primary vehicle and two independently verified backup truck-driver pairs, each with valid fuel range, payload, hygiene, response-time, and authority evidence. Fuel range must cover the route, detour allowance, and a 25% reserve. Missing or inconsistent evidence blocks dispatch.

Using illustrative probabilities rather than measured pilot rates, the model produced 20.29% failed deliveries without controls and 4.87% with controls, a 17.57 percentage-point improvement in on-time outcomes, and a 355-minute improvement in P95 disruption delay. These values are model outputs for comparing control designs; they are not forecasts, compliance proof, insurance estimates, or service commitments.

### Design

The design uses a warm limestone background, deep produce-green navigation, editorial typography, rounded operational cards, and responsive desktop/mobile layouts. It is intentionally an agricultural operations product, not a consumer grocery app or generic finance dashboard.

## 7. What the application does not yet do

The current actions run in browser memory and disappear after refresh. Before real transactions, the product still needs:

- Persistent relational data storage
- Secure authentication and role-based permissions
- Buyer, supplier, inspector, driver, and administrator accounts
- Supplier and buyer verification records
- Server-side economic calculations and validation
- Secure image and document storage
- Timestamped evidence and complete audit logs
- Deposits, settlement, refunds, and payment reconciliation
- Notifications and WhatsApp-friendly summaries
- Real delivery tracking or transport-provider workflows
- Disputes, partial acceptance, diversion, and cancellation rules
- Credit limits and overdue-payment controls
- Lot traceability and food-safety incident handling
- Data exports, backups, monitoring, and operational support

Payments, transport tracking, notifications, and quality verification must remain clearly labelled as simulated until their integrations and operating procedures are tested.

## 8. Correct unit economics

The earlier `EGP 8.40/kg projected spread` was not economically consistent with a buyer ceiling near EGP 9.50/kg. It has been replaced throughout the dashboard and matching workflow by a shared, tested cost engine.

Illustrative pilot assumptions, not verified market quotations:

| Item | Assumption |
|---|---:|
| Delivered quantity | 3,500 kg |
| Buyer price | EGP 9.50/kg |
| Supplier price | EGP 4.75/purchased kg |
| Sorting loss | 8% |
| Transport | EGP 1.80/delivered kg |
| Handling and crates | EGP 0.35/delivered kg |
| Inspection and loading | EGP 0.25/delivered kg |
| Claims/payment reserve | EGP 0.20/delivered kg |

Required purchase quantity:

`delivered quantity / (1 - sorting loss) = 3,500 / 0.92 = approximately 3,804 kg`

| Result | Amount |
|---|---:|
| Buyer revenue | EGP 33,250 |
| Produce purchase cost | approximately EGP 18,071 |
| Transport | EGP 6,300 |
| Handling and crates | EGP 1,225 |
| Inspection and loading | EGP 875 |
| Claims/payment reserve | EGP 700 |
| Total variable cost | approximately EGP 27,171 |
| Contribution before fixed expenses | approximately **EGP 6,079** |
| Contribution per delivered kg | approximately **EGP 1.74/kg** |
| Contribution margin | approximately **18.3%** |

At EGP 25,000 of lean monthly fixed operating expenses, illustrative break-even is about 14,400 delivered kg per month. That is roughly 4.1 routes of 3,500 kg; operationally, at least five successful routes would be safer.

Every order must calculate revenue, required purchase weight, supplier cost, sorting loss, transport, crates, handling, inspection, payment cost, claims/bad-debt reserve, diversion cost, contribution, contribution/kg, and contribution margin.

### 100,000-scenario stress test

The repository now contains a deterministic Monte Carlo stress test using seed `20260813`. It samples broad ranges for quantity, buyer price, supplier price, sorting loss, transport, and seven disruption events. These inputs are deliberately conservative operating hypotheses, not measured probabilities or financial forecasts.

With the modelled controls (30% deposit, backup sourcing/buyers, inspection, and backup transport), the 100,000 runs produced:

- 24.26% loss-making outcomes, including 4.24% severe-loss outcomes
- EGP 1,176 median contribution per order and EGP 0.79 median contribution per delivered kg
- EGP -2,555 at the 5th percentile, versus EGP -9,413 without the controls
- EGP 821 higher average contribution and EGP 6,858 better 5th-percentile downside than the unprotected model
- Food-safety incidents and payment defaults as the largest single-event financial shocks

The result is not "the business has a 24.26% real-world failure probability." It means the model remains fragile across wide input ranges, so real pilot observations must replace the illustrative assumptions before scale decisions.

## 9. The most important real-life failures

| Failure | Operational response | Product control |
|---|---|---|
| Buyer cancels or does not receive | Keep an agreed deposit, charge according to cancellation terms, call backup buyers, and divert quickly | Deposit status, cancellation clock, backup-buyer list, diversion workflow |
| Supplier quantity is short | Reconfirm before dispatch, split the demand, and use a backup lot | Reservation expiry, confirmed weight, split sourcing |
| Quality differs from photos | Inspect before loading against measurable tolerances | Timestamped photos, checklist, inspector sign-off |
| Buyer partially rejects | Weigh accepted/rejected produce, photograph it, apply the agreement, and divert the rejected amount | Partial acceptance and dispute evidence |
| Delivery weight is short | Compare calibrated pickup and delivery weights | Two weight records and discrepancy alert |
| Vehicle is late or breaks down | Notify early and dispatch a backup provider | Route event, backup carrier, escalation log |
| Price changes after agreement | Use short quote validity and lock only after confirmation/deposit | Quote expiry and immutable confirmed terms |
| Buyer pays late or defaults | Begin with deposits/prepayment and earn credit limits gradually | Credit limit, overdue block, settlement status |
| Supplier sells a reserved lot elsewhere | Reconfirm immediately before vehicle dispatch and downgrade unreliable suppliers | Timed reservation and partner risk score |
| Produce deteriorates in transit | Use suitable crates, early pickup, short routes, and temperature/time rules where required | Pickup timestamp, route timer, exception alert |
| Crates disappear | Number them and use a refundable deposit or return record | Crate ledger |
| The app or internet fails | Continue through WhatsApp and a controlled offline order sheet, then reconcile | Exportable order summary and later sync procedure |
| Food-safety complaint | Stop distribution, quarantine the lot, identify recipients, preserve evidence, and escalate | End-to-end lot traceability and incident workflow |
| Buyer and supplier bypass ReHarvest | Make verification, logistics, payment protection, and records valuable enough to retain both sides | Service history, partner benefits, controlled contact exposure |

Credit risk is especially dangerous. One unpaid 1,000 kg order at EGP 9.50/kg creates EGP 9,500 of bad debt. At about EGP 1.74 contribution per kg, it can erase the contribution of roughly five and a half successful 1,000 kg orders.

## 10. Operating rules that should never be broken

1. No speculative buying during the pilot.
2. No unverified lot can be reserved.
3. No pickup before inspection passes.
4. No delivery acceptance without proof of delivery and weight.
5. No supplier payment release while a dispute is open.
6. No expired or cancelled reservation can be collected.
7. Any confirmed price, quantity, or quality change creates an audit record.
8. No open buyer credit until the buyer earns a documented limit.
9. Every route has a backup supplier, buyer, and two verified backup truck-driver pairs.
10. Demo data and simulated integrations must never be presented as live operations.

## 11. Main risks by category

### Commercial

- Buyers may already have trusted traders and see no reason to switch.
- Grade-B savings may disappear after sorting, transport, and rejection.
- Demand may be too inconsistent for route economics.
- Buyers and suppliers may transact outside the platform after introduction.

### Supply and quality

- Grade descriptions may be subjective or dishonest.
- Available quantity and quality change quickly after harvest.
- One supplier creates concentration risk.
- Food-use suitability is different from cosmetic acceptability; spoiled or unsafe produce is never Grade B.

### Logistics

- Small scattered orders create high cost per kilogram.
- Delays increase deterioration and rejection.
- Poor crates, handling, or weighing destroy margin and trust.
- Diversion options may not be available quickly enough.

### Financial

- Buyer credit can consume several good orders' contribution.
- Supplier prepayment and buyer delay create working-capital pressure.
- Volatile prices can invalidate quotations.
- Hidden loss, claims, and return costs can make apparent gross spread meaningless.

### Legal and compliance

- ReHarvest's exact classification for trading, sorting, transporting, storing, and reselling food must be confirmed with Egyptian legal, tax, and food-safety advisers.
- Contracts must define title, risk transfer, grades, tolerances, rejection, cancellation, payment, liability, and traceability.
- Records must support recalls and complaints.

### Product and technology

- The current interface is a simulation with local state, although its economics and guardrails are now tested.
- Incorrect economics could drive loss-making decisions.
- Weak permissions or audit logs could allow disputes or fraud.
- Evidence files, personal data, and payment information require secure handling.
- Overbuilding software before proving operations wastes time and money.

## 12. Alternatives and the recommended choice

| Model | Advantage | Weakness | Decision |
|---|---|---|---|
| Lead-generation marketplace | Low operating burden | Low control, trust, and revenue | Not sufficient alone |
| Broker/agent | Low inventory risk | Lower control and margin | Useful for the first manual tests |
| Managed marketplace | Controls verification and delivery without long storage | Operationally demanding | **Recommended pilot** |
| Buy-and-resell distributor | Higher potential margin | Spoilage, credit, and working-capital risk | Only after repeat demand |
| Procurement subscription | Predictable recurring revenue | Requires proven service reliability | Add after stable repeat orders |
| Open public marketplace | Faster listing growth | Fraud and quality-control risk | Do not launch initially |
| Processing facility | Can absorb surplus | Capital, licensing, hygiene, and production complexity | Much later |

## 13. Pilot scorecard and decision gate

Run the pilot manually with the application supporting the operator. Track:

- Number of confirmed buyers and reorder rate
- Delivered kilograms and route density
- Purchase-to-delivery time
- Supplier fill rate
- Sorting loss and spoilage percentage
- Pickup-to-delivery weight difference
- On-time delivery percentage
- Full, partial, and rejected acceptance rates
- Revenue, complete variable cost, contribution/kg, and contribution margin
- Deposit coverage and days to collect payment
- Claims and diversion recovery
- Operator hours per order

Recommended decision after the first four weeks:

- **Go:** recurring demand, reliable supply, positive contribution after all costs, controlled rejection, and acceptable cash cycle.
- **Continue testing:** interest exists but one or two assumptions remain unproven.
- **Change corridor:** the problem is real but crop, buyer segment, geography, or service level is wrong.
- **Stop:** repeat demand or delivered economics do not work.

Do not expand because people compliment the idea. Expand only because buyers reorder and the final cash result is positive.

## 14. Product build priorities

### Phase 1 — Operational pilot

- Keep the current operator interface.
- Use the corrected shared economics engine and enforced pilot guardrails.
- Use a controlled spreadsheet/WhatsApp fallback.
- Test one tomato corridor with real quotations and small orders.

### Phase 2 — Reliable internal system

- Persistent database and authentication
- Buyers, suppliers, lots, demands, matches, orders, evidence, payments, exceptions, and audit logs
- Server-side economics engine
- Deposits, reservations, weights, partial acceptance, disputes, and diversion
- Operator notifications and exports
- Automated tests for economics and order-state rules

### Phase 3 — Partner access

- Limited buyer demand portal
- Limited supplier availability portal
- Inspector and transport mobile workflows
- Earned credit limits and payment adapter
- Performance and risk scoring

### Phase 4 — Controlled expansion

- Additional buyers in the same corridor
- Additional corridors only after route economics work
- A second crop only after the first is stable
- Subscriptions or procurement contracts for repeat buyers

## 15. Current repository and references

- Private production pilot: https://reharvest-egypt.omar273hf.chatgpt.site
- Editable Figma: https://www.figma.com/design/z82wgMrOptytqxw4nm9Ds1
- GitHub: private repository `abdullahomariko-arch/reharvest-egypt`
- Main interface: `app/reharvest-app.tsx`
- Main styling: `app/globals.css`
- Economics engine: `lib/economics.ts`
- Stress-test runner: `scripts/run-risk-simulation.ts`
- Aggregate diagnostic results: `diagnostics/monte-carlo-results.json`
- Product overview and setup: `README.md`

The repository currently represents a tested decision prototype. It passes type checking, linting, production build validation, eight automated tests, and a production-dependency security audit with zero known vulnerabilities at the time of this report. It is not yet safe to accept live orders, real payments, or legally binding quality evidence because storage, identity, evidence, settlement, and compliance workflows are still unconfigured.

## 16. Final judgment

**Verdict: pilot first.** The opportunity is credible, but success will come from controlling one reliable transaction corridor—not from launching a broad public app.

The first proof is not downloads or signups. It is three to five recurring buyers receiving acceptable tomatoes, suppliers fulfilling what they promised, routes arriving on time, and ReHarvest retaining positive cash contribution after procurement, sorting loss, transport, handling, claims, and payment risk.
