/**
 * One-time codes for mobile sign-in.
 *
 * Phone and a code, not email and password. A packhouse foreman has a phone
 * number; a meaningful share have no email they check, and a password they will
 * never remember becomes a shared password written on the office wall.
 *
 * The provider is an interface with a development implementation that logs the
 * code, so the whole flow — rate limits, expiry, attempt counting, token
 * issuance — is exercised locally without an SMS account. Stubbing at the
 * "sign in as this user" level instead, which is what the demo screen did,
 * means none of that logic runs until production.
 */

import { randomInt, timingSafeEqual, createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

type Db = PostgresJsDatabase<Record<string, never>>;

export interface OtpProvider {
  readonly name: string;
  send(phoneE164: string, code: string): Promise<void>;
}

/** Logs the code. Development and CI only — never selected in production. */
export const consoleOtpProvider: OtpProvider = {
  name: 'console',
  async send(phone, code) {
    console.log(`[otp] ${phone} -> ${code}`);
  },
};

/**
 * A real SMS gateway, over HTTP.
 *
 * Written against the shape every Egyptian aggregator exposes — a POST with an
 * account credential, a destination and a body — because the specific vendor is
 * a procurement decision and should not be a code change. Endpoint, credentials
 * and sender id all come from configuration.
 */
export function httpSmsProvider(config: {
  endpoint: string;
  apiKey: string;
  senderId: string;
  fetchImpl?: typeof fetch;
}): OtpProvider {
  const doFetch = config.fetchImpl ?? fetch;

  return {
    name: 'http-sms',
    async send(phone, code) {
      const res = await doFetch(config.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({
          to: phone,
          from: config.senderId,
          // Deliberately says who it is from and that ReHarvest will never ask
          // for it. The common attack is a phone call asking a supplier to read
          // the code back.
          text: `ReHarvest: your sign-in code is ${code}. It expires in 10 minutes. We will never ask you for it.`,
        }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        // The code is never logged here, even on failure. A delivery error is
        // not a reason to write a live credential to the application log.
        throw new OtpError(
          `The SMS gateway rejected the message (${res.status}).`,
          'OTP_DELIVERY_FAILED',
          502,
        );
      }
    },
  };
}

export interface OtpConfig {
  /** Which provider to use. Explicit, never inferred from NODE_ENV. */
  readonly driver: 'console' | 'http-sms';
  readonly endpoint?: string;
  readonly apiKey?: string;
  readonly senderId?: string;
}

/**
 * Builds the provider from configuration.
 *
 * Selection is explicit rather than derived from NODE_ENV. The previous version
 * hard-coded the console stub and then refused to start in production, so the
 * shipped image could not boot at all — the guard was right and the wiring
 * around it was wrong.
 *
 * Production still cannot fall back to the stub: choosing `console` while
 * NODE_ENV is production is refused here, at boot, rather than discovered when
 * the first supplier cannot sign in.
 */
export function createOtpProvider(config: OtpConfig, nodeEnv: string | undefined): OtpProvider {
  if (config.driver === 'console') {
    if (nodeEnv === 'production') {
      throw new Error(
        'Refusing to start: OTP_DRIVER=console is a development stub and would write every sign-in ' +
          'code to the application log. Set OTP_DRIVER=http-sms with OTP_SMS_ENDPOINT, OTP_SMS_API_KEY ' +
          'and OTP_SMS_SENDER_ID.',
      );
    }
    return consoleOtpProvider;
  }

  const missing = (['endpoint', 'apiKey', 'senderId'] as const).filter((k) => !config[k]);
  if (missing.length > 0) {
    // Fails at boot, not at the first sign-in attempt. A half-configured gateway
    // that starts cleanly is discovered by a supplier standing in a yard.
    throw new Error(
      `Refusing to start: OTP_DRIVER=http-sms is missing ${missing
        .map((k) => `OTP_SMS_${k === 'apiKey' ? 'API_KEY' : k === 'senderId' ? 'SENDER_ID' : 'ENDPOINT'}`)
        .join(', ')}.`,
    );
  }

  return httpSmsProvider({
    endpoint: config.endpoint!,
    apiKey: config.apiKey!,
    senderId: config.senderId!,
  });
}

const CODE_TTL_MINUTES = 10;
const MAX_ATTEMPTS = 5;
/** Per phone number, per window. Stops an attacker cycling codes cheaply. */
const MAX_REQUESTS_PER_HOUR = 5;

/** Codes are stored hashed. A leaked table must not be a list of live codes. */
const hashCode = (phone: string, code: string): string =>
  createHash('sha256').update(`${phone}\u0000${code}`).digest('hex');

export class OtpError extends Error {
  constructor(
    message: string,
    readonly reasonCode: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'OtpError';
  }
}

export function createOtpService(db: Db, provider: OtpProvider) {
  return {
    /**
     * Issues a code, if the number belongs to an approved party.
     *
     * The response is identical whether the number is known or not. This is an
     * invite-only marketplace, and a sign-in endpoint that confirms membership
     * tells a competitor exactly who trades here.
     */
    async request(phoneE164: string): Promise<{ sent: boolean }> {
      const phone = phoneE164.trim();

      const recent = await db.execute(sql`
        SELECT count(*)::int AS n FROM otp_codes
         WHERE phone_e164 = ${phone} AND created_at > now() - interval '1 hour'
      `);
      const count = Number((recent as unknown as Array<Record<string, unknown>>)[0]?.n ?? 0);
      if (count >= MAX_REQUESTS_PER_HOUR) {
        throw new OtpError(
          'Too many sign-in codes requested. Try again in an hour.',
          'OTP_RATE_LIMITED',
          429,
        );
      }

      const parties = await db.execute(sql`
        SELECT id FROM parties WHERE phone_e164 = ${phone} AND state = 'ACTIVE' LIMIT 1
      `);
      const party = (parties as unknown as Array<Record<string, unknown>>)[0];

      // Unknown number: record nothing, send nothing, and report success anyway.
      if (!party) return { sent: true };

      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');

      await db.execute(sql`
        INSERT INTO otp_codes (phone_e164, code_hash, party_id, expires_at)
        VALUES (${phone}, ${hashCode(phone, code)}, ${String(party.id)}::uuid,
                now() + interval '${sql.raw(String(CODE_TTL_MINUTES))} minutes')
      `);

      await provider.send(phone, code);
      return { sent: true };
    },

    /**
     * Verifies a code and returns the party it belongs to.
     *
     * Attempts are counted against the stored row, so guessing is bounded by
     * the code's lifetime rather than by the attacker's patience.
     */
    async verify(phoneE164: string, code: string): Promise<{ partyId: string } | null> {
      const phone = phoneE164.trim();

      const rows = await db.execute(sql`
        SELECT id, code_hash, party_id, attempts FROM otp_codes
         WHERE phone_e164 = ${phone} AND consumed_at IS NULL AND expires_at > now()
         ORDER BY created_at DESC LIMIT 1
      `);
      const row = (rows as unknown as Array<Record<string, unknown>>)[0];
      if (!row) return null;

      if (Number(row.attempts) >= MAX_ATTEMPTS) {
        throw new OtpError(
          'Too many incorrect attempts. Request a new code.',
          'OTP_ATTEMPTS_EXCEEDED',
          429,
        );
      }

      const expected = Buffer.from(String(row.code_hash), 'hex');
      const actual = Buffer.from(hashCode(phone, code.trim()), 'hex');
      const ok = expected.length === actual.length && timingSafeEqual(expected, actual);

      if (!ok) {
        await db.execute(sql`UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ${String(row.id)}::uuid`);
        return null;
      }

      // Single use. Without this a code observed once works until it expires.
      await db.execute(sql`UPDATE otp_codes SET consumed_at = now() WHERE id = ${String(row.id)}::uuid`);
      return { partyId: String(row.party_id) };
    },
  };
}
