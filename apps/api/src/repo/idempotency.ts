/**
 * Idempotency, rebuilt around defects reproduced through the HTTP routes.
 *
 * The previous version stored responses keyed on the client's raw header value,
 * recorded them only after the work finished, and never hashed the request. All
 * three were reproduced as real failures:
 *
 *   - A second user sending the same key received the first user's order.
 *   - The same key with a ten times larger amount returned the first response.
 *   - Nothing prevented two concurrent requests both executing.
 *
 * The model here is reserve-then-execute:
 *
 *   1. Reserve the scoped key as IN_PROGRESS, atomically, BEFORE the operation.
 *   2. Run the operation.
 *   3. Mark COMPLETED with the response.
 *
 * A duplicate arriving at step 2 finds IN_PROGRESS and is told to retry rather
 * than executing alongside. A duplicate arriving after step 3 gets the stored
 * response. A duplicate with a different body gets a 409, because that is a
 * client bug or a probe, not a retry.
 */

import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { createHash } from 'node:crypto';

type Db = PostgresJsDatabase<Record<string, never>>;

export interface StoredResponse {
  readonly status: number;
  readonly body: unknown;
}

export type ReservationOutcome =
  /** First time. The caller owns this key and must run the operation. */
  | { kind: 'reserved'; scopedKey: string }
  /** Already done. Replay the stored response verbatim. */
  | { kind: 'completed'; response: StoredResponse }
  /** A duplicate is executing right now. The caller should retry shortly. */
  | { kind: 'in_progress'; startedAt: string }
  /** Same key, different request. Refuse. */
  | { kind: 'conflict'; reason: string };

export interface Scope {
  readonly actorId: string;
  readonly method: string;
  readonly path: string;
  readonly clientKey: string;
}

/** Long enough for a client retrying after an outage, short enough to stay small. */
const TTL_HOURS = 24;

/**
 * A reservation older than this with no completion is treated as abandoned —
 * the process that owned it died mid-request. Long enough that a slow but live
 * request is never stolen from.
 */
const STALE_RESERVATION_MINUTES = 5;

export function createIdempotencyStore(db: Db) {
  const store = {
    /**
     * Atomically claims the key, or reports why it cannot be claimed.
     *
     * The claim is one statement. A read-then-write would leave a window where
     * two concurrent requests both see nothing and both proceed, which is
     * exactly the case this exists to prevent.
     */
    async reserve(scope: Scope, body: unknown): Promise<ReservationOutcome> {
      const scopedKey = scopeKey(scope);
      const hash = hashRequest(scope.path, body);

      /*
        Insert, or take over a row that has expired or been abandoned.

        The DO UPDATE clause fixes the expired-row defect: previously the primary
        key survived expiry and ON CONFLICT DO NOTHING silently dropped the new
        response, so the key could never be reused. The WHERE makes the takeover
        conditional, so a live reservation is never stolen from.
      */
      const inserted = await db.execute(sql`
        INSERT INTO idempotency_keys
          (scoped_key, actor_id, method, request_path, client_key, request_hash,
           state, expires_at)
        VALUES (
          ${scopedKey}, ${scope.actorId}::uuid, ${scope.method}, ${scope.path},
          ${scope.clientKey}, ${hash}, 'IN_PROGRESS',
          now() + interval '${sql.raw(String(TTL_HOURS))} hours'
        )
        ON CONFLICT (scoped_key) DO UPDATE
          SET request_hash    = EXCLUDED.request_hash,
              state           = 'IN_PROGRESS',
              response_status = NULL,
              response_body   = NULL,
              created_at      = now(),
              completed_at    = NULL,
              expires_at      = EXCLUDED.expires_at
          WHERE idempotency_keys.expires_at <= now()
             OR (idempotency_keys.state = 'IN_PROGRESS'
                 AND idempotency_keys.created_at
                     < now() - interval '${sql.raw(String(STALE_RESERVATION_MINUTES))} minutes')
        RETURNING scoped_key
      `);

      if ((inserted as unknown as unknown[]).length > 0) {
        return { kind: 'reserved', scopedKey };
      }

      // The row exists and is live. Decide what the caller should be told.
      const rows = await db.execute(sql`
        SELECT request_hash, state, response_status, response_body, created_at
          FROM idempotency_keys
         WHERE scoped_key = ${scopedKey}
         LIMIT 1
      `);
      const row = (rows as unknown as Array<Record<string, unknown>>)[0];

      // Vanishingly rare: swept between the two statements. Try once more.
      if (!row) return store.reserve(scope, body);

      if (row.request_hash !== hash) {
        return {
          kind: 'conflict',
          reason:
            'This idempotency key was already used with a different request. That is not a retry — use a new key.',
        };
      }

      if (row.state === 'COMPLETED') {
        return {
          kind: 'completed',
          response: { status: Number(row.response_status), body: row.response_body },
        };
      }

      return { kind: 'in_progress', startedAt: String(row.created_at) };
    },

    /** Records the response against a reservation this caller owns. */
    async complete(scopedKey: string, response: StoredResponse): Promise<void> {
      await db.execute(sql`
        UPDATE idempotency_keys
           SET state = 'COMPLETED',
               response_status = ${response.status},
               response_body = ${JSON.stringify(response.body ?? null)}::jsonb,
               completed_at = now()
         WHERE scoped_key = ${scopedKey}
      `);
    },

    /**
     * Releases a reservation without recording a response.
     *
     * Used when the operation failed in a way that should be retriable. Leaving
     * the row IN_PROGRESS would block the client's own retry for five minutes,
     * turning a transient error into a stuck order.
     */
    async release(scopedKey: string): Promise<void> {
      await db.execute(sql`
        DELETE FROM idempotency_keys WHERE scoped_key = ${scopedKey} AND state = 'IN_PROGRESS'
      `);
    },

    /** Clears expired rows. For a scheduled job, not the hot path. */
    async sweep(): Promise<number> {
      const rows = await db.execute(sql`
        DELETE FROM idempotency_keys WHERE expires_at <= now() RETURNING scoped_key
      `);
      return (rows as unknown as unknown[]).length;
    },
  };

  return store;
}

export type IdempotencyStore = ReturnType<typeof createIdempotencyStore>;

/**
 * Scopes a client-supplied key to the actor, method and route.
 *
 * Without this, "retry-1" from one buyer addresses the same row as "retry-1"
 * from another, and the second caller receives the first caller's response.
 * That was reproduced: a second user received the first user's order code.
 */
export function scopeKey(scope: Scope): string {
  return createHash('sha256')
    .update([scope.actorId, scope.method.toUpperCase(), scope.path, scope.clientKey].join('\n'))
    .digest('hex');
}

/** Hashes path and body together so the same key on two routes is caught. */
export function hashRequest(path: string, body: unknown): string {
  return createHash('sha256').update(`${path}\n${stableStringify(body)}`).digest('hex');
}

/**
 * Stable JSON. Key order must not change the hash, or a client that serialises
 * its body differently between attempts looks like a different request and gets
 * refused on a legitimate retry.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
    .join(',')}}`;
}
