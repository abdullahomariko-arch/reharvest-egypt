/**
 * Encryption tests.
 *
 * The tampering test is the one that justifies choosing GCM over CBC. For a
 * bank account number, a cipher that silently decrypts altered ciphertext into
 * *different digits* is worse than one that fails: the payment succeeds, to
 * someone else's account, and nothing looks wrong until the supplier calls.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import { Keyring, DecryptionFailed, accountTail } from './crypto.ts';

const k1 = Buffer.from(webcrypto.getRandomValues(new Uint8Array(32))).toString('base64');
const k2 = Buffer.from(webcrypto.getRandomValues(new Uint8Array(32))).toString('base64');

const ring = Keyring.fromEnv(`v1:${k1}`);
const rotated = Keyring.fromEnv(`v2:${k2},v1:${k1}`);

const ACCOUNT = '1234567890123456';

/** Every encrypted value is sealed to a row and a field. */
const BINDING = { recordId: 'ben-nubaria', field: 'account_number' } as const;

describe('keyring configuration', () => {
  test('an empty configuration is refused', () => {
    assert.throws(() => Keyring.fromEnv(''), /No encryption keys configured/);
  });

  test('a short key is refused rather than silently weakening everything', () => {
    const short = Buffer.from(new Uint8Array(16)).toString('base64');
    assert.throws(() => Keyring.fromEnv(`v1:${short}`), /must be 32 bytes/);
  });

  test('a malformed entry names what was expected', () => {
    assert.throws(() => Keyring.fromEnv('no-colon-here'), /Expected "keyId:base64key"/);
  });

  test('the first key listed is the active one', () => {
    assert.equal(rotated.activeKeyId, 'v2');
  });
});

describe('encrypting a bank account number', () => {
  test('round-trips exactly', async () => {
    const field = await ring.encrypt(ACCOUNT, BINDING);
    assert.equal(await ring.decrypt(field, BINDING), ACCOUNT);
  });

  test('the ciphertext does not contain the plaintext', async () => {
    const field = await ring.encrypt(ACCOUNT, BINDING);
    assert.equal(field.ciphertext.includes(ACCOUNT), false);
    assert.equal(Buffer.from(field.ciphertext, 'base64').toString('utf8').includes('1234'), false);
  });

  test('encrypting the same value twice gives different ciphertext', async () => {
    // A fresh IV each time. Identical ciphertexts would let anyone with the
    // dump see which suppliers share a bank account.
    const a = await ring.encrypt(ACCOUNT, BINDING);
    const b = await ring.encrypt(ACCOUNT, BINDING);
    assert.notEqual(a.ciphertext, b.ciphertext);
    assert.notEqual(a.iv, b.iv);
    assert.equal(await ring.decrypt(a, BINDING), await ring.decrypt(b, BINDING));
  });

  test('every encryption records which key was used', async () => {
    const field = await ring.encrypt(ACCOUNT, BINDING);
    assert.equal(field.keyId, 'v1');
  });
});

describe('tampering', () => {
  test('altered ciphertext fails to decrypt instead of producing wrong digits', async () => {
    const field = await ring.encrypt(ACCOUNT, BINDING);
    const bytes = Buffer.from(field.ciphertext, 'base64');
    bytes[2] ^= 0xff; // flip a byte, as a database attacker would

    await assert.rejects(
      () => ring.decrypt({ ...field, ciphertext: bytes.toString('base64') }, BINDING),
      DecryptionFailed,
    );
  });

  test('a swapped IV fails to decrypt', async () => {
    const a = await ring.encrypt(ACCOUNT, BINDING);
    const b = await ring.encrypt('9999999999999999', BINDING);
    await assert.rejects(() => ring.decrypt({ ...a, iv: b.iv }, BINDING), DecryptionFailed);
  });

  test('the wrong key fails to decrypt', async () => {
    const field = await ring.encrypt(ACCOUNT, BINDING);
    const other = Keyring.fromEnv(`v1:${k2}`); // same id, different bytes
    await assert.rejects(() => other.decrypt(field, BINDING), DecryptionFailed);
  });

  test('an unknown key id says so, and says why it matters', async () => {
    const field = await ring.encrypt(ACCOUNT, BINDING);
    await assert.rejects(
      () => rotated.decrypt({ ...field, keyId: 'v9' }, BINDING),
      /must stay in FIELD_ENCRYPTION_KEYS until every row/,
    );
  });
});

describe('key rotation', () => {
  test('a row encrypted under the old key is still readable after rotation', async () => {
    // The whole point: rotation is a background job, not an outage.
    const old = await ring.encrypt(ACCOUNT, BINDING);
    assert.equal(await rotated.decrypt(old, BINDING), ACCOUNT);
  });

  test('rotating re-encrypts under the active key and preserves the value', async () => {
    const old = await ring.encrypt(ACCOUNT, BINDING);
    const now = await rotated.rotate(old, BINDING);

    assert.equal(now.keyId, 'v2');
    assert.notEqual(now.ciphertext, old.ciphertext);
    assert.equal(await rotated.decrypt(now, BINDING), ACCOUNT);
  });

  test('rotating an already-current row is a no-op', async () => {
    const current = await rotated.encrypt(ACCOUNT, BINDING);
    const again = await rotated.rotate(current, BINDING);
    assert.equal(again.ciphertext, current.ciphertext, 'must not churn rows that are already current');
  });
});

describe('account tail', () => {
  test('keeps the last four digits for phone confirmation', () => {
    assert.equal(accountTail('1234567890123456'), '3456');
  });

  test('ignores formatting', () => {
    assert.equal(accountTail('1234-5678 9012 3456'), '3456');
  });

  test('pads a short number rather than leaking its length', () => {
    assert.equal(accountTail('89'), '0089');
  });
});


/* ------------------------------------------------------------------ *
 * Binding
 *
 * The reason AAD exists. Demonstrated as a working attack before it was
 * added: a whole encrypted value — ciphertext, IV and key id together —
 * lifted from one beneficiary row into another decrypted perfectly, and
 * the payout would have gone to the attacker's account with every check
 * passing. No key required, only write access to the database.
 * ------------------------------------------------------------------ */

describe('binding a value to its record', () => {
  const nubaria = { recordId: 'ben-nubaria', field: 'account_number' } as const;
  const attacker = { recordId: 'ben-attacker', field: 'account_number' } as const;

  test('a value swapped into another beneficiary will not decrypt', async () => {
    const theirs = await ring.encrypt('9999999999', attacker);

    // The swap: their complete encrypted value, written into Nubaria's row.
    await assert.rejects(() => ring.decrypt(theirs, nubaria), DecryptionFailed);
  });

  test('the value still decrypts for the record it belongs to', async () => {
    const theirs = await ring.encrypt('9999999999', attacker);
    assert.equal(await ring.decrypt(theirs, attacker), '9999999999');
  });

  test('a value cannot be moved between fields on the same record', async () => {
    const account = await ring.encrypt(ACCOUNT, { recordId: 'ben-1', field: 'account_number' });
    await assert.rejects(
      () => ring.decrypt(account, { recordId: 'ben-1', field: 'national_id' }),
      DecryptionFailed,
    );
  });

  test('the binding is not recoverable from the ciphertext', async () => {
    // AAD is authenticated, not encrypted — but it must not be *stored* in the
    // ciphertext either, or the record id leaks to anyone holding a dump.
    const sealed = await ring.encrypt(ACCOUNT, nubaria);
    const raw = Buffer.from(sealed.ciphertext, 'base64').toString('latin1');
    assert.equal(raw.includes('ben-nubaria'), false);
  });

  test('rotation preserves the binding rather than resealing it elsewhere', async () => {
    const sealed = await ring.encrypt(ACCOUNT, nubaria);
    const moved = await rotated.rotate(sealed, nubaria);

    assert.equal(moved.keyId, 'v2');
    assert.equal(await rotated.decrypt(moved, nubaria), ACCOUNT);
    // Still refuses to open under a different record after rotation.
    await assert.rejects(() => rotated.decrypt(moved, attacker), DecryptionFailed);
  });
});
