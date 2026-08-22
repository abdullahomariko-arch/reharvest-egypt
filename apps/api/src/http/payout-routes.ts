/**
 * Payout routes.
 *
 * The submission endpoint takes one thing: the payout id. Everything else —
 * amount, supplier, beneficiary, bank account, who prepared it, who approved it
 * — is read from Postgres.
 *
 * That is the entire security model here. An endpoint that accepts an amount is
 * an endpoint where the amount can be changed; an endpoint that accepts a bank
 * account is a redirect waiting to happen. The request body is not a source of
 * truth about money, and this file has no code path that reads one.
 */

import { Hono, type Context } from 'hono';
import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import { ServiceError } from '../service/lot-order-service.ts';
import { approvePayout, submitPayout, settlePayout } from '../repo/allocation.ts';
import type { BeneficiaryRepository } from '../repo/beneficiary.ts';
import type { Principal } from '../auth.ts';
import { hasRole } from '../authz.ts';

type Db = PostgresJsDatabase<Record<string, never>>;

type Vars = { principal: Principal };

export interface PayoutRouteDeps {
  readonly db: Db;
  readonly beneficiaries: BeneficiaryRepository;
  readonly authenticate: (req: Request) => Promise<Principal | null>;
  /**
   * Sends money. Receives the account number decrypted moments earlier for this
   * specific settlement, never anything from a request body.
   */
  readonly disburse: (args: {
    idempotencyKey: string;
    amountPiastres: bigint;
    accountNumber: string;
    holderName: string;
    bankCode: string | null;
  }) => Promise<{ providerTransactionId: string; status: 'accepted' | 'failed'; failureReason?: string }>;
}

export function buildPayoutRoutes(deps: PayoutRouteDeps) {
  const app = new Hono<{ Variables: Vars }>();

  app.use('/payouts/*', async (c, next) => {
    const p = await deps.authenticate(c.req.raw);
    if (!p) return c.json({ error: 'unauthenticated' }, 401);
    if (!hasRole(p, 'finance', 'ops_manager', 'executive')) {
      return c.json({ error: 'forbidden', message: 'Payouts require a finance role.' }, 403);
    }
    c.set('principal', p);
    await next();
  });

  /** Approve. Records a decision; moves no money. */
  app.post('/payouts/:id/approve', async (c) =>
    handle(c, async () => {
      const r = await approvePayout(deps.db, {
        paymentId: c.req.param('id'),
        actor: c.get('principal'),
        at: new Date().toISOString(),
      });
      return {
        state: 'APPROVED',
        amountPiastres: r.amountPiastres.toString(),
        note: 'Approved. No money has moved; submit it separately.',
      };
    }),
  );

  /**
   * Submit to the provider.
   *
   * Reads the payout, the supplier and the beneficiary from the database, and
   * decrypts the account number only here, bound to this settlement.
   */
  app.post('/payouts/:id/submit', async (c) =>
    handle(c, async () => {
      const actor = c.get('principal');
      const paymentId = c.req.param('id');

      const rows = await deps.db.execute(sql`
        SELECT p.id, p.state, p.amount_piastres, p.beneficiary_id, p.idempotency_key,
               p.prepared_by, p.approved_by, b.holder_name, b.bank_code
          FROM payments p
          LEFT JOIN beneficiaries b ON b.id = p.beneficiary_id
         WHERE p.id = ${paymentId}::uuid AND p.direction = 'outbound'
         LIMIT 1
      `);
      const row = (rows as unknown as Array<Record<string, unknown>>)[0];

      if (!row) {
        throw new ServiceError('No such payout.', 'PAYMENT_NOT_FOUND', 'D28', 'Refresh the queue.', 404);
      }

      if (!row.beneficiary_id) {
        throw new ServiceError(
          'This payout has no beneficiary on file.',
          'BENEFICIARY_MISSING',
          'D28',
          'Record the supplier’s bank details before submitting. They are never taken from the request.',
        );
      }

      /*
        Decryption happens here and nowhere else in the request path. It is
        bound to this beneficiary row and attributed to this settlement, so a
        decryption that was not part of a payment run is visible in the audit
        log afterwards.
      */
      const accountNumber = await deps.beneficiaries.revealForPayout(String(row.beneficiary_id), {
        settlementId: String(row.idempotency_key ?? paymentId),
        actorId: actor.userId,
        actorRoles: actor.roles,
      });

      const result = await submitPayout(deps.db, {
        paymentId,
        actor,
        at: new Date().toISOString(),
        send: ({ idempotencyKey, amountPiastres }) =>
          deps.disburse({
            // Both come from the database row, not from the caller.
            idempotencyKey,
            amountPiastres,
            accountNumber,
            holderName: String(row.holder_name ?? ''),
            bankCode: (row.bank_code as string | null) ?? null,
          }),
      });

      return {
        state: result.state,
        providerTransactionId: result.providerTransactionId,
        // The tail only. A response that echoes the full account number
        // undoes the encryption it just went through.
        accountTail: accountNumber.slice(-4),
      };
    }),
  );

  /**
   * The provider's final word.
   *
   * Authenticated the same way as any other internal call for now; a real
   * deployment puts the provider's signature check in front of it, exactly as
   * the Paymob collection webhook does.
   */
  app.post('/payouts/settle', async (c) =>
    handle(c, async () => {
      const b = await c.req.json<{ providerTransactionId: string; outcome: 'paid' | 'failed'; failureReason?: string }>();
      const r = await settlePayout(deps.db, {
        providerTransactionId: b.providerTransactionId,
        outcome: b.outcome,
        failureReason: b.failureReason,
        at: new Date().toISOString(),
      });
      return { changed: r.changed };
    }),
  );

  return app;
}

async function handle(c: Context<{ Variables: Vars }>, fn: () => Promise<unknown>) {
  try {
    return c.json((await fn()) as object, 200);
  } catch (e) {
    if (e instanceof ServiceError) {
      return c.json(
        {
          error: 'blocked',
          domainId: e.domainId,
          reasonCode: e.reasonCode,
          message: e.message,
          correctionPath: e.correctionPath,
        },
        e.status as 422,
      );
    }
    if ((e as Error).name === 'BeneficiaryAccessDenied') {
      return c.json({ error: 'forbidden', message: (e as Error).message }, 403);
    }
    console.error('payout route failure', e);
    return c.json({ error: 'internal' }, 500);
  }
}
