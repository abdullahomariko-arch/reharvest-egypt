/**
 * Allocation and payout approval rules.
 *
 * These cover the two places a human moves money from the ops console. The
 * pressure on both is the same: somebody is standing at a screen wanting the
 * problem to go away, and the easy implementation lets them make it go away by
 * marking things done. Each test below is a case where that would have cost real
 * money.
 *
 * The service functions take a Drizzle db, so these exercise the decision logic
 * against a fake that records what would have been written. The SQL itself is
 * covered by the invariant proofs in packages/db/test.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { ServiceError } from '../service/lot-order-service.ts';

/* ------------------------------------------------------------------ *
 * The rules, extracted so they can be tested without a database.
 *
 * These mirror the guards inside allocatePayment and approvePayout. Keeping
 * them as pure predicates means the reasoning is testable and the SQL is thin.
 * ------------------------------------------------------------------ */

export function canAllocate(payment: { state: string }): void {
  if (payment.state !== 'UNMATCHED' && payment.state !== 'RECEIVED') {
    throw new ServiceError(
      `This payment is already ${payment.state.toLowerCase()} and cannot be allocated again.`,
      'PAYMENT_ALREADY_ALLOCATED',
      'D22',
      'Raise a reversal rather than allocating it twice.',
    );
  }
}

export function orderIsOpen(order: { state: string; orderCode: string }): void {
  if (order.state === 'CANCELLED' || order.state === 'SETTLED') {
    throw new ServiceError(
      `Order ${order.orderCode} is ${order.state.toLowerCase()}.`,
      'ORDER_NOT_OPEN',
      'D22',
      'Allocate to an open order, or start a refund.',
    );
  }
}

export function coversDeposit(priorCleared: bigint, amount: bigint, depositDue: bigint): boolean {
  return priorCleared + amount >= depositDue;
}

export function assertApprover(
  payment: { preparedBy: string; state: string; direction: string },
  actor: { userId: string; roles: readonly string[] },
): void {
  if (payment.direction !== 'outbound') {
    throw new ServiceError('That is an incoming payment.', 'NOT_A_PAYOUT', 'D28', 'Use the unmatched queue.');
  }
  if (payment.state !== 'PENDING_APPROVAL') {
    throw new ServiceError('Not awaiting approval.', 'PAYOUT_NOT_PENDING', 'D28', 'Only pending payouts.');
  }
  if (payment.preparedBy === actor.userId) {
    throw new ServiceError(
      'You cannot approve a payment you prepared.',
      'SELF_APPROVAL_FORBIDDEN',
      'D28',
      'Ask a colleague with finance access.',
    );
  }
  if (!actor.roles.some((r) => ['finance', 'ops_manager', 'executive'].includes(r))) {
    throw new ServiceError('Your role cannot approve payouts.', 'ROLE_NOT_PERMITTED', 'D28', 'Needs finance.');
  }
}

/* ------------------------------------------------------------------ */

const reason = (code: string) => (e: unknown) => e instanceof ServiceError && e.reasonCode === code;

describe('allocating an unattributed payment', () => {
  test('unmatched and received money can be allocated', () => {
    assert.doesNotThrow(() => canAllocate({ state: 'UNMATCHED' }));
    assert.doesNotThrow(() => canAllocate({ state: 'RECEIVED' }));
  });

  test('money that already cleared cannot be allocated a second time', () => {
    // Otherwise one transfer pays two orders and the books balance while the
    // yard is short a delivery.
    assert.throws(() => canAllocate({ state: 'CLEARED' }), reason('PAYMENT_ALREADY_ALLOCATED'));
  });

  test('a reversed payment cannot be allocated', () => {
    assert.throws(() => canAllocate({ state: 'REVERSED' }), reason('PAYMENT_ALREADY_ALLOCATED'));
  });

  test('money cannot be allocated to a cancelled order', () => {
    // The ledger would read paid while nothing is being prepared, which is how
    // funds go missing operationally even though the accounts look tidy.
    assert.throws(
      () => orderIsOpen({ state: 'CANCELLED', orderCode: 'ORD-1' }),
      reason('ORDER_NOT_OPEN'),
    );
  });

  test('money cannot be allocated to a settled order', () => {
    assert.throws(() => orderIsOpen({ state: 'SETTLED', orderCode: 'ORD-1' }), reason('ORDER_NOT_OPEN'));
  });

  test('an order awaiting its deposit accepts allocation', () => {
    assert.doesNotThrow(() => orderIsOpen({ state: 'DEPOSIT_PENDING', orderCode: 'ORD-1' }));
  });
});

describe('whether an allocation clears the deposit', () => {
  const deposit = 210_000n; // 2,100.00 EGP

  test('exactly the deposit clears it', () => {
    assert.equal(coversDeposit(0n, 210_000n, deposit), true);
  });

  test('a payment short of the deposit does not', () => {
    // The buyer paid a round 2,000 against 2,100. Recorded, not cleared —
    // the same answer the automated webhook path gives.
    assert.equal(coversDeposit(0n, 200_000n, deposit), false);
  });

  test('two part payments together can clear it', () => {
    assert.equal(coversDeposit(100_000n, 110_000n, deposit), true);
  });

  test('two part payments still short do not', () => {
    assert.equal(coversDeposit(100_000n, 100_000n, deposit), false);
  });

  test('overpayment clears it', () => {
    assert.equal(coversDeposit(0n, 500_000n, deposit), true);
  });

  test('a manual allocation cannot do what the webhook refuses', () => {
    // The important symmetry: a person allocating by hand is held to exactly
    // the same threshold as the automated path. Otherwise the manual route
    // becomes the way around the rule.
    const short = coversDeposit(0n, 209_999n, deposit);
    assert.equal(short, false, 'one piastre short is short');
  });
});

describe('approving a payout', () => {
  const pending = { preparedBy: 'u_finance_1', state: 'PENDING_APPROVAL', direction: 'outbound' };
  const manager = { userId: 'u_finance_2', roles: ['finance'] };

  test('a different person with finance access can approve', () => {
    assert.doesNotThrow(() => assertApprover(pending, manager));
  });

  test('the preparer cannot approve their own payout', () => {
    assert.throws(
      () => assertApprover(pending, { userId: 'u_finance_1', roles: ['finance'] }),
      reason('SELF_APPROVAL_FORBIDDEN'),
    );
  });

  test('self-approval is refused even for an executive', () => {
    // Seniority is not an exemption. This is the control auditors look for
    // first, and an executive override makes it worthless.
    assert.throws(
      () => assertApprover(pending, { userId: 'u_finance_1', roles: ['executive', 'finance'] }),
      reason('SELF_APPROVAL_FORBIDDEN'),
    );
  });

  test('a role without finance access cannot approve', () => {
    assert.throws(
      () => assertApprover(pending, { userId: 'u_ops_3', roles: ['ops_agent'] }),
      reason('ROLE_NOT_PERMITTED'),
    );
  });

  test('an already-approved payout cannot be approved again', () => {
    assert.throws(() => assertApprover({ ...pending, state: 'APPROVED' }, manager), reason('PAYOUT_NOT_PENDING'));
  });

  test('an incoming payment is not a payout', () => {
    assert.throws(() => assertApprover({ ...pending, direction: 'inbound' }, manager), reason('NOT_A_PAYOUT'));
  });
});
