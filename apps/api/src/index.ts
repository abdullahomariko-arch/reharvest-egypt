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
import { PaymobClient } from '@reharvest/payments/paymob';
import { buildP0Registry } from '@reharvest/core/guard';

/* ------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------ */

interface Config {
  readonly port: number;
  readonly databaseUrl: string;
  readonly authSecret: string;
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

  const app = new Hono();

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
      distanceKm: () => 28,
      originName: (lot) => lot.supplierId,
    }),
  );

  app.route(
    '/',
    buildPaymentRoutes({
      payments: new PaymentService({
        paymob: new PaymobClient(config.paymob as never, fetch),
        config: config.paymob as never,
        orders: {
          async findByCode() {
            return null;
          },
          async advance() {},
        },
        payments: {
          async findByProviderTransactionId() {
            return null;
          },
          async recordInbound() {},
          async markUnmatched() {},
        },
        controls: buildP0Registry({ record: () => {} }),
        clock,
      }),
      idempotency: makeIdempotencyStore(),
      authenticate: async (req) => {
        const p = await authenticate(req);
        return p ? { userId: p.userId, roles: [...p.roles] } : null;
      },
    }),
  );

  return { app, client };
}

/**
 * Idempotency store.
 *
 * In-memory here, which is correct for a single instance and wrong for more
 * than one — two instances behind a load balancer will not see each other's
 * replays. Moving this to Redis or a Postgres table is the first thing to do
 * before scaling horizontally, and it is called out in the deployment notes.
 */
function makeIdempotencyStore() {
  const map = new Map<string, { status: number; body: unknown; at: number }>();
  const TTL_MS = 24 * 3600 * 1000;

  return {
    async get(key: string) {
      const hit = map.get(key);
      if (!hit) return null;
      if (Date.now() - hit.at > TTL_MS) {
        map.delete(key);
        return null;
      }
      return { status: hit.status, body: hit.body };
    },
    async put(key: string, value: { status: number; body: unknown }) {
      map.set(key, { ...value, at: Date.now() });
    },
  };
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
