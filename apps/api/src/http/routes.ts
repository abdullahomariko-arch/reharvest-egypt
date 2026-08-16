/**
 * HTTP layer (Hono). Thin on purpose — routes parse, authorise and delegate.
 * No business rule lives here, because a rule in a route handler is a rule the
 * mobile app cannot run offline and the test suite cannot reach without a server.
 *
 * Two things this layer owns that the service cannot:
 *   - idempotency at the edge, so a retried POST returns the first response
 *     instead of doing the work twice
 *   - HTTP status semantics for the PSP, which decide whether Paymob retries
 */

import { Hono } from 'hono';
import type { PaymentService } from '../service/payment-service.ts';
import { ControlBlocked } from '@reharvest/core/guard';
import { TransitionDenied } from '@reharvest/core/state-machines';

export interface IdempotencyStore {
  get(key: string): Promise<{ status: number; body: unknown } | null>;
  put(key: string, value: { status: number; body: unknown }): Promise<void>;
}

export interface RouteDeps {
  readonly payments: PaymentService;
  readonly idempotency: IdempotencyStore;
  readonly authenticate: (req: Request) => Promise<{ userId: string; roles: string[] } | null>;
}

export function buildRoutes(deps: RouteDeps) {
  const app = new Hono();

  /* -------------------------------------------------------------- *
   * Idempotency. Any non-GET carrying the header replays its first
   * response rather than executing again. (D53.)
   * -------------------------------------------------------------- */
  app.use('*', async (c, next) => {
    const key = c.req.header('Idempotency-Key');
    if (!key || c.req.method === 'GET') return next();

    const cached = await deps.idempotency.get(key);
    if (cached) {
      c.header('Idempotent-Replay', 'true');
      return c.json(cached.body as object, cached.status as 200);
    }

    await next();

    if (c.res.status < 500) {
      const body = await c.res.clone().json().catch(() => null);
      await deps.idempotency.put(key, { status: c.res.status, body });
    }
  });

  /* -------------------------------------------------------------- *
   * Buyer starts a deposit.
   * -------------------------------------------------------------- */
  app.post('/orders/:code/deposit-intention', async (c) => {
    const auth = await deps.authenticate(c.req.raw);
    if (!auth) return c.json({ error: 'unauthenticated' }, 401);

    const body = await c.req.json<{ completedOrders: number; hasVerifiedBankAccount: boolean }>();

    try {
      const result = await deps.payments.createDepositIntention(c.req.param('code'), body);
      return c.json({
        clientSecret: result.clientSecret,
        publicKey: result.publicKey,
        // Sent back so the app can display it, never so the app can set it.
        amountPiastres: result.amount.amount.toString(),
        methods: result.methods,
      });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 409);
    }
  });

  /* -------------------------------------------------------------- *
   * Paymob callback.
   *
   * Status codes here are load-bearing. Paymob retries anything that is
   * not 2xx, so:
   *   200 — processed, or deliberately rejected. Stop retrying.
   *   401 — bad signature. Stop retrying; this was not us.
   *   500 — our fault. Please retry.
   * Returning 500 for a business rejection would loop forever.
   * -------------------------------------------------------------- */
  app.post('/webhooks/paymob', async (c) => {
    const hmac = c.req.query('hmac') ?? c.req.header('hmac') ?? '';
    const payload = await c.req.json();

    try {
      const result = await deps.payments.handleWebhook(payload, hmac);
      return c.json(result, 200);
    } catch (e) {
      if ((e as Error).message.includes('HMAC mismatch')) {
        return c.json({ error: 'signature rejected' }, 401);
      }
      if (e instanceof TransitionDenied) {
        // The money is real but the order was not in a state to receive it.
        // Recorded, surfaced to finance, and not retried.
        return c.json({ outcome: 'held_for_review', reasonCode: e.reasonCode, message: e.message }, 200);
      }
      console.error('paymob webhook failure', e);
      return c.json({ error: 'internal' }, 500);
    }
  });

  /* -------------------------------------------------------------- *
   * Supplier payout. Requires both an idempotency key and an approver
   * who is not the caller; the service enforces the second condition.
   * -------------------------------------------------------------- */
  app.post('/settlements/:id/pay', async (c) => {
    const auth = await deps.authenticate(c.req.raw);
    if (!auth) return c.json({ error: 'unauthenticated' }, 401);
    if (!auth.roles.includes('finance')) return c.json({ error: 'forbidden' }, 403);
    if (!c.req.header('Idempotency-Key')) {
      return c.json({ error: 'Idempotency-Key header is required for irreversible actions' }, 400);
    }

    const body = await c.req.json();

    try {
      const receipt = await deps.payments.paySupplier({
        ...body,
        settlementId: c.req.param('id'),
        preparedBy: auth.userId,
      });
      return c.json(receipt, 200);
    } catch (e) {
      if (e instanceof ControlBlocked) {
        // The block is the response. The client renders it as a BlockCard.
        return c.json(
          {
            error: 'blocked',
            domainId: e.outcome.domainId,
            reasonCode: e.outcome.reasonCode,
            messageEn: e.outcome.messageEn,
            messageAr: e.outcome.messageAr,
            correctionPath: e.outcome.correctionPath,
          },
          422,
        );
      }
      return c.json({ error: (e as Error).message }, 409);
    }
  });

  return app;
}
