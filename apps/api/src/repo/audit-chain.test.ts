/**
 * Audit chain tests.
 *
 * The stable-serialisation test at the bottom is a regression guard for a bug
 * that only appeared against a real database: `before_state` and `after_state`
 * are jsonb columns, and Postgres normalises jsonb key order on write. Hashing
 * `JSON.stringify(payload)` therefore produced one string going in and another
 * coming back, so the integrity check reported every healthy chain as tampered
 * with. Unit tests against an in-memory fake could never have caught it, because
 * a JavaScript object round-trips through a Map with its key order intact.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

/** Mirrors the implementation in payment-postgres.ts. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(',')}}`;
}

const hash = (s: string) => createHash('sha256').update(s).digest('hex');

describe('stable serialisation', () => {
  test('key order does not change the hash', () => {
    // This is exactly what jsonb does: same data, different key order.
    const written = { state: 'DEPOSIT_CLEARED', providerTransactionId: 'tx_1', amount: '210000' };
    const readBack = { amount: '210000', providerTransactionId: 'tx_1', state: 'DEPOSIT_CLEARED' };

    assert.notEqual(JSON.stringify(written), JSON.stringify(readBack), 'the naive form differs — this is the bug');
    assert.equal(stableStringify(written), stableStringify(readBack), 'the stable form must not');
  });

  test('nested objects are sorted too', () => {
    const a = { outer: { b: 1, a: 2 }, list: [{ y: 1, x: 2 }] };
    const b = { list: [{ x: 2, y: 1 }], outer: { a: 2, b: 1 } };
    assert.equal(stableStringify(a), stableStringify(b));
  });

  test('different data still produces a different hash', () => {
    // Sorting must not flatten genuinely different payloads together, or the
    // chain would happily accept an altered entry.
    assert.notEqual(
      stableStringify({ amount: '210000' }),
      stableStringify({ amount: '200000' }),
    );
  });

  test('arrays keep their order, because order is data', () => {
    assert.notEqual(stableStringify(['a', 'b']), stableStringify(['b', 'a']));
  });
});

describe('chain linkage', () => {
  const link = (prev: string, payload: unknown) => hash(`${prev}|${stableStringify(payload)}`);

  test('altering a historical entry breaks every hash after it', () => {
    const e1 = link('GENESIS', { seq: 1, amount: '100' });
    const e2 = link(e1, { seq: 2, amount: '200' });
    const e3 = link(e2, { seq: 3, amount: '300' });

    // Someone edits entry 1 in the database.
    const tampered1 = link('GENESIS', { seq: 1, amount: '999' });
    const tampered2 = link(tampered1, { seq: 2, amount: '200' });

    assert.notEqual(tampered1, e1);
    assert.notEqual(tampered2, e2, 'the break must propagate, not stay local');
    assert.notEqual(link(tampered2, { seq: 3, amount: '300' }), e3);
  });

  test('a deleted middle entry is detectable through the prev pointer', () => {
    const e1 = link('GENESIS', { seq: 1 });
    const e2 = link(e1, { seq: 2 });
    const e3 = link(e2, { seq: 3 });

    // Delete entry 2 and entry 3 still claims e2 as its predecessor, which no
    // longer exists. Checking only the hash would miss this; checking the prev
    // pointer against the actual previous row catches it.
    const remaining = [
      { hash: e1, prev: 'GENESIS' },
      { hash: e3, prev: e2 },
    ];
    assert.notEqual(remaining[1].prev, remaining[0].hash);
  });
});
