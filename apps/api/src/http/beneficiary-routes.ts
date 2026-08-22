/**
 * Beneficiary routes.
 *
 * The only way bank details enter the system over HTTP. Every write goes through
 * the repository, so encryption and record binding are not something a call site
 * can forget — there is no path that writes the column directly.
 *
 * Reads never return a full account number. The list and detail responses carry
 * the last four digits, which is what a screen needs and what finance reads back
 * to a supplier on the phone. The full number is reachable only from the payout
 * submission path, bound to a settlement and audited.
 */

import { Hono, type Context } from 'hono';

import type { BeneficiaryRepository } from '../repo/beneficiary.ts';
import type { Principal } from '../auth.ts';
import { Forbidden, hasRole, isPlatformStaff } from '../authz.ts';

type Vars = { principal: Principal };

export interface BeneficiaryRouteDeps {
  readonly beneficiaries: BeneficiaryRepository;
  readonly authenticate: (req: Request) => Promise<Principal | null>;
}

export function buildBeneficiaryRoutes(deps: BeneficiaryRouteDeps) {
  const app = new Hono<{ Variables: Vars }>();

  app.use('/beneficiaries', guard);
  app.use('/beneficiaries/*', guard);

  async function guard(c: Context<{ Variables: Vars }>, next: () => Promise<void>) {
    const p = await deps.authenticate(c.req.raw);
    if (!p) return c.json({ error: 'unauthenticated' }, 401);
    c.set('principal', p);
    await next();
  }

  /**
   * Bank details on file for a party.
   *
   * A supplier sees their own. Platform staff can look at any party, because
   * finance has to confirm an account before a payment run.
   */
  app.get('/beneficiaries', async (c) => {
    const p = c.get('principal');
    const requested = c.req.query('partyId') ?? p.partyId;

    if (requested !== p.partyId && !isPlatformStaff(p)) {
      return c.json({ error: 'forbidden', reasonCode: 'NOT_YOUR_PARTY' }, 403);
    }

    const rows = await deps.beneficiaries.listForParty(requested);

    // Tail only. Deliberately built field by field rather than spread, so a
    // column added to the repository's summary type cannot leak here by default.
    return c.json({
      beneficiaries: rows.map((b) => ({
        id: b.id,
        channel: b.channel,
        holderName: b.holderName,
        bankCode: b.bankCode,
        accountTail: b.accountTail,
        effectiveFrom: b.effectiveFrom,
        supersededAt: b.supersededAt,
        current: b.supersededAt === null,
      })),
    });
  });

  /**
   * Record new or changed bank details.
   *
   * A supplier may record their own; ops may record on their behalf, which is
   * how a phone call from a packhouse actually gets handled. Either way the
   * repository supersedes the previous row rather than overwriting it, so the
   * 24-hour payout cooldown has a change to measure from.
   */
  app.post('/beneficiaries', async (c) => {
    const p = c.get('principal');
    const b = await c.req.json<{
      partyId?: string;
      channel?: 'bank' | 'wallet';
      accountNumber?: string;
      holderName?: string;
      bankCode?: string;
    }>();

    const partyId = b.partyId ?? p.partyId;

    if (partyId !== p.partyId && !hasRole(p, 'ops_agent', 'ops_manager', 'finance')) {
      return c.json({ error: 'forbidden', reasonCode: 'NOT_YOUR_PARTY' }, 403);
    }

    if (!b.accountNumber || !b.holderName || !b.channel) {
      return c.json(
        {
          error: 'invalid',
          message: 'channel, accountNumber and holderName are all required.',
        },
        400,
      );
    }

    try {
      const created = await deps.beneficiaries.record({
        partyId,
        channel: b.channel,
        accountNumber: b.accountNumber,
        holderName: b.holderName,
        bankCode: b.bankCode,
        actorId: p.userId,
        actorRoles: p.roles,
        at: new Date().toISOString(),
      });

      // The response echoes the tail, never the number that was just submitted.
      // Echoing it back would put a full account number in a browser's network
      // log the moment after it was encrypted.
      return c.json(
        {
          id: created.id,
          accountTail: created.accountTail,
          holderName: created.holderName,
          effectiveFrom: created.effectiveFrom,
          note: 'Payouts to this account are blocked for 24 hours after a change.',
        },
        201,
      );
    } catch (e) {
      if (e instanceof Forbidden) {
        return c.json({ error: 'forbidden', message: e.message }, 403);
      }
      if ((e as Error).name === 'BeneficiaryAccessDenied') {
        return c.json({ error: 'invalid', message: (e as Error).message }, 400);
      }
      throw e;
    }
  });

  return app;
}
