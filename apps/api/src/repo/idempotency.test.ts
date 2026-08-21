/**
 * Idempotency hashing.
 *
 * The store itself is exercised against a real Postgres in CI; these cover the
 * decision the store makes about whether two requests are "the same".
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { hashRequest, scopeKey } from './idempotency.ts';

describe('request hashing', () => {
  test('the same request hashes the same', () => {
    assert.equal(
      hashRequest('/orders', { lotId: 'a', quantityGrams: '800000' }),
      hashRequest('/orders', { lotId: 'a', quantityGrams: '800000' }),
    );
  });

  test('key order does not change the hash', () => {
    // A client that serialises its body differently between attempts is still
    // retrying. Refusing that would break legitimate retries.
    assert.equal(
      hashRequest('/orders', { lotId: 'a', quantityGrams: '800000' }),
      hashRequest('/orders', { quantityGrams: '800000', lotId: 'a' }),
    );
  });

  test('a different amount is a different request', () => {
    // This is the one that matters: same key, different money.
    assert.notEqual(
      hashRequest('/settlements/1/pay', { amount: '5200' }),
      hashRequest('/settlements/1/pay', { amount: '52000' }),
    );
  });

  test('the same body on a different endpoint is a different request', () => {
    assert.notEqual(hashRequest('/orders', { a: 1 }), hashRequest('/lots', { a: 1 }));
  });

  test('nested key order does not matter either', () => {
    assert.equal(
      hashRequest('/x', { billing: { first: 'a', last: 'b' } }),
      hashRequest('/x', { billing: { last: 'b', first: 'a' } }),
    );
  });

  test('array order does matter, because order is data', () => {
    assert.notEqual(hashRequest('/x', { items: [1, 2] }), hashRequest('/x', { items: [2, 1] }));
  });
});

describe('key scoping', () => {
  const base = { actorId: '00000000-0000-4000-8000-000000000001', method: 'POST', path: '/orders', clientKey: 'retry-1' };

  test('the same key from two different users addresses different rows', () => {
    // Reproduced as a real failure before scoping existed: user B sent user A's
    // key and received A's order back, order code and all.
    const a = scopeKey(base);
    const b = scopeKey({ ...base, actorId: '00000000-0000-4000-8000-000000000002' });
    assert.notEqual(a, b);
  });

  test('the same key on two routes addresses different rows', () => {
    assert.notEqual(scopeKey(base), scopeKey({ ...base, path: '/settlements/1/pay' }));
  });

  test('the same key with a different method addresses different rows', () => {
    assert.notEqual(scopeKey(base), scopeKey({ ...base, method: 'DELETE' }));
  });

  test('method comparison is case-insensitive, so a lowercase verb is the same request', () => {
    assert.equal(scopeKey(base), scopeKey({ ...base, method: 'post' }));
  });

  test('the same actor, route and key is stable across calls', () => {
    assert.equal(scopeKey(base), scopeKey({ ...base }));
  });
});
