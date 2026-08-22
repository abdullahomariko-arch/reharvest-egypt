/**
 * Field encryption for bank details.
 *
 * AES-256-GCM, with the key held outside the database. The point is narrow and
 * worth stating plainly: a stolen database dump should not yield supplier bank
 * account numbers. It does not protect against an attacker who has both the
 * dump and the application's environment — nothing at this layer does.
 *
 * Three decisions:
 *
 * 1. **GCM, not CBC.** GCM is authenticated: a tampered ciphertext fails to
 *    decrypt rather than silently producing different plaintext. For a bank
 *    account number, silently producing *different digits* is the worst
 *    possible failure mode, because the payment succeeds to the wrong account.
 *
 * 2. **A fresh random IV per encryption, stored alongside.** Reusing an IV with
 *    the same key in GCM is catastrophic — it leaks the keystream. The IV is
 *    not secret; it just has to be unique.
 *
 * 3. **A key id travels with every row.** Keys have to be rotatable without a
 *    flag day: new rows encrypt under the new key while old rows stay readable
 *    under the old one. A scheme with no key id forces a big-bang re-encryption
 *    that nobody ever schedules.
 *
 * 4. **Ciphertext is bound to the row it belongs to** via GCM additional
 *    authenticated data. Without this, encryption is not enough: GCM
 *    authenticates the *bytes*, not their location, so anyone with write access
 *    can lift a complete encrypted value — ciphertext, IV and key id together —
 *    from one beneficiary into another. It decrypts perfectly and the payout
 *    goes to the wrong bank account with every check passing. Demonstrated
 *    before this was added; see crypto.test.ts.
 */

import { webcrypto } from 'node:crypto';

const enc = new TextEncoder();
const dec = new TextDecoder();

export interface EncryptedField {
  /** Base64 ciphertext, including the GCM authentication tag. */
  readonly ciphertext: string;
  /** Base64 initialisation vector. Not secret; must be unique per encryption. */
  readonly iv: string;
  /** Which key this was encrypted under, so keys can be rotated. */
  readonly keyId: string;
}

/**
 * What a ciphertext is bound to.
 *
 * Included in the GCM tag but not in the ciphertext, so decryption fails if the
 * value is presented against a different row or field than it was sealed for.
 * This is what stops a whole encrypted value being swapped between beneficiaries.
 */
export interface FieldBinding {
  /** The row this value belongs to, e.g. a beneficiary id. */
  readonly recordId: string;
  /** Which field on that row, so two encrypted columns cannot be swapped either. */
  readonly field: string;
}

function aad(binding: FieldBinding): Uint8Array {
  return new TextEncoder().encode(`${binding.field}\u0000${binding.recordId}`);
}

export class DecryptionFailed extends Error {
  constructor(reason: string) {
    super(`Could not decrypt: ${reason}`);
    this.name = 'DecryptionFailed';
  }
}

/**
 * A keyring rather than a single key, so rotation is possible.
 *
 * `active` is what new writes use. Every key in `keys` stays available for
 * reads, which is what makes rotation a background job rather than an outage.
 */
export class Keyring {
  private readonly cache = new Map<string, Awaited<ReturnType<typeof webcrypto.subtle.importKey>>>();

  private constructor(
    private readonly raw: ReadonlyMap<string, Uint8Array>,
    readonly activeKeyId: string,
  ) {}

  /**
   * Builds a keyring from environment configuration.
   *
   * Format: `keyId:base64key` entries, comma separated. The first is active.
   * Refuses anything shorter than 32 bytes, because a short key here silently
   * weakens everything above it.
   */
  static fromEnv(spec: string): Keyring {
    const entries = spec
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    if (entries.length === 0) {
      throw new Error('No encryption keys configured. Set FIELD_ENCRYPTION_KEYS.');
    }

    const map = new Map<string, Uint8Array>();
    for (const entry of entries) {
      const idx = entry.indexOf(':');
      if (idx <= 0) {
        throw new Error(`Malformed encryption key entry. Expected "keyId:base64key", got "${entry.slice(0, 12)}…".`);
      }
      const keyId = entry.slice(0, idx);
      const bytes = new Uint8Array(Buffer.from(entry.slice(idx + 1), 'base64'));
      if (bytes.length !== 32) {
        throw new Error(`Encryption key "${keyId}" must be 32 bytes (AES-256), got ${bytes.length}.`);
      }
      map.set(keyId, bytes);
    }

    return new Keyring(map, entries[0].slice(0, entries[0].indexOf(':')));
  }

  private async key(keyId: string): Promise<Awaited<ReturnType<typeof webcrypto.subtle.importKey>>> {
    const cached = this.cache.get(keyId);
    if (cached) return cached;

    const bytes = this.raw.get(keyId);
    if (!bytes) {
      throw new DecryptionFailed(
        `no key with id "${keyId}" is configured. If this key was retired, it must stay in FIELD_ENCRYPTION_KEYS until every row using it has been re-encrypted.`,
      );
    }

    // Node's Uint8Array type and the DOM lib's BufferSource have drifted apart
    // in recent typings. Same bytes at runtime; the alias keeps the compiler
    // from insisting otherwise.
    const k = (await webcrypto.subtle.importKey(
      'raw',
      bytes as unknown as ArrayBuffer,
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt'],
    )) as CryptoKey;
    this.cache.set(keyId, k);
    return k;
  }

  /**
   * Encrypts a value, sealed to the row and field it belongs to.
   *
   * The binding is mandatory. An optional binding would be omitted at exactly
   * the call site that mattered.
   */
  async encrypt(plaintext: string, binding: FieldBinding): Promise<EncryptedField> {
    // 96 bits is the GCM-recommended IV size; longer gets hashed internally
    // and buys nothing.
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    const key = await this.key(this.activeKeyId);

    const ct = await webcrypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: iv as unknown as ArrayBuffer,
        additionalData: aad(binding) as unknown as ArrayBuffer,
      },
      key as never,
      enc.encode(plaintext) as unknown as ArrayBuffer,
    );

    return {
      ciphertext: Buffer.from(new Uint8Array(ct)).toString('base64'),
      iv: Buffer.from(iv).toString('base64'),
      keyId: this.activeKeyId,
    };
  }

  async decrypt(field: EncryptedField, binding: FieldBinding): Promise<string> {
    const key = await this.key(field.keyId);
    try {
      const pt = await webcrypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: new Uint8Array(Buffer.from(field.iv, 'base64')) as unknown as ArrayBuffer,
          additionalData: aad(binding) as unknown as ArrayBuffer,
        },
        key as never,
        new Uint8Array(Buffer.from(field.ciphertext, 'base64')) as unknown as ArrayBuffer,
      );
      return dec.decode(pt);
    } catch {
      /*
        GCM authentication failed. Either the bytes were altered, the wrong key
        was used, or — the case this binding exists for — the value was moved to
        a different row. Deliberately not saying which: telling an attacker
        whether they got the row right or the key right is free information.
      */
      throw new DecryptionFailed(
        'authentication failed — the value was altered, moved to a different record, or sealed under a different key',
      );
    }
  }

  /**
   * Re-encrypts under the active key. The rotation job's inner loop.
   *
   * The binding is passed through unchanged: rotation changes which key seals
   * the value, never where it belongs.
   */
  async rotate(field: EncryptedField, binding: FieldBinding): Promise<EncryptedField> {
    if (field.keyId === this.activeKeyId) return field;
    return this.encrypt(await this.decrypt(field, binding), binding);
  }
}

/**
 * The last four digits, kept in the clear on purpose.
 *
 * Finance reads this back to a supplier over the phone to confirm an account
 * before a payment run. Decrypting a full account number for that is a worse
 * trade than exposing four digits, which on their own identify nothing.
 */
export function accountTail(accountNumber: string): string {
  const digits = accountNumber.replace(/\D/g, '');
  return digits.slice(-4).padStart(4, '0');
}
