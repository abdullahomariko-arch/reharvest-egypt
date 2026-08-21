/**
 * Staff credential verification.
 *
 * scrypt, not a bare hash. A passphrase protected by SHA-256 is protected by
 * nothing: commodity hardware tries billions of SHA-256 guesses per second
 * against a stolen table. scrypt is deliberately slow and memory-hard, so an
 * offline attack costs real money per guess.
 *
 * Parameters follow the usual interactive-login guidance (N=2^15). Verification
 * takes roughly 100ms, which is unnoticeable to a person signing in once a shift
 * and ruinous to someone working through a leaked table.
 */

import { scrypt as scryptCb, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

type Db = PostgresJsDatabase<Record<string, never>>;

const PARAMS = { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LENGTH = 64;

export interface StaffUser {
  readonly userId: string;
  readonly displayName: string;
  readonly partyId: string;
  readonly roles: readonly string[];
}

/** Produces the stored value: `scrypt$N$r$p$salt$hash`, everything needed to verify later. */
export async function hashPassphrase(passphrase: string): Promise<string> {
  if (passphrase.length < 12) {
    // Length is the only property that reliably matters. Composition rules push
    // people toward Passw0rd! and a sticky note.
    throw new Error('A staff passphrase must be at least 12 characters.');
  }
  const salt = randomBytes(16);
  const hash = await scrypt(passphrase, salt, KEY_LENGTH, PARAMS);
  return [
    'scrypt',
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64'),
    hash.toString('base64'),
  ].join('$');
}

export async function verifyPassphrase(passphrase: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, n, r, p, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');

  // Parameters come from the stored value, not from the constants above, so
  // records written under older settings keep verifying after a tuning change.
  const actual = await scrypt(passphrase, salt, expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: 256 * 1024 * 1024,
  });

  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Looks up a staff member and checks their passphrase.
 *
 * Returns null for both an unknown identifier and a wrong passphrase, and does
 * the same amount of work either way. Answering faster for an unknown user
 * turns this endpoint into a way to enumerate staff accounts.
 */
export function verifyStaffLogin(db: Db) {
  return async (identifier: string, secret: string): Promise<StaffUser | null> => {
    const rows = await db.execute(sql`
      SELECT user_id, display_name, party_id, roles, passphrase_hash
        FROM staff_credentials
       WHERE identifier = ${identifier.trim().toLowerCase()}
         AND disabled_at IS NULL
       LIMIT 1
    `);

    const row = (rows as unknown as Array<Record<string, unknown>>)[0];

    if (!row) {
      // Burn comparable time against a dummy hash so the timing does not reveal
      // whether the identifier exists.
      await verifyPassphrase(secret, DUMMY_HASH);
      return null;
    }

    const ok = await verifyPassphrase(secret, String(row.passphrase_hash));
    if (!ok) return null;

    return {
      userId: String(row.user_id),
      displayName: String(row.display_name),
      partyId: String(row.party_id),
      roles: row.roles as string[],
    };
  };
}

/** A real scrypt record over a value nobody knows, used only to equalise timing. */
const DUMMY_HASH =
  'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' +
  Buffer.alloc(KEY_LENGTH, 7).toString('base64');
