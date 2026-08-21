/**
 * Idempotency middleware.
 *
 * Ordering matters more than anything else in this file: this must run AFTER
 * authentication, never before. The previous version was mounted ahead of the
 * auth check and keyed on the raw client header, which meant an unauthenticated
 * caller could be handed a stored response, and one user's key addressed another
 * user's result. Both were reproduced.
 *
 * The flow:
 *
 *   reserve → run the handler → complete
 *
 * with three early exits: a completed reservation replays, an in-progress one
 * returns 409 Conflict with Retry-After, and a mismatched body returns 409.
 */

import type { Context, Next } from 'hono';

/** Variables this middleware reads and writes. */
export type IdempotencyVars = {
  idempotencyApplied: boolean;
  idempotencyScopedKey: string;
};
import type { IdempotencyStore } from '../repo/idempotency.ts';

export interface IdempotentDeps {
  readonly idempotency: IdempotencyStore;
  /** Reads the authenticated actor a preceding middleware placed on the context. */
  readonly actorOf: (c: Context<any>) => { userId: string } | null;
}

/** Methods that change state and therefore need protecting. */
const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

export function idempotencyMiddleware(deps: IdempotentDeps) {
  return async (c: Context<{ Variables: IdempotencyVars }>, next: Next) => {
    if (!MUTATING.has(c.req.method)) return next();

    /*
      Re-entry guard.

      Hono matches both '/orders' and '/orders/*' for a POST to /orders, so a
      middleware registered on each pattern runs twice on one request. The
      second pass found the reservation the first pass had just made and
      returned 409 in-progress — every first request failed. Marking the
      context means the layer runs once per request regardless of how many
      patterns matched.
    */
    if (c.get('idempotencyApplied')) return next();
    c.set('idempotencyApplied', true);

    const clientKey = c.req.header('Idempotency-Key');
    if (!clientKey) {
      // Required on mutations. An unkeyed retry is indistinguishable from a
      // second deliberate request, and for a payout that difference is money.
      return c.json(
        {
          error: 'idempotency_key_required',
          message: 'Every state-changing request must carry an Idempotency-Key header.',
        },
        400,
      );
    }

    const actor = deps.actorOf(c);
    if (!actor) {
      // Should be unreachable — auth runs first — but failing closed here means
      // a future re-ordering cannot silently serve stored responses to strangers.
      return c.json({ error: 'unauthenticated' }, 401);
    }

    // Read the body once and hand the parsed value onward, so the hash is taken
    // over exactly what the handler will act on.
    let body: unknown = null;
    try {
      const raw = await c.req.raw.clone().text();
      body = raw ? JSON.parse(raw) : null;
    } catch {
      return c.json({ error: 'invalid_json', message: 'The request body is not valid JSON.' }, 400);
    }

    const scope = {
      actorId: actor.userId,
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      clientKey,
    };

    const outcome = await deps.idempotency.reserve(scope, body);

    if (outcome.kind === 'conflict') {
      return c.json({ error: 'idempotency_key_conflict', message: outcome.reason }, 409);
    }

    if (outcome.kind === 'completed') {
      c.header('Idempotent-Replay', 'true');
      return c.json(outcome.response.body as object, outcome.response.status as 200);
    }

    if (outcome.kind === 'in_progress') {
      // A duplicate is mid-flight. Telling the client to wait is safer than
      // running the operation twice or guessing at the first one's outcome.
      c.header('Retry-After', '2');
      return c.json(
        {
          error: 'idempotency_key_in_progress',
          message: 'An identical request is still being processed. Retry in a moment.',
          startedAt: outcome.startedAt,
        },
        409,
      );
    }

    /*
      Publish the scoped key for the handler.

      Services dedupe too — an order carries the key that created it. If they
      use the raw client header, that store is global and one user's key finds
      another user's order, which is exactly what was reproduced. Handlers take
      the scoped value from here so every layer agrees on identity.
    */
    c.set('idempotencyScopedKey', outcome.scopedKey);

    // Reserved. We own the key; run the handler.
    await next();

    const status = c.res.status;

    if (status >= 500) {
      // Our fault and retriable. Releasing lets the client's own retry through
      // instead of blocking it behind a reservation for five minutes.
      await deps.idempotency.release(outcome.scopedKey);
      return;
    }

    const responseBody = await c.res.clone().json().catch(() => null);
    await deps.idempotency.complete(outcome.scopedKey, { status, body: responseBody });
  };
}
