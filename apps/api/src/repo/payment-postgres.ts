/**
 * Payment repositories.
 *
 * These are what turn the payment service from a tested-but-unplugged component
 * into something that can actually clear a deposit. Until this file existed the
 * server ran with stub repos that returned null for everything, which meant a
 * perfectly valid Paymob webhook would verify, reconcile, and then quietly do
 * nothing.
 *
 * Three things here are load-bearing:
 *
 * 1. **Unmatched money is recorded, never dropped.** A payment that arrives for
 *    an order we do not recognise still gets a row. Finance allocates it by
 *    hand. Money that exists in a bank account but not in the ledger is the
 *    worst kind of discrepancy, because nobody knows to go looking for it.
 *
 * 2. **Order advancement is a compare-and-swap.** Two webhook deliveries racing
 *    each other must not both advance the order.
 *
 * 3. **Every advance writes an audit row, hash-chained to the one before it.**
 *    The chain is what makes the log evidence rather than a list: altering an
 *    entry breaks every hash after it, and the audit table has UPDATE and DELETE
 *    revoked besides.
 */

import { and, eq, sql, desc } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { createHash } from 'node:crypto';

import { orders, orderTermVersions, payments, auditLog, parties } from '@reharvest/db/schema';
import { egp, type Money } from '@reharvest/core/money';
import type { OrderRecord, OrderRepo, PaymentRepo, StoredPayment, AdvanceAudit } from '../service/payment-service.ts';
import type { OrderState } from '@reharvest/core/state-machines';

type Db = PostgresJsDatabase<Record<string, never>>;

/** 30% deposit, matching DEPOSIT_BPS in the order service. */
const DEPOSIT_BPS = 3000n;

/* ------------------------------------------------------------------ *
 * Audit chain
 * ------------------------------------------------------------------ */

/**
 * Appends a hash-chained audit entry.
 *
 * `previousHash` is the hash of the most recent row, so entries form a chain.
 * Tampering with any historical row invalidates every hash after it, which is
 * detectable by re-walking the chain. Combined with the REVOKE in
 * migration 0001, this is what makes the log defensible to an auditor rather
 * than merely informative to us.
 */
export interface AuditEntryInput {
  readonly actorId: string;
  readonly actorRoles: readonly string[];
  readonly action: string;
  /** The table the subject lives in, e.g. 'orders'. */
  readonly subjectTable: string;
  /** Must be the row's UUID, not a human-facing code. */
  readonly subjectId: string;
  readonly decision: 'allowed' | 'blocked';
  readonly reasonCode: string;
  readonly domainId?: string;
  readonly beforeState?: unknown;
  readonly afterState?: unknown;
  readonly at: string;
}

/**
 * Stable JSON: object keys sorted recursively.
 *
 * This exists because of a real failure. `before_state` and `after_state` are
 * jsonb columns, and **jsonb does not preserve key order** — Postgres normalises
 * it on write. So hashing `JSON.stringify(payload)` produced one string going in
 * and a different one coming back out, and the integrity check reported every
 * healthy chain as tampered with.
 *
 * A hash over data that round-trips through a normalising store has to be taken
 * over a canonical form, not over whatever key order the writer happened to use.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;

  const record = value as Record<string, unknown>;
  /*
    Undefined keys are dropped, matching what jsonb does.

    `{ providerTransactionId: 'x', failureReason: undefined }` hashed as
    `failureReason: null` on the way in, but Postgres stored the key not at all
    and returned `{ providerTransactionId: 'x' }` — a different string, a
    different hash, and an integrity check reporting tampering on an untouched
    chain.

    That is the third defect of this exact shape (after jsonb reordering keys
    and timestamps gaining milliseconds). The rule they all point at: anything
    hashed here must round-trip through Postgres byte-identical, so the hash is
    taken over the *stored* form rather than the in-memory one.
  */
  const keys = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort();

  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(',')}}`;
}

/** Canonical serialisation. Field order is fixed, or the same entry hashes
 *  differently between runs and a healthy chain looks tampered with. */
function canonicalise(prevHash: string, e: AuditEntryInput): string {
  return JSON.stringify([
    prevHash,
    /*
      Normalised, because the value that goes in is not the value that comes
      back. A caller passing '2026-08-18T09:00:00Z' has it stored as a
      timestamptz and re-read as '2026-08-18T09:00:00.000Z' — different strings,
      different hash, and the integrity check reports tampering on a chain that
      is perfectly intact.

      Every field hashed here must survive the database round trip unchanged.
      This is the second instance of that same class of bug; the first was jsonb
      reordering object keys.
    */
    new Date(e.at).toISOString(),
    e.actorId,
    stableStringify([...e.actorRoles].sort()),
    e.action,
    e.subjectTable,
    e.subjectId,
    e.decision,
    e.reasonCode,
    e.domainId ?? '',
    stableStringify(e.beforeState ?? null),
    stableStringify(e.afterState ?? null),
  ]);
}

/**
 * Appends an entry, taking its own transaction if it was not given one.
 *
 * `pg_advisory_xact_lock` is released at the end of the surrounding
 * transaction. Called on a plain connection each statement is its own
 * transaction, so the lock would be released before the insert it was meant to
 * protect — the guard would appear present and do nothing. Two call sites did
 * exactly that.
 */
export async function appendAudit(db: Db, entry: AuditEntryInput): Promise<void> {
  const inTransaction = (db as unknown as { transaction?: unknown }).transaction === undefined;
  if (inTransaction) return appendAuditInTx(db, entry);
  return db.transaction(async (tx) => appendAuditInTx(tx as unknown as Db, entry));
}

async function appendAuditInTx(tx: Db, entry: AuditEntryInput): Promise<void> {
  /*
    Serialise appends across every instance.

    Reading the chain tip and inserting the next link are two statements, and
    two processes doing that concurrently both read the same tip and both chain
    from it. The chain forks, and the integrity check then reports tampering
    that never happened — which is worse than no check at all, because it
    trains people to ignore the alarm.

    Found on a fresh database with two API instances running the integration
    suites: the chain broke at sequence 16. A long-lived development database
    with one instance had never surfaced it.

    A transaction-scoped advisory lock is the right tool: it is released
    automatically on commit or rollback, so a crash mid-append cannot wedge the
    audit log for everyone.
  */
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('reharvest_audit_chain'))`);

  const [prev] = await tx
    .select({ seq: auditLog.seq, hash: auditLog.hash })
    .from(auditLog)
    .orderBy(desc(auditLog.seq))
    .limit(1);

  const prevHash = prev?.hash ?? 'GENESIS';
  const seq = (prev?.seq ?? 0n) + 1n;

  await tx.insert(auditLog).values({
    seq,
    at: new Date(entry.at),
    actorId: entry.actorId,
    actorRoles: [...entry.actorRoles],
    action: entry.action,
    subjectTable: entry.subjectTable,
    subjectId: entry.subjectId,
    domainId: entry.domainId,
    decision: entry.decision,
    reasonCode: entry.reasonCode,
    beforeState: (entry.beforeState ?? null) as never,
    afterState: (entry.afterState ?? null) as never,
    prevHash,
    hash: createHash('sha256').update(canonicalise(prevHash, entry)).digest('hex'),
  });
}

/**
 * Re-walks the chain and reports the first entry whose hash does not follow
 * from its predecessor. Intended for a scheduled integrity check, and for the
 * moment somebody asks whether the log can be trusted.
 */
export async function verifyAuditChain(db: Db): Promise<{ ok: boolean; brokenAtSeq?: bigint; checked: number }> {
  const rows = await db.select().from(auditLog).orderBy(auditLog.seq);

  let prevHash = 'GENESIS';
  for (const r of rows) {
    const expected = createHash('sha256')
      .update(
        canonicalise(prevHash, {
          actorId: r.actorId ?? '',
          actorRoles: r.actorRoles ?? [],
          action: r.action,
          subjectTable: r.subjectTable,
          subjectId: r.subjectId,
          decision: r.decision as 'allowed' | 'blocked',
          reasonCode: r.reasonCode,
          domainId: r.domainId ?? undefined,
          beforeState: r.beforeState,
          afterState: r.afterState,
          at: r.at.toISOString(),
        }),
      )
      .digest('hex');

    // Both the stored hash and the stored prev pointer must agree. Checking
    // only the hash would miss a row deleted from the middle of the chain.
    if (expected !== r.hash || prevHash !== r.prevHash) {
      return { ok: false, brokenAtSeq: r.seq, checked: rows.length };
    }
    prevHash = r.hash;
  }
  return { ok: true, checked: rows.length };
}

/* ------------------------------------------------------------------ *
 * Orders, as the payment service sees them
 * ------------------------------------------------------------------ */

export function createPaymentOrderRepo(db: Db): OrderRepo {
  return {
    async findByCode(orderCode): Promise<OrderRecord | null> {
      const [o] = await db.select().from(orders).where(eq(orders.orderCode, orderCode)).limit(1);
      if (!o) return null;

      const [terms] = await db
        .select()
        .from(orderTermVersions)
        .where(eq(orderTermVersions.orderId, o.id))
        .orderBy(desc(orderTermVersions.version))
        .limit(1);

      if (!terms) return null;

      const [buyer] = await db.select().from(parties).where(eq(parties.id, o.buyerId)).limit(1);

      const total = egp.fromPiastres((terms.pricePerKgPiastres * terms.quantityGrams + 500n) / 1000n);
      const deposit = egp.fromPiastres((total.amount * DEPOSIT_BPS + 5000n) / 10000n);

      return {
        orderCode: o.orderCode,
        buyerId: o.buyerId,
        buyerLegalName: buyer?.legalNameAr ?? 'unknown',
        buyerPhone: buyer?.phoneE164 ?? '',
        // Paymob requires an email on the billing object; a synthesised address
        // is better than blocking a cash-first buyer who does not have one.
        buyerEmail: `orders+${o.orderCode.toLowerCase()}@reharvest.eg`,
        state: o.state as OrderState,
        totalDue: total,
        depositDue: deposit,
        lineItems: [{ nameAr: 'شحنة', amount: total, quantity: 1 }],
      };
    },

    /**
     * Advances the order and writes the audit entry in one transaction.
     *
     * The `WHERE state = <current>` clause is the compare-and-swap: if a second
     * webhook delivery already advanced this order, this update matches zero
     * rows and the transaction is a no-op rather than a double advance.
     */
    async advance(orderCode: string, to: OrderState, audit: AdvanceAudit): Promise<void> {
      await db.transaction(async (tx) => {
        const [current] = await tx
          .select({ id: orders.id, state: orders.state, version: orders.version })
          .from(orders)
          .where(eq(orders.orderCode, orderCode))
          .limit(1);

        if (!current) throw new Error(`Cannot advance unknown order ${orderCode}`);
        if (current.state === to) return; // already there; a replay

        const moved = await tx
          .update(orders)
          .set({ state: to as never, version: sql`${orders.version} + 1` })
          .where(and(eq(orders.id, current.id), eq(orders.version, current.version)))
          .returning({ id: orders.id });

        if (moved.length === 0) return; // lost the race; the winner did the work

        await appendAudit(tx as unknown as Db, {
          // The webhook is not a person. Attribution is explicit rather than
          // borrowing whichever user happened to be nearby.
          actorId: SYSTEM_ACTOR,
          actorRoles: ['finance'],
          action: `order.${to.toLowerCase()}`,
          subjectTable: 'orders',
          // The row UUID, not the human-facing code: subject_id is a uuid column.
          subjectId: current.id,
          decision: 'allowed',
          reasonCode: audit.reasonCode,
          domainId: 'D24',
          beforeState: { state: current.state },
          afterState: { state: to, providerTransactionId: audit.providerTransactionId },
          at: audit.at,
        });
      });
    },
  };
}

/* ------------------------------------------------------------------ *
 * Payments
 * ------------------------------------------------------------------ */

export function createPaymentRepo(db: Db): PaymentRepo {
  return {
    async findByProviderTransactionId(id): Promise<StoredPayment | null> {
      const [p] = await db
        .select()
        .from(payments)
        .where(eq(payments.providerTransactionId, id))
        .limit(1);

      if (!p) return null;

      const [o] = p.orderId
        ? await db.select({ code: orders.orderCode }).from(orders).where(eq(orders.id, p.orderId)).limit(1)
        : [undefined];

      return {
        providerTransactionId: p.providerTransactionId ?? id,
        orderCode: o?.code ?? '',
        amount: egp.fromPiastres(p.amountPiastres),
        method: p.method,
        payerNameObserved: p.payerNameObserved ?? '',
        bankReference: p.bankReference ?? '',
        clearedAt: p.clearedAt?.toISOString() ?? null,
        purpose: 'deposit',
      };
    },

    async recordInbound(p: StoredPayment): Promise<void> {
      const [o] = await db
        .select({ id: orders.id, buyerId: orders.buyerId })
        .from(orders)
        .where(eq(orders.orderCode, p.orderCode))
        .limit(1);

      await db
        .insert(payments)
        .values({
          direction: 'inbound',
          orderId: o?.id,
          partyId: o?.buyerId ?? SYSTEM_PARTY,
          amountPiastres: p.amount.amount,
          method: p.method,
          /*
            CLEARED means matched by the webhook and counted toward the order.
            RECEIVED means the money is real but not yet attached to anything —
            it stays in the ops queue for a person to allocate. Both are counted
            by the coverage sum only once they carry an order_id, which RECEIVED
            does not.
          */
          state: (p.clearedAt ? 'CLEARED' : 'RECEIVED') as never,
          reconciledAt: p.clearedAt ? new Date(p.clearedAt) : null,
          providerTransactionId: p.providerTransactionId,
          bankReference: p.bankReference,
          payerNameObserved: p.payerNameObserved,
          clearedAt: p.clearedAt ? new Date(p.clearedAt) : null,
          preparedBy: SYSTEM_ACTOR,
          idempotencyKey: `inbound:${p.providerTransactionId}`,
        })
        // A retried webhook must not create a second payment row.
        /*
          Upsert on the provider's transaction id, which is the natural key for
          "this specific movement of money at Paymob".

          DO NOTHING was wrong here. When a webhook is repairing an order that
          was left stuck — payment recorded, order never advanced — the row
          already exists, and DO NOTHING made the repair fail on the unique
          index instead of completing. Recording the same provider transaction
          twice must converge on one row that reflects the latest known state,
          not error and not duplicate.
        */
        .onConflictDoUpdate({
          target: payments.providerTransactionId,
          set: {
            orderId: sql`excluded.order_id`,
            partyId: sql`excluded.party_id`,
            state: sql`excluded.state`,
            clearedAt: sql`excluded.cleared_at`,
            reconciledAt: sql`excluded.reconciled_at`,
            bankReference: sql`excluded.bank_reference`,
            payerNameObserved: sql`excluded.payer_name_observed`,
          },
        });
    },

    /**
     * Money arrived that we cannot attribute. This is the case that must never
     * be a silent drop: the funds are real and sitting in the merchant account,
     * so they get a row, a reason, and a note for whoever reconciles.
     */
    async markUnmatched(id: string, reasonCode: string, note: string, amount: Money): Promise<void> {
      await db.transaction(async (tx) => {
        const inserted = await tx
          .insert(payments)
          .values({
            direction: 'inbound',
            partyId: SYSTEM_PARTY,
            // The real amount, not a placeholder. This money exists in the
            // merchant account; only its allocation is unknown. The UNMATCHED
            // state is what keeps it out of any order's paid balance.
            amountPiastres: amount.amount,
            method: 'unknown',
            state: 'UNMATCHED' as never,
            providerTransactionId: id,
            preparedBy: SYSTEM_ACTOR,
            idempotencyKey: `unmatched:${id}`,
          })
          .onConflictDoNothing({ target: payments.idempotencyKey })
          .returning({ id: payments.id });

        // Already recorded by an earlier delivery of the same webhook.
        if (inserted.length === 0) return;

        await appendAudit(tx as unknown as Db, {
          actorId: SYSTEM_ACTOR,
          actorRoles: ['finance'],
          action: 'payment.unmatched',
          subjectTable: 'payments',
          subjectId: inserted[0].id,
          decision: 'blocked',
          reasonCode,
          domainId: 'D22',
          afterState: { providerTransactionId: id, note, amountPiastres: amount.amount.toString() },
          at: new Date().toISOString(),
        });
      });
    },
  };
}

/**
 * The platform's own party and actor rows, seeded by migration. Unattributable
 * money has to belong to somebody in the ledger, and it belongs to us until
 * finance says otherwise.
 */
const SYSTEM_PARTY = '33333333-3333-4333-8333-333333333333';
const SYSTEM_ACTOR = '00000000-0000-4000-8000-000000000000';

export { DEPOSIT_BPS };

/**
 * Runs the deposit-settlement unit inside one Postgres transaction.
 *
 * The service takes this as its `transact` port. Everything the callback does —
 * writing the payment, advancing the order, appending the audit entry — commits
 * together or not at all. That is what makes a failed advance leave no payment
 * row behind, which in turn is what lets Paymob's retry repair the operation
 * instead of being dismissed as a duplicate.
 */
export function createWebhookTransactor(db: Db) {
  return async <T>(
    fn: (repos: { orders: OrderRepo; payments: PaymentRepo }) => Promise<T>,
  ): Promise<T> => {
    return db.transaction(async (tx) => {
      const scoped = tx as unknown as Db;
      return fn({
        orders: createPaymentOrderRepo(scoped),
        payments: createPaymentRepo(scoped),
      });
    });
  };
}
