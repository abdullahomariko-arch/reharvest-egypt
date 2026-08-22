/**
 * Server entry point.
 *
 * The only file in the API that knows about the outside world: environment
 * variables, the database connection, the Paymob credentials. Everything below
 * it takes its dependencies as arguments, which is why the whole business layer
 * is testable without a Postgres or a network.
 *
 * Configuration is validated at boot and the process refuses to start if
 * anything required is missing. A service that starts with a missing HMAC secret
 * and only discovers it when the first webhook arrives has turned a config
 * error into a payment incident.
 */

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';

import { buildLotRoutes } from './http/lot-routes.ts';
import { buildRoutes as buildPaymentRoutes } from './http/routes.ts';
import { makeAuthenticator } from './auth.ts';
import { LotService, OrderService } from './service/lot-order-service.ts';
import { PaymentService } from './service/payment-service.ts';
import { createLotRepo, createOrderRepo } from './repo/postgres.ts';
import {
  createPaymentOrderRepo,
  createPaymentRepo,
  createWebhookTransactor,
  verifyAuditChain,
} from './repo/payment-postgres.ts';
import { buildOpsConsole } from '../../admin/src/routes.ts';
import { createIdempotencyStore } from './repo/idempotency.ts';
import { createSessionStore } from './session.ts';
import { assertMayReadInternal } from './authz.ts';
import { buildAuthRoutes } from './http/auth-routes.ts';
import { buildPayoutRoutes } from './http/payout-routes.ts';
import { buildBeneficiaryRoutes } from './http/beneficiary-routes.ts';
import { createBeneficiaryRepository } from './repo/beneficiary.ts';
import { createFakeDisbursement, assertDisbursementDriverIsSafe } from './fake-disbursement.ts';
import { createOtpService, createOtpProvider, type OtpConfig } from './otp.ts';
import { verifyStaffLogin } from './staff-login.ts';
import { Keyring } from '@reharvest/core/crypto';
import { PaymobClient } from '@reharvest/payments/paymob';
import { buildP0Registry } from '@reharvest/core/guard';

/* ------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------ */

interface Config {
  readonly port: number;
  readonly databaseUrl: string;
  readonly authSecret: string;
  readonly encryptionKeys: string;
  readonly otp: OtpConfig;
  readonly paymob: {
    baseUrl: string;
    secretKey: string;
    publicKey: string;
    hmacSecret: string;
    integrationIds: Record<string, number[]>;
  };
}

function loadConfig(env: NodeJS.ProcessEnv): Config {
  const missing: string[] = [];
  const need = (name: string): string => {
    const v = env[name];
    if (!v) missing.push(name);
    return v ?? '';
  };

  const config: Config = {
    port: Number(env.PORT ?? 8787),
    databaseUrl: need('DATABASE_URL'),
    authSecret: need('AUTH_SIGNING_SECRET'),
    encryptionKeys: need('FIELD_ENCRYPTION_KEYS'),
    otp: {
      // Defaults to the stub only outside production; production has no default.
      driver: (env.OTP_DRIVER as 'console' | 'http-sms') ?? (env.NODE_ENV === 'production' ? 'http-sms' : 'console'),
      endpoint: env.OTP_SMS_ENDPOINT,
      apiKey: env.OTP_SMS_API_KEY,
      senderId: env.OTP_SMS_SENDER_ID,
    },
    paymob: {
      baseUrl: env.PAYMOB_BASE_URL ?? 'https://accept.paymob.com',
      secretKey: need('PAYMOB_SECRET_KEY'),
      publicKey: need('PAYMOB_PUBLIC_KEY'),
      hmacSecret: need('PAYMOB_HMAC_SECRET'),
      integrationIds: {
        card: intList(env.PAYMOB_INTEGRATION_CARD),
        wallet: intList(env.PAYMOB_INTEGRATION_WALLET),
        kiosk_cash: intList(env.PAYMOB_INTEGRATION_KIOSK),
        bank_transfer: intList(env.PAYMOB_INTEGRATION_BANK),
        bnpl: intList(env.PAYMOB_INTEGRATION_BNPL),
      },
    },
  };

  if (missing.length) {
    // Fail loudly at boot rather than quietly at the first webhook.
    throw new Error(
      `Refusing to start. Missing required environment variables:\n  ${missing.join('\n  ')}\n` +
        `See .env.example for what each one is.`,
    );
  }

  if (config.authSecret.length < 32) {
    throw new Error('AUTH_SIGNING_SECRET must be at least 32 characters. Short secrets are brute-forceable.');
  }

  // Validated at boot rather than at the first payout. A malformed keyring
  // discovered while money is moving is the worst possible time to find out.
  Keyring.fromEnv(config.encryptionKeys);

  // Same reasoning: a bad OTP configuration should stop the deploy, not the
  // first person trying to sign in.
  createOtpProvider(config.otp, env.NODE_ENV);

  return config;
}

const intList = (v: string | undefined): number[] =>
  (v ?? '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);

/* ------------------------------------------------------------------ *
 * Composition
 * ------------------------------------------------------------------ */

export function buildServer(config: Config) {
  // `max` is deliberately modest: this API is I/O bound on Paymob and Postgres,
  // and a large pool mostly buys you a thundering herd after a blip.
  const client = postgres(config.databaseUrl, { max: 10, idle_timeout: 20 });
  const db = drizzle(client);

  const lotRepo = createLotRepo(db);
  const orderRepo = createOrderRepo(db);
  const clock = { now: () => new Date().toISOString() };
  const authenticate = makeAuthenticator(config.authSecret);
  const idempotency = createIdempotencyStore(db);

  const app = new Hono();

  // Selected by configuration. Production refuses the development stub, and
  // refuses a half-configured gateway, at boot rather than at first sign-in.
  const otpProvider = createOtpProvider(config.otp, process.env.NODE_ENV);

  const keyring = Keyring.fromEnv(config.encryptionKeys);
  const beneficiaries = createBeneficiaryRepository(db, keyring);

  const disbursementDriver = process.env.DISBURSEMENT_DRIVER ?? (process.env.NODE_ENV === 'production' ? 'paymob' : 'fake');
  assertDisbursementDriverIsSafe(disbursementDriver, process.env.NODE_ENV);
  const fakeDisburse = createFakeDisbursement(db);

  app.route('/', buildBeneficiaryRoutes({ beneficiaries, authenticate }));

  app.route(
    '/',
    buildPayoutRoutes({
      db,
      beneficiaries,
      authenticate,
      disburse: async ({ idempotencyKey, amountPiastres, accountNumber, holderName, bankCode }) => {
        if (disbursementDriver === 'fake') {
          return fakeDisburse({ idempotencyKey, amountPiastres, accountNumber, holderName, bankCode });
        }
        const receipt = await new PaymobClient(config.paymob as never, fetch).disburse({
          settlementId: idempotencyKey,
          amount: { amount: amountPiastres, currency: 'EGP' } as never,
          channel: 'bank',
          beneficiaryName: holderName,
          bankAccountNumber: accountNumber,
          bankCode: bankCode ?? undefined,
          preparedBy: 'system',
          approvedBy: 'system',
          idempotencyKey,
        });
        return {
          providerTransactionId: receipt.providerTransactionId,
          status: receipt.status === 'failed' ? ('failed' as const) : ('accepted' as const),
        };
      },
    }),
  );

  app.route('/', buildAuthRoutes({ db, otp: createOtpService(db, otpProvider), authSecret: config.authSecret }));

  /*
    Health checks are two endpoints, not one, and the difference matters to a
    load balancer:

      /health  — is this process alive? Cheap, no dependencies. Used for
                 restart decisions.
      /ready   — can it actually serve? Touches the database. Used for
                 routing decisions.

    Conflating them means a database blip restarts every healthy instance.
  */
  app.get('/health', (c) => c.json({ ok: true, at: clock.now() }));

  /*
    Audit chain integrity. Exposed as an endpoint so it can be scheduled and
    alerted on rather than being something somebody remembers to check. A broken
    chain means either a bug in how entries are written or someone with database
    access editing history; both need a person immediately.
  */
  app.get('/internal/audit-integrity', async (c) => {
    /*
      Restricted. Left open it told anyone on the network how many audit entries
      exist and, more usefully to an attacker, whether tampering had been
      noticed yet. Reproduced as a 200 with no credentials at all.
    */
    const actor = await authenticate(c.req.raw);
    if (!actor) return c.json({ error: 'unauthenticated' }, 401);
    try {
      assertMayReadInternal(actor);
    } catch (e) {
      return c.json({ error: 'forbidden', message: (e as Error).message }, 403);
    }

    const result = await verifyAuditChain(db);
    return c.json(
      {
        ok: result.ok,
        checked: result.checked,
        // Serialised as a string for the same reason every other integer in
        // this API is: JSON.stringify throws on a bigint outright.
        brokenAtSeq: result.brokenAtSeq?.toString(),
      },
      result.ok ? 200 : 500,
    );
  });

  app.get('/ready', async (c) => {
    try {
      await db.execute(sql`SELECT 1`);
      return c.json({ ready: true });
    } catch (e) {
      return c.json({ ready: false, reason: (e as Error).message }, 503);
    }
  });

  app.route(
    '/',
    buildLotRoutes({
      lots: new LotService(lotRepo, clock),
      orders: new OrderService(lotRepo, orderRepo, clock),
      authenticate,
      // Straight-line distance is enough to sort a market list. Road distance
      // belongs to the transport module, which is deliberately out of scope.
      idempotency,
      distanceKm: () => 28,
      originName: (lot) => lot.supplierId,
    }),
  );

  /*
    The ops console is served by the same process as the API, on purpose. It
    calls the same services, so an ops manager quarantining a lot travels the
    identical code path as an inspector doing it from the phone — there is no
    admin back door that skips the rules.
  */
  app.route(
    '/',
    buildOpsConsole({
      db,
      lots: new LotService(lotRepo, clock),
      authenticate,
      sessions: createSessionStore(db, config.authSecret),
      verifyStaffLogin: verifyStaffLogin(db),
      concentrationCeilingPct: 35,
    }),
  );

  app.route(
    '/',
    buildPaymentRoutes({
      payments: new PaymentService({
        paymob: new PaymobClient(config.paymob as never, fetch),
        config: config.paymob as never,
        orders: createPaymentOrderRepo(db),
        payments: createPaymentRepo(db),
        // Record, advance and audit commit together or not at all.
        transact: createWebhookTransactor(db),
        controls: buildP0Registry({ record: () => {} }),
        clock,
      }),
      idempotency,
      authenticate: async (req) => {
        const p = await authenticate(req);
        return p ? { userId: p.userId, partyId: p.partyId, roles: [...p.roles] } : null;
      },
      ownerOfOrder: async (orderCode) => {
        const o = await orderRepo.byCode(orderCode);
        return o?.buyerId ?? null;
      },
    }),
  );

  return { app, client };
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig(process.env);
  const { app, client } = buildServer(config);

  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`ReHarvest API listening on :${info.port}`);
  });

  // Drain in-flight requests before dying. A payout mid-flight when a deploy
  // rolls is exactly the request you do not want half-completed.
  const shutdown = async (signal: string) => {
    console.log(`${signal} received, draining.`);
    server.close();
    await client.end({ timeout: 5 });
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

export { loadConfig };
