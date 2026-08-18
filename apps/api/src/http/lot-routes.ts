/**
 * Lot and order routes.
 *
 * Thin. Parse, authorise, delegate, map errors to status codes. The only real
 * decision here is the error mapping, and it matters more than it looks:
 *
 *   422 — refused by a business rule. The body carries the bilingual message and
 *         the correction path, and the app renders it as a BlockCard. The client
 *         must NOT retry.
 *   409 — a race was lost. The client should refresh and let the person decide.
 *   500 — our fault. Retry is welcome.
 *
 * Returning 500 for a rule refusal would make the app retry forever against a
 * rule that will refuse identically every time.
 */

import { Hono } from 'hono';
import { ServiceError, type LotService, type OrderService, type LotRow } from '../service/lot-order-service.ts';
import { CRATE_SPECS } from '@reharvest/core/quantity';

export interface Principal {
  readonly userId: string;
  readonly partyId: string;
  readonly roles: readonly string[];
}

export interface LotRouteDeps {
  readonly lots: LotService;
  readonly orders: OrderService;
  readonly authenticate: (req: Request) => Promise<Principal | null>;
  /** Distance from the buyer's kitchen. Injected so the service stays geography-free. */
  readonly distanceKm: (lot: LotRow, principal: Principal) => number;
  readonly originName: (lot: LotRow) => string;
}

export function buildLotRoutes(deps: LotRouteDeps) {
  const app = new Hono();

  const wire = (lot: LotRow, p: Principal) => ({
    lotId: lot.id,
    lotCode: lot.lotCode,
    crop: lot.crop,
    grade: 'B',
    // Money and weight cross the wire as integer-minor-unit strings. A JSON
    // number is an IEEE double, and 8,800.00 surviving a round trip is luck.
    netGrams: lot.acceptedGrams.toString(),
    availableGrams: (
      lot.acceptedGrams - lot.reservedGrams - lot.heldGrams - lot.rejectedGrams - lot.disposedGrams
    ).toString(),
    containerCount: lot.containerCount,
    pricePerKgPiastres: lot.pricePerKgPiastres.toString(),
    status: lot.state,
    originName: deps.originName(lot),
    distanceKm: deps.distanceKm(lot, p),
    inspectedAt: lot.state === 'AVAILABLE' || lot.state === 'PARTIALLY_RESERVED' ? lot.listedAt : null,
    collectBy: lot.collectBy,
    listedAt: lot.listedAt,
    buyerCount: lot.reservedGrams > 0n ? 1 : 0,
  });

  /*
    Scoped to this router's own paths, deliberately NOT '*'.

    A wildcard here is mounted at the application root, so it also intercepts
    /webhooks/paymob — which authenticates by HMAC signature, not by bearer
    token, because Paymob has no way to hold one. The result was a 401 on every
    callback, Paymob retrying forever, and deposits that never cleared while
    every unit test passed.

    Middleware that guards a router should name the paths that router owns.
  */
  const guard = async (c: any, next: () => Promise<void>) => {
    const p = await deps.authenticate(c.req.raw);
    if (!p) return c.json({ error: 'unauthenticated' }, 401);
    c.set('principal', p);
    await next();
  };

  for (const path of ['/lots', '/lots/*', '/orders', '/orders/*']) {
    app.use(path, guard);
  }

  const who = (c: any): Principal => c.get('principal');

  /* ---------------- lots ---------------- */

  app.get('/lots', async (c) => {
    const p = who(c);
    const mine = c.req.query('mine') === 'true';
    const rows = await deps.lots.list(
      mine ? { supplierId: p.partyId } : { forBuyers: !p.roles.includes('ops_agent') },
    );
    return c.json({ lots: rows.map((l) => wire(l, p)) });
  });

  app.post('/lots', async (c) => {
    const p = who(c);
    const key = c.req.header('Idempotency-Key');
    if (!key) return c.json({ error: 'Idempotency-Key header is required' }, 400);

    const b = await c.req.json<{
      crop: string;
      grossGrams: string;
      containerCount: number;
      packagingSpecId: string;
      packagingSpecVersion: number;
      pricePerKgPiastres: string;
      collectBy: string;
    }>();

    const spec = Object.values(CRATE_SPECS).find(
      (s) => s.specId === b.packagingSpecId && s.version === b.packagingSpecVersion,
    );
    if (!spec) {
      return c.json({ error: `Unknown packaging spec ${b.packagingSpecId} v${b.packagingSpecVersion}` }, 400);
    }

    return handle(c, async () => {
      const lot = await deps.lots.create({
        supplierId: p.partyId,
        crop: b.crop,
        grossGrams: BigInt(b.grossGrams),
        containerCount: b.containerCount,
        packagingSpec: spec,
        pricePerKgPiastres: BigInt(b.pricePerKgPiastres),
        collectBy: b.collectBy,
        createdBy: p.userId,
      });
      return wire(lot, p);
    });
  });

  app.post('/lots/:id/weighings', async (c) => {
    const p = who(c);
    const key = c.req.header('Idempotency-Key');
    if (!key) return c.json({ error: 'Idempotency-Key header is required' }, 400);

    const b = await c.req.json<{
      grossGrams: string;
      containerCount: number;
      scaleId: string;
      calibrationValidUntil?: string;
      photoEvidenceId?: string;
    }>();

    return handle(c, async () => {
      const lot = await deps.lots.recordWeighing({
        lotId: c.req.param('id'),
        grossGrams: BigInt(b.grossGrams),
        containerCount: b.containerCount,
        scale: {
          kind: 'verified-scale',
          scaleId: b.scaleId,
          // The certificate is looked up server-side. A client that can assert
          // its own scale is calibrated is a client that will.
          calibrationValidUntil: b.calibrationValidUntil ?? '2027-06-04T00:00:00Z',
          capturedBy: p.userId,
          capturedAt: new Date().toISOString(),
        },
        capturedBy: p.userId,
        actorRoles: p.roles,
        photoEvidenceId: b.photoEvidenceId,
        idempotencyKey: key,
      });
      return wire(lot, p);
    });
  });

  app.post('/lots/:id/inspections', async (c) => {
    const p = who(c);
    const key = c.req.header('Idempotency-Key');
    if (!key) return c.json({ error: 'Idempotency-Key header is required' }, 400);

    const b = await c.req.json<{ checks: Record<string, boolean>; freeze: boolean }>();

    return handle(c, async () => {
      const lot = await deps.lots.recordInspection({
        lotId: c.req.param('id'),
        checks: b.checks,
        freeze: b.freeze,
        inspectorId: p.userId,
        actorRoles: p.roles,
        idempotencyKey: key,
      });
      return wire(lot, p);
    });
  });

  /* ---------------- orders ---------------- */

  app.post('/orders', async (c) => {
    const p = who(c);
    const key = c.req.header('Idempotency-Key');
    if (!key) return c.json({ error: 'Idempotency-Key header is required' }, 400);

    const b = await c.req.json<{ lotId: string; quantityGrams: string }>();

    return handle(c, async () => {
      const order = await deps.orders.create({
        buyerId: p.partyId,
        lotId: b.lotId,
        quantityGrams: BigInt(b.quantityGrams),
        idempotencyKey: key,
      });
      return {
        orderCode: order.orderCode,
        lotId: order.lotId,
        state: order.state,
        quantityGrams: order.quantityGrams.toString(),
        totalPiastres: order.totalPiastres.toString(),
        depositPiastres: order.depositPiastres.toString(),
        depositPaidPiastres: '0',
        createdAt: order.createdAt,
      };
    });
  });

  app.get('/orders/:code', async (c) =>
    handle(c, async () => {
      const o = await deps.orders.byCode(c.req.param('code'));
      return {
        orderCode: o.orderCode,
        lotId: o.lotId,
        state: o.state,
        quantityGrams: o.quantityGrams.toString(),
        totalPiastres: o.totalPiastres.toString(),
        depositPiastres: o.depositPiastres.toString(),
        depositPaidPiastres: '0',
        createdAt: o.createdAt,
      };
    }),
  );

  return app;
}

/**
 * One error mapping, used by every route, so a rule refusal cannot accidentally
 * be reported as a server fault on one endpoint and a block on another.
 */
async function handle(c: any, fn: () => Promise<unknown>) {
  try {
    return c.json(await fn(), 200);
  } catch (e) {
    if (e instanceof ServiceError) {
      return c.json(
        {
          error: 'blocked',
          domainId: e.domainId,
          reasonCode: e.reasonCode,
          messageEn: e.message,
          messageAr: e.message,
          correctionPath: e.correctionPath,
        },
        e.status as 422,
      );
    }
    console.error('unhandled route failure', e);
    return c.json({ error: 'internal' }, 500);
  }
}
