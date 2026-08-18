/**
 * Lot and order tests.
 *
 * The one that earns its keep is the double-sell race at the bottom. Two buyers
 * reserving the last 800kg at the same instant is not a hypothetical — it is
 * what happens when a WhatsApp broadcast goes out and four kitchens tap at once.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  LotService,
  OrderService,
  ServiceError,
  type LotRepo,
  type LotRow,
  type OrderRepo2,
  type OrderRow,
} from './lot-order-service.ts';
import { CRATE_SPECS, type WeightSource } from '@reharvest/core/quantity';

/* ---------------------------------------------------------------- *
 * In-memory repositories.
 *
 * `updateIfVersion` deliberately implements real compare-and-swap so the
 * race test below is meaningful rather than decorative.
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
    async updateIfVersion(lotId, expectedVersion, patch) {
      const cur = lots.get(lotId);
      if (!cur || cur.version !== expectedVersion) return null;
      const next = { ...cur, ...patch, version: cur.version + 1 };
      lots.set(lotId, next);
      return next;
    },
    async findWeighingByKey(key) {
      return weighings.get(key) ?? null;
    },
    async insertWeighing(w) {
      if (weighings.has(w.idempotencyKey)) return;
      weighings.set(w.idempotencyKey, { lotId: w.lotId, netGrams: w.netGrams });
    },
  };

  const orderRepo: OrderRepo2 = {
    async byCode(code) {
      return orders.get(code) ?? null;
    },
    async findByIdempotencyKey(key) {
      const code = orderKeys.get(key);
      return code ? (orders.get(code) ?? null) : null;
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

  return { lotRepo, orderRepo, lots, orders };
}

const clock = { now: () => '2026-08-18T09:00:00Z' };

const goodScale: WeightSource = {
  kind: 'verified-scale',
  scaleId: 'scale-nubaria-01',
  calibrationValidUntil: '2027-06-04T00:00:00Z',
  capturedBy: 'u_inspector',
  capturedAt: '2026-08-18T09:00:00Z',
};

const expiredScale: WeightSource = { ...goodScale, calibrationValidUntil: '2026-01-01T00:00:00Z' } as WeightSource;

async function seedWeighedLot() {
  const r = memoryRepos();
  const lotSvc = new LotService(r.lotRepo, clock);
  const lot = await lotSvc.create({
    supplierId: 'party_nubaria',
    crop: 'tomato',
    grossGrams: 812_500n,
    containerCount: 25,
    packagingSpec: CRATE_SPECS.plastic_standard_v2,
    pricePerKgPiastres: 875n,
    collectBy: '2026-08-21T00:00:00Z',
    createdBy: 'u_supplier',
  });
  const weighed = await lotSvc.recordWeighing({
    lotId: lot.id,
    grossGrams: 812_500n,
    containerCount: 25,
    scale: goodScale,
    capturedBy: 'u_ops',
    actorRoles: ['ops_agent'],
    idempotencyKey: `w:${lot.id}`,
  });
  // Weighed in is not the same as on sale. An inspector must pass it first.
  const passed = await lotSvc.recordInspection({
    lotId: weighed.id,
    checks: { colour: true, damage: true, ferment: true },
    freeze: false,
    inspectorId: 'u_inspector',
    actorRoles: ['inspector'],
    idempotencyKey: `i:${lot.id}`,
  });
  return { ...r, lotSvc, lot: passed, weighed };
}

/* ---------------------------------------------------------------- */

describe('listing a lot', () => {
  test('a new lot has zero sellable weight until it is weighed in', async () => {
    const { lotRepo } = memoryRepos();
    const svc = new LotService(lotRepo, clock);
    const lot = await svc.create({
      supplierId: 'party_nubaria',
      crop: 'tomato',
      grossGrams: 812_500n,
      containerCount: 25,
      packagingSpec: CRATE_SPECS.plastic_standard_v2,
      pricePerKgPiastres: 875n,
      collectBy: '2026-08-21T00:00:00Z',
      createdBy: 'u_supplier',
    });
    // The supplier's claim is not inventory. Only a calibrated weighing is.
    assert.equal(lot.state, 'DECLARED');
    assert.equal(lot.acceptedGrams, 0n);
  });

  test('the wrong crate template is refused at listing', async () => {
    const { lotRepo } = memoryRepos();
    const svc = new LotService(lotRepo, clock);
    await assert.rejects(
      () =>
        svc.create({
          supplierId: 'party_nubaria',
          crop: 'tomato',
          grossGrams: 812_500n,
          containerCount: 1700,
          packagingSpec: CRATE_SPECS.plastic_standard_v2,
          pricePerKgPiastres: 875n,
          collectBy: '2026-08-21T00:00:00Z',
          createdBy: 'u_supplier',
        }),
      (e: any) => e instanceof ServiceError && e.reasonCode === 'QTY_NET_NOT_POSITIVE',
    );
  });

  test('a zero price is refused', async () => {
    const { lotRepo } = memoryRepos();
    const svc = new LotService(lotRepo, clock);
    await assert.rejects(
      () =>
        svc.create({
          supplierId: 'party_nubaria',
          crop: 'tomato',
          grossGrams: 812_500n,
          containerCount: 25,
          packagingSpec: CRATE_SPECS.plastic_standard_v2,
          pricePerKgPiastres: 0n,
          collectBy: '2026-08-21T00:00:00Z',
          createdBy: 'u_supplier',
        }),
      (e: any) => e instanceof ServiceError && e.reasonCode === 'PRICE_NOT_POSITIVE',
    );
  });
});

describe('weighing in', () => {
  test('a calibrated weighing records the weight and queues the lot for inspection', async () => {
    const { weighed } = await seedWeighedLot();
    assert.equal(weighed.acceptedGrams, 800_000n);
    // Crucially NOT available yet. Weight is proven; quality is not.
    assert.equal(weighed.state, 'INSPECTION_PENDING');
  });

  test('passing inspection is what puts a lot on the market', async () => {
    const { lot } = await seedWeighedLot();
    assert.equal(lot.state, 'AVAILABLE');
  });

  test('an expired calibration certificate blocks acceptance', async () => {
    const { lotRepo } = memoryRepos();
    const svc = new LotService(lotRepo, clock);
    const lot = await svc.create({
      supplierId: 'party_nubaria',
      crop: 'tomato',
      grossGrams: 812_500n,
      containerCount: 25,
      packagingSpec: CRATE_SPECS.plastic_standard_v2,
      pricePerKgPiastres: 875n,
      collectBy: '2026-08-21T00:00:00Z',
      createdBy: 'u_supplier',
    });
    await assert.rejects(
      () =>
        svc.recordWeighing({
          lotId: lot.id,
          grossGrams: 812_500n,
          containerCount: 25,
          scale: expiredScale,
          capturedBy: 'u_ops',
          actorRoles: ['ops_agent'],
          idempotencyKey: 'w:1',
        }),
      (e: any) => e instanceof ServiceError && e.reasonCode === 'QTY_SCALE_CALIBRATION_EXPIRED',
    );
  });

  test('the same weighing submitted twice accepts the load once', async () => {
    const { lotSvc, lot } = await seedWeighedLot();
    const before = (await lotSvc.list({}))[0];
    const again = await lotSvc.recordWeighing({
      lotId: lot.id,
      grossGrams: 812_500n,
      containerCount: 25,
      scale: goodScale,
      capturedBy: 'u_ops',
      actorRoles: ['ops_agent'],
      idempotencyKey: `w:${lot.id}`,
    });
    assert.equal(again.acceptedGrams, 800_000n);
    assert.equal(again.version, before.version, 'a replay must not bump the row version');
  });
});

describe('ordering', () => {
  test('an order reserves stock and waits for the deposit', async () => {
    const { lotRepo, orderRepo, lot } = await seedWeighedLot();
    const svc = new OrderService(lotRepo, orderRepo, clock);
    const order = await svc.create({
      buyerId: 'party_cairo_pizza',
      lotId: lot.id,
      quantityGrams: 800_000n,
      idempotencyKey: 'o:1',
    });

    assert.equal(order.state, 'DEPOSIT_PENDING');
    assert.equal(order.totalPiastres, 700_000n); // 800kg x 8.75
    assert.equal(order.depositPiastres, 210_000n); // 30%
    assert.equal((await lotRepo.byId(lot.id))!.reservedGrams, 800_000n);
  });

  test('ordering more than is available is refused', async () => {
    const { lotRepo, orderRepo, lot } = await seedWeighedLot();
    const svc = new OrderService(lotRepo, orderRepo, clock);
    await assert.rejects(
      () => svc.create({ buyerId: 'b', lotId: lot.id, quantityGrams: 900_000n, idempotencyKey: 'o:2' }),
      (e: any) => e instanceof ServiceError && e.reasonCode === 'RESERVATION_EXCEEDS_ATP',
    );
  });

  test('a frozen lot cannot be ordered at all', async () => {
    const { lotRepo, orderRepo, lotSvc, lot } = await seedWeighedLot();
    await lotSvc.recordInspection({
      lotId: lot.id,
      checks: {},
      freeze: true,
      inspectorId: 'u_inspector',
      actorRoles: ['inspector'],
      idempotencyKey: 'i:1',
    });
    const svc = new OrderService(lotRepo, orderRepo, clock);
    await assert.rejects(
      () => svc.create({ buyerId: 'b', lotId: lot.id, quantityGrams: 100_000n, idempotencyKey: 'o:3' }),
      (e: any) => e instanceof ServiceError && e.reasonCode === 'LOT_NOT_TRADEABLE',
    );
  });

  test('a retried order does not reserve twice', async () => {
    const { lotRepo, orderRepo, lot } = await seedWeighedLot();
    const svc = new OrderService(lotRepo, orderRepo, clock);
    const a = await svc.create({ buyerId: 'b', lotId: lot.id, quantityGrams: 400_000n, idempotencyKey: 'o:same' });
    const b = await svc.create({ buyerId: 'b', lotId: lot.id, quantityGrams: 400_000n, idempotencyKey: 'o:same' });

    assert.equal(a.orderCode, b.orderCode);
    assert.equal((await lotRepo.byId(lot.id))!.reservedGrams, 400_000n);
  });

  /**
   * The one that matters. Two kitchens tap "reserve" on the last 800kg in the
   * same tick. Exactly one must win; the other must be told, not quietly given
   * stock that does not exist.
   */
  test('two buyers racing for the last 800kg produce one order, not two', async () => {
    const { lotRepo, orderRepo, lot } = await seedWeighedLot();
    const svc = new OrderService(lotRepo, orderRepo, clock);

    const results = await Promise.allSettled([
      svc.create({ buyerId: 'kitchen_a', lotId: lot.id, quantityGrams: 800_000n, idempotencyKey: 'race:a' }),
      svc.create({ buyerId: 'kitchen_b', lotId: lot.id, quantityGrams: 800_000n, idempotencyKey: 'race:b' }),
    ]);

    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');

    assert.equal(won.length, 1, 'exactly one buyer should get the stock');
    assert.equal(lost.length, 1);

    const reason = (lost[0] as PromiseRejectedResult).reason;
    assert.ok(reason instanceof ServiceError);
    // The loser is told what happened and what to do, not handed a 500.
    assert.ok(['LOT_VERSION_CONFLICT', 'RESERVATION_EXCEEDS_ATP'].includes(reason.reasonCode));

    // And the lot is never over-committed.
    const finalLot = (await lotRepo.byId(lot.id))!;
    assert.equal(finalLot.reservedGrams, 800_000n);
    assert.ok(finalLot.acceptedGrams - finalLot.reservedGrams >= 0n);
  });
});

describe('atomicity', () => {
  /**
   * Regression test for a bug found by running the API against a real Postgres.
   *
   * The reservation used to be a separate write from the order insert. When the
   * insert failed — a foreign key, a constraint, a dropped connection — the
   * reserved weight stayed on the lot. That weight then belonged to no order and
   * was invisible to every future buyer, quietly shrinking the market.
   */
  test('a failed order insert leaves no reserved weight behind', async () => {
    const { lotRepo, orderRepo, lot } = await seedWeighedLot();

    // Simulate exactly what Postgres did: the order write blows up.
    const exploding: OrderRepo2 = {
      ...orderRepo,
      async reserveAndCreateOrder() {
        throw new Error('foreign key violation on orders.buyer_id');
      },
    };

    const svc = new OrderService(lotRepo, exploding, clock);
    await assert.rejects(
      () => svc.create({ buyerId: 'ghost', lotId: lot.id, quantityGrams: 800_000n, idempotencyKey: 'atomic:1' }),
      /foreign key/,
    );

    const after = (await lotRepo.byId(lot.id))!;
    assert.equal(after.reservedGrams, 0n, 'no phantom reservation may survive a failed order');
    assert.equal(after.version, lot.version, 'the lot row must not have moved at all');
  });

  test('the lot is only touched once per successful order', async () => {
    const { lotRepo, orderRepo, lot } = await seedWeighedLot();
    const svc = new OrderService(lotRepo, orderRepo, clock);
    await svc.create({ buyerId: 'b', lotId: lot.id, quantityGrams: 200_000n, idempotencyKey: 'atomic:2' });
    const after = (await lotRepo.byId(lot.id))!;
    assert.equal(after.version, lot.version + 1);
    assert.equal(after.reservedGrams, 200_000n);
  });
});

describe('inspection', () => {
  test('freezing a lot moves unsold weight into held so it cannot be reserved', async () => {
    const { lotRepo, lotSvc, lot } = await seedWeighedLot();
    const frozen = await lotSvc.recordInspection({
      lotId: lot.id,
      checks: {},
      freeze: true,
      inspectorId: 'u_inspector',
      actorRoles: ['inspector'],
      idempotencyKey: 'i:2',
    });
    assert.equal(frozen.state, 'QUARANTINED');
    assert.equal(frozen.heldGrams, 800_000n);
  });
});
