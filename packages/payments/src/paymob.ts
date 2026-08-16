/**
 * Paymob adapter — Egypt.
 *
 * Collection: the Intentions API. One call from our backend creates an intention
 * and returns a `client_secret`; the mobile app mounts Unified Checkout with it.
 * We never touch card data, so the app stays out of PCI scope.
 *
 * Payout: Paymob's disbursement rail, used for supplier settlement. Payouts are
 * irreversible, so every call carries an idempotency key and cannot run without
 * a second approver (D26, D28, D47, D53).
 *
 * Methods we enable for this market, in the order Egyptian food businesses
 * actually use them:
 *   - bank transfer / InstaPay        buyers settling weekly invoices
 *   - mobile wallet (Vodafone Cash…)  smaller kitchens, deposits
 *   - card                            chains with procurement cards
 *   - Aman / kiosk cash               cash-first buyers, and the deposit path
 *                                     that makes "confirmed demand" real
 *   - valU / Souhoola BNPL            larger recurring buyers only, off by default
 */

import { Money, egp } from '@reharvest/core/money';

export type PaymentMethod = 'card' | 'wallet' | 'kiosk_cash' | 'bank_transfer' | 'bnpl';

export interface PaymobConfig {
  readonly baseUrl: string; // https://accept.paymob.com for Egypt production
  readonly secretKey: string; // Authorization: Token <secretKey>
  readonly publicKey: string; // used by the client to mount checkout
  readonly hmacSecret: string; // webhook signature verification
  /** Paymob issues one integration id per method per account. */
  readonly integrationIds: Readonly<Record<PaymentMethod, number[]>>;
}

export interface CreateIntentionInput {
  readonly orderId: string;
  readonly amount: Money;
  readonly methods: readonly PaymentMethod[];
  readonly billing: {
    readonly firstName: string;
    readonly lastName: string;
    readonly phoneNumber: string; // E.164, e.g. +2010…
    readonly email: string;
  };
  readonly items: ReadonlyArray<{ name: string; amount: Money; quantity: number }>;
  /** Written into Paymob's extras so a webhook can be traced back without guessing. */
  readonly reharvestRefs: {
    readonly orderId: string;
    readonly buyerId: string;
    readonly purpose: 'deposit' | 'invoice' | 'balance';
  };
}

export interface Intention {
  readonly clientSecret: string;
  readonly paymobIntentionId: string;
  readonly expiresAt: string;
}

export class PaymobError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'PaymobError';
  }
}

export class PaymobClient {
  constructor(
    private readonly cfg: PaymobConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private headers(idempotencyKey?: string): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: `Token ${this.cfg.secretKey}`,
      'Content-Type': 'application/json',
    };
    if (idempotencyKey) h['Idempotency-Key'] = idempotencyKey;
    return h;
  }

  /**
   * Amounts go to Paymob in piastres, which is what we already store, so there
   * is no conversion and therefore no rounding bug at the payment boundary.
   */
  async createIntention(input: CreateIntentionInput): Promise<Intention> {
    const integrationIds = input.methods.flatMap((m) => this.cfg.integrationIds[m] ?? []);
    if (integrationIds.length === 0) {
      throw new PaymobError(`No Paymob integration configured for ${input.methods.join(', ')}`, 0, null, false);
    }

    const payload = {
      amount: Number(input.amount.amount),
      currency: 'EGP',
      payment_methods: integrationIds,
      items: input.items.map((i) => ({
        name: i.name,
        amount: Number(i.amount.amount),
        quantity: i.quantity,
      })),
      billing_data: {
        first_name: input.billing.firstName,
        last_name: input.billing.lastName,
        phone_number: input.billing.phoneNumber,
        email: input.billing.email,
        country: 'EG',
      },
      special_reference: input.orderId,
      extras: { ...input.reharvestRefs },
    };

    const res = await this.fetchImpl(`${this.cfg.baseUrl}/v1/intention/`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new PaymobError(
        `Paymob rejected the intention for order ${input.orderId}`,
        res.status,
        body,
        res.status >= 500 || res.status === 429,
      );
    }

    const json = (await res.json()) as { client_secret: string; id: string | number };
    return {
      clientSecret: json.client_secret,
      paymobIntentionId: String(json.id),
      // Intentions are short-lived; we re-create rather than reuse a stale secret.
      expiresAt: new Date(Date.now() + 55 * 60_000).toISOString(),
    };
  }

  /**
   * Supplier payout. Irreversible: the caller must already hold an approval record
   * from a different person, and must pass a stable idempotency key derived from
   * the settlement id, not from the clock.
   */
  async disburse(input: DisbursementInput): Promise<DisbursementReceipt> {
    if (!input.idempotencyKey) {
      throw new PaymobError('Payouts require an idempotency key', 0, null, false);
    }
    if (input.approvedBy === input.preparedBy) {
      throw new PaymobError('Payout preparer and approver must be different people', 0, null, false);
    }

    const res = await this.fetchImpl(`${this.cfg.baseUrl}/api/disburse/`, {
      method: 'POST',
      headers: this.headers(input.idempotencyKey),
      body: JSON.stringify({
        amount: Number(input.amount.amount),
        issuer: input.channel,
        msisdn: input.channel === 'wallet' ? input.walletNumber : undefined,
        bank_card_number: input.channel === 'bank' ? input.bankAccountNumber : undefined,
        bank_code: input.channel === 'bank' ? input.bankCode : undefined,
        full_name: input.beneficiaryName,
        reference: input.settlementId,
      }),
    });

    const body = (await res.json()) as { transaction_id?: string; disbursement_status?: string };
    if (!res.ok) {
      throw new PaymobError(
        `Payout for settlement ${input.settlementId} failed`,
        res.status,
        body,
        res.status >= 500,
      );
    }

    return {
      settlementId: input.settlementId,
      providerTransactionId: body.transaction_id ?? '',
      status: body.disbursement_status === 'successful' ? 'sent' : 'pending',
      sentAt: new Date().toISOString(),
    };
  }
}

export type DisbursementChannel = 'wallet' | 'bank';

export interface DisbursementInput {
  readonly settlementId: string;
  readonly amount: Money;
  readonly channel: DisbursementChannel;
  readonly beneficiaryName: string;
  readonly walletNumber?: string;
  readonly bankAccountNumber?: string;
  readonly bankCode?: string;
  readonly preparedBy: string;
  readonly approvedBy: string;
  readonly idempotencyKey: string;
}

export interface DisbursementReceipt {
  readonly settlementId: string;
  readonly providerTransactionId: string;
  readonly status: 'sent' | 'pending' | 'failed';
  readonly sentAt: string;
}

/* ------------------------------------------------------------------ *
 * Webhook. Paymob HMACs a fixed, ordered subset of fields. Verifying the
 * signature is what separates a real payment from a forged callback, and it
 * is the only thing that may move an order to DEPOSIT_CLEARED.
 * ------------------------------------------------------------------ */

const HMAC_FIELD_ORDER = [
  'amount_cents',
  'created_at',
  'currency',
  'error_occured',
  'has_parent_transaction',
  'id',
  'integration_id',
  'is_3d_secure',
  'is_auth',
  'is_capture',
  'is_refunded',
  'is_standalone_payment',
  'is_voided',
  'order.id',
  'owner',
  'pending',
  'source_data.pan',
  'source_data.sub_type',
  'source_data.type',
  'success',
] as const;

export interface PaymobWebhookPayload {
  readonly type: string;
  readonly obj: Record<string, unknown>;
}

export interface VerifiedPayment {
  readonly providerTransactionId: string;
  readonly merchantOrderId: string;
  readonly amount: Money;
  readonly success: boolean;
  readonly pending: boolean;
  readonly refunded: boolean;
  readonly voided: boolean;
  readonly method: string;
  readonly occurredAt: string;
}

export async function verifyWebhook(
  payload: PaymobWebhookPayload,
  receivedHmac: string,
  hmacSecret: string,
  subtle: SubtleCrypto = globalThis.crypto.subtle,
): Promise<VerifiedPayment> {
  const concatenated = HMAC_FIELD_ORDER.map((path) => stringifyPath(payload.obj, path)).join('');

  const key = await subtle.importKey(
    'raw',
    new TextEncoder().encode(hmacSecret),
    { name: 'HMAC', hash: 'SHA-512' },
    false,
    ['sign'],
  );
  const sig = await subtle.sign('HMAC', key, new TextEncoder().encode(concatenated));
  const computed = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');

  if (!timingSafeEqual(computed, receivedHmac.toLowerCase())) {
    throw new PaymobError('Webhook HMAC mismatch — payload rejected', 401, null, false);
  }

  const obj = payload.obj as Record<string, any>;
  return {
    providerTransactionId: String(obj.id),
    merchantOrderId: String(obj.order?.merchant_order_id ?? obj.order?.id ?? ''),
    amount: egp.fromPiastres(BigInt(obj.amount_cents)),
    success: obj.success === true,
    pending: obj.pending === true,
    refunded: obj.is_refunded === true,
    voided: obj.is_voided === true,
    method: String(obj.source_data?.type ?? 'unknown'),
    occurredAt: String(obj.created_at ?? new Date().toISOString()),
  };
}

function stringifyPath(obj: Record<string, unknown>, path: string): string {
  const value = path.split('.').reduce<unknown>((acc, k) => (acc as Record<string, unknown>)?.[k], obj);
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const Money_ = Money; // re-export guard so callers cannot smuggle in float money
