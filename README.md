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
npm run lint
npm run build
```

## Production-readiness gate

Before accepting live orders, add persistent storage, authenticated operator roles, server-side validation, audit logging, notification integrations, and a tested settlement/refund process. Validate the operating model with one supplier corridor and three to five recurring buyers before scaling inventory or transport commitments.
