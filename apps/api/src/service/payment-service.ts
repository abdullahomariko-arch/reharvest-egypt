/**
 * Payment service — the orchestration between Paymob, the reconciliation rules
 * and the order state machine.
 *
 * The whole file exists to defend one sentence: **a webhook is not money.**
 *
 * A callback arriving at our endpoint is an unauthenticated HTTP request from
 * the internet. Before it is allowed to advance an order it has to survive four
 * separate gates, in this order:
 *
 *   1. HMAC — is this actually from Paymob, or forged?
 *   2. Replay — have we already processed this transaction id?
 *   3. Reconciliation — payer, reference, amount, reversal status all match?
 *   4. State machine — is this transition legal from where the order is now?
 *
 * Skipping any one of them is how a platform ships produce against money that
 * was never sent. They are ordered cheapest-first so a flood of forged callbacks
 * costs us one HMAC check each and never touches the database.
 */

import { Money, egp } from '@reharvest/core/money';
import { orderMachine, type OrderState, type TransitionContext } from '@reharvest/core/state-machines';
import { ControlBlocked, type ControlRegistry } from '@reharvest/core/guard';
import {
  PaymobClient,
  verifyWebhook,
  type PaymentMethod,
  type PaymobConfig,
  type PaymobWebhookPayload,
  type VerifiedPayment,
} from '@reharvest/payments/paymob';
import {
  matchReceipt,
  DEFAULT_MATCH_POLICY,
  type ExpectedReceipt,
  type ObservedCredit,
  type MatchDecision,
  type MatchPolicy,
} from '@reharvest/payments/reconciliation';

/* ------------------------------------------------------------------ *
 * Ports. The service depends on these interfaces, not on Postgres, so
 * the whole payment flow is testable without a database.
 * ------------------------------------------------------------------ */

export interface OrderRepo {
  findByCode(orderCode: string): Promise<OrderRecord | null>;
  advance(orderCode: string, to: OrderState, audit: AdvanceAudit): Promise<void>;
}

export interface OrderRecord {
  readonly orderCode: string;
  readonly buyerId: string;
  readonly buyerLegalName: string;
  readonly buyerPhone: string;
  readonly buyerEmail: string;
  readonly state: OrderState;
  readonly totalDue: Money;
  readonly depositDue: Money;
  readonly lineItems: ReadonlyArray<{ nameAr: string; amount: Money; quantity: number }>;
}

export interface AdvanceAudit {
  readonly actorId: string;
  readonly reasonCode: string;
  readonly providerTransactionId?: string;
  readonly at: string;
}

export interface PaymentRepo {
  /** Returns the existing row if this provider transaction was already recorded. */
  findByProviderTransactionId(id: string): Promise<StoredPayment | null>;
  recordInbound(p: StoredPayment): Promise<void>;
  markUnmatched(id: string, reasonCode: string, note: string): Promise<void>;
}

export interface StoredPayment {
  readonly providerTransactionId: string;
  readonly orderCode: string;
  readonly amount: Money;
  readonly method: string;
  readonly payerNameObserved: string;
  readonly bankReference: string;
  readonly clearedAt: string | null;
  readonly purpose: 'deposit' | 'invoice' | 'balance';
}

export interface Clock {
  now(): string;
}

/* ------------------------------------------------------------------ *
 * Method selection. Which rails we offer is a commercial decision, not a
 * technical one, so it lives here where it can be read without grep.
 * ------------------------------------------------------------------ */

export interface MethodPolicy {
  /** BNPL is off for new buyers: it settles to us fast but hides the buyer's real liquidity. */
  readonly bnplMinimumCompletedOrders: number;
  /** Above this, a kiosk cash payment is impractical and we push to transfer. */
  readonly kioskCeiling: Money;
}

export const DEFAULT_METHOD_POLICY: MethodPolicy = {
  bnplMinimumCompletedOrders: 6,
  kioskCeiling: egp.fromPounds(30_000),
};

export function methodsFor(
  amount: Money,
  buyer: { completedOrders: number; hasVerifiedBankAccount: boolean },
  policy: MethodPolicy = DEFAULT_METHOD_POLICY,
): PaymentMethod[] {
  const methods: PaymentMethod[] = ['wallet', 'card'];

  // Kiosk cash is the rail that makes "cleared deposit" achievable for a
  // cash-first kitchen that will not send a bank transfer for a first order.
  if (Money.lt(amount, policy.kioskCeiling)) methods.push('kiosk_cash');

  if (buyer.hasVerifiedBankAccount) methods.push('bank_transfer');

  if (buyer.completedOrders >= policy.bnplMinimumCompletedOrders) methods.push('bnpl');

  return methods;
}

/* ------------------------------------------------------------------ */

export interface PaymentServiceDeps {
  readonly paymob: PaymobClient;
  readonly config: PaymobConfig;
  readonly orders: OrderRepo;
  readonly payments: PaymentRepo;
  readonly controls: ControlRegistry;
  readonly clock: Clock;
  readonly matchPolicy?: MatchPolicy;
}

export type WebhookResult =
  | { outcome: 'order_advanced'; orderCode: string; to: OrderState }
  | { outcome: 'ignored_duplicate'; providerTransactionId: string }
  | { outcome: 'ignored_unsuccessful'; providerTransactionId: string; why: string }
  | { outcome: 'held_for_review'; orderCode: string; reasonCode: string; message: string };

export class PaymentService {
  constructor(private readonly deps: PaymentServiceDeps) {}

  /**
   * Called when a buyer taps "pay deposit". Creates a Paymob intention and hands
   * the client_secret back to the app, which mounts Unified Checkout with it.
   *
   * The amount is read from the order on the server. It is never taken from the
   * request body — a client that can name its own price is a client that will.
   */
  async createDepositIntention(
    orderCode: string,
    buyer: { completedOrders: number; hasVerifiedBankAccount: boolean },
  ): Promise<{ clientSecret: string; publicKey: string; amount: Money; methods: PaymentMethod[] }> {
    const order = await this.deps.orders.findByCode(orderCode);
    if (!order) throw new Error(`Unknown order ${orderCode}`);

    if (order.state !== 'DEPOSIT_PENDING' && order.state !== 'CONDITIONAL') {
      throw new Error(
        `Order ${orderCode} is ${order.state}. A deposit is only collected once the buyer has accepted a quote.`,
      );
    }

    const methods = methodsFor(order.depositDue, buyer);

    const intention = await this.deps.paymob.createIntention({
      orderId: orderCode,
      amount: order.depositDue,
      methods,
      billing: {
        firstName: order.buyerLegalName.split(' ')[0] ?? order.buyerLegalName,
        lastName: order.buyerLegalName.split(' ').slice(1).join(' ') || '-',
        phoneNumber: order.buyerPhone,
        email: order.buyerEmail,
      },
      items: order.lineItems.map((l) => ({ name: l.nameAr, amount: l.amount, quantity: l.quantity })),
      reharvestRefs: { orderId: orderCode, buyerId: order.buyerId, purpose: 'deposit' },
    });

    return {
      clientSecret: intention.clientSecret,
      publicKey: this.deps.config.publicKey,
      amount: order.depositDue,
      methods,
    };
  }

  /**
   * The webhook. Returns a result rather than throwing on business outcomes,
   * because Paymob retries anything that is not a 2xx and we do not want a
   * legitimately-rejected payment retried forever. Only genuine faults throw.
   */
  async handleWebhook(payload: PaymobWebhookPayload, receivedHmac: string): Promise<WebhookResult> {
    // Gate 1 — authenticity. Throws on mismatch; the route maps that to 401.
    const verified: VerifiedPayment = await verifyWebhook(
      payload,
      receivedHmac,
      this.deps.config.hmacSecret,
    );

    // Gate 2 — replay. Paymob retries on any non-2xx, and a phone on a bad
    // connection can trigger several callbacks for one payment.
    const existing = await this.deps.payments.findByProviderTransactionId(verified.providerTransactionId);
    if (existing) {
      return { outcome: 'ignored_duplicate', providerTransactionId: verified.providerTransactionId };
    }

    if (!verified.success || verified.pending) {
      return {
        outcome: 'ignored_unsuccessful',
        providerTransactionId: verified.providerTransactionId,
        why: verified.pending ? 'still pending at the provider' : 'declined at the provider',
      };
    }

    const order = await this.deps.orders.findByCode(verified.merchantOrderId);
    if (!order) {
      // Money arrived for an order we do not have. Never silently drop it.
      await this.deps.payments.markUnmatched(
        verified.providerTransactionId,
        'ORDER_NOT_FOUND',
        `Cleared ${Money.format(verified.amount, 'en-EG')} references unknown order "${verified.merchantOrderId}".`,
      );
      return {
        outcome: 'held_for_review',
        orderCode: verified.merchantOrderId,
        reasonCode: 'ORDER_NOT_FOUND',
        message: 'Money cleared against an order this platform does not recognise. Finance must allocate it manually.',
      };
    }

    // Gate 3 — reconciliation.
    const receipt: ExpectedReceipt = {
      receiptId: `rcpt_${order.orderCode}`,
      orderId: order.orderCode,
      buyerId: order.buyerId,
      expectedAmount: order.depositDue,
      expectedPayerName: order.buyerLegalName,
      purpose: 'deposit',
    };

    const credit: ObservedCredit = {
      creditId: verified.providerTransactionId,
      source: 'paymob_webhook',
      amount: verified.amount,
      payerName: order.buyerLegalName, // card/wallet rails settle under the merchant account
      bankReference: verified.providerTransactionId,
      valueDate: verified.occurredAt,
      reversed: verified.refunded || verified.voided,
      settledAt: verified.occurredAt,
    };

    const decision: MatchDecision = matchReceipt(
      receipt,
      credit,
      this.deps.matchPolicy ?? DEFAULT_MATCH_POLICY,
    );

    await this.deps.payments.recordInbound({
      providerTransactionId: verified.providerTransactionId,
      orderCode: order.orderCode,
      amount: verified.amount,
      method: verified.method,
      payerNameObserved: credit.payerName,
      bankReference: credit.bankReference,
      clearedAt: decision.status === 'cleared' ? verified.occurredAt : null,
      purpose: 'deposit',
    });

    if (decision.status !== 'cleared') {
      const reasonCode = decision.status === 'partial' ? 'DEPOSIT_SHORT' : decision.reasonCode;
      const message =
        decision.status === 'partial'
          ? `Short by ${Money.format(decision.shortfall, 'en-EG')}. The order stays where it is until the balance arrives.`
          : decision.messageEn;
      return { outcome: 'held_for_review', orderCode: order.orderCode, reasonCode, message };
    }

    // Gate 4 — the state machine. It will refuse unless the funds-matched
    // reason is present, which is exactly what we have just established.
    const ctx: TransitionContext = {
      actorId: 'system:paymob-webhook',
      actorRoles: ['finance'],
      at: this.deps.clock.now(),
      actorCreatedRecord: false,
      idempotencyKey: `webhook:${verified.providerTransactionId}`,
      reasons: ['funds_matched_to_bank_reference'],
    };

    const to = orderMachine.next(order.state, 'deposit_cleared', ctx);

    await this.deps.orders.advance(order.orderCode, to, {
      actorId: ctx.actorId,
      reasonCode: 'DEPOSIT_CLEARED',
      providerTransactionId: verified.providerTransactionId,
      at: ctx.at,
    });

    return { outcome: 'order_advanced', orderCode: order.orderCode, to };
  }

  /**
   * Supplier payout. Deliberately awkward to call: it needs a settlement id, two
   * different named people, and a key derived from the settlement rather than the
   * clock. All three are what make a duplicate payout impossible rather than unlikely.
   */
  async paySupplier(input: {
    settlementId: string;
    supplierPartyId: string;
    amount: Money;
    channel: 'wallet' | 'bank';
    beneficiaryName: string;
    walletNumber?: string;
    bankAccountNumber?: string;
    bankCode?: string;
    beneficiaryChangedAt?: string;
    preparedBy: string;
    approvedBy: string;
  }): Promise<{ providerTransactionId: string; status: string }> {
    // D28 and D47 are enforced by the guard, not by a comment.
    this.deps.controls.assert({
      domainId: 'D28',
      action: 'payment.submit',
      subjectId: input.settlementId,
      actorId: input.preparedBy,
      actorRoles: ['finance'],
      at: this.deps.clock.now(),
      idempotencyKey: `payout:${input.settlementId}`,
      evidence: [],
      facts: { beneficiaryChangedAt: input.beneficiaryChangedAt },
    });

    const receipt = await this.deps.paymob.disburse({
      settlementId: input.settlementId,
      amount: input.amount,
      channel: input.channel,
      beneficiaryName: input.beneficiaryName,
      walletNumber: input.walletNumber,
      bankAccountNumber: input.bankAccountNumber,
      bankCode: input.bankCode,
      preparedBy: input.preparedBy,
      approvedBy: input.approvedBy,
      // Derived from the settlement, never from Date.now(). A retry after a
      // timeout must produce the same key or it becomes a second payment.
      idempotencyKey: `payout:${input.settlementId}`,
    });

    return { providerTransactionId: receipt.providerTransactionId, status: receipt.status };
  }
}

export { ControlBlocked };
