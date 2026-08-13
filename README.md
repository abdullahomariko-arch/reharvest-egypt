# ReHarvest Egypt Pilot

ReHarvest is a managed B2B marketplace pilot for redirecting usable Grade-B and surplus produce into Egyptian food businesses. The operating model is demand-first: confirm buyer need, match a verified lot, inspect quality, approve landed economics, and control delivery evidence.

For the complete business model, operating risks, unit economics, pilot scorecard, and product roadmap, read [PROJECT_MASTER_SUMMARY.md](PROJECT_MASTER_SUMMARY.md).

## Pilot workflow

- Post confirmed demand from restaurants, central kitchens, juice producers, or processors.
- Review verified supplier lots by match confidence, usable yield, price, location, and pickup date.
- Reserve a lot only after the landed-cost and margin view is acceptable.
- Track quality evidence, freight status, weight slips, and buyer acceptance.
- Start with one corridor and one crop before expanding working capital.

The included interface contains realistic Egypt-focused demonstration data. User actions are held in local React state for pilot review; they are not yet a durable multi-user transaction backend.

## Stack

- React 19 and TypeScript
- Next-compatible Vinext runtime on Vite
- Cloudflare/Sites deployment target
- Responsive, dependency-light UI implemented in `app/reharvest-app.tsx` and `app/globals.css`

## Run locally

Requires Node.js 22.13 or newer.

```bash
npm ci
npm run dev
```

Quality checks:

```bash
npm run diagnostics
npm run typecheck
npm run lint
npm test
npm audit --omit=dev
```

`npm run diagnostics` runs a seeded 100,000-scenario operating and unit-economics stress test. Its aggregate results are stored in `diagnostics/monte-carlo-results.json`; the assumptions are deliberately broad stress inputs, not measured market forecasts.

## Production-readiness gate

Before accepting live orders, configure persistent D1/R2 storage, authenticated operator roles, server-side validation, audit logging, notification integrations, and a tested settlement/refund process. Validate the operating model with one supplier corridor and three to five recurring buyers before scaling inventory or transport commitments.
