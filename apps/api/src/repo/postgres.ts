/**
 * Postgres repositories.
 *
 * The services depend on ports; this is the real implementation behind them.
 * Two things here are load-bearing:
 *
 * 1. **`updateIfVersion` is a compare-and-swap in SQL**, not a read-then-write
 *    in JavaScript. `WHERE id = $1 AND version = $2` is evaluated by Postgres
 *    under row locks, so two concurrent reservations cannot both succeed. The
 *    application-level check in the service catches the common case early; this
 *    is what actually holds under load.
 *
 * 2. **Weighings are inserted with ON CONFLICT DO NOTHING** on the idempotency
 *    key, so a retry after a timeout is a no-op at the database rather than a
 *    second accepted load.
 *
 * Neither of these is sufficient alone. The CHECK constraint documented in the
 * schema (`accepted - reserved - held - rejected - disposed >= 0`) is the final
 * backstop if both application and CAS logic are somehow bypassed.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import { lots, orders, orderTermVersions, reservations, weighings } from '@reharvest/db/schema';
import type { LotRepo, LotRow, OrderRepo2, OrderRow } from '../service/lot-order-service.ts';
import type { LotState, OrderState } from '@reharvest/core/state-machines';

type Db = PostgresJsDatabase<Record<string, never>>;

export function createLotRepo(db: Db): LotRepo {
  const toRow = (r: typeof lots.$inferSelect): LotRow => {
    return {
      id: r.id,
      lotCode: r.lotCode,
      supplierId: r.supplierId,
      crop: r.crop,
      state: r.state as LotState,
      acceptedGrams: r.acceptedGrams,
      reservedGrams: r.reservedGrams,
      heldGrams: r.heldGrams,
      rejectedGrams: r.rejectedGrams,
      disposedGrams: r.disposedGrams,
      pricePerKgPiastres: r.askPricePerKgPiastres,
      containerCount: r.containerCount,
      collectBy: (r.collectBy ?? r.createdAt).toISOString(),
      listedAt: r.createdAt.toISOString(),
      version: r.version,
    };
  };

  return {
    async list(filter) {
      const where = [];
      if (filter.supplierId) where.push(eq(lots.supplierId, filter.supplierId));
      if (filter.tradeableOnly) {
        where.push(inArray(lots.state, ['AVAILABLE', 'PARTIALLY_RESERVED'] as never));
      }
      const rows = await db
        .select()
        .from(lots)
        .where(where.length ? and(...where) : undefined);
      return rows.map(toRow);
    },

    async byId(lotId) {
      const [r] = await db.select().from(lots).where(eq(lots.id, lotId)).limit(1);
      return r ? toRow(r) : null;
    },

    async insert(row) {
      const [r] = await db
        .insert(lots)
        .values({
          id: row.id,
          lotCode: row.lotCode,
          supplierId: row.supplierId,
          sourceId: row.supplierId,
          crop: row.crop,
          harvestDate: new Date(row.listedAt),
          state: row.state as never,
          acceptedGrams: row.acceptedGrams,
          reservedGrams: row.reservedGrams,
          heldGrams: row.heldGrams,
          rejectedGrams: row.rejectedGrams,
          disposedGrams: row.disposedGrams,
          askPricePerKgPiastres: row.pricePerKgPiastres,
          containerCount: row.containerCount,
          collectBy: new Date(row.collectBy),
        })
        .returning();
      return toRow(r);
    },

    /**
     * Compare-and-swap. Returns null when no row matched, which means the
     * version moved — another agent wrote first and this caller must re-read.
     */
    async updateIfVersion(lotId, expectedVersion, patch) {
      const values: Record<string, unknown> = { version: sql`${lots.version} + 1` };
      if (patch.acceptedGrams !== undefined) values.acceptedGrams = patch.acceptedGrams;
      if (patch.reservedGrams !== undefined) values.reservedGrams = patch.reservedGrams;
      if (patch.heldGrams !== undefined) values.heldGrams = patch.heldGrams;
      if (patch.rejectedGrams !== undefined) values.rejectedGrams = patch.rejectedGrams;
      if (patch.disposedGrams !== undefined) values.disposedGrams = patch.disposedGrams;
      if (patch.state !== undefined) values.state = patch.state;

      const [r] = await db
        .update(lots)
        .set(values as never)
        .where(and(eq(lots.id, lotId), eq(lots.version, expectedVersion)))
        .returning();

      return r ? toRow(r) : null;
    },

    async findWeighingByKey(key) {
      const [r] = await db
        .select({ lotId: weighings.lotId, netGrams: weighings.netGrams })
        .from(weighings)
        .where(eq(weighings.idempotencyKey, key))
        .limit(1);
      return r ?? null;
    },

    async insertWeighing(w) {
      await db
        .insert(weighings)
        .values({
          lotId: w.lotId,
          grossGrams: w.grossGrams,
          tareGrams: w.tareGrams,
          netGrams: w.netGrams,
          scaleId: w.scaleId,
          scaleCalibrationValidUntil: new Date(w.scaleCalibrationValidUntil),
          packagingSpecId: w.packagingSpecId,
          packagingSpecVersion: w.packagingSpecVersion,
          capturedBy: w.capturedBy,
          photoEvidenceId: w.photoEvidenceId,
          idempotencyKey: w.idempotencyKey,
        })
        // A retry after a timeout must be a no-op, not a second accepted load.
        .onConflictDoNothing({ target: weighings.idempotencyKey });
    },
  };
}

export function createOrderRepo(db: Db): OrderRepo2 {
  const toRow = (
    o: typeof orders.$inferSelect,
    terms: typeof orderTermVersions.$inferSelect,
    res: typeof reservations.$inferSelect,
  ): OrderRow => {
    const total = (terms.pricePerKgPiastres * terms.quantityGrams + 500n) / 1000n;
    return {
      id: o.id,
      orderCode: o.orderCode,
      buyerId: o.buyerId,
      lotId: res.lotId,
      state: o.state as OrderState,
      quantityGrams: terms.quantityGrams,
      totalPiastres: total,
      depositPiastres: (total * 3000n + 5000n) / 10000n,
      createdAt: o.createdAt.toISOString(),
    };
  };

  const loadByOrderId = async (orderId: string): Promise<OrderRow | null> => {
    const [o] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!o) return null;
    const [terms] = await db
      .select()
      .from(orderTermVersions)
      .where(eq(orderTermVersions.orderId, o.id))
      .orderBy(sql`${orderTermVersions.version} DESC`)
      .limit(1);
    const [res] = await db.select().from(reservations).where(eq(reservations.orderId, o.id)).limit(1);
    return terms && res ? toRow(o, terms, res) : null;
  };

  return {
    async byCode(orderCode) {
      const [o] = await db.select().from(orders).where(eq(orders.orderCode, orderCode)).limit(1);
      return o ? loadByOrderId(o.id) : null;
    },

    async findByIdempotencyKey(key) {
      // The key is stored on the order itself. A replayed request finds the
      // original order rather than falling through to the reservation logic and
      // being told there is no stock left — stock its own first attempt took.
      const [o] = await db.select().from(orders).where(eq(orders.idempotencyKey, key)).limit(1);
      return o ? loadByOrderId(o.id) : null;
    },

    /**
     * The lot reservation, the order, its terms and the reservation row are all
     * written in a single transaction.
     *
     * The compare-and-swap on `lots.version` happens inside that transaction, so
     * if another buyer won the race the whole thing rolls back and no order
     * exists. Doing the CAS first and the insert second — which is what this
     * used to do — left phantom reserved weight behind on any insert failure.
     */
    async reserveAndCreateOrder({ lotId, expectedVersion, reservedGramsAfter, lotStateAfter, order: row, idempotencyKey }) {
      return db.transaction(async (tx) => {
        const claimed = await tx
          .update(lots)
          .set({
            reservedGrams: reservedGramsAfter,
            state: lotStateAfter as never,
            version: sql`${lots.version} + 1`,
          })
          .where(and(eq(lots.id, lotId), eq(lots.version, expectedVersion)))
          .returning({ id: lots.id });

        // Lost the race. Rolling back is implicit: nothing else runs.
        if (claimed.length === 0) return null;

        await tx.insert(orders).values({
          id: row.id,
          orderCode: row.orderCode,
          buyerId: row.buyerId,
          state: row.state as never,
          idempotencyKey,
        });

        await tx.insert(orderTermVersions).values({
          orderId: row.id,
          version: 1,
          specificationId: row.lotId,
          quantityGrams: row.quantityGrams,
          pricePerKgPiastres: (row.totalPiastres * 1000n) / row.quantityGrams,
          validUntil: new Date(Date.parse(row.createdAt) + 48 * 3_600_000),
          createdBy: row.buyerId,
        });

        await tx.insert(reservations).values({
          orderId: row.id,
          lotId: row.lotId,
          grams: row.quantityGrams,
          // A reservation that is never confirmed must expire, or supply
          // silently disappears from the market while nobody pays for it.
          expiresAt: new Date(Date.parse(row.createdAt) + 48 * 3_600_000),
        });

        return row;
      });
    },
  };
}
