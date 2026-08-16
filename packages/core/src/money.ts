/**
 * Money — integer minor units only (piastres). Never binary floating point.
 *
 * Controls: D21 margin integrity, D26 settlement, D45 tax records, D51 data governance.
 * Invariant: a value that will be posted to a ledger, an invoice, or a payment
 * instruction must pass through this module. `number` money is a bug.
 */

export type Currency = 'EGP';

/** Integer piastres. 1 EGP = 100 piastres. Branded so a raw number cannot be used by mistake. */
export type Piastres = bigint & { readonly __brand: 'Piastres' };

export interface Money {
  readonly amount: Piastres;
  readonly currency: Currency;
}

const MAX_SAFE_PIASTRES = 10_000_000_000_00n; // 10 billion EGP ceiling; anything above is a data error

export class MoneyError extends Error {
  constructor(
    message: string,
    readonly reasonCode: string,
  ) {
    super(message);
    this.name = 'MoneyError';
  }
}

function brand(v: bigint): Piastres {
  if (v > MAX_SAFE_PIASTRES || v < -MAX_SAFE_PIASTRES) {
    throw new MoneyError(`Amount ${v} exceeds the sanity ceiling`, 'MONEY_OUT_OF_RANGE');
  }
  return v as Piastres;
}

export const egp = {
  /** From whole pounds. `egp.fromPounds(120)` -> 120.00 EGP */
  fromPounds(pounds: number | bigint): Money {
    if (typeof pounds === 'number' && !Number.isInteger(pounds)) {
      throw new MoneyError(
        `Use fromDecimalString for fractional pounds; ${pounds} would lose precision`,
        'MONEY_FRACTIONAL_INPUT',
      );
    }
    return { amount: brand(BigInt(pounds) * 100n), currency: 'EGP' };
  },

  fromPiastres(p: number | bigint): Money {
    if (typeof p === 'number' && !Number.isInteger(p)) {
      throw new MoneyError(`Piastres must be a whole number, got ${p}`, 'MONEY_SUBUNIT_FRACTION');
    }
    return { amount: brand(BigInt(p)), currency: 'EGP' };
  },

  /**
   * Parse operator- or API-entered text. Accepts "12", "12.5", "12.50", "١٢٫٥" (Arabic-Indic).
   * Rejects more than 2 decimal places rather than silently rounding an operator's typo.
   */
  fromDecimalString(input: string): Money {
    const normalised = input
      .trim()
      .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
      .replace(/[\u066B\u060C]/g, '.')
      .replace(/[\s,]/g, '');

    const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(normalised);
    if (!match) {
      throw new MoneyError(
        `"${input}" is not a valid EGP amount. Use up to two decimal places.`,
        'MONEY_UNPARSEABLE',
      );
    }
    const [, sign, whole, frac = ''] = match;
    const piastres = BigInt(whole) * 100n + BigInt(frac.padEnd(2, '0'));
    return { amount: brand(sign === '-' ? -piastres : piastres), currency: 'EGP' };
  },

  zero(): Money {
    return { amount: 0n as Piastres, currency: 'EGP' };
  },
};

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new MoneyError(`Cannot mix ${a.currency} and ${b.currency}`, 'MONEY_CURRENCY_MISMATCH');
  }
}

export const Money = {
  add(a: Money, b: Money): Money {
    assertSameCurrency(a, b);
    return { amount: brand(a.amount + b.amount), currency: a.currency };
  },

  sub(a: Money, b: Money): Money {
    assertSameCurrency(a, b);
    return { amount: brand(a.amount - b.amount), currency: a.currency };
  },

  sum(items: readonly Money[]): Money {
    return items.reduce((acc, m) => Money.add(acc, m), egp.zero());
  },

  /**
   * price-per-kg × weight. Weight arrives as integer grams so the whole product
   * stays in integers; the final division is the only rounding point and it is explicit.
   *
   * D34: settlement weight must be net grams from a calibrated scale, never a decimal kg float.
   */
  perKgTimesGrams(pricePerKg: Money, grams: bigint, rounding: Rounding = 'half-even'): Money {
    if (grams < 0n) {
      throw new MoneyError('Weight cannot be negative', 'MONEY_NEGATIVE_WEIGHT');
    }
    return divideRounded(pricePerKg.amount * grams, 1000n, rounding, pricePerKg.currency);
  },

  /** Apply a rate expressed in basis points (1% = 100 bps). Used for commission and tax. */
  basisPoints(m: Money, bps: number, rounding: Rounding = 'half-even'): Money {
    if (!Number.isInteger(bps)) {
      throw new MoneyError('Basis points must be an integer', 'MONEY_FRACTIONAL_BPS');
    }
    return divideRounded(m.amount * BigInt(bps), 10_000n, rounding, m.currency);
  },

  negate(m: Money): Money {
    return { amount: brand(-m.amount), currency: m.currency };
  },

  isZero(m: Money): boolean {
    return m.amount === 0n;
  },
  isNegative(m: Money): boolean {
    return m.amount < 0n;
  },
  gte(a: Money, b: Money): boolean {
    assertSameCurrency(a, b);
    return a.amount >= b.amount;
  },
  lt(a: Money, b: Money): boolean {
    assertSameCurrency(a, b);
    return a.amount < b.amount;
  },
  eq(a: Money, b: Money): boolean {
    return a.currency === b.currency && a.amount === b.amount;
  },

  /**
   * Split a total across n parties with no piastre lost. Remainder goes to the
   * earliest recipients, deterministically. D26: three-way settlement must reconcile to zero.
   */
  allocate(total: Money, weights: readonly bigint[]): Money[] {
    const totalWeight = weights.reduce((a, b) => a + b, 0n);
    if (totalWeight <= 0n) {
      throw new MoneyError('Allocation weights must sum above zero', 'MONEY_BAD_ALLOCATION');
    }
    const shares = weights.map((w) => (total.amount * w) / totalWeight);
    let remainder = total.amount - shares.reduce((a, b) => a + b, 0n);
    return shares.map((s, i) => {
      const extra = i < Number(remainder < 0n ? -remainder : remainder) ? (remainder < 0n ? -1n : 1n) : 0n;
      return { amount: brand(s + extra), currency: total.currency };
    });
  },

  /** Display for UI and printed invoices. Always two decimals, never locale-rounded. */
  format(m: Money, locale: 'ar-EG' | 'en-EG' = 'ar-EG'): string {
    const neg = m.amount < 0n;
    const abs = neg ? -m.amount : m.amount;
    const whole = abs / 100n;
    const frac = (abs % 100n).toString().padStart(2, '0');
    const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const body = `${neg ? '-' : ''}${grouped}.${frac}`;
    return locale === 'ar-EG' ? `${body} ج.م` : `EGP ${body}`;
  },

  /** Canonical string for ledger storage and audit hashing. */
  toStorage(m: Money): string {
    return `${m.currency}:${m.amount.toString()}`;
  },

  fromStorage(s: string): Money {
    const [currency, amount] = s.split(':');
    if (currency !== 'EGP') throw new MoneyError(`Unknown currency ${currency}`, 'MONEY_UNKNOWN_CURRENCY');
    return { amount: brand(BigInt(amount)), currency };
  },
};

export type Rounding = 'half-even' | 'half-up' | 'floor' | 'ceil';

function divideRounded(numerator: bigint, denominator: bigint, mode: Rounding, currency: Currency): Money {
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const q = n / d;
  const r = n % d;
  if (r === 0n) return { amount: brand(negative ? -q : q), currency };

  let rounded: bigint;
  switch (mode) {
    case 'floor':
      rounded = negative ? q + 1n : q;
      break;
    case 'ceil':
      rounded = negative ? q : q + 1n;
      break;
    case 'half-up':
      rounded = r * 2n >= d ? q + 1n : q;
      break;
    case 'half-even': {
      const twice = r * 2n;
      if (twice > d) rounded = q + 1n;
      else if (twice < d) rounded = q;
      else rounded = q % 2n === 0n ? q : q + 1n;
      break;
    }
  }
  return { amount: brand(negative ? -rounded : rounded), currency };
}
