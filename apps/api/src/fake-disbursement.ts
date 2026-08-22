/**
 * A disbursement provider for development and CI.
 *
 * It records every request it receives, so a test can assert on what actually
 * reached the provider rather than on what the API said it would send. Those
 * are different questions, and only the first one proves that the amount and
 * bank account came from the database.
 *
 * Selected by DISBURSEMENT_DRIVER. Production refuses it for the same reason
 * production refuses the console OTP stub.
 */

import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

type Db = PostgresJsDatabase<Record<string, never>>;

export interface DisbursementRequest {
  readonly idempotencyKey: string;
  readonly amountPiastres: bigint;
  readonly accountNumber: string;
  readonly holderName: string;
  readonly bankCode: string | null;
}

export interface DisbursementResult {
  readonly providerTransactionId: string;
  readonly status: 'accepted' | 'failed';
  readonly failureReason?: string;
}

export function createFakeDisbursement(db: Db) {
  return async (req: DisbursementRequest): Promise<DisbursementResult> => {
    const behaviour = await db.execute(sql`
      SELECT behaviour FROM provider_behaviour WHERE idempotency_key = ${req.idempotencyKey} LIMIT 1
    `);
    const mode = (behaviour as unknown as Array<Record<string, unknown>>)[0]?.behaviour;

    if (mode === 'timeout') {
      /*
        Deliberately records the call BEFORE hanging.

        That is what a real timeout looks like: the provider received it and we
        did not hear back. A fake that fails without recording would let a test
        pass while proving the opposite of what it claims.
      */
      await db.execute(sql`
        INSERT INTO provider_calls (idempotency_key, amount_piastres, account_number, holder_name, bank_code)
        VALUES (${req.idempotencyKey}, ${String(req.amountPiastres)}::bigint, ${req.accountNumber},
                ${req.holderName}, ${req.bankCode})
      `);
      throw new Error('provider timed out');
    }

    await db.execute(sql`
      INSERT INTO provider_calls (idempotency_key, amount_piastres, account_number, holder_name, bank_code)
      VALUES (${req.idempotencyKey}, ${String(req.amountPiastres)}::bigint, ${req.accountNumber},
              ${req.holderName}, ${req.bankCode})
    `);

    if (mode === 'reject') {
      return { providerTransactionId: `fake_${req.idempotencyKey}`, status: 'failed', failureReason: 'rejected by fake provider' };
    }

    return { providerTransactionId: `fake_${req.idempotencyKey}`, status: 'accepted' };
  };
}

export function assertDisbursementDriverIsSafe(driver: string, nodeEnv: string | undefined): void {
  if (nodeEnv === 'production' && driver === 'fake') {
    throw new Error(
      'Refusing to start: DISBURSEMENT_DRIVER=fake records payouts to a table instead of sending them.',
    );
  }
}
