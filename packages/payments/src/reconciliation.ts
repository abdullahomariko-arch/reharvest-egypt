/**
 * Cleared-funds reconciliation.
 *
 * The failure this prevents: an operator sees a transfer screenshot in WhatsApp,
 * marks the order paid, and the platform buys 800kg of tomatoes against money that
 * was never sent, was sent by a different person, or was reversed two days later.
 *
 * A payment becomes *cleared* only when payer, reference, amount and reversal
 * status all agree with a real bank or PSP line. Everything else is `unmatched`
 * and creates no procurement exposure. (D24, D26, D28.)
 */

import { Money, egp } from '@reharvest/core/money';

export type ClearingSource = 'paymob_webhook' | 'bank_statement' | 'kiosk_receipt' | 'manual_attestation';

export interface ExpectedReceipt {
  readonly receiptId: string;
  readonly orderId: string;
  readonly buyerId: string;
  readonly expectedAmount: Money;
  readonly expectedPayerName: string;
  readonly expectedPayerAccountTail?: string;
  readonly purpose: 'deposit' | 'invoice' | 'balance';
}

export interface ObservedCredit {
  readonly creditId: string;
  readonly source: ClearingSource;
  readonly amount: Money;
  readonly payerName: string;
  readonly payerAccountTail?: string;
  readonly bankReference: string;
  readonly valueDate: string;
  readonly reversed: boolean;
  /** Some rails settle T+1. Money that has not settled is not money. */
  readonly settledAt: string | null;
}

export type MatchDecision =
  | { status: 'cleared'; receipt: ExpectedReceipt; credit: ObservedCredit; notes: string[] }
  | { status: 'partial'; receipt: ExpectedReceipt; credit: ObservedCredit; shortfall: Money; notes: string[] }
  | { status: 'unmatched'; reasonCode: string; messageEn: string; messageAr: string; correctionPath: string };

export interface MatchPolicy {
  /** Piastre tolerance for bank fees deducted in transit. Default: none. */
  readonly amountToleranceP: bigint;
  /** Manual attestation can never clear on its own above this figure. */
  readonly manualAttestationCeiling: Money;
  readonly requirePayerNameMatch: boolean;
}

export const DEFAULT_MATCH_POLICY: MatchPolicy = {
  amountToleranceP: 0n,
  manualAttestationCeiling: egp.fromPounds(5_000),
  requirePayerNameMatch: true,
};

export function matchReceipt(
  receipt: ExpectedReceipt,
  credit: ObservedCredit,
  policy: MatchPolicy = DEFAULT_MATCH_POLICY,
): MatchDecision {
  const notes: string[] = [];

  if (credit.reversed) {
    return deny(
      'CREDIT_REVERSED',
      'This transfer was reversed. Treat the order as unpaid.',
      'تم استرداد هذا التحويل. تعامل مع الطلب على أنه غير مدفوع.',
      'Contact the buyer for a fresh payment before releasing anything.',
    );
  }

  if (!credit.settledAt) {
    return deny(
      'CREDIT_NOT_SETTLED',
      'The transfer is visible but has not settled yet.',
      'التحويل ظاهر لكنه لم يُسوَّ بعد.',
      'Wait for settlement, or take a kiosk cash payment if the order cannot wait.',
    );
  }

  if (!credit.bankReference || credit.bankReference.trim().length < 4) {
    return deny(
      'NO_BANK_REFERENCE',
      'There is no bank reference to tie this money to.',
      'لا يوجد مرجع بنكي يربط هذا المبلغ بالطلب.',
      'Pull the reference from the statement line or the PSP transaction.',
    );
  }

  if (policy.requirePayerNameMatch && !namesLikelyMatch(receipt.expectedPayerName, credit.payerName)) {
    notes.push(`Payer sent as "${credit.payerName}", expected "${receipt.expectedPayerName}".`);
    return deny(
      'PAYER_MISMATCH',
      `Money arrived from "${credit.payerName}", not the buyer on this order.`,
      'وصل المبلغ من جهة مختلفة عن المشتري المسجَّل على الطلب.',
      'Confirm with the buyer in writing that this payer acts for them, then record the authorisation and retry.',
    );
  }

  if (
    receipt.expectedPayerAccountTail &&
    credit.payerAccountTail &&
    receipt.expectedPayerAccountTail !== credit.payerAccountTail
  ) {
    notes.push(`Account tail ${credit.payerAccountTail} differs from the one on file.`);
  }

  if (
    credit.source === 'manual_attestation' &&
    Money.gte(credit.amount, policy.manualAttestationCeiling)
  ) {
    return deny(
      'MANUAL_ATTESTATION_ABOVE_CEILING',
      `A manual attestation cannot clear ${Money.format(credit.amount, 'en-EG')}. Only a bank line or PSP webhook can.`,
      'الإقرار اليدوي لا يكفي لتصفية هذا المبلغ. يلزم كشف بنكي أو إشعار من مزوّد الدفع.',
      'Attach the bank statement line, or split the payment below the ceiling.',
    );
  }

  const difference = Money.sub(receipt.expectedAmount, credit.amount);
  const absDiff = difference.amount < 0n ? -difference.amount : difference.amount;

  if (absDiff <= policy.amountToleranceP) {
    return { status: 'cleared', receipt, credit, notes };
  }

  if (difference.amount > 0n) {
    return { status: 'partial', receipt, credit, shortfall: difference, notes };
  }

  notes.push(`Overpaid by ${Money.format(Money.negate(difference), 'en-EG')} — hold the surplus as an unallocated credit.`);
  return { status: 'cleared', receipt, credit, notes };
}

function deny(
  reasonCode: string,
  messageEn: string,
  messageAr: string,
  correctionPath: string,
): MatchDecision {
  return { status: 'unmatched', reasonCode, messageEn, messageAr, correctionPath };
}

/**
 * Arabic names arrive with inconsistent spacing, honorifics and Latin transliteration.
 * We normalise conservatively and require a strong overlap — this is a gate, not a search box.
 */
export function namesLikelyMatch(expected: string, observed: string): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[\u064B-\u065F\u0670]/g, '')
      .replace(/[أإآ]/g, 'ا')
      .replace(/ى/g, 'ي')
      .replace(/ة/g, 'ه')
      .replace(/\b(mr|mrs|eng|dr|شركة|مؤسسة|السيد|الاستاذ|م)\b\.?/g, ' ')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(Boolean);

  const a = new Set(norm(expected));
  const b = norm(observed);
  if (a.size === 0 || b.length === 0) return false;
  const overlap = b.filter((t) => a.has(t)).length;
  return overlap >= Math.min(2, a.size);
}

/**
 * Only a `cleared` decision may advance an order. Call this instead of reading
 * `.status` at the call site, so the rule lives in one place.
 */
export function assertClearedForExposure(decision: MatchDecision): asserts decision is Extract<
  MatchDecision,
  { status: 'cleared' }
> {
  if (decision.status !== 'cleared') {
    const reason =
      decision.status === 'partial'
        ? `Short by ${Money.format(decision.shortfall, 'en-EG')}`
        : decision.messageEn;
    throw new Error(`Funds are not cleared: ${reason}`);
  }
}
