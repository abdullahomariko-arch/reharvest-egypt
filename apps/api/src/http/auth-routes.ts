/**
 * Mobile sign-in.
 *
 * Two endpoints, no session state between them beyond the stored code. The
 * token issued at the end is the same signed token every other route verifies,
 * so there is one authentication mechanism rather than a real one and a demo one.
 */

import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import { issueToken } from '../auth.ts';
import { OtpError, type createOtpService } from '../otp.ts';

type Db = PostgresJsDatabase<Record<string, never>>;

export interface AuthRouteDeps {
  readonly db: Db;
  readonly otp: ReturnType<typeof createOtpService>;
  readonly authSecret: string;
}

export function buildAuthRoutes(deps: AuthRouteDeps) {
  const app = new Hono();

  app.post('/auth/request-code', async (c) => {
    const { phone } = await c.req.json<{ phone?: string }>();
    if (!phone || phone.replace(/\D/g, '').length < 10) {
      return c.json({ error: 'invalid_phone', message: 'Enter the mobile number registered with ReHarvest.' }, 400);
    }

    try {
      await deps.otp.request(phone);
    } catch (e) {
      if (e instanceof OtpError) return c.json({ error: e.reasonCode, message: e.message }, e.status as 429);
      throw e;
    }

    // Always the same answer. Confirming which numbers are registered would
    // tell a competitor exactly who trades on an invite-only platform.
    return c.json({ sent: true, message: 'If that number is registered, a code has been sent.' });
  });

  app.post('/auth/verify-code', async (c) => {
    const { phone, code } = await c.req.json<{ phone?: string; code?: string }>();
    if (!phone || !code) return c.json({ error: 'missing_fields' }, 400);

    let result;
    try {
      result = await deps.otp.verify(phone, code);
    } catch (e) {
      if (e instanceof OtpError) return c.json({ error: e.reasonCode, message: e.message }, e.status as 429);
      throw e;
    }

    if (!result) {
      return c.json({ error: 'invalid_code', message: 'That code is not valid. Request a new one.' }, 401);
    }

    // Roles come from the party record, never from the client. A client that
    // can name its own role can pay itself.
    const rows = await deps.db.execute(sql`
      SELECT id, kind, legal_name_ar FROM parties WHERE id = ${result.partyId}::uuid LIMIT 1
    `);
    const party = (rows as unknown as Array<Record<string, unknown>>)[0];
    if (!party) return c.json({ error: 'invalid_code' }, 401);

    const kind = String(party.kind);
    const roles = kind === 'supplier' ? ['supplier'] : kind === 'buyer' ? ['buyer'] : ['ops_agent'];

    const token = await issueToken(
      {
        // The party's own id doubles as the user id until per-person accounts
        // exist for counterparties; both are UUIDs, which the token requires.
        userId: String(party.id),
        partyId: String(party.id),
        roles,
        displayName: String(party.legal_name_ar),
      },
      deps.authSecret,
      12 * 3600,
    );

    return c.json({
      token,
      party: { id: String(party.id), displayName: String(party.legal_name_ar), roles },
    });
  });

  return app;
}
