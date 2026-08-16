/**
 * Calculation invariants. These are the formulas from the handoff, implemented
 * once, in integers, with every violation carrying a reason code an operator can act on.
 *
 * The rule that matters: these functions do not clamp, round away, or "fix" a bad
 * number. They throw. A negative available-to-promise is not a display problem,
 * it means something was double-sold.
 */

import { Money, egp } from './money.js';
import { Qty, grams, type Quantity } from './quantity.js';

export class InvariantViolation extends Error {
  constructor(
    message: string,
    readonly reasonCode: string,
    readonly controls: readonly string[],
    readonly correctionPath: string,
  ) {
    super(message);
    this.name = 'InvariantViolation';
  }
}

/* ---------------------------------------------------------------- *
 * Available to promise — D08, D09, D39
 * ---------------------------------------------------------------- */

export interface LotPosition {
  readonly lotId: string;
  readonly acceptedKg: Quantity;
  readonly reservedKg: Quantity;
  readonly heldKg: Quantity;
  readonly rejectedKg: Quantity;
  readonly disposedKg: Quantity;
}

export function availableToPromise(p: LotPosition): Quantity {
  const atp = grams(
    p.acceptedKg.value - p.reservedKg.value - p.heldKg.value - p.rejectedKg.value - p.disposedKg.value,
  );
  if (Qty.isNegative(atp)) {
    throw new InvariantViolation(
      `Lot ${p.lotId} is over-committed by ${Qty.format(grams(-atp.value), 'en-EG')}. Reservations exceed what physically exists.`,
      'ATP_NEGATIVE',
      ['D09', 'D39'],
      'Find the duplicate reservation and release it before quoting this lot again.',
    );
  }
  return atp;
}

export function assertReservable(p: LotPosition, requested: Quantity): void {
  const atp = availableToPromise(p);
  if (Qty.lt(atp, requested)) {
    throw new InvariantViolation(
      `Lot ${p.lotId} has ${Qty.format(atp, 'en-EG')} available, not ${Qty.format(requested, 'en-EG')}.`,
      'RESERVATION_EXCEEDS_ATP',
      ['D08', 'D09'],
      'Reduce the quantity, split across another verified lot, or source more supply before confirming.',
    );
  }
}

/* ---------------------------------------------------------------- *
 * Inventory reconciliation — D39, D40. Must land on zero within tolerance.
 * ---------------------------------------------------------------- */

export interface InventoryPeriod {
  readonly openingKg: Quantity;
  readonly acceptedInKg: Quantity;
  readonly soldOrUsedKg: Quantity;
  readonly rejectedKg: Quantity;
  readonly disposedKg: Quantity;
  readonly closingKg: Quantity;
  /** Approved measurement tolerance in grams. Anything wider needs an approval record. */
  readonly toleranceGrams: bigint;
}

export interface ReconciliationResult {
  readonly varianceGrams: bigint;
  readonly withinTolerance: boolean;
  readonly explanation: string;
}

export function reconcileInventory(p: InventoryPeriod): ReconciliationResult {
  const variance =
    p.openingKg.value +
    p.acceptedInKg.value -
    p.soldOrUsedKg.value -
    p.rejectedKg.value -
    p.disposedKg.value -
    p.closingKg.value;
  const abs = variance < 0n ? -variance : variance;
  const withinTolerance = abs <= p.toleranceGrams;
  return {
    varianceGrams: variance,
    withinTolerance,
    explanation: withinTolerance
      ? `Reconciled. Variance ${variance}g is inside the approved ${p.toleranceGrams}g tolerance.`
      : `Unexplained ${variance > 0n ? 'shortfall' : 'surplus'} of ${abs}g. Stock left the count without a waste record — check disposals, unrecorded sales and the sorting yield.`,
  };
}

/* ---------------------------------------------------------------- *
 * Margin engine — D10, D20, D21, D22. Every cost line is mandatory.
 * A missing cost is a null, never a zero.
 * ---------------------------------------------------------------- */

export interface CostModelInput {
  readonly acceptedSaleWeightGrams: bigint;
  readonly buyerPricePerKg: Money;
  readonly acceptedPurchaseWeightGrams: bigint;
  readonly supplierPricePerKg: Money;
  readonly packaging: Money;
  readonly labour: Money;
  readonly storage: Money;
  readonly financeCost: Money;
  readonly taxesAndFees: Money;
  /** Expected reject cost. Grade B only works when usable yield is priced in, not hoped for. */
  readonly expectedRejectCost: Money;
  readonly otherVariableCost: Money;
  /** Downside sensitivity, in basis points of extra yield loss to stress-test. */
  readonly downsideYieldLossBps: number;
}

export interface MarginResult {
  readonly revenue: Money;
  readonly purchaseCost: Money;
  readonly contribution: Money;
  readonly contributionBps: number;
  readonly downsideContribution: Money;
  readonly breakdown: ReadonlyArray<{ line: string; amount: Money }>;
}

const REQUIRED_COST_LINES = [
  'packaging',
  'labour',
  'storage',
  'financeCost',
  'taxesAndFees',
  'expectedRejectCost',
  'otherVariableCost',
] as const;

export function computeMargin(input: CostModelInput): MarginResult {
  for (const line of REQUIRED_COST_LINES) {
    if (input[line] === undefined || input[line] === null) {
      throw new InvariantViolation(
        `Cost line "${line}" is missing. An order that omits a cost shows a profit that does not exist.`,
        'MARGIN_INCOMPLETE_COST_MODEL',
        ['D21', 'D22'],
        `Enter ${line}, or enter zero explicitly with a reason if it genuinely does not apply.`,
      );
    }
  }

  const revenue = Money.perKgTimesGrams(input.buyerPricePerKg, input.acceptedSaleWeightGrams);
  const purchaseCost = Money.perKgTimesGrams(input.supplierPricePerKg, input.acceptedPurchaseWeightGrams);

  const breakdown = [
    { line: 'Buyer revenue', amount: revenue },
    { line: 'Produce cost', amount: Money.negate(purchaseCost) },
    { line: 'Packaging', amount: Money.negate(input.packaging) },
    { line: 'Labour and sorting', amount: Money.negate(input.labour) },
    { line: 'Storage', amount: Money.negate(input.storage) },
    { line: 'Finance cost', amount: Money.negate(input.financeCost) },
    { line: 'Taxes and fees', amount: Money.negate(input.taxesAndFees) },
    { line: 'Expected rejects', amount: Money.negate(input.expectedRejectCost) },
    { line: 'Other variable', amount: Money.negate(input.otherVariableCost) },
  ];

  const contribution = Money.sum(breakdown.map((b) => b.amount));
  const contributionBps =
    revenue.amount === 0n ? 0 : Number((contribution.amount * 10_000n) / revenue.amount);

  const lostRevenue = Money.basisPoints(revenue, input.downsideYieldLossBps);
  const downsideContribution = Money.sub(contribution, lostRevenue);

  return { revenue, purchaseCost, contribution, contributionBps, downsideContribution, breakdown };
}

/**
 * D21 hard rule. An order below the floor is not "thin", it is blocked.
 * The downside case is the one that must clear the floor, not the optimistic one.
 */
export function assertMarginFloor(result: MarginResult, floorBps: number): void {
  if (Money.isNegative(result.downsideContribution)) {
    throw new InvariantViolation(
      `Under the downside yield assumption this order loses ${Money.format(Money.negate(result.downsideContribution), 'en-EG')}.`,
      'MARGIN_NEGATIVE_DOWNSIDE',
      ['D21'],
      'Raise the buyer price, renegotiate the supplier price, or reduce the sorting loss assumption with evidence.',
    );
  }
  if (result.contributionBps < floorBps) {
    throw new InvariantViolation(
      `Contribution is ${(result.contributionBps / 100).toFixed(2)}%, below the ${(floorBps / 100).toFixed(2)}% floor.`,
      'MARGIN_BELOW_FLOOR',
      ['D20', 'D21'],
      'An executive override can approve this, with a reason and an expiry date.',
    );
  }
}

/* ---------------------------------------------------------------- *
 * Cash — D23. Accounting profit is not spendable money.
 * ---------------------------------------------------------------- */

export interface CashPosition {
  readonly clearedCash: Money;
  readonly highConfidenceInflows: Money;
  readonly authorisedOutflows: Money;
  readonly committedOutflows: Money;
  readonly minimumBuffer: Money;
}

export function cashAvailableAfterCommitments(p: CashPosition): Money {
  return Money.sub(
    Money.sub(Money.sub(Money.add(p.clearedCash, p.highConfidenceInflows), p.authorisedOutflows), p.committedOutflows),
    p.minimumBuffer,
  );
}

export function assertCanCommitCash(p: CashPosition, newCommitment: Money): void {
  const headroom = cashAvailableAfterCommitments(p);
  if (Money.lt(headroom, newCommitment)) {
    throw new InvariantViolation(
      `Committing ${Money.format(newCommitment, 'en-EG')} would breach the minimum cash buffer. Headroom is ${Money.format(headroom, 'en-EG')}.`,
      'CASH_BUFFER_BREACH',
      ['D23'],
      'Collect a receivable, take a deposit, or reduce the purchase. Do not fund produce from the buffer.',
    );
  }
}

/* ---------------------------------------------------------------- *
 * Buyer exposure — D19, D25
 * ---------------------------------------------------------------- */

export interface BuyerExposure {
  readonly unpaidInvoices: Money;
  readonly committedCreditOrders: Money;
  readonly approvedClaimsPending: Money;
  readonly clearedUnallocatedReceipts: Money;
}

export function totalBuyerExposure(e: BuyerExposure): Money {
  return Money.sub(
    Money.sum([e.unpaidInvoices, e.committedCreditOrders, e.approvedClaimsPending]),
    e.clearedUnallocatedReceipts,
  );
}

export function assertWithinCreditLimit(e: BuyerExposure, limit: Money, buyerName: string): void {
  const exposure = totalBuyerExposure(e);
  if (Money.lt(limit, exposure)) {
    throw new InvariantViolation(
      `${buyerName} is at ${Money.format(exposure, 'en-EG')} against a ${Money.format(limit, 'en-EG')} limit.`,
      'CREDIT_LIMIT_EXCEEDED',
      ['D25'],
      'Take payment on delivery for this order, or raise the limit through the credit approval workflow.',
    );
  }
}

/**
 * D04 / D19. Concentration is measured as a share of exposure, not a count of
 * parties. Three buyers is not diversification if one of them is 80% of the book.
 */
export function concentrationBps(partyExposure: Money, totalExposure: Money): number {
  if (totalExposure.amount === 0n) return 0;
  return Number((partyExposure.amount * 10_000n) / totalExposure.amount);
}

export function assertConcentrationCeiling(
  partyExposure: Money,
  totalExposure: Money,
  ceilingBps: number,
  partyName: string,
): void {
  const share = concentrationBps(partyExposure, totalExposure);
  if (share > ceilingBps) {
    throw new InvariantViolation(
      `${partyName} would be ${(share / 100).toFixed(1)}% of total exposure, above the ${(ceilingBps / 100).toFixed(1)}% ceiling.`,
      'CONCENTRATION_CEILING_EXCEEDED',
      ['D04', 'D19'],
      'Needs executive approval with a stated plan to bring the share back down.',
    );
  }
}

export const zeroCash = (): CashPosition => ({
  clearedCash: egp.zero(),
  highConfidenceInflows: egp.zero(),
  authorisedOutflows: egp.zero(),
  committedOutflows: egp.zero(),
  minimumBuffer: egp.zero(),
});
