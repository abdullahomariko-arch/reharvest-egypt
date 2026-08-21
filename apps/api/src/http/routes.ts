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

/** Typed context so `principal` is not a stringly-typed hole in every handler. */
type Vars = {
  principal: { userId: string; partyId?: string; roles: string[] };
  idempotencyScopedKey: string;
  idempotencyApplied: boolean;
};
import type { PaymentService } from '../service/payment-service.ts';
import { ControlBlocked } from '@reharvest/core/guard';
import { TransitionDenied } from '@reharvest/core/state-machines';
import { idempotencyMiddleware } from './idempotency-middleware.ts';
import type { IdempotencyStore } from '../repo/idempotency.ts';

export interface RouteDeps {
  readonly payments: PaymentService;
  readonly idempotency: IdempotencyStore;
  readonly authenticate: (req: Request) => Promise<{ userId: string; partyId?: string; roles: string[] } | null>;
  /** The party that placed an order, for the ownership check. */
  readonly ownerOfOrder: (orderCode: string) => Promise<string | null>;
}

export function buildRoutes(deps: RouteDeps) {
  const app = new Hono<{ Variables: Vars }>();

  /* -------------------------------------------------------------- *
   * Authentication, then idempotency — in that order.
   *
   * The webhook is deliberately excluded from both: Paymob authenticates by
   * HMAC signature and cannot hold a bearer token or choose a key. Mounting
   * auth on '*' here is what previously swallowed every callback with a 401.
   * -------------------------------------------------------------- */

  const authed = ['/orders/*', '/settlements/*'];

  for (const path of authed) {
    app.use(path, async (c, next) => {
      const p = await deps.authenticate(c.req.raw);
      if (!p) return c.json({ error: 'unauthenticated' }, 401);
      c.set('principal', p);
      await next();
    });
    app.use(
      path,
      idempotencyMiddleware({
        idempotency: deps.idempotency,
        actorOf: (c) => c.get('principal') ?? null,
      }),
    );
  }

  /* -------------------------------------------------------------- *
   * Buyer starts a deposit.
   * -------------------------------------------------------------- */
  app.post('/orders/:code/deposit-intention', async (c) => {
    /*
      Ownership before anything else. Without it, one buyer could open a deposit
      against another buyer's order — learning its amount, and paying into it.
    */
    const actor = c.get('principal');
    const owner = await deps.ownerOfOrder(c.req.param('code'));
    if (!owner) return c.json({ error: 'not_found' }, 404);
    if (
      owner !== (actor as { partyId?: string }).partyId &&
      !actor.roles.some((r) => ['ops_agent', 'ops_manager', 'finance'].includes(r))
    ) {
      return c.json(
        { error: 'forbidden', reasonCode: 'NOT_YOUR_ORDER', message: 'That order is not available to you.' },
        403,
      );
    }

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
    const auth = c.get('principal');
    if (!auth.roles.includes('finance')) return c.json({ error: 'forbidden' }, 403);

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
