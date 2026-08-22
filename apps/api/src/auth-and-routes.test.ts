/**
 * Auth and route-level tests.
 *
 * These drive the real Hono app through `app.request()`, so they cover the
 * layer the mobile client actually talks to: headers, status codes, and the
 * shape of the block payload the app renders as a BlockCard.
 *
 * The status codes are the point. A rule refusal must be 422 and must not be
 * retried; a lost race must be 409 and should be; a server fault must be 500.
 * Getting this wrong means an app that either retries forever against a rule
 * that will never pass, or silently drops a payment that only needed a retry.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { issueToken, verifyToken, AuthError, makeAuthenticator, requireRole } from './auth.ts';
import { buildLotRoutes } from './http/lot-routes.ts';
import { LotService, OrderService } from './service/lot-order-service.ts';
import { CRATE_SPECS } from '@reharvest/core/quantity';
import { scopeKey, hashRequest } from './repo/idempotency.ts';
import type { LotRepo, LotRow, OrderRepo2, OrderRow } from './service/lot-order-service.ts';

const SECRET = 'test-signing-secret';

const supplier = {
  userId: '00000000-0000-4000-8000-000000000001',
  partyId: '11111111-1111-4111-8111-111111111111',
  roles: ['supplier', 'ops_agent'],
  displayName: 'عبدالله عمر',
};

const buyer = {
  userId: '00000000-0000-4000-8000-000000000002',
  partyId: '22222222-2222-4222-8222-222222222221',
  roles: ['buyer'],
  displayName: 'مطاعم القاهرة',
};
const inspector = {
  userId: '00000000-0000-4000-8000-000000000003',
  partyId: '33333333-3333-4333-8333-333333333333',
  roles: ['inspector'],
  displayName: 'فاطمة حسن',
};

/* ---------------------------------------------------------------- */

describe('tokens', () => {
  test('a token round-trips to the same principal', async () => {
    const t = await issueToken(supplier, SECRET);
    const p = await verifyToken(t, SECRET);
    assert.equal(p.userId, supplier.userId);
    assert.deepEqual([...p.roles], ['supplier', 'ops_agent']);
  });

  test('a token signed with a different secret is rejected', async () => {
    const t = await issueToken(supplier, 'some-other-secret');
    await assert.rejects(() => verifyToken(t, SECRET), (e: any) => e instanceof AuthError && e.reason === 'bad_signature');
  });

  test('editing the payload invalidates the signature', async () => {
    const t = await issueToken(buyer, SECRET);
    const [h, , s] = t.split('.');
    // The classic attack: swap the body for one claiming finance rights.
    const forged = Buffer.from(
      JSON.stringify({ ...buyer, roles: ['finance'], exp: 9_999_999_999, iat: 0 }),
    ).toString('base64url');
    await assert.rejects(
      () => verifyToken(`${h}.${forged}.${s}`, SECRET),
      (e: any) => e instanceof AuthError && e.reason === 'bad_signature',
    );
  });

  test('a friendly, non-UUID user id is refused', async () => {
    // These reach uuid columns. Rejecting at the boundary turns what was a 500
    // on the weighing endpoint into a clean 401.
    const t = await issueToken({ ...supplier, userId: 'u_supplier' }, SECRET);
    await assert.rejects(() => verifyToken(t, SECRET), (e: any) => e instanceof AuthError && e.reason === 'malformed');
  });

  test('an expired token is refused even though the signature is valid', async () => {
    const t = await issueToken(supplier, SECRET, -60);
    await assert.rejects(() => verifyToken(t, SECRET), (e: any) => e instanceof AuthError && e.reason === 'expired');
  });

  test('role checks read the signed payload, not a header', () => {
    assert.equal(requireRole(supplier, 'ops_agent'), true);
    assert.equal(requireRole(buyer, 'finance'), false);
  });
});

/* ---------------------------------------------------------------- *
 * Route tests
 * ---------------------------------------------------------------- */

function memoryRepos() {
  const lots = new Map<string, LotRow>();
  const weighings = new Map<string, { lotId: string; netGrams: bigint }>();
  const orders = new Map<string, OrderRow>();
  const orderKeys = new Map<string, string>();

  const lotRepo: LotRepo = {
    async list({ supplierId }) {
      return [...lots.values()].filter((l) => !supplierId || l.supplierId === supplierId);
    },
    async byId(id) {
      return lots.get(id) ?? null;
    },
    async insert(row) {
      const full = { ...row, version: 1 };
      lots.set(full.id, full);
      return full;
    },
    async updateIfVersion(id, v, patch) {
      const cur = lots.get(id);
      if (!cur || cur.version !== v) return null;
      const next = { ...cur, ...patch, version: cur.version + 1 };
      lots.set(id, next);
      return next;
    },
    async findWeighingByKey(k) {
      return weighings.get(k) ?? null;
    },
    async insertWeighing(w) {
      if (!weighings.has(w.idempotencyKey)) weighings.set(w.idempotencyKey, { lotId: w.lotId, netGrams: w.netGrams });
    },
  };

  const orderRepo: OrderRepo2 = {
    async byCode(c) {
      return orders.get(c) ?? null;
    },
    async findByIdempotencyKey(k) {
      const c = orderKeys.get(k);
      return c ? (orders.get(c) ?? null) : null;
    },
    async reserveAndCreateOrder({ lotId, expectedVersion, reservedGramsAfter, lotStateAfter, order, idempotencyKey }) {
      // Mirrors the real transaction: if the compare-and-swap fails, no order
      // is written at all.
      const cur = lots.get(lotId);
      if (!cur || cur.version !== expectedVersion) return null;
      lots.set(lotId, { ...cur, reservedGrams: reservedGramsAfter, state: lotStateAfter, version: cur.version + 1 });
      orders.set(order.orderCode, order);
      orderKeys.set(idempotencyKey, order.orderCode);
      return order;
    },
  };

  return { lotRepo, orderRepo };
}

/**
 * An in-memory stand-in for the Postgres idempotency store, implementing the
 * same reserve/complete contract. The real store is exercised against Postgres
 * and through HTTP in the integration tests; this keeps the route tests fast.
 */
function memoryIdempotency() {
  const rows = new Map<string, { hash: string; state: 'IN_PROGRESS' | 'COMPLETED'; response?: { status: number; body: unknown }; at: string }>();
  return {
    async reserve(scope: any, body: unknown) {
      const key = scopeKey(scope);
      const hash = hashRequest(scope.path, body);
      const row = rows.get(key);
      if (!row) {
        rows.set(key, { hash, state: 'IN_PROGRESS', at: new Date().toISOString() });
        return { kind: 'reserved' as const, scopedKey: key };
      }
      if (row.hash !== hash) return { kind: 'conflict' as const, reason: 'different request' };
      if (row.state === 'COMPLETED') return { kind: 'completed' as const, response: row.response! };
      return { kind: 'in_progress' as const, startedAt: row.at };
    },
    async complete(key: string, response: { status: number; body: unknown }) {
      const row = rows.get(key);
      if (row) rows.set(key, { ...row, state: 'COMPLETED', response });
    },
    async release(key: string) {
      rows.delete(key);
    },
    async sweep() {
      return 0;
    },
  };
}

function buildApp() {
  const { lotRepo, orderRepo } = memoryRepos();
  const clock = { now: () => '2026-08-18T09:00:00Z' };
  const app = buildLotRoutes({
    lots: new LotService(lotRepo, clock),
    orders: new OrderService(lotRepo, orderRepo, clock),
    authenticate: makeAuthenticator(SECRET),
    idempotency: memoryIdempotency() as never,
    distanceKm: () => 28,
    originName: () => 'محطة فرز النوبارية',
  });
  return { app, lotRepo };
}

async function authed(
  app: ReturnType<typeof buildApp>['app'],
  principal: typeof supplier,
  path: string,
  init: { method?: string; body?: unknown; key?: string } = {},
) {
  const token = await issueToken(principal, SECRET);
  return app.request(path, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.key ? { 'Idempotency-Key': init.key } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
}

const goodLot = {
  crop: 'tomato',
  grossGrams: '812500',
  containerCount: 25,
  packagingSpecId: 'plastic_standard',
  packagingSpecVersion: 2,
  pricePerKgPiastres: '875',
  collectBy: '2026-08-21T00:00:00Z',
};

describe('routes — authentication', () => {
  test('no token is 401, not 500', async () => {
    const { app } = buildApp();
    const res = await app.request('/lots');
    assert.equal(res.status, 401);
  });

  test('a forged token is 401', async () => {
    const { app } = buildApp();
    const res = await app.request('/lots', { headers: { Authorization: 'Bearer not.a.token' } });
    assert.equal(res.status, 401);
  });
});

describe('routes — lots', () => {
  test('a mutation without an idempotency key is refused', async () => {
    const { app } = buildApp();
    const res = await authed(app, supplier, '/lots', { method: 'POST', body: goodLot });
    assert.equal(res.status, 400);
  });

  test('a valid listing returns wire types as strings, not numbers', async () => {
    const { app } = buildApp();
    const res = await authed(app, supplier, '/lots', { method: 'POST', body: goodLot, key: 'k1' });
    assert.equal(res.status, 200);
    const body = await res.json();

    // Money and weight must survive JSON without becoming doubles.
    assert.equal(typeof body.pricePerKgPiastres, 'string');
    assert.equal(typeof body.netGrams, 'string');
    assert.equal(body.status, 'DECLARED');
    assert.equal(body.netGrams, '0', 'a declared lot has no accepted weight yet');
  });

  test('the wrong crate template comes back as a 422 block the app can render', async () => {
    const { app } = buildApp();
    const res = await authed(app, supplier, '/lots', {
      method: 'POST',
      body: { ...goodLot, containerCount: 1700 },
      key: 'k2',
    });

    assert.equal(res.status, 422, 'a rule refusal must not be retried');
    const b = await res.json();
    assert.equal(b.error, 'blocked');
    assert.equal(b.domainId, 'D34');
    assert.equal(b.reasonCode, 'QTY_NET_NOT_POSITIVE');
    // The correction path is what makes the refusal actionable rather than a wall.
    assert.ok(b.correctionPath.length > 0);
  });

  test('an unknown packaging spec is a 400, not a silent default', async () => {
    const { app } = buildApp();
    const res = await authed(app, supplier, '/lots', {
      method: 'POST',
      body: { ...goodLot, packagingSpecVersion: 99 },
      key: 'k3',
    });
    assert.equal(res.status, 400);
  });
});

describe('routes — the full intake path', () => {
  test('list, weigh, inspect, then order', async () => {
    const { app } = buildApp();

    const created = await (await authed(app, supplier, '/lots', { method: 'POST', body: goodLot, key: 'c1' })).json();

    // Weighing proves the weight but does not put the lot on sale.
    const weighed = await (
      await authed(app, supplier, `/lots/${created.lotId}/weighings`, {
        method: 'POST',
        body: { grossGrams: '812500', containerCount: 25, scaleId: 'scale-01' },
        key: 'w1',
      })
    ).json();
    assert.equal(weighed.netGrams, '800000');
    assert.equal(weighed.status, 'INSPECTION_PENDING');

    // A buyer cannot order it yet.
    const tooEarly = await authed(app, buyer, '/orders', {
      method: 'POST',
      body: { lotId: created.lotId, quantityGrams: '800000' },
      key: 'o0',
    });
    assert.equal(tooEarly.status, 422);
    assert.equal((await tooEarly.json()).reasonCode, 'LOT_NOT_YET_SELLABLE');

    // Inspection is what opens the market.
    const passed = await (
      await authed(app, inspector, `/lots/${created.lotId}/inspections`, {
        method: 'POST',
        body: { checks: { colour: true }, freeze: false },
        key: 'i1',
      })
    ).json();
    assert.equal(passed.status, 'AVAILABLE');

    const ordered = await authed(app, buyer, '/orders', {
      method: 'POST',
      body: { lotId: created.lotId, quantityGrams: '800000' },
      key: 'o1',
    });
    assert.equal(ordered.status, 200);
    const order = await ordered.json();
    assert.equal(order.totalPiastres, '700000');
    assert.equal(order.depositPiastres, '210000');
    assert.equal(order.state, 'DEPOSIT_PENDING', 'interest is not demand');
  });

  test('quarantining a lot removes it from the buyer market entirely', async () => {
    const { app } = buildApp();
    const created = await (await authed(app, supplier, '/lots', { method: 'POST', body: goodLot, key: 'c2' })).json();
    await authed(app, supplier, `/lots/${created.lotId}/weighings`, {
      method: 'POST',
      body: { grossGrams: '812500', containerCount: 25, scaleId: 'scale-01' },
      key: 'w2',
    });
    await authed(app, inspector, `/lots/${created.lotId}/inspections`, {
      method: 'POST',
      body: { checks: { colour: true }, freeze: false },
      key: 'i2',
    });

    const frozen = await (
      await authed(app, inspector, `/lots/${created.lotId}/inspections`, {
        method: 'POST',
        body: { checks: {}, freeze: true },
        key: 'i3',
      })
    ).json();
    assert.equal(frozen.status, 'QUARANTINED');

    // Gone from the buyer's market list.
    const market = await (await authed(app, buyer, '/lots', {})).json();
    assert.equal(market.lots.length, 0);

    // And refused if a stale client tries to order it anyway.
    const res = await authed(app, buyer, '/orders', {
      method: 'POST',
      body: { lotId: created.lotId, quantityGrams: '100000' },
      key: 'o2',
    });
    assert.equal(res.status, 422);
    assert.equal((await res.json()).domainId, 'D31');
  });
});
