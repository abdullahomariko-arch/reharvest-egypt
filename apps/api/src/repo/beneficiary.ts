/**
 * Beneficiary repository.
 *
 * The single door for every beneficiary read and write. That is the whole
 * design: encryption that some call sites apply and others forget is not
 * encryption, it is a plaintext column with a good story. Nothing outside this
 * file touches the `beneficiaries` table.
 *
 * Two rules it enforces that are easy to lose otherwise:
 *
 * 1. **Reads do not decrypt.** The ordinary read returns the last four digits
 *    and nothing else, because that is all any list, console page or API
 *    response has ever needed. Full account numbers are reachable only through
 *    `revealForPayout`, which demands an explicit authorisation object and
 *    writes an audit entry every time.
 *
 * 2. **Every ciphertext is bound to its row.** GCM authenticates bytes, not
 *    location. Without binding, anyone with write access can lift a complete
 *    encrypted value from one beneficiary into another; it decrypts cleanly and
 *    the money goes to the wrong bank account with every check passing. That was
 *    demonstrated as a working attack before this existed.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import { beneficiaries } from '@reharvest/db/schema';
import { Keyring, accountTail, type FieldBinding } from '@reharvest/core/crypto';
import { appendAudit } from './payment-postgres.ts';

type Db = PostgresJsDatabase<Record<string, never>>;

/** The field name that goes into the AAD. Changing it invalidates every row. */
const ACCOUNT_FIELD = 'account_number';

/**
 * The identity maintenance commands act under.
 *
 * A real UUID rather than a label, because audit_log.actor_id is a uuid column
 * and every actor in the log has to be resolvable. Backfills and rotations are
 * attributable to this actor plus whoever ran the command.
 */
export const SYSTEM_MAINTENANCE_ACTOR = '00000000-0000-4000-8000-00000000000f';

const bindingFor = (beneficiaryId: string): FieldBinding => ({
  recordId: beneficiaryId,
  field: ACCOUNT_FIELD,
});

/** What a caller gets from an ordinary read. Deliberately no full number. */
export interface BeneficiarySummary {
  readonly id: string;
  readonly partyId: string;
  readonly channel: string;
  readonly holderName: string;
  readonly bankCode: string | null;
  /** Last four digits, for reading back to a supplier over the phone. */
  readonly accountTail: string;
  readonly effectiveFrom: string;
  readonly supersededAt: string | null;
  readonly verifiedOutOfBandAt: string | null;
  readonly encryptionKeyId: string | null;
}

/**
 * Proof that a specific payout needs a specific account number.
 *
 * Required by `revealForPayout` and recorded in the audit entry, so every
 * decryption of a real bank account is attributable to a settlement and a
 * person rather than appearing as an unexplained read.
 */
export interface PayoutAuthorisation {
  readonly settlementId: string;
  readonly actorId: string;
  readonly actorRoles: readonly string[];
}

export class BeneficiaryAccessDenied extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BeneficiaryAccessDenied';
  }
}

export class BeneficiaryNotFound extends Error {
  constructor(id: string) {
    super(`No beneficiary ${id}.`);
    this.name = 'BeneficiaryNotFound';
  }
}

export function createBeneficiaryRepository(db: Db, keyring: Keyring) {
  const toSummary = (r: typeof beneficiaries.$inferSelect): BeneficiarySummary => ({
    id: r.id,
    partyId: r.partyId,
    channel: r.channel,
    holderName: r.holderName,
    bankCode: r.bankCode,
    accountTail: r.accountTail,
    effectiveFrom: r.effectiveFrom.toISOString(),
    supersededAt: r.supersededAt?.toISOString() ?? null,
    verifiedOutOfBandAt: r.verifiedOutOfBandAt?.toISOString() ?? null,
    encryptionKeyId: r.encryptionKeyId,
  });

  return {
    /** Everything on file for a party. Tails only. */
    async listForParty(partyId: string): Promise<BeneficiarySummary[]> {
      const rows = await db.select().from(beneficiaries).where(eq(beneficiaries.partyId, partyId));
      return rows.map(toSummary);
    },

    /** The account currently in effect for a party, if any. */
    async currentForParty(partyId: string): Promise<BeneficiarySummary | null> {
      const [row] = await db
        .select()
        .from(beneficiaries)
        .where(and(eq(beneficiaries.partyId, partyId), isNull(beneficiaries.supersededAt)))
        .orderBy(sql`${beneficiaries.effectiveFrom} DESC`)
        .limit(1);
      return row ? toSummary(row) : null;
    },

    async byId(id: string): Promise<BeneficiarySummary | null> {
      const [row] = await db.select().from(beneficiaries).where(eq(beneficiaries.id, id)).limit(1);
      return row ? toSummary(row) : null;
    },

    /**
     * Records a new or changed bank account.
     *
     * A change supersedes rather than overwrites: the old row stays, with
     * `superseded_at` set. That history is what the 24-hour payout cooldown is
     * computed from, and an overwrite would erase the very fact that a change
     * happened — which is exactly what the fraud depends on.
     *
     * The row id is generated first because the ciphertext is sealed to it. A
     * value encrypted before the id exists could not be bound to anything.
     */
    async record(input: {
      partyId: string;
      channel: 'bank' | 'wallet';
      accountNumber: string;
      holderName: string;
      bankCode?: string;
      actorId: string;
      actorRoles: readonly string[];
      at: string;
    }): Promise<BeneficiarySummary> {
      const digits = input.accountNumber.replace(/\s/g, '');
      if (digits.length < 4) {
        throw new BeneficiaryAccessDenied('An account number must be at least four characters.');
      }

      return db.transaction(async (tx) => {
        const id = crypto.randomUUID();
        const sealed = await keyring.encrypt(digits, bindingFor(id));

        // Supersede whatever was in effect, in the same transaction, so there is
        // never a moment with two live accounts for one party.
        await tx
          .update(beneficiaries)
          .set({ supersededAt: new Date(input.at) })
          .where(and(eq(beneficiaries.partyId, input.partyId), isNull(beneficiaries.supersededAt)));

        const [row] = await tx
          .insert(beneficiaries)
          .values({
            id,
            partyId: input.partyId,
            channel: input.channel,
            accountNumberEnc: sealed.ciphertext,
            accountNumberIv: sealed.iv,
            encryptionKeyId: sealed.keyId,
            accountTail: accountTail(digits),
            bankCode: input.bankCode,
            holderName: input.holderName,
            effectiveFrom: new Date(input.at),
          })
          .returning();

        await appendAudit(tx as unknown as Db, {
          actorId: input.actorId,
          actorRoles: input.actorRoles,
          action: 'beneficiary.recorded',
          subjectTable: 'beneficiaries',
          subjectId: id,
          decision: 'allowed',
          reasonCode: 'BENEFICIARY_CHANGED',
          domainId: 'D28',
          // The tail only. An audit log that records the number it was
          // protecting is a second copy of the thing being protected.
          afterState: { partyId: input.partyId, accountTail: accountTail(digits), channel: input.channel },
          at: input.at,
        });

        return toSummary(row);
      });
    },

    /**
     * Returns the full account number, for a payout, once.
     *
     * The only path that decrypts. It demands a settlement id and a finance
     * role, and it writes an audit entry before returning — so a decryption
     * that was not part of a payment run is visible after the fact.
     */
    async revealForPayout(beneficiaryId: string, auth: PayoutAuthorisation): Promise<string> {
      if (!auth.actorRoles.some((r) => ['finance', 'ops_manager', 'executive'].includes(r))) {
        throw new BeneficiaryAccessDenied(
          'Reading a full account number requires a finance, ops manager or executive role.',
        );
      }
      if (!auth.settlementId) {
        throw new BeneficiaryAccessDenied(
          'A full account number can only be read against a specific settlement.',
        );
      }

      const [row] = await db.select().from(beneficiaries).where(eq(beneficiaries.id, beneficiaryId)).limit(1);
      if (!row) throw new BeneficiaryNotFound(beneficiaryId);

      if (!row.accountNumberIv || !row.encryptionKeyId) {
        // A row that predates encryption. Refuse rather than guessing that the
        // column holds plaintext — see the backfill command.
        throw new BeneficiaryAccessDenied(
          `Beneficiary ${beneficiaryId} has no encryption metadata. Run the backfill before paying it.`,
        );
      }

      const plaintext = await keyring.decrypt(
        { ciphertext: row.accountNumberEnc, iv: row.accountNumberIv, keyId: row.encryptionKeyId },
        bindingFor(beneficiaryId),
      );

      await appendAudit(db, {
        actorId: auth.actorId,
        actorRoles: auth.actorRoles,
        action: 'beneficiary.revealed',
        subjectTable: 'beneficiaries',
        subjectId: beneficiaryId,
        decision: 'allowed',
        reasonCode: 'PAYOUT_ACCOUNT_READ',
        domainId: 'D28',
        afterState: { settlementId: auth.settlementId, accountTail: row.accountTail },
        at: new Date().toISOString(),
      });

      return plaintext;
    },

    /**
     * Re-seals one row under the active key. The rotation command's inner loop.
     *
     * Returns a result rather than throwing, and never throws for a row it
     * simply cannot open. A rotation run touches every beneficiary, and one bad
     * row aborting the whole pass means a half-rotated table and an operator who
     * has to work out where it stopped.
     *
     * `unreadable` is a real state, not a theoretical one: rows written before
     * the record binding existed cannot be opened under the current scheme at
     * all. They are not a rotation problem — they need re-entering from a
     * trusted source through `backfillRow`.
     */
    async rotateRow(
      beneficiaryId: string,
    ): Promise<'rotated' | 'already-current' | 'no-metadata' | 'unreadable'> {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(beneficiaries)
          .where(eq(beneficiaries.id, beneficiaryId))
          .limit(1);

        if (!row || !row.accountNumberIv || !row.encryptionKeyId) return 'no-metadata';
        if (row.encryptionKeyId === keyring.activeKeyId) return 'already-current';

        const binding = bindingFor(beneficiaryId);
        let resealed;
        try {
          resealed = await keyring.rotate(
            { ciphertext: row.accountNumberEnc, iv: row.accountNumberIv, keyId: row.encryptionKeyId },
            binding,
          );
        } catch {
          return 'unreadable';
        }

        await tx
          .update(beneficiaries)
          .set({
            accountNumberEnc: resealed.ciphertext,
            accountNumberIv: resealed.iv,
            encryptionKeyId: resealed.keyId,
          })
          .where(eq(beneficiaries.id, beneficiaryId));

        return 'rotated';
      });
    },

    /**
     * Ids of encrypted rows not sealed under the active key. Drives rotation.
     *
     * Deliberately excludes rows with no encryption metadata. Those are the
     * backfill's job, and including them made rotation report work it could
     * never complete — the operator sees a count that never reaches zero and
     * stops trusting the command.
     */
    async idsNeedingRotation(): Promise<string[]> {
      const rows = await db
        .select({ id: beneficiaries.id })
        .from(beneficiaries)
        .where(
          and(
            sql`${beneficiaries.encryptionKeyId} IS NOT NULL`,
            sql`${beneficiaries.encryptionKeyId} <> ${keyring.activeKeyId}`,
          ),
        );
      return rows.map((r) => r.id);
    },

    /** Ids of rows with no encryption metadata at all. Drives the backfill. */
    async idsNeedingBackfill(): Promise<Array<{ id: string; stored: string }>> {
      const rows = await db
        .select({ id: beneficiaries.id, stored: beneficiaries.accountNumberEnc })
        .from(beneficiaries)
        .where(isNull(beneficiaries.encryptionKeyId));
      return rows;
    },

    /**
     * Encrypts a row that was written before encryption existed.
     *
     * Takes the plaintext explicitly rather than reading the column, because
     * legacy rows hold a mixture: some plaintext, some the string
     * `enc:placeholder` from an early seed. Guessing which is which is how a
     * literal placeholder ends up encrypted and treated as a real account.
     */
    async backfillRow(
      beneficiaryId: string,
      plaintextAccount: string,
      actorId: string = SYSTEM_MAINTENANCE_ACTOR,
    ): Promise<void> {
      const digits = plaintextAccount.replace(/\s/g, '');
      const sealed = await keyring.encrypt(digits, bindingFor(beneficiaryId));

      await db.transaction(async (tx) => {
        await tx
          .update(beneficiaries)
          .set({
            accountNumberEnc: sealed.ciphertext,
            accountNumberIv: sealed.iv,
            encryptionKeyId: sealed.keyId,
            accountTail: accountTail(digits),
          })
          .where(and(eq(beneficiaries.id, beneficiaryId), isNull(beneficiaries.encryptionKeyId)));

        await appendAudit(tx as unknown as Db, {
          actorId,
          actorRoles: ['ops_manager'],
          action: 'beneficiary.backfilled',
          subjectTable: 'beneficiaries',
          subjectId: beneficiaryId,
          decision: 'allowed',
          reasonCode: 'ENCRYPTION_BACKFILL',
          domainId: 'D28',
          afterState: { accountTail: accountTail(digits), keyId: sealed.keyId },
          at: new Date().toISOString(),
        });
      });
    },
  };
}

export type BeneficiaryRepository = ReturnType<typeof createBeneficiaryRepository>;
