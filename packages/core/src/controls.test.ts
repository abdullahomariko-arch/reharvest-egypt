/**
 * Acceptance tests, keyed to the domain IDs in the risk catalog.
 *
 * The rule for this file: a control that has no failing-path test here is not
 * implemented, no matter what the code says. Each `describe` name is the domain
 * id so a reviewer can walk D01..D54 and see coverage without reading the code.
 *
 * Run: node --experimental-strip-types --test packages/core/src/controls.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { Money, egp, MoneyError } from './money.ts';
import { kg, grams, crates, Qty, QuantityError, assertSettlementWeight } from './quantity.ts';
import {
  availableToPromise,
  assertReservable,
  reconcileInventory,
  computeMargin,
  assertMarginFloor,
  assertCanCommitCash,
  assertConcentrationCeiling,
  InvariantViolation,
} from './invariants.ts';
import {
  orderMachine,
  lotMachine,
  paymentMachine,
  assertMayCreateProcurementExposure,
  assertLotIsTradeable,
  TransitionDenied,
  type TransitionContext,
} from './state-machines.ts';
import { buildP0Registry, ControlBlocked, type AuditEntry } from './guard.ts';
import { CONTROLS, blockingControls } from './controls.generated.ts';

const ctx = (over: Partial<TransitionContext> = {}): TransitionContext => ({
  actorId: 'u_ops_1',
  actorRoles: ['ops_agent'],
  at: '2026-08-16T09:00:00Z',
  actorCreatedRecord: false,
  idempotencyKey: 'idem_1',
  reasons: [],
  ...over,
});

const collector = () => {
  const entries: AuditEntry[] = [];
  return { sink: { record: (e: AuditEntry) => entries.push(e) }, entries };
};

/* ---------------------------------------------------------------- */

describe('registry integrity', () => {
  test('all 54 domains are present and every BLOCK rule is named', () => {
    assert.equal(Object.keys(CONTROLS).length, 54);
    assert.ok(blockingControls().length > 30);
    for (const c of Object.values(CONTROLS)) {
      assert.ok(c.hardRule.length > 0, `${c.domainId} has no hard rule`);
      assert.ok(c.acceptanceTests.length >= 6, `${c.domainId} has too few acceptance tests`);
    }
  });
});

describe('D51 — ambiguous units and money precision', () => {
  test('money never uses floating point', () => {
    const price = egp.fromDecimalString('12.35');
    assert.equal(price.amount, 1235n);
    // The classic float failure: 0.1 + 0.2. In piastres it is exact.
    const sum = Money.add(egp.fromDecimalString('0.10'), egp.fromDecimalString('0.20'));
    assert.equal(Money.format(sum, 'en-EG'), 'EGP 0.30');
  });

  test('three decimal places are rejected, not silently rounded', () => {
    assert.throws(() => egp.fromDecimalString('12.345'), MoneyError);
  });

  test('Arabic-Indic digits and the Arabic decimal separator parse correctly', () => {
    assert.equal(egp.fromDecimalString('١٢٫٥').amount, 1250n);
  });

  test('kilograms and crates cannot be added', () => {
    assert.throws(() => Qty.add(kg(10), crates(2)), QuantityError);
  });

  test('allocation loses no piastre across three parties', () => {
    const parts = Money.allocate(egp.fromDecimalString('100.00'), [1n, 1n, 1n]);
    assert.equal(Money.sum(parts).amount, 10000n);
  });
});

describe('D34 — weighing, tare and settlement weight', () => {
  test('net weight is gross minus tare', () => {
    assert.equal(Qty.net(kg(812.5), kg(12.5)).value, 800_000n);
  });

  test('a tare heavier than the gross blocks instead of clamping to zero', () => {
    assert.throws(() => Qty.net(kg(10), kg(12)), /QTY_NET_NOT_POSITIVE|Re-weigh/);
  });

  test('nominal crate weight cannot settle money', () => {
    assert.throws(
      () => assertSettlementWeight({ kind: 'nominal-from-packaging', specId: 'CR-40', version: 3 }),
      QuantityError,
    );
  });

  test('an expired scale calibration blocks settlement', () => {
    assert.throws(
      () =>
        assertSettlementWeight({
          kind: 'verified-scale',
          scaleId: 'SC-02',
          calibrationValidUntil: '2026-01-01T00:00:00Z',
          capturedBy: 'u_insp_3',
          capturedAt: '2026-08-16T08:00:00Z',
        }),
      /calibration expired/,
    );
  });

  test('price x weight is exact at the piastre', () => {
    // 8.75 EGP/kg over 800.000 kg = 7,000.00 EGP exactly
    const line = Money.perKgTimesGrams(egp.fromDecimalString('8.75'), 800_000n);
    assert.equal(Money.format(line, 'en-EG'), 'EGP 7,000.00');
  });
});

describe('D09 / D39 — lot reservation and double-selling', () => {
  const position = {
    lotId: 'LOT-2026-0814-TOM-017',
    acceptedKg: kg(800),
    reservedKg: kg(500),
    heldKg: kg(0),
    rejectedKg: kg(40),
    disposedKg: kg(0),
  };

  test('available to promise subtracts reserved, held, rejected and disposed', () => {
    assert.equal(availableToPromise(position).value, 260_000n);
  });

  test('a second buyer cannot reserve past the physical lot', () => {
    assert.throws(() => assertReservable(position, kg(300)), InvariantViolation);
  });

  test('negative ATP is treated as a double-sell, not a display bug', () => {
    assert.throws(
      () => availableToPromise({ ...position, reservedKg: kg(900) }),
      /over-committed/,
    );
  });

  test('a held lot cannot be sold, mixed or settled', () => {
    assert.throws(() => assertLotIsTradeable('QUARANTINED', 'LOT-1'), TransitionDenied);
  });
});

describe('D14 / D17 — interest is not confirmed demand', () => {
  test('a quoted order cannot authorise buying produce', () => {
    assert.throws(() => assertMayCreateProcurementExposure('QUOTED'), /not confirmed demand/);
  });

  test('a confirmed order can', () => {
    assert.doesNotThrow(() => assertMayCreateProcurementExposure('CONFIRMED'));
  });

  test('a deposit only clears when the funds are matched to a bank line', () => {
    assert.throws(
      () => orderMachine.next('DEPOSIT_PENDING', 'deposit_cleared', ctx({ actorRoles: ['finance'] })),
      /screenshot is not cleared money/,
    );
    assert.equal(
      orderMachine.next(
        'DEPOSIT_PENDING',
        'deposit_cleared',
        ctx({ actorRoles: ['finance'], reasons: ['funds_matched_to_bank_reference'] }),
      ),
      'DEPOSIT_CLEARED',
    );
  });

  test('confirming without a deposit needs an approved credit line and a second person', () => {
    assert.throws(
      () => orderMachine.next('CONDITIONAL', 'confirm', ctx({ actorRoles: ['ops_manager'] })),
      /approved credit line/,
    );
    assert.throws(
      () =>
        orderMachine.next(
          'CONDITIONAL',
          'confirm',
          ctx({
            actorRoles: ['ops_manager'],
            actorCreatedRecord: true,
            reasons: ['buyer_has_approved_credit_line'],
          }),
        ),
      /cannot approve a record you created/,
    );
  });

  test('cancelling confirmed demand requires naming who absorbs the stranded cost', () => {
    assert.throws(
      () => orderMachine.next('CONFIRMED', 'cancel', ctx({ actorRoles: ['ops_manager'] })),
      /stranded|strands/,
    );
  });
});

describe('D30 / D31 — sampling and food safety', () => {
  test('inspection cannot pass without a complete sample plan', () => {
    assert.throws(
      () => lotMachine.next('INSPECTION_PENDING', 'pass_inspection', ctx({ actorRoles: ['inspector'] })),
      /sample plan/,
    );
  });

  test('a quarantined lot is released only by a food safety officer on a recorded basis', () => {
    assert.throws(
      () => lotMachine.next('QUARANTINED', 'food_safety_release', ctx({ actorRoles: ['ops_manager'] })),
      /food_safety_officer/,
    );
    assert.throws(
      () =>
        lotMachine.next('QUARANTINED', 'food_safety_release', ctx({ actorRoles: ['food_safety_officer'] })),
      /recorded, authorised basis/,
    );
    assert.equal(
      lotMachine.next(
        'QUARANTINED',
        'food_safety_release',
        ctx({ actorRoles: ['food_safety_officer'], reasons: ['lab_or_documented_basis_recorded'] }),
      ),
      'AVAILABLE',
    );
  });

  test('there is no path from QUARANTINED to a discounted sale', () => {
    assert.equal(lotMachine.can('QUARANTINED', 'release_to_order'), false);
    assert.equal(lotMachine.can('QUARANTINED', 'reserve'), false);
  });
});

describe('D21 — margin integrity', () => {
  const base = {
    acceptedSaleWeightGrams: 800_000n,
    buyerPricePerKg: egp.fromDecimalString('11.00'),
    acceptedPurchaseWeightGrams: 800_000n,
    supplierPricePerKg: egp.fromDecimalString('6.50'),
    packaging: egp.fromDecimalString('350.00'),
    labour: egp.fromDecimalString('600.00'),
    storage: egp.fromDecimalString('120.00'),
    financeCost: egp.fromDecimalString('80.00'),
    taxesAndFees: egp.fromDecimalString('140.00'),
    expectedRejectCost: egp.fromDecimalString('520.00'),
    otherVariableCost: egp.fromDecimalString('90.00'),
    downsideYieldLossBps: 800,
  };

  test('a missing cost line blocks rather than defaulting to zero', () => {
    const { packaging, ...withoutPackaging } = base;
    assert.throws(
      () => computeMargin(withoutPackaging as never),
      /shows a profit that does not exist/,
    );
  });

  test('contribution is computed from every line', () => {
    const r = computeMargin(base);
    // 8800 revenue - 5200 produce - 1900 costs = 1700.00
    assert.equal(Money.format(r.contribution, 'en-EG'), 'EGP 1,700.00');
  });

  test('an order that only works in the optimistic case is blocked', () => {
    const thin = computeMargin({ ...base, buyerPricePerKg: egp.fromDecimalString('7.30') });
    assert.throws(() => assertMarginFloor(thin, 800), InvariantViolation);
  });
});

describe('D23 / D19 — cash buffer and concentration', () => {
  test('a commitment that eats the buffer is blocked', () => {
    assert.throws(
      () =>
        assertCanCommitCash(
          {
            clearedCash: egp.fromPounds(50_000),
            highConfidenceInflows: egp.fromPounds(10_000),
            authorisedOutflows: egp.fromPounds(20_000),
            committedOutflows: egp.fromPounds(15_000),
            minimumBuffer: egp.fromPounds(20_000),
          },
          egp.fromPounds(12_000),
        ),
      /minimum cash buffer/,
    );
  });

  test('concentration is a share of exposure, not a count of buyers', () => {
    assert.throws(
      () => assertConcentrationCeiling(egp.fromPounds(80_000), egp.fromPounds(100_000), 3500, 'Buyer A'),
      /ceiling/,
    );
  });
});

describe('D39 / D40 — inventory reconciliation', () => {
  test('an unexplained shortfall is reported with a direction, not hidden', () => {
    const r = reconcileInventory({
      openingKg: kg(1000),
      acceptedInKg: kg(800),
      soldOrUsedKg: kg(1500),
      rejectedKg: kg(50),
      disposedKg: kg(20),
      closingKg: kg(200),
      toleranceGrams: 5_000n,
    });
    assert.equal(r.withinTolerance, false);
    assert.equal(r.varianceGrams, 30_000n);
    assert.match(r.explanation, /shortfall/);
  });
});

describe('D26 / D28 / D47 — payment approval and beneficiary change', () => {
  test('a changed bank account cannot be paid the same day', () => {
    const { sink } = collector();
    const registry = buildP0Registry(sink);
    assert.throws(
      () =>
        registry.assert({
          domainId: 'D28',
          action: 'payment.submit',
          subjectId: 'PAY-1',
          actorId: 'u_fin_1',
          actorRoles: ['finance'],
          at: '2026-08-16T09:00:00Z',
          idempotencyKey: 'k1',
          evidence: [],
          facts: { beneficiaryChangedAt: '2026-08-16T06:00:00Z' },
        }),
      ControlBlocked,
    );
  });

  test('the payer cannot approve their own payout', () => {
    assert.throws(
      () =>
        paymentMachine.next(
          'PENDING_APPROVAL',
          'approve',
          ctx({ actorRoles: ['ops_manager'], actorCreatedRecord: true }),
        ),
      /cannot approve a record you created/,
    );
  });

  test('an irreversible payment without an idempotency key is refused', () => {
    assert.throws(
      () => paymentMachine.next('APPROVED', 'submit', ctx({ actorRoles: ['finance'], idempotencyKey: '' })),
      /idempotency key/,
    );
  });
});

describe('D53 / D54 — offline replay and autonomous decisions', () => {
  test('an unkeyed irreversible action is blocked and audited', () => {
    const { sink, entries } = collector();
    const registry = buildP0Registry(sink);
    assert.throws(
      () =>
        registry.assert({
          domainId: 'D53',
          action: 'payment.submit',
          subjectId: 'PAY-2',
          actorId: 'u_fin_1',
          actorRoles: ['finance'],
          at: '2026-08-16T09:00:00Z',
          evidence: [],
          facts: {},
        }),
      ControlBlocked,
    );
    assert.equal(entries.at(-1)?.decision, 'BLOCK');
    assert.equal(entries.at(-1)?.reasonCode, 'IDEMPOTENCY_KEY_MISSING');
  });

  test('no algorithm may release food, decide law, or send an irreversible payment', () => {
    const { sink } = collector();
    const registry = buildP0Registry(sink);
    for (const kind of ['food_safety_release', 'legal_determination', 'irreversible_payment']) {
      assert.throws(
        () =>
          registry.assert({
            domainId: 'D54',
            action: 'automation.execute',
            subjectId: 'AUTO-1',
            actorId: 'system',
            actorRoles: [],
            at: '2026-08-16T09:00:00Z',
            idempotencyKey: 'k',
            evidence: [],
            facts: { automatedDecisionKind: kind },
          }),
        ControlBlocked,
        `${kind} should be blocked`,
      );
    }
  });
});

describe('exception governance', () => {
  test('an exception to a food-safety rule cannot be granted at all', () => {
    const { sink } = collector();
    const registry = buildP0Registry(sink);
    assert.throws(
      () =>
        registry.grantException(
          {
            domainId: 'D31',
            scopeSubjectId: 'LOT-1',
            reason: 'buyer is waiting and the truck is loaded',
            approvedBy: 'u_exec_1',
            approvedAt: '2026-08-16T09:00:00Z',
            expiresAt: '2026-08-16T10:00:00Z',
          },
          ['executive'],
        ),
      /absolute/,
    );
  });

  test('an exception that outlives its ceiling is refused', () => {
    const { sink } = collector();
    const registry = buildP0Registry(sink);
    assert.throws(
      () =>
        registry.grantException(
          {
            domainId: 'D14',
            scopeSubjectId: 'ORD-9',
            reason: 'pre-agreed standing order with Cairo Pizza Group, contract on file',
            approvedBy: 'u_exec_1',
            approvedAt: '2026-08-16T09:00:00Z',
            expiresAt: '2026-08-30T09:00:00Z',
          },
          ['executive'],
        ),
      /at most 48h/,
    );
  });

  test('a granted exception converts a block into an audited allowance', () => {
    const { sink, entries } = collector();
    const registry = buildP0Registry(sink);
    registry.grantException(
      {
        domainId: 'D14',
        scopeSubjectId: 'ORD-9',
        reason: 'standing weekly order, contract on file, approved by CEO',
        approvedBy: 'u_exec_1',
        approvedAt: '2026-08-16T09:00:00Z',
        expiresAt: '2026-08-17T09:00:00Z',
      },
      ['executive'],
    );
    const outcome = registry.evaluate({
      domainId: 'D14',
      action: 'procurement.commit',
      subjectId: 'ORD-9',
      actorId: 'u_ops_1',
      actorRoles: ['ops_agent'],
      at: '2026-08-16T12:00:00Z',
      idempotencyKey: 'k',
      evidence: [],
      facts: { demandState: 'QUOTED' },
    });
    assert.equal(outcome.decision, 'ALLOW_WITH_EXCEPTION');
    assert.ok(entries.at(-1)?.exceptionId);
  });
});
