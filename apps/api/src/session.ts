/**
 * Staff browser sessions.
 *
 * The ops console previously authenticated with a bearer token, which a browser
 * cannot attach to a normal navigation. In practice that meant either nobody
 * could use it, or someone would paste a token into a query string — where it
 * lands in server logs, browser history and the Referer header of every outbound
 * link. So the console gets real cookie sessions.
 *
 * The cookie carries a signed session id, not the session itself. Two reasons:
 * a signed blob still leaks its contents to anyone holding the cookie, and a
 * server-side record can be revoked. A stateless token cannot be logged out.
 *
 * Cookie flags, and why each matters here:
 *
 *   HttpOnly  — script cannot read it, so an injected script cannot exfiltrate
 *               a live finance session.
 *   Secure    — never sent over plain HTTP. Ops staff use this over hotel and
 *               packhouse wifi.
 *   SameSite=Strict — the browser will not attach it to a cross-site request at
 *               all, which removes most of the CSRF surface before the token
 *               below is even consulted.
 *   Path=/ops — not sent to the API routes, which use bearer tokens. A cookie
 *               that travels everywhere is a cookie that gets replayed somewhere
 *               it was not meant for.
 */

import { webcrypto, randomBytes, timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

type Db = PostgresJsDatabase<Record<string, never>>;

export const SESSION_COOKIE = 'reharvest_ops';
export const CSRF_FIELD = '_csrf';

/** Short, because these are shared office machines. Renewed on each request. */
const SESSION_HOURS = 8;

/** An idle session dies well before the absolute expiry. */
const IDLE_MINUTES = 45;

export interface StaffSession {
  readonly id: string;
  readonly userId: string;
  readonly displayName: string;
  readonly partyId: string;
  readonly roles: readonly string[];
  readonly csrfToken: string;
}

/**
 * Reads a roles value back out of jsonb.
 *
 * Defensive because of a real bug: passing a pre-stringified array as a bound
 * parameter cast to jsonb made Postgres treat the JSON *text* as the value, and
 * it came back as an array of single characters — ['[', '"', 'o', 'p', 's', …].
 * The roles check then silently failed and every staff member was refused their
 * own console with "Not your console", which is a maddening thing to debug from
 * the symptom.
 */
function parseRoles(value: unknown): string[] {
  if (Array.isArray(value)) {
    // The character-array shape: reassemble and re-parse rather than serving
    // nonsense roles to an authorisation check.
    if (value.length > 0 && value.every((v) => typeof v === 'string' && v.length === 1)) {
      try {
        const rebuilt = JSON.parse(value.join(''));
        if (Array.isArray(rebuilt)) return rebuilt.map(String);
      } catch {
        /* fall through */
      }
    }
    return value.map(String);
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function createSessionStore(db: Db, signingSecret: string) {
  return {
    async create(user: {
      userId: string;
      displayName: string;
      partyId: string;
      roles: readonly string[];
    }): Promise<{ session: StaffSession; cookie: string }> {
      const id = randomBytes(32).toString('base64url');
      // A separate secret per session, so a CSRF token from one session is
      // useless in another even if an attacker obtains it.
      const csrfToken = randomBytes(32).toString('base64url');

      await db.execute(sql`
        INSERT INTO staff_sessions (id, user_id, display_name, party_id, roles, csrf_token, expires_at, last_seen_at)
        VALUES (${id}, ${user.userId}::uuid, ${user.displayName}, ${user.partyId}::uuid,
                ${sql.raw(`'${JSON.stringify([...user.roles]).replace(/'/g, "''")}'`)}::jsonb, ${csrfToken},
                now() + interval '${sql.raw(String(SESSION_HOURS))} hours', now())
      `);

      const session: StaffSession = { id, ...user, roles: [...user.roles], csrfToken };
      return { session, cookie: await this.cookieFor(id) };
    },

    /** The cookie value is `id.signature`, so a forged id is rejected without a database hit. */
    async cookieFor(sessionId: string): Promise<string> {
      const sig = await sign(sessionId, signingSecret);
      const value = `${sessionId}.${sig}`;
      return [
        `${SESSION_COOKIE}=${value}`,
        'HttpOnly',
        'Secure',
        'SameSite=Strict',
        'Path=/ops',
        `Max-Age=${SESSION_HOURS * 3600}`,
      ].join('; ');
    },

    async read(cookieHeader: string | null): Promise<StaffSession | null> {
      const raw = parseCookie(cookieHeader, SESSION_COOKIE);
      if (!raw) return null;

      const dot = raw.lastIndexOf('.');
      if (dot <= 0) return null;

      const id = raw.slice(0, dot);
      const provided = raw.slice(dot + 1);

      // Verify the signature before touching the database, so an attacker
      // cannot use this endpoint to probe which session ids exist.
      const expected = await sign(id, signingSecret);
      if (!constantTimeEqual(provided, expected)) return null;

      const rows = await db.execute(sql`
        SELECT id, user_id, display_name, party_id, roles, csrf_token
          FROM staff_sessions
         WHERE id = ${id}
           AND revoked_at IS NULL
           AND expires_at > now()
           AND last_seen_at > now() - interval '${sql.raw(String(IDLE_MINUTES))} minutes'
         LIMIT 1
      `);

      const row = (rows as unknown as Array<Record<string, unknown>>)[0];
      if (!row) return null;

      // Sliding idle window. A person working through a payment run should not
      // be logged out mid-approval.
      await db.execute(sql`UPDATE staff_sessions SET last_seen_at = now() WHERE id = ${id}`);

      return {
        id: String(row.id),
        userId: String(row.user_id),
        displayName: String(row.display_name),
        partyId: String(row.party_id),
        roles: parseRoles(row.roles),
        csrfToken: String(row.csrf_token),
      };
    },

    /** Revocation is server-side, which is the whole reason sessions are not stateless. */
    async revoke(sessionId: string): Promise<void> {
      await db.execute(sql`UPDATE staff_sessions SET revoked_at = now() WHERE id = ${sessionId}`);
    },

    clearedCookie(): string {
      return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/ops; Max-Age=0`;
    },

    async sweep(): Promise<number> {
      const rows = await db.execute(sql`
        DELETE FROM staff_sessions WHERE expires_at <= now() - interval '7 days' RETURNING id
      `);
      return (rows as unknown as unknown[]).length;
    },
  };
}

export type SessionStore = ReturnType<typeof createSessionStore>;

/**
 * Checks the CSRF token submitted with a form.
 *
 * SameSite=Strict already blocks the classic cross-site POST, but this is not
 * redundant: SameSite is enforced by the browser, and the set of browsers in a
 * packhouse office is not something this system controls. Two independent
 * mechanisms, either of which is sufficient.
 */
export function checkCsrf(session: StaffSession, submitted: unknown): boolean {
  if (typeof submitted !== 'string' || submitted.length === 0) return false;
  return constantTimeEqual(submitted, session.csrfToken);
}

/* ------------------------------------------------------------------ */

async function sign(value: string, secret: string): Promise<string> {
  const key = await webcrypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await webcrypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return Buffer.from(new Uint8Array(sig)).toString('base64url');
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  // Length is compared first because timingSafeEqual throws on a mismatch;
  // the length of a token is not the secret part.
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function parseCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return null;
}
