/**
 * Allocation and payout approval.
 *
 * These are the two places where a person in the ops console moves money, so
 * they get the same treatment as anything else that moves money: explicit
 * rules, an audit entry, and a refusal that explains itself.
 *
 * Allocation is the human resolution of the case the webhook could not resolve
 * automatically — money that cleared at Paymob but referenced an order we could
 * not find. That happens for dull reasons: a buyer typing an old order code into
 * a bank transfer reference, a partial payment against the wrong invoice. The
 * money is real either way, and it has to end up attached to something.
 */

import { and, eq, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import { orders, orderTermVersions, payments } from '@reharvest/db/schema';
import { appendAudit } from './payment-postgres.ts';
import { ServiceError } from '../service/lot-order-service.ts';
import type { Principal } from '../auth.ts';

type Db = PostgresJsDatabase<Record<string, never>>;

const DEPOSIT_BPS = 3000n;

export interface AllocationResult {
  readonly orderCode: string;
  readonly amountPiastres: bigint;
  readonly depositDuePiastres: bigint;
  /** Everything reconciled against the order, including this allocation. */
  readonly totalReconciledPiastres: bigint;
  /** True when this allocation was enough to clear the deposit and move the order. */
  readonly orderAdvanced: boolean;
}

/**
 * Attaches an unattributed payment to an order.
 *
 * The rules, and why each exists:
 *
 * - **Only UNMATCHED or RECEIVED payments can be allocated.** Re-allocating a
 *   payment that already cleared would let one transfer pay two orders.
 *
 * - **The order must exist and must be awaiting a deposit.** Allocating money
 *   to a cancelled order is how funds become unrecoverable in practice — the
 *   ledger says paid, the operation says nothing is happening.
 *
 * - **An allocation short of the deposit records the money but does not advance
 *   the order.** Same rule the webhook follows. A person allocating by hand must
 *   not be able to do what the automated path correctly refuses.
 *
 * - **The allocating user is recorded.** This is a manual money movement; it
 *   needs a name against it forever.
 */
export async function allocatePayment(
  db: Db,
  input: { paymentId: string; orderCode: string; actor: Principal; at: string },
): Promise<AllocationResult> {
  return db.transaction(async (tx) => {
    /*
      SELECT ... FOR UPDATE, not a plain read.

      Two ops agents allocating the same payment to two different orders at the
      same moment both used to succeed: 2,100 EGP cleared 4,200 EGP of produce.
      Reproduced through the HTTP routes before this lock existed. The row lock
      serialises them, so the second one arrives to find the payment already
      reconciled and is refused.
    */
    const locked = await tx.execute(sql`
      SELECT id, state, amount_piastres, order_id
        FROM payments
       WHERE id = ${input.paymentId}
       FOR UPDATE
    `);

    const payment = (locked as unknown as Array<Record<string, unknown>>)[0];
    if (!payment) {
      throw new ServiceError('That payment no longer exists.', 'PAYMENT_NOT_FOUND', 'D22', 'Refresh the queue.', 404);
    }

    const paymentState = String(payment.state);
    const paymentAmount = BigInt(String(payment.amount_piastres));

    if (paymentState !== 'UNMATCHED' && paymentState !== 'RECEIVED') {
      throw new ServiceError(
        `This payment is already ${paymentState.toLowerCase()} and cannot be allocated again.`,
        'PAYMENT_ALREADY_ALLOCATED',
        'D22',
        'If it went to the wrong order, raise a reversal rather than allocating it twice.',
      );
    }

    const code = input.orderCode.trim().toUpperCase();
    const [order] = await tx.select().from(orders).where(eq(orders.orderCode, code)).limit(1);
    if (!order) {
      throw new ServiceError(
        `No order with the code ${code}.`,
        'ORDER_NOT_FOUND',
        'D22',
        'Check the code against the orders list. The money stays in this queue until it matches something real.',
      );
    }

    if (order.state === 'CANCELLED' || order.state === 'SETTLED') {
      throw new ServiceError(
        `Order ${code} is ${String(order.state).toLowerCase()}.`,
        'ORDER_NOT_OPEN',
        'D22',
        'Allocate to an open order, or start a refund. Money attached to a closed order goes missing operationally even though the ledger looks tidy.',
      );
    }

    const [terms] = await tx
      .select()
      .from(orderTermVersions)
      .where(eq(orderTermVersions.orderId, order.id))
      .orderBy(sql`${orderTermVersions.version} DESC`)
      .limit(1);

    if (!terms) {
      throw new ServiceError(
        `Order ${code} has no agreed terms.`,
        'ORDER_TERMS_MISSING',
        'D24',
        'An order with no terms cannot be priced, so nothing can be allocated to it.',
      );
    }

    const total = (terms.pricePerKgPiastres * terms.quantityGrams + 500n) / 1000n;
    const depositDue = (total * DEPOSIT_BPS + 5000n) / 10000n;

    /*
      Every payment already reconciled against this order, plus the one being
      allocated now.

      This used to count only CLEARED payments, which meant a payment short of
      the deposit was recorded as RECEIVED and then never counted again.
      Allocating 1,000 and then 1,100 against a 2,100 deposit left the order
      unpaid forever, even though the buyer had paid in full across two
      transfers. Reconciled money counts, whether or not it covered the deposit
      on its own.
    */
    const priorRows = await tx.execute(sql`
      SELECT coalesce(sum(amount_piastres), 0)::text AS sum
        FROM payments
       WHERE order_id = ${order.id}
         AND state IN ('RECONCILED', 'CLEARED')
    `);
    const prior = BigInt(String((priorRows as unknown as Array<Record<string, unknown>>)[0]?.sum ?? '0'));

    const paidAfter = prior + paymentAmount;
    const coversDeposit = paidAfter >= depositDue;

    /*
      The payment becomes RECONCILED unconditionally. Attachment and coverage
      are different facts: this money now belongs to this order and can never be
      allocated elsewhere, regardless of whether it was enough on its own.
    */
    await tx.execute(sql`
      UPDATE payments
         SET order_id = ${order.id},
             party_id = ${order.buyerId},
             state = 'RECONCILED',
             reconciled_at = ${input.at}::timestamptz,
             reconciled_by = ${input.actor.userId}::uuid,
             cleared_at = ${coversDeposit ? input.at : null}::timestamptz
       WHERE id = ${input.paymentId}
         AND state IN ('UNMATCHED', 'RECEIVED')
    `);

    let advanced = false;
    if (coversDeposit && order.state === 'DEPOSIT_PENDING') {
      const moved = await tx
        .update(orders)
        .set({ state: 'DEPOSIT_CLEARED' as never, version: sql`${orders.version} + 1` })
        .where(and(eq(orders.id, order.id), eq(orders.version, order.version)))
        .returning({ id: orders.id });
      advanced = moved.length > 0;
    }

    await appendAudit(tx as unknown as Db, {
      actorId: input.actor.userId,
      actorRoles: input.actor.roles,
      action: 'payment.allocated',
      subjectTable: 'payments',
      subjectId: input.paymentId,
      decision: 'allowed',
      reasonCode: coversDeposit ? 'ALLOCATED_DEPOSIT_CLEARED' : 'ALLOCATED_STILL_SHORT',
      domainId: 'D22',
      beforeState: { state: paymentState, orderId: payment.order_id ?? null },
      afterState: {
        orderCode: code,
        amountPiastres: paymentAmount.toString(),
        totalReconciledPiastres: paidAfter.toString(),
        depositDuePiastres: depositDue.toString(),
        orderAdvanced: advanced,
      },
      at: input.at,
    });

    return {
      orderCode: code,
      amountPiastres: paymentAmount,
      depositDuePiastres: depositDue,
      totalReconciledPiastres: paidAfter,
      orderAdvanced: advanced,
    };
  });
}

/**
 * Approves an outbound payout.
 *
 * Two rules, both of which the database also enforces, because a control that
 * lives only in application code is one refactor away from not existing:
 *
 * - The approver cannot be the person who prepared it (D28).
 * - A beneficiary whose bank details changed inside 24 hours cannot be paid.
 *
 * Doing the check here as well means the console can explain the refusal in
 * words rather than surfacing a Postgres constraint violation to a finance clerk.
 */
export async function approvePayout(
  db: Db,
  input: { paymentId: string; actor: Principal; at: string },
): Promise<{ amountPiastres: bigint }> {
  return db.transaction(async (tx) => {
    const [payment] = await tx.select().from(payments).where(eq(payments.id, input.paymentId)).limit(1);
    if (!payment) {
      throw new ServiceError('That payout no longer exists.', 'PAYMENT_NOT_FOUND', 'D28', 'Refresh the queue.', 404);
    }

    if (payment.direction !== 'outbound') {
      throw new ServiceError(
        'That is an incoming payment, not a payout.',
        'NOT_A_PAYOUT',
        'D28',
        'Incoming money is allocated from the unmatched queue instead.',
      );
    }

    if (payment.state !== 'PENDING_APPROVAL') {
      throw new ServiceError(
        `This payout is ${String(payment.state).toLowerCase()} and is not waiting for approval.`,
        'PAYOUT_NOT_PENDING',
        'D28',
        'Only a payout in pending approval can be approved.',
      );
    }

    if (payment.preparedBy === input.actor.userId) {
      throw new ServiceError(
        'You cannot approve a payment you prepared.',
        'SELF_APPROVAL_FORBIDDEN',
        'D28',
        'Ask a colleague with finance access to approve it. Same-person prepare-and-approve is the control auditors look for first.',
      );
    }

    if (!input.actor.roles.some((r) => ['finance', 'ops_manager', 'executive'].includes(r))) {
      throw new ServiceError(
        'Your role cannot approve payouts.',
        'ROLE_NOT_PERMITTED',
        'D28',
        'Approval needs a finance, ops manager or executive role.',
      );
    }

    await tx
      .update(payments)
      .set({ state: 'APPROVED' as never, approvedBy: input.actor.userId })
      .where(eq(payments.id, payment.id));

    await appendAudit(tx as unknown as Db, {
      actorId: input.actor.userId,
      actorRoles: input.actor.roles,
      action: 'payout.approved',
      subjectTable: 'payments',
      subjectId: payment.id,
      decision: 'allowed',
      reasonCode: 'DUAL_APPROVAL_SATISFIED',
      domainId: 'D28',
      beforeState: { state: payment.state, approvedBy: payment.approvedBy },
      afterState: { state: 'APPROVED', approvedBy: input.actor.userId, preparedBy: payment.preparedBy },
      at: input.at,
    });

    return { amountPiastres: payment.amountPiastres };
  });
}

/**
 * Submits an approved payout to the provider.
 *
 * Separate from approval on purpose. Approval is a human decision; submission is
 * a network call that can time out, fail, or succeed without us hearing back.
 * Collapsing them means the moment a second person clicks "approve" the money is
 * either gone or in an unknown state, with no row recording which.
 *
 * The states are therefore:
 *
 *   PENDING_APPROVAL  a second person has not agreed yet
 *   APPROVED          agreed, not yet sent
 *   SUBMITTED_TO_PSP  sent, outcome unknown
 *   CLEARED / FAILED  the provider told us what happened
 *
 * SUBMITTED_TO_PSP is the state that matters. Without it, a timeout looks
 * identical to "never sent", and the safe-looking action — retry — is how a
 * supplier gets paid twice.
 */
export async function submitPayout(
  db: Db,
  input: {
    paymentId: string;
    actor: Principal;
    at: string;
    /** Performs the transfer. Must be idempotent on the key it is given. */
    send: (args: { idempotencyKey: string; amountPiastres: bigint }) => Promise<{
      providerTransactionId: string;
      status: 'accepted' | 'failed';
      failureReason?: string;
    }>;
  },
): Promise<{ state: 'SUBMITTED_TO_PSP' | 'FAILED'; providerTransactionId?: string }> {
  // Claim the row first, in its own transaction, so two operators clicking
  // "send" cannot both reach the provider.
  const claimed = await db.transaction(async (tx) => {
    const rows = await tx.execute(sql`
      SELECT id, state, amount_piastres, approved_by, idempotency_key
        FROM payments
       WHERE id = ${input.paymentId}
       FOR UPDATE
    `);
    const row = (rows as unknown as Array<Record<string, unknown>>)[0];
    if (!row) throw new ServiceError('That payout no longer exists.', 'PAYMENT_NOT_FOUND', 'D28', 'Refresh.', 404);

    if (String(row.state) !== 'APPROVED') {
      throw new ServiceError(
        `This payout is ${String(row.state).toLowerCase()} and cannot be submitted.`,
        'PAYOUT_NOT_APPROVED',
        'D28',
        'Only an approved payout can be sent to the provider.',
      );
    }

    if (!row.approved_by) {
      throw new ServiceError(
        'This payout has no recorded approver.',
        'PAYOUT_NOT_APPROVED',
        'D28',
        'It must be approved by someone other than whoever prepared it.',
      );
    }

    await tx.execute(sql`
      UPDATE payments SET state = 'SUBMITTED_TO_PSP', submitted_at = ${input.at}::timestamptz
       WHERE id = ${input.paymentId}
    `);

    return {
      amount: BigInt(String(row.amount_piastres)),
      idempotencyKey: String(row.idempotency_key),
    };
  });

  /*
    The provider call happens OUTSIDE the transaction, deliberately.

    Holding a database transaction open across a network call means a slow
    provider holds a row lock for its entire timeout, and a provider outage
    becomes a database outage. The row is already marked SUBMITTED_TO_PSP, so a
    crash here leaves a state that says exactly what is true: we sent it and do
    not yet know the outcome.
  */
  let result;
  try {
    result = await input.send({ idempotencyKey: claimed.idempotencyKey, amountPiastres: claimed.amount });
  } catch (e) {
    // Deliberately NOT reverted to APPROVED. The request may have arrived. It
    // stays SUBMITTED_TO_PSP for reconciliation against the provider's report.
    await appendAudit(db, {
      actorId: input.actor.userId,
      actorRoles: input.actor.roles,
      action: 'payout.submission_uncertain',
      subjectTable: 'payments',
      subjectId: input.paymentId,
      decision: 'allowed',
      reasonCode: 'PROVIDER_UNREACHABLE',
      domainId: 'D28',
      afterState: { error: (e as Error).message },
      at: input.at,
    });
    throw new ServiceError(
      'The payment provider did not respond. This payout may or may not have been sent.',
      'PROVIDER_UNREACHABLE',
      'D28',
      'Do not retry. Reconcile against the provider statement first — retrying an accepted payout pays twice.',
      502,
    );
  }

  const finalState = result.status === 'accepted' ? 'SUBMITTED_TO_PSP' : 'FAILED';

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE payments
         SET state = ${finalState},
             provider_transaction_id = ${result.providerTransactionId}
       WHERE id = ${input.paymentId}
    `);

    await appendAudit(tx as unknown as Db, {
      actorId: input.actor.userId,
      actorRoles: input.actor.roles,
      action: result.status === 'accepted' ? 'payout.submitted' : 'payout.failed',
      subjectTable: 'payments',
      subjectId: input.paymentId,
      decision: 'allowed',
      reasonCode: result.status === 'accepted' ? 'SENT_TO_PROVIDER' : 'PROVIDER_REJECTED',
      domainId: 'D28',
      afterState: { providerTransactionId: result.providerTransactionId, failureReason: result.failureReason },
      at: input.at,
    });
  });

  return { state: finalState, providerTransactionId: result.providerTransactionId };
}

/**
 * Records the provider's final word on a payout.
 *
 * Called from the provider's disbursement callback. Only a payout we actually
 * sent can be settled: a callback for something in PENDING_APPROVAL means either
 * a forged request or a serious bug, and either way must not mark money paid.
 */
export async function settlePayout(
  db: Db,
  input: { providerTransactionId: string; outcome: 'paid' | 'failed'; failureReason?: string; at: string },
): Promise<{ changed: boolean }> {
  return db.transaction(async (tx) => {
    const rows = await tx.execute(sql`
      SELECT id, state FROM payments
       WHERE provider_transaction_id = ${input.providerTransactionId}
         AND direction = 'outbound'
       FOR UPDATE
    `);
    const row = (rows as unknown as Array<Record<string, unknown>>)[0];
    if (!row) return { changed: false };

    const state = String(row.state);
    // Already final. A duplicate callback must not rewrite history.
    if (state === 'CLEARED' || state === 'FAILED') return { changed: false };
    if (state !== 'SUBMITTED_TO_PSP') return { changed: false };

    const next = input.outcome === 'paid' ? 'CLEARED' : 'FAILED';
    await tx.execute(sql`
      UPDATE payments SET state = ${next}, cleared_at = ${input.outcome === 'paid' ? input.at : null}::timestamptz
       WHERE id = ${String(row.id)}::uuid
    `);

    await appendAudit(tx as unknown as Db, {
      actorId: SYSTEM_ACTOR,
      actorRoles: ['finance'],
      action: `payout.${input.outcome}`,
      subjectTable: 'payments',
      subjectId: String(row.id),
      decision: 'allowed',
      reasonCode: input.outcome === 'paid' ? 'PROVIDER_CONFIRMED_PAID' : 'PROVIDER_CONFIRMED_FAILED',
      domainId: 'D28',
      beforeState: { state },
      afterState: { state: next, failureReason: input.failureReason },
      at: input.at,
    });

    return { changed: true };
  });
}

const SYSTEM_ACTOR = '00000000-0000-4000-8000-000000000000';
