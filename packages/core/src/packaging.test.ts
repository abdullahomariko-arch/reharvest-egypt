import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { kg, grams, Qty, CRATE_SPECS, netFromGross, QuantityError } from './quantity.ts';
import { egp, Money } from './money.ts';

describe('crate specs and net weight', () => {
  test('the normal case: 812.5kg gross across 25 crates', () => {
    const net = netFromGross(kg('812.5'), CRATE_SPECS.plastic_standard_v2, 25);
    assert.equal(net.value, 800000n);
    assert.equal(Qty.format(net, 'en-EG'), '800 kg');
  });

  test('the wrong crate template is refused, not clamped', () => {
    assert.throws(
      () => netFromGross(kg('812.5'), CRATE_SPECS.plastic_standard_v2, 1700),
      (e: any) => e instanceof QuantityError && e.reasonCode === 'QTY_NET_NOT_POSITIVE',
    );
  });

  test('a fractional crate count is refused', () => {
    assert.throws(() => netFromGross(kg('812.5'), CRATE_SPECS.plastic_standard_v2, 2.5), QuantityError);
  });

  test('sacks carry a different tare, and it changes the answer', () => {
    const a = netFromGross(kg('500'), CRATE_SPECS.plastic_standard_v2, 10);
    const b = netFromGross(kg('500'), CRATE_SPECS.sack_50kg_v1, 10);
    assert.notEqual(a.value, b.value);
    assert.equal(b.value - a.value, 3200n); // 10 x (500g - 180g)
  });

  test('lot value derives from net weight, in whole piastres', () => {
    const net = netFromGross(kg('812.5'), CRATE_SPECS.plastic_standard_v2, 25);
    const value = Money.perKgTimesGrams(egp.fromDecimalString('8.75'), net.value);
    assert.equal(value.amount, 700000n); // 800kg x 8.75 = 7,000.00 EGP
  });
});
