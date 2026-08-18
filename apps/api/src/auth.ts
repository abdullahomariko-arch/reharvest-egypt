/**
 * Authentication.
 *
 * Signed, short-lived bearer tokens. Deliberately boring, with three properties
 * that matter more than the algorithm choice:
 *
 * 1. **The role lives in the signed payload, not in a header or a request body.**
 *    A client that can name its own role can pay itself.
 *
 * 2. **Signature verification is constant-time.** A byte-by-byte early return
 *    leaks the expected signature one character at a time to anyone patient.
 *
 * 3. **Expiry is checked on every request**, not at sign-in. A packhouse phone
 *    that gets passed around, or left in a drawer for a fortnight, must not
 *    still be able to release money.
 *
 * HS256 is used because the API is a single service verifying tokens it issued
 * itself. If a second service ever needs to verify without being able to mint,
 * this becomes asymmetric (RS256/EdDSA) — the shape of the file does not change.
 */

import { webcrypto } from 'node:crypto';

export interface Principal {
  readonly userId: string;
  readonly partyId: string;
  readonly roles: readonly string[];
  readonly displayName: string;
}

interface TokenPayload extends Principal {
  /** Seconds since epoch. */
  readonly exp: number;
  readonly iat: number;
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly reason: 'malformed' | 'bad_signature' | 'expired',
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

const enc = new TextEncoder();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function fromB64url(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64url'));
}

/**
 * Node's webcrypto CryptoKey and the DOM lib's CryptoKey have drifted apart in
 * recent Node typings (post-quantum key usages exist in one and not the other).
 * They are the same object at runtime, so the alias is taken from the
 * implementation actually in use rather than from the DOM lib.
 */
type NodeCryptoKey = Awaited<ReturnType<typeof webcrypto.subtle.importKey>>;

async function key(secret: string): Promise<NodeCryptoKey> {
  return webcrypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

/** Issues a token. Lifetime is short because these live on shared devices. */
export async function issueToken(
  principal: Principal,
  secret: string,
  ttlSeconds = 12 * 3600,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: TokenPayload = { ...principal, iat: now, exp: now + ttlSeconds };

  const head = b64url(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const signingInput = `${head}.${body}`;

  const sig = await webcrypto.subtle.sign('HMAC', await key(secret), enc.encode(signingInput));
  return `${signingInput}.${b64url(new Uint8Array(sig))}`;
}

/**
 * Verifies a token and returns the principal.
 *
 * Throws rather than returning null so a caller cannot accidentally treat a
 * forged token as an anonymous one and fall through to a permissive branch.
 */
export async function verifyToken(token: string, secret: string, now = Date.now()): Promise<Principal> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new AuthError('Malformed token.', 'malformed');

  const [head, body, sig] = parts;

  const expected = new Uint8Array(
    await webcrypto.subtle.sign('HMAC', await key(secret), enc.encode(`${head}.${body}`)),
  );
  const actual = fromB64url(sig);

  // Length check first, then constant-time compare. Returning early on the
  // first differing byte leaks the signature one character at a time.
  if (actual.length !== expected.length) throw new AuthError('Signature rejected.', 'bad_signature');

  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected[i] ^ actual[i];
  if (diff !== 0) throw new AuthError('Signature rejected.', 'bad_signature');

  let payload: TokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TokenPayload;
  } catch {
    throw new AuthError('Malformed token body.', 'malformed');
  }

  if (typeof payload.exp !== 'number' || payload.exp * 1000 <= now) {
    throw new AuthError('Token expired.', 'expired');
  }

  if (!payload.userId || !payload.partyId || !Array.isArray(payload.roles)) {
    throw new AuthError('Token is missing required claims.', 'malformed');
  }

  /*
    Identifiers must be UUIDs, because that is what the database columns they
    end up in actually are. Discovered the hard way: a token carrying a
    friendly id like "u_supplier" sails through verification and then fails
    at the INSERT, turning an authentication problem into a 500 on the
    weighing endpoint. Validate the shape where the claim enters the system,
    not where it lands.
  */
  if (!isUuid(payload.userId) || !isUuid(payload.partyId)) {
    throw new AuthError('userId and partyId claims must be UUIDs.', 'malformed');
  }

  return {
    userId: payload.userId,
    partyId: payload.partyId,
    roles: payload.roles,
    displayName: payload.displayName ?? payload.userId,
  };
}

/** Builds the authenticate function the routes depend on. */
export function makeAuthenticator(secret: string) {
  return async (req: Request): Promise<Principal | null> => {
    const header = req.headers.get('authorization');
    if (!header?.startsWith('Bearer ')) return null;
    try {
      return await verifyToken(header.slice(7), secret);
    } catch {
      // Every failure mode collapses to "not authenticated" at the boundary.
      // Telling a caller *why* their forged token failed is free reconnaissance.
      return null;
    }
  };
}

/**
 * Role check. Separate from authentication because the answer to "who are you"
 * and "may you do this" are different questions with different failure codes —
 * 401 versus 403 — and conflating them tells an attacker which usernames exist.
 */
export function requireRole(principal: Principal, ...allowed: readonly string[]): boolean {
  return principal.roles.some((r) => allowed.includes(r));
}
