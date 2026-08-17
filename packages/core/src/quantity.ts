/**
 * Quantity — every quantity carries its unit. "800" is never accepted on its own.
 *
 * Controls: D34 weighing/tare/units, D51 ambiguous units, D39 inventory accuracy.
 *
 * Weight is stored as integer grams. Crates and pieces are counts and can only
 * become weight through a *recorded, versioned* conversion tied to a specific
 * packaging spec — because "one crate" is not a constant and pretending it is
 * is how settlement weight silently drifts from delivered weight.
 */

export type Unit = 'g' | 'crate' | 'piece';

export interface Quantity {
  readonly value: bigint;
  readonly unit: Unit;
}

export class QuantityError extends Error {
  constructor(
    message: string,
    readonly reasonCode: string,
  ) {
    super(message);
    this.name = 'QuantityError';
  }
}

export const grams = (v: bigint | number): Quantity => {
  if (typeof v === 'number' && !Number.isInteger(v)) {
    throw new QuantityError(`Grams must be whole, got ${v}`, 'QTY_FRACTIONAL_GRAMS');
  }
  return { value: BigInt(v), unit: 'g' };
};

export const kg = (v: number | string): Quantity => {
  const s = typeof v === 'number' ? v.toString() : v.trim();
  const m = /^(-?)(\d+)(?:[.,](\d{1,3}))?$/.exec(s);
  if (!m) throw new QuantityError(`"${v}" is not a valid kilogram value`, 'QTY_UNPARSEABLE');
  const [, sign, whole, frac = ''] = m;
  const g = BigInt(whole) * 1000n + BigInt(frac.padEnd(3, '0'));
  return { value: sign === '-' ? -g : g, unit: 'g' };
};

export const crates = (n: number): Quantity => {
  if (!Number.isInteger(n)) throw new QuantityError('Crate counts must be whole', 'QTY_FRACTIONAL_COUNT');
  return { value: BigInt(n), unit: 'crate' };
};

export const pieces = (n: number): Quantity => {
  if (!Number.isInteger(n)) throw new QuantityError('Piece counts must be whole', 'QTY_FRACTIONAL_COUNT');
  return { value: BigInt(n), unit: 'piece' };
};

function assertSameUnit(a: Quantity, b: Quantity): void {
  if (a.unit !== b.unit) {
    throw new QuantityError(
      `Cannot combine ${a.unit} with ${b.unit}. Convert through a recorded packaging spec first.`,
      'QTY_UNIT_MISMATCH',
    );
  }
}

export const Qty = {
  add(a: Quantity, b: Quantity): Quantity {
    assertSameUnit(a, b);
    return { value: a.value + b.value, unit: a.unit };
  },
  sub(a: Quantity, b: Quantity): Quantity {
    assertSameUnit(a, b);
    return { value: a.value - b.value, unit: a.unit };
  },
  sum(items: readonly Quantity[]): Quantity {
    if (items.length === 0) return grams(0);
    return items.reduce((acc, q) => Qty.add(acc, q));
  },
  gte(a: Quantity, b: Quantity): boolean {
    assertSameUnit(a, b);
    return a.value >= b.value;
  },
  lt(a: Quantity, b: Quantity): boolean {
    assertSameUnit(a, b);
    return a.value < b.value;
  },
  isNegative(q: Quantity): boolean {
    return q.value < 0n;
  },
  isZero(q: Quantity): boolean {
    return q.value === 0n;
  },

  /**
   * D34 hard rule: net = gross - tare, and the result must be positive.
   * A tare heavier than the gross means the wrong crate template was picked
   * or the scale drifted — block, do not clamp to zero.
   */
  net(gross: Quantity, tare: Quantity): Quantity {
    assertSameUnit(gross, tare);
    if (gross.unit !== 'g') {
      throw new QuantityError('Tare arithmetic only applies to weight', 'QTY_TARE_NON_WEIGHT');
    }
    const net = gross.value - tare.value;
    if (net <= 0n) {
      throw new QuantityError(
        `Net weight would be ${net}g. Re-weigh: check the crate tare template and the scale zero.`,
        'QTY_NET_NOT_POSITIVE',
      );
    }
    return { value: net, unit: 'g' };
  },

  format(q: Quantity, locale: 'ar-EG' | 'en-EG' = 'ar-EG'): string {
    if (q.unit === 'g') {
      const neg = q.value < 0n;
      const abs = neg ? -q.value : q.value;
      const whole = (abs / 1000n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      const frac = (abs % 1000n).toString().padStart(3, '0').replace(/0+$/, '');
      const body = `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''}`;
      return locale === 'ar-EG' ? `${body} كجم` : `${body} kg`;
    }
    const noun =
      locale === 'ar-EG'
        ? q.unit === 'crate'
          ? 'صندوق'
          : 'قطعة'
        : q.unit === 'crate'
          ? 'crates'
          : 'pieces';
    return `${q.value} ${noun}`;
  },
};

/**
 * A packaging spec is the only legal bridge between counts and weight.
 * It is versioned: converting an old lot must use the spec version in force
 * when the lot was accepted, not today's spec. (D36 packaging, D51 master data.)
 */
export interface PackagingSpec {
  readonly specId: string;
  readonly version: number;
  readonly crateTareGrams: bigint;
  readonly nominalNetGramsPerCrate: bigint;
  readonly approvedAt: string;
  readonly approvedBy: string;
}

export interface ConversionResult {
  readonly quantity: Quantity;
  /** Written into the audit record so the arithmetic can be replayed years later. */
  readonly derivation: string;
}

export function cratesToNominalWeight(count: Quantity, spec: PackagingSpec): ConversionResult {
  if (count.unit !== 'crate') {
    throw new QuantityError('Expected a crate count', 'QTY_UNIT_MISMATCH');
  }
  return {
    quantity: grams(count.value * spec.nominalNetGramsPerCrate),
    derivation: `${count.value} crates x ${spec.nominalNetGramsPerCrate}g nominal (spec ${spec.specId} v${spec.version})`,
  };
}

/**
 * Nominal crate weight is an estimate and must never settle money.
 * This guard is called by the settlement path. (D26, D34.)
 */
export function assertSettlementWeight(source: WeightSource): void {
  if (source.kind !== 'verified-scale') {
    throw new QuantityError(
      'Settlement weight must come from a calibrated verified scale, not a nominal or declared figure.',
      'QTY_UNVERIFIED_SETTLEMENT_WEIGHT',
    );
  }
  if (!source.calibrationValidUntil || new Date(source.calibrationValidUntil) < new Date()) {
    throw new QuantityError(
      `Scale ${source.scaleId} calibration expired on ${source.calibrationValidUntil}. Recalibrate before settling.`,
      'QTY_SCALE_CALIBRATION_EXPIRED',
    );
  }
}

export type WeightSource =
  | {
      kind: 'verified-scale';
      scaleId: string;
      calibrationValidUntil: string;
      capturedBy: string;
      capturedAt: string;
      photoEvidenceId?: string;
    }
  | { kind: 'nominal-from-packaging'; specId: string; version: number }
  | { kind: 'declared-by-party'; declaredBy: string };

/* ------------------------------------------------------------------ *
 * Registered packaging specs.
 *
 * These live in the database in production; the constant here is the seed
 * and the fallback the mobile app carries so it can compute a net weight
 * with no signal. Specs are append-only — correcting a tare means adding a
 * new version, never editing an existing one, because lots already accepted
 * under v2 must keep settling against v2 forever.
 * ------------------------------------------------------------------ */

export const CRATE_SPECS = {
  /** The standard blue plastic field crate used across the Delta. */
  plastic_standard_v2: {
    specId: 'plastic_standard',
    version: 2,
    crateTareGrams: 500n,
    nominalNetGramsPerCrate: 20_000n,
    approvedAt: '2026-03-01T00:00:00Z',
    approvedBy: 'ops:quality-lead',
  },
  /** Woven sack, used for onions and potatoes. */
  sack_50kg_v1: {
    specId: 'sack_50kg',
    version: 1,
    crateTareGrams: 180n,
    nominalNetGramsPerCrate: 50_000n,
    approvedAt: '2026-03-01T00:00:00Z',
    approvedBy: 'ops:quality-lead',
  },
} as const satisfies Record<string, PackagingSpec>;

/**
 * Gross weight off the scale, minus the tare of a counted number of empty
 * containers, using a named spec version.
 *
 * Throws (rather than clamping) when the tare equals or exceeds the gross.
 * That combination almost always means the wrong crate template was selected,
 * and silently producing a zero or negative net is how a supplier ends up
 * being paid for weight that was never there.
 */
export function netFromGross(gross: Quantity, spec: PackagingSpec, containerCount: number): Quantity {
  if (gross.unit !== 'g') {
    throw new QuantityError('Gross weight must be a weight', 'QTY_UNIT_MISMATCH');
  }
  if (!Number.isInteger(containerCount) || containerCount <= 0) {
    throw new QuantityError(
      `Container count must be a positive whole number, got ${containerCount}`,
      'QTY_BAD_CONTAINER_COUNT',
    );
  }
  const tare = grams(BigInt(containerCount) * spec.crateTareGrams);
  return Qty.net(gross, tare);
}
