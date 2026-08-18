/**
 * Payment flow tests.
 *
 * These are the ones worth writing, because each corresponds to something that
 * actually happens to marketplaces handling money in Egypt: forged callbacks,
 * duplicated callbacks on bad mobile connections, buyers paying a round number
 * instead of the invoice, and a supplier's "new bank account" arriving by
 * WhatsApp an hour before payment run.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import { Money, egp } from '@reharvest/core/money';
import { buildP0Registry, ControlBlocked, type AuditEntry } from '@reharvest/core/guard';
import { PaymobClient, type PaymobConfig } from '@reharvest/payments/paymob';
import {
  PaymentService,
  methodsFor,
  type OrderRecord,
  type OrderRepo,
  type PaymentRepo,
  type StoredPayment,
} from './payment-service.ts';

const HMAC_SECRET = 'test-hmac-secret';

const config: PaymobConfig = {
  baseUrl: 'https://accept.paymob.test',
  secretKey: 'sk_test',
  publicKey: 'pk_test',
  hmacSecret: HMAC_SECRET,
  integrationIds: {
    card: [1001],
    wallet: [1002],
    kiosk_cash: [1003],
    bank_transfer: [1004],
    bnpl: [1005],
  },
};

/* ---------------------------------------------------------------- *
 * Fakes
 * ---------------------------------------------------------------- */

const baseOrder: OrderRecord = {
  orderCode: 'ORD-2026-0816-004',
  buyerId: 'buyer_pizza_group',
  buyerLegalName: 'مطاعم القاهرة للبيتزا',
  buyerPhone: '+201001234567',
  buyerEmail: 'procurement@cairopizza.example',
  state: 'DEPOSIT_PENDING',
  totalDue: egp.fromPounds(8_800),
  depositDue: egp.fromPounds(2_640),
  lineItems: [{ nameAr: 'طماطم درجة صلصة', amount: egp.fromPounds(8_800), quantity: 1 }],
};

function fakes(order: OrderRecord = baseOrder) {
  const advanced: Array<{ to: string; reasonCode: string }> = [];
  const stored: StoredPayment[] = [];
  const unmatched: Array<{ id: string; reasonCode: string; amount: Money }> = [];
  let current = order;

  const orders: OrderRepo = {
    async findByCode(code) {
      return code === current.orderCode ? current : null;
    },
    async advance(_code, to, audit) {
      advanced.push({ to, reasonCode: audit.reasonCode });
      current = { ...current, state: to };
    },
  };

  const payments: PaymentRepo = {
    async findByProviderTransactionId(id) {
      return stored.find((p) => p.providerTransactionId === id) ?? null;
    },
    async recordInbound(p) {
      stored.push(p);
    },
    async markUnmatched(id, reasonCode, _note, amount) {
      unmatched.push({ id, reasonCode, amount });
    },
  };

  const audit: AuditEntry[] = [];
  const controls = buildP0Registry({ record: (e) => audit.push(e) });

  return { orders, payments, controls, advanced, stored, unmatched, audit };
}

/** Builds a webhook body and signs it exactly the way Paymob does. */
async function signedWebhook(over: Record<string, unknown> = {}) {
  const obj: Record<string, unknown> = {
    amount_cents: 264000,
    created_at: '2026-08-16T09:30:00Z',
    currency: 'EGP',
    error_occured: false,
    has_parent_transaction: false,
    id: 998877,
    integration_id: 1002,
    is_3d_secure: true,
    is_auth: false,
    is_capture: false,
    is_refunded: false,
    is_standalone_payment: true,
    is_voided: false,
    order: { id: 555, merchant_order_id: baseOrder.orderCode },
    owner: 42,
    pending: false,
    source_data: { pan: '1234', sub_type: 'wallet', type: 'wallet' },
    success: true,
    ...over,
  };

  const FIELDS = [
    'amount_cents', 'created_at', 'currency', 'error_occured', 'has_parent_transaction',
    'id', 'integration_id', 'is_3d_secure', 'is_auth', 'is_capture', 'is_refunded',
    'is_standalone_payment', 'is_voided', 'order.id', 'owner', 'pending',
    'source_data.pan', 'source_data.sub_type', 'source_data.type', 'success',
  ];

  const concat = FIELDS.map((path) => {
    const v = path.split('.').reduce<any>((acc, k) => acc?.[k], obj);
    if (v === null || v === undefined) return '';
    return typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v);
  }).join('');

  const key = await webcrypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(HMAC_SECRET),
    { name: 'HMAC', hash: 'SHA-512' },
    false,
    ['sign'],
  );
  const sig = await webcrypto.subtle.sign('HMAC', key, new TextEncoder().encode(concat));
  const hmac = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');

  return { payload: { type: 'TRANSACTION', obj }, hmac };
}

const clock = { now: () => '2026-08-16T09:31:00Z' };

function service(f: ReturnType<typeof fakes>, fetchImpl?: typeof fetch) {
  return new PaymentService({
    paymob: new PaymobClient(config, fetchImpl ?? (async () => new Response('{}', { status: 200 }))),
    config,
    orders: f.orders,
    payments: f.payments,
    controls: f.controls,
    clock,
  });
}

/* ---------------------------------------------------------------- */

describe('method selection', () => {
  test('a first-time buyer gets wallet, card and kiosk cash but not BNPL', () => {
    const m = methodsFor(egp.fromPounds(2_640), { completedOrders: 0, hasVerifiedBankAccount: false });
    assert.deepEqual(m.sort(), ['card', 'kiosk_cash', 'wallet']);
  });

  test('kiosk cash disappears above the practical ceiling', () => {
    const m = methodsFor(egp.fromPounds(45_000), { completedOrders: 0, hasVerifiedBankAccount: false });
    assert.equal(m.includes('kiosk_cash'), false);
  });

  test('BNPL only opens after a real order history', () => {
    const m = methodsFor(egp.fromPounds(5_000), { completedOrders: 9, hasVerifiedBankAccount: true });
    assert.equal(m.includes('bnpl'), true);
  });
});

describe('deposit intention', () => {
  test('the amount comes from the order, never from the client', async () => {
    const f = fakes();
    let sentBody: any;
    const svc = service(f, async (_url, init) => {
      sentBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ client_secret: 'cs_abc', id: 777 }), { status: 200 });
    });

    const result = await svc.createDepositIntention('ORD-2026-0816-004', {
      completedOrders: 0,
      hasVerifiedBankAccount: false,
    });

    assert.equal(result.clientSecret, 'cs_abc');
    assert.equal(sentBody.amount, 264000); // piastres, straight from the order
    assert.equal(sentBody.currency, 'EGP');
    assert.equal(sentBody.special_reference, 'ORD-2026-0816-004');
  });

  test('a deposit cannot be collected on an order that has not been quoted', async () => {
    const f = fakes({ ...baseOrder, state: 'INTEREST' });
    const svc = service(f);
    await assert.rejects(
      () => svc.createDepositIntention('ORD-2026-0816-004', { completedOrders: 0, hasVerifiedBankAccount: false }),
      /only collected once the buyer has accepted a quote/,
    );
  });
});

describe('webhook — gate 1: authenticity', () => {
  test('a forged callback is rejected before anything is written', async () => {
    const f = fakes();
    const svc = service(f);
    const { payload } = await signedWebhook();

    await assert.rejects(() => svc.handleWebhook(payload, 'deadbeef'.repeat(16)), /HMAC mismatch/);
    assert.equal(f.stored.length, 0);
    assert.equal(f.advanced.length, 0);
  });

  test('a tampered amount invalidates the signature', async () => {
    const f = fakes();
    const svc = service(f);
    const { payload, hmac } = await signedWebhook();
    (payload.obj as any).amount_cents = 1; // attacker edits the body, keeps the old signature

    await assert.rejects(() => svc.handleWebhook(payload, hmac), /HMAC mismatch/);
    assert.equal(f.advanced.length, 0);
  });
});

describe('webhook — gate 2: replay', () => {
  test('the same transaction delivered twice advances the order once', async () => {
    const f = fakes();
    const svc = service(f);
    const { payload, hmac } = await signedWebhook();

    const first = await svc.handleWebhook(payload, hmac);
    const second = await svc.handleWebhook(payload, hmac);

    assert.equal(first.outcome, 'order_advanced');
    assert.equal(second.outcome, 'ignored_duplicate');
    assert.equal(f.advanced.length, 1);
    assert.equal(f.stored.length, 1);
  });
});

describe('webhook — gate 3: reconciliation', () => {
  test('a successful, matched deposit clears and moves the order', async () => {
    const f = fakes();
    const svc = service(f);
    const { payload, hmac } = await signedWebhook();

    const result = await svc.handleWebhook(payload, hmac);

    assert.deepEqual(result, {
      outcome: 'order_advanced',
      orderCode: 'ORD-2026-0816-004',
      to: 'DEPOSIT_CLEARED',
    });
    assert.equal(f.stored[0]?.clearedAt, '2026-08-16T09:30:00Z');
  });

  test('a buyer who pays a round 2,000 instead of 2,640 does not unlock procurement', async () => {
    const f = fakes();
    const svc = service(f);
    const { payload, hmac } = await signedWebhook({ amount_cents: 200000 });

    const result = await svc.handleWebhook(payload, hmac);

    assert.equal(result.outcome, 'held_for_review');
    assert.equal(f.advanced.length, 0);
    // The money is still recorded — it exists, it just has not cleared the order.
    assert.equal(f.stored.length, 1);
    assert.equal(f.stored[0]?.clearedAt, null);
  });

  test('a refunded transaction never advances anything', async () => {
    const f = fakes();
    const svc = service(f);
    const { payload, hmac } = await signedWebhook({ is_refunded: true });

    const result = await svc.handleWebhook(payload, hmac);
    assert.equal(result.outcome, 'held_for_review');
    assert.equal(f.advanced.length, 0);
  });

  test('a declined transaction is ignored without touching the order', async () => {
    const f = fakes();
    const svc = service(f);
    const { payload, hmac } = await signedWebhook({ success: false });

    const result = await svc.handleWebhook(payload, hmac);
    assert.equal(result.outcome, 'ignored_unsuccessful');
    assert.equal(f.stored.length, 0);
  });

  test('money for an unknown order is held for finance, never dropped', async () => {
    const f = fakes();
    const svc = service(f);
    const { payload, hmac } = await signedWebhook({
      order: { id: 555, merchant_order_id: 'ORD-DOES-NOT-EXIST' },
    });

    const result = await svc.handleWebhook(payload, hmac);
    assert.equal(result.outcome, 'held_for_review');
    assert.equal(f.unmatched[0]?.reasonCode, 'ORDER_NOT_FOUND');
    // The amount must be recorded, not zeroed: this money is really in the account.
    assert.equal(f.unmatched[0]?.amount.amount, 264000n);
  });
});

describe('supplier payout', () => {
  const payoutInput = {
    settlementId: 'STL-2026-0816-011',
    supplierPartyId: 'party_packhouse_7',
    amount: egp.fromPounds(5_200),
    channel: 'bank' as const,
    beneficiaryName: 'محطة فرز النوبارية',
    bankAccountNumber: '1234567890',
    bankCode: 'CIB',
    preparedBy: 'u_finance_1',
    approvedBy: 'u_manager_2',
  };

  test('a payout carries an idempotency key derived from the settlement, not the clock', async () => {
    const f = fakes();
    const seen: string[] = [];
    const svc = service(f, async (_url, init) => {
      seen.push(String((init?.headers as Record<string, string>)['Idempotency-Key']));
      return new Response(JSON.stringify({ transaction_id: 'tx_1', disbursement_status: 'successful' }), {
        status: 200,
      });
    });

    await svc.paySupplier(payoutInput);
    await svc.paySupplier(payoutInput); // a retry after a timeout

    assert.equal(seen[0], 'payout:STL-2026-0816-011');
    assert.equal(seen[0], seen[1]); // same key both times — the PSP can dedupe
  });

  test('a bank account changed this morning cannot be paid this afternoon', async () => {
    const f = fakes();
    const svc = service(f);
    await assert.rejects(
      () => svc.paySupplier({ ...payoutInput, beneficiaryChangedAt: '2026-08-16T06:00:00Z' }),
      ControlBlocked,
    );
  });

  test('the same person cannot prepare and approve a payout', async () => {
    const f = fakes();
    const svc = service(f, async () =>
      new Response(JSON.stringify({ transaction_id: 'tx', disbursement_status: 'successful' }), { status: 200 }),
    );
    await assert.rejects(
      () => svc.paySupplier({ ...payoutInput, approvedBy: 'u_finance_1' }),
      /must be different people/,
    );
  });

  test('a beneficiary changed two days ago clears the cooldown', async () => {
    const f = fakes();
    const svc = service(f, async () =>
      new Response(JSON.stringify({ transaction_id: 'tx_9', disbursement_status: 'successful' }), { status: 200 }),
    );
    const r = await svc.paySupplier({ ...payoutInput, beneficiaryChangedAt: '2026-08-14T06:00:00Z' });
    assert.equal(r.providerTransactionId, 'tx_9');
  });
});
