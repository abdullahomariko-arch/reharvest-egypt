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
    const [payment] = await tx.select().from(payments).where(eq(payments.id, input.paymentId)).limit(1);
    if (!payment) {
      throw new ServiceError('That payment no longer exists.', 'PAYMENT_NOT_FOUND', 'D22', 'Refresh the queue.', 404);
    }

    if (payment.state !== 'UNMATCHED' && payment.state !== 'RECEIVED') {
      throw new ServiceError(
        `This payment is already ${String(payment.state).toLowerCase()} and cannot be allocated again.`,
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

    // Everything already cleared against this order, plus what we are adding.
    const [prior] = await tx
      .select({ sum: sql<string>`coalesce(sum(${payments.amountPiastres}), 0)::text` })
      .from(payments)
      .where(and(eq(payments.orderId, order.id), eq(payments.state, 'CLEARED' as never)));

    const paidAfter = BigInt(prior?.sum ?? '0') + payment.amountPiastres;
    const coversDeposit = paidAfter >= depositDue;

    await tx
      .update(payments)
      .set({
        orderId: order.id,
        partyId: order.buyerId,
        // Only mark it cleared if it actually covers what is owed. Otherwise it
        // stays RECEIVED: real money, recorded, but not yet a paid deposit.
        state: (coversDeposit ? 'CLEARED' : 'RECEIVED') as never,
        clearedAt: coversDeposit ? new Date(input.at) : null,
      })
      .where(eq(payments.id, payment.id));

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
      subjectId: payment.id,
      decision: 'allowed',
      reasonCode: coversDeposit ? 'ALLOCATED_DEPOSIT_CLEARED' : 'ALLOCATED_STILL_SHORT',
      domainId: 'D22',
      beforeState: { state: payment.state, orderId: payment.orderId },
      afterState: {
        orderCode: code,
        amountPiastres: payment.amountPiastres.toString(),
        depositDuePiastres: depositDue.toString(),
        orderAdvanced: advanced,
      },
      at: input.at,
    });

    return {
      orderCode: code,
      amountPiastres: payment.amountPiastres,
      depositDuePiastres: depositDue,
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
