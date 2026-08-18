/**
 * Lot and order services.
 *
 * The business logic behind every screen that is not payments. It depends on a
 * repository *port* rather than on Drizzle directly, for one practical reason:
 * the double-sell test below has to be able to simulate two agents reserving the
 * same lot in the same millisecond, and that is far easier against an in-memory
 * repo than against a real Postgres transaction.
 *
 * The rules that matter here:
 *
 *   D14/D09 — a reservation may never take available-to-promise below zero.
 *             Checked in the application layer *and* by a CHECK constraint in
 *             the database, because the application layer loses races.
 *
 *   D34/D26 — settlement weight comes from a calibrated scale, and net is
 *             derived, never entered.
 *
 *   D31     — a frozen lot is not tradeable by anyone, at any level.
 */

import { Money, egp } from '@reharvest/core/money';
import {
  Qty,
  grams,
  netFromGross,
  assertSettlementWeight,
  CRATE_SPECS,
  QuantityError,
  type Quantity,
  type PackagingSpec,
  type WeightSource,
} from '@reharvest/core/quantity';
import { assertReservable, availableToPromise, InvariantViolation } from '@reharvest/core/invariants';
import {
  assertLotIsTradeable,
  lotMachine,
  FROZEN_LOT_STATES,
  type LotState,
  type OrderState,
  type Role,
} from '@reharvest/core/state-machines';

/** Every role the state machine recognises. Anything else is not a role. */
const KNOWN_ROLES: readonly Role[] = [
  'supplier', 'buyer', 'inspector', 'ops_agent', 'ops_manager',
  'finance', 'food_safety_officer', 'executive',
];

/**
 * Roles arrive from a token as plain strings. Narrowing them here, once, at the
 * boundary means an unrecognised role silently grants nothing rather than being
 * cast into the type system and trusted downstream.
 */
export function parseRoles(raw: readonly string[]): readonly Role[] {
  return raw.filter((r): r is Role => (KNOWN_ROLES as readonly string[]).includes(r));
}

/** States from which a buyer may reserve. Anything else is not on the market yet. */
const SELLABLE_STATES: readonly LotState[] = ['AVAILABLE', 'PARTIALLY_RESERVED'];

/* ------------------------------------------------------------------ *
 * Ports
 * ------------------------------------------------------------------ */

export interface LotRow {
  readonly id: string;
  readonly lotCode: string;
  readonly supplierId: string;
  readonly crop: string;
  readonly state: LotState;
  readonly acceptedGrams: bigint;
  readonly reservedGrams: bigint;
  readonly heldGrams: bigint;
  readonly rejectedGrams: bigint;
  readonly disposedGrams: bigint;
  readonly pricePerKgPiastres: bigint;
  readonly containerCount: number;
  readonly collectBy: string;
  readonly listedAt: string;
  readonly version: number;
}

export interface OrderRow {
  readonly id: string;
  readonly orderCode: string;
  readonly buyerId: string;
  readonly lotId: string;
  readonly state: OrderState;
  readonly quantityGrams: bigint;
  readonly totalPiastres: bigint;
  readonly depositPiastres: bigint;
  readonly createdAt: string;
}

export interface LotRepo {
  list(filter: { supplierId?: string; tradeableOnly?: boolean }): Promise<LotRow[]>;
  byId(lotId: string): Promise<LotRow | null>;
  insert(row: Omit<LotRow, 'version'>): Promise<LotRow>;
  /**
   * Compare-and-swap on `version`. Returns null when the row moved underneath
   * us, which is the signal that another agent reserved from the same lot.
   */
  updateIfVersion(lotId: string, expectedVersion: number, patch: Partial<LotRow>): Promise<LotRow | null>;
  findWeighingByKey(key: string): Promise<{ lotId: string; netGrams: bigint } | null>;
  insertWeighing(w: {
    lotId: string;
    grossGrams: bigint;
    tareGrams: bigint;
    netGrams: bigint;
    scaleId: string;
    scaleCalibrationValidUntil: string;
    packagingSpecId: string;
    packagingSpecVersion: number;
    capturedBy: string;
    photoEvidenceId?: string;
    idempotencyKey: string;
  }): Promise<void>;
}

export interface OrderRepo2 {
  byCode(orderCode: string): Promise<OrderRow | null>;
  findByIdempotencyKey(key: string): Promise<OrderRow | null>;
  insert(row: OrderRow, idempotencyKey: string): Promise<OrderRow>;
}

export interface Clock {
  now(): string;
}

export class ServiceError extends Error {
  constructor(
    message: string,
    readonly reasonCode: string,
    readonly domainId: string,
    readonly correctionPath: string,
    readonly status = 422,
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}

/** Deposit is 30% of order value. One constant, not a scatter of literals. */
export const DEPOSIT_BPS = 3000n;

/* ------------------------------------------------------------------ *
 * Lots
 * ------------------------------------------------------------------ */

export class LotService {
  constructor(
    private readonly repo: LotRepo,
    private readonly clock: Clock,
  ) {}

  async list(opts: { supplierId?: string; forBuyers?: boolean }): Promise<LotRow[]> {
    const rows = await this.repo.list({
      supplierId: opts.supplierId,
      tradeableOnly: !!opts.forBuyers,
    });

    // A buyer must never be shown a frozen lot, even briefly, even if a filter
    // upstream was wrong. Belt and braces on the one rule with no override.
    // A buyer must never see a held, quarantined, disposed or expired lot, even
    // briefly, even if a filter upstream was wrong.
    return opts.forBuyers ? rows.filter((r) => SELLABLE_STATES.includes(r.state)) : rows;
  }

  async create(input: {
    supplierId: string;
    crop: string;
    grossGrams: bigint;
    containerCount: number;
    packagingSpec: PackagingSpec;
    pricePerKgPiastres: bigint;
    collectBy: string;
    createdBy: string;
  }): Promise<LotRow> {
    let net: Quantity;
    try {
      net = netFromGross(grams(input.grossGrams), input.packagingSpec, input.containerCount);
    } catch (e) {
      if (e instanceof QuantityError) {
        throw new ServiceError(e.message, e.reasonCode, 'D34', 'Re-weigh with the correct crate template.');
      }
      throw e;
    }

    if (input.pricePerKgPiastres <= 0n) {
      throw new ServiceError(
        'A lot cannot be listed at zero or negative price.',
        'PRICE_NOT_POSITIVE',
        'D24',
        'Enter the price you want per kilo before listing.',
      );
    }

    const now = this.clock.now();

    // A lot enters as DECLARED, not ACCEPTED. Declared weight is the supplier's
    // claim; it becomes accepted weight only after an inspector weighs it on a
    // calibrated scale. Listing does not create sellable inventory (D26).
    return this.repo.insert({
      id: crypto.randomUUID(),
      lotCode: lotCode(input.crop, now),
      supplierId: input.supplierId,
      crop: input.crop,
      state: 'DECLARED',
      acceptedGrams: 0n,
      reservedGrams: 0n,
      heldGrams: 0n,
      rejectedGrams: 0n,
      disposedGrams: 0n,
      pricePerKgPiastres: input.pricePerKgPiastres,
      containerCount: input.containerCount,
      collectBy: input.collectBy,
      listedAt: now,
    });
  }

  /**
   * The weighing that turns a supplier's claim into inventory the platform can
   * sell. Idempotent on the key: a retry after a timeout returns the original
   * result rather than accepting the load twice.
   */
  async recordWeighing(input: {
    lotId: string;
    grossGrams: bigint;
    containerCount: number;
    scale: WeightSource;
    packagingSpec?: PackagingSpec;
    capturedBy: string;
    actorRoles: readonly string[];
    photoEvidenceId?: string;
    idempotencyKey: string;
  }): Promise<LotRow> {
    const existing = await this.repo.findWeighingByKey(input.idempotencyKey);
    if (existing) {
      const lot = await this.repo.byId(existing.lotId);
      if (lot) return lot;
    }

    const lot = await this.repo.byId(input.lotId);
    if (!lot) throw new ServiceError('Unknown lot.', 'LOT_NOT_FOUND', 'D51', 'Refresh and try again.', 404);

    // A frozen lot cannot be weighed into inventory. This is the food-safety
    // stop, and it has no override at any level.
    try {
      assertLotIsTradeable(lot.state, lot.lotCode);
    } catch (e) {
      throw new ServiceError(
        (e as Error).message,
        'LOT_NOT_TRADEABLE',
        'D31',
        'A qualified inspector must clear this lot in person before it can move.',
      );
    }

    try {
      assertSettlementWeight(input.scale);
    } catch (e) {
      const err = e as QuantityError;
      throw new ServiceError(
        err.message,
        err.reasonCode,
        'D26',
        'Use the station’s approved scale, with a valid calibration certificate.',
      );
    }

    const spec = input.packagingSpec ?? CRATE_SPECS.plastic_standard_v2;
    let net: Quantity;
    try {
      net = netFromGross(grams(input.grossGrams), spec, input.containerCount);
    } catch (e) {
      const err = e as QuantityError;
      throw new ServiceError(err.message, err.reasonCode, 'D34', 'Check the crate template and the scale zero.');
    }

    await this.repo.insertWeighing({
      lotId: lot.id,
      grossGrams: input.grossGrams,
      tareGrams: input.grossGrams - net.value,
      netGrams: net.value,
      scaleId: input.scale.kind === 'verified-scale' ? input.scale.scaleId : 'unknown',
      scaleCalibrationValidUntil:
        input.scale.kind === 'verified-scale' ? input.scale.calibrationValidUntil : this.clock.now(),
      packagingSpecId: spec.specId,
      packagingSpecVersion: spec.version,
      capturedBy: input.capturedBy,
      photoEvidenceId: input.photoEvidenceId,
      idempotencyKey: input.idempotencyKey,
    });

    /*
      Intake is two machine steps, not one. Weighing a load proves the source is
      real (verify_source) and puts it in the inspection queue
      (submit_for_inspection). It does NOT make the lot sellable — that needs a
      completed sample plan, which is the inspector's job on the next screen.
    */
    const ctx = {
      actorId: input.capturedBy,
      actorRoles: parseRoles(input.actorRoles),
      at: this.clock.now(),
      actorCreatedRecord: false,
      idempotencyKey: input.idempotencyKey,
      reasons: ['verified_scale'],
    };

    let nextState = lot.state;
    try {
      if (nextState === 'DECLARED') nextState = lotMachine.next(nextState, 'verify_source', ctx);
      if (nextState === 'SOURCE_VERIFIED') nextState = lotMachine.next(nextState, 'submit_for_inspection', ctx);
    } catch (e) {
      throw new ServiceError(
        (e as Error).message,
        'LOT_TRANSITION_DENIED',
        'D30',
        'Intake weighing is recorded by an ops agent at the packing station.',
      );
    }

    const updated = await this.repo.updateIfVersion(lot.id, lot.version, {
      acceptedGrams: net.value,
      state: nextState,
    });

    if (!updated) {
      throw new ServiceError(
        'This lot changed while the weighing was being recorded.',
        'LOT_VERSION_CONFLICT',
        'D39',
        'Refresh the lot and record the weighing again.',
        409,
      );
    }
    return updated;
  }

  async recordInspection(input: {
    lotId: string;
    checks: Record<string, boolean>;
    /** True when the inspector flagged a food-safety fault. */
    freeze: boolean;
    inspectorId: string;
    actorRoles: readonly string[];
    idempotencyKey: string;
  }): Promise<LotRow> {
    const lot = await this.repo.byId(input.lotId);
    if (!lot) throw new ServiceError('Unknown lot.', 'LOT_NOT_FOUND', 'D51', 'Refresh and try again.', 404);

    const ctx = {
      actorId: input.inspectorId,
      actorRoles: parseRoles(input.actorRoles),
      at: this.clock.now(),
      actorCreatedRecord: false,
      idempotencyKey: input.idempotencyKey,
      // A pass is only legal when the generated sample plan was completed.
      // Convenience sampling hides exactly the defects that cause rejection later.
      reasons: input.freeze ? ['food_safety_fault'] : ['sample_plan_complete'],
    };

    let nextState: LotState;
    try {
      nextState = lotMachine.next(lot.state, input.freeze ? 'quarantine' : 'pass_inspection', ctx);
    } catch (e) {
      throw new ServiceError(
        (e as Error).message,
        'LOT_TRANSITION_DENIED',
        input.freeze ? 'D31' : 'D30',
        input.freeze
          ? 'Quarantine is recorded by an inspector or food safety officer.'
          : 'Complete the generated sample plan before passing this lot.',
      );
    }

    const updated = await this.repo.updateIfVersion(lot.id, lot.version, {
      state: nextState,
      // Quarantine moves everything not already sold into held, so it cannot be
      // reserved while the investigation runs.
      heldGrams: input.freeze ? lot.acceptedGrams - lot.reservedGrams : lot.heldGrams,
    });

    if (!updated) {
      throw new ServiceError(
        'This lot changed while the inspection was being recorded.',
        'LOT_VERSION_CONFLICT',
        'D39',
        'Refresh the lot and record the inspection again.',
        409,
      );
    }
    return updated;
  }
}

function lotCode(crop: string, isoNow: string): string {
  const d = isoNow.slice(0, 10).replace(/-/g, '');
  const tag = crop.slice(0, 3).toUpperCase();
  const seq = Math.floor(Math.random() * 900 + 100);
  return `LOT-${d}-${tag}-${seq}`;
}

/* ------------------------------------------------------------------ *
 * Orders
 * ------------------------------------------------------------------ */

export class OrderService {
  constructor(
    private readonly lots: LotRepo,
    private readonly orders: OrderRepo2,
    private readonly clock: Clock,
  ) {}

  /**
   * Creates an order and reserves stock against a lot in one operation.
   *
   * The reservation is the whole point. An order that does not reserve is an
   * order that can be created twice against the same 800kg, and the second
   * kitchen finds out on delivery day.
   */
  async create(input: {
    buyerId: string;
    lotId: string;
    quantityGrams: bigint;
    idempotencyKey: string;
  }): Promise<OrderRow> {
    const replay = await this.orders.findByIdempotencyKey(input.idempotencyKey);
    if (replay) return replay;

    const lot = await this.lots.byId(input.lotId);
    if (!lot) throw new ServiceError('Unknown lot.', 'LOT_NOT_FOUND', 'D51', 'Refresh the market and try again.', 404);

    try {
      assertLotIsTradeable(lot.state, lot.lotCode);
    } catch (e) {
      throw new ServiceError(
        (e as Error).message,
        'LOT_NOT_TRADEABLE',
        'D31',
        'This lot is not available. Choose another lot of the same crop.',
      );
    }

    if (!SELLABLE_STATES.includes(lot.state)) {
      throw new ServiceError(
        `Lot ${lot.lotCode} is ${lot.state.toLowerCase()} and has not passed inspection yet.`,
        'LOT_NOT_YET_SELLABLE',
        'D30',
        'This lot is still being checked. It appears on the market once inspection passes.',
      );
    }

    const position = {
      lotId: lot.lotCode,
      acceptedKg: grams(lot.acceptedGrams),
      reservedKg: grams(lot.reservedGrams),
      heldKg: grams(lot.heldGrams),
      rejectedKg: grams(lot.rejectedGrams),
      disposedKg: grams(lot.disposedGrams),
    };

    try {
      assertReservable(position, grams(input.quantityGrams));
    } catch (e) {
      const err = e as InvariantViolation;
      throw new ServiceError(err.message, err.reasonCode, 'D14', err.correctionPath ?? 'Reduce the quantity.');
    }

    const total = Money.perKgTimesGrams(egp.fromPiastres(lot.pricePerKgPiastres), input.quantityGrams);
    const deposit = egp.fromPiastres((total.amount * DEPOSIT_BPS + 5000n) / 10000n);

    // Compare-and-swap. If another buyer reserved from this lot between our
    // read and our write, the version has moved and we refuse rather than
    // overwrite their reservation.
    const reservedAfter = lot.reservedGrams + input.quantityGrams;
    const fullyReserved = reservedAfter >= lot.acceptedGrams - lot.heldGrams;

    const updated = await this.lots.updateIfVersion(lot.id, lot.version, {
      reservedGrams: reservedAfter,
      state: fullyReserved && lot.state === 'PARTIALLY_RESERVED' ? 'FULLY_RESERVED' : 'PARTIALLY_RESERVED',
    });

    if (!updated) {
      throw new ServiceError(
        'Someone reserved from this lot a moment ago.',
        'LOT_VERSION_CONFLICT',
        'D14',
        'Refresh to see what is left, then order again.',
        409,
      );
    }

    const now = this.clock.now();
    const order: OrderRow = {
      id: crypto.randomUUID(),
      orderCode: orderCode(now),
      buyerId: input.buyerId,
      lotId: lot.id,
      // DEPOSIT_PENDING, not CONFIRMED. Interest is not demand: no procurement
      // exposure is created until money has actually cleared.
      state: 'DEPOSIT_PENDING',
      quantityGrams: input.quantityGrams,
      totalPiastres: total.amount,
      depositPiastres: deposit.amount,
      createdAt: now,
    };

    return this.orders.insert(order, input.idempotencyKey);
  }

  async byCode(orderCode: string): Promise<OrderRow> {
    const o = await this.orders.byCode(orderCode);
    if (!o) throw new ServiceError('Unknown order.', 'ORDER_NOT_FOUND', 'D51', 'Check the order code.', 404);
    return o;
  }
}

function orderCode(isoNow: string): string {
  const d = isoNow.slice(0, 10).replace(/-/g, '');
  const seq = Math.floor(Math.random() * 900 + 100);
  return `ORD-${d}-${seq}`;
}

export { availableToPromise, Qty, FROZEN_LOT_STATES, SELLABLE_STATES };
