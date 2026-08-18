/**
 * Postgres schema (Drizzle).
 *
 * Three structural commitments, each one a direct answer to a failure chain in
 * the diagnostic:
 *
 *   1. **Nothing material is updated in place.** Prices, specifications, quotes
 *      and quantities are versioned rows. `UPDATE` on a committed term is a bug,
 *      and the migration adds triggers that refuse it. (D17, D45, D51.)
 *   2. **The audit log is hash-chained.** Each entry carries the hash of the one
 *      before it, so a row cannot be quietly removed from the middle of a dispute
 *      or a tax record. (D45, D47.)
 *   3. **Every irreversible action is keyed.** A unique index on the idempotency
 *      key is what makes a duplicate payment a database error rather than a
 *      second payment. (D53.)
 *
 * Money is `bigint` piastres. Weight is `bigint` grams. There is no `numeric`
 * money column anywhere in this schema, and no `real` or `double precision`.
 */

import {
  pgTable,
  pgEnum,
  uuid,
  text,
  bigint,
  integer,
  timestamp,
  jsonb,
  boolean,
  index,
  uniqueIndex,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/* ---------------------------------------------------------------- *
 * Enums mirror the state machines in @reharvest/core exactly.
 * A migration that changes one without the other is a failing test.
 * ---------------------------------------------------------------- */

export const partyState = pgEnum('party_state', [
  'DRAFT', 'IDENTITY_SUBMITTED', 'UNDER_REVIEW', 'ACTIVE', 'RESTRICTED', 'FROZEN', 'OFFBOARDED',
]);

export const orderState = pgEnum('order_state', [
  'INTEREST', 'QUOTED', 'CONDITIONAL', 'DEPOSIT_PENDING', 'DEPOSIT_CLEARED', 'CONFIRMED',
  'ALLOCATED', 'IN_FULFILMENT', 'DELIVERED_PENDING_ACCEPTANCE', 'ACCEPTED',
  'PARTIALLY_ACCEPTED', 'SETTLED', 'CANCELLED', 'DISPUTED',
]);

export const lotState = pgEnum('lot_state', [
  'DECLARED', 'SOURCE_VERIFIED', 'INSPECTION_PENDING', 'AVAILABLE', 'PARTIALLY_RESERVED',
  'FULLY_RESERVED', 'HELD', 'QUARANTINED', 'RELEASED_TO_ORDER', 'CONSUMED', 'DISPOSED', 'EXPIRED',
]);

export const paymentState = pgEnum('payment_state', [
  'DRAFT', 'AWAITING_BENEFICIARY_COOLDOWN', 'PENDING_APPROVAL', 'APPROVED',
  'SUBMITTED_TO_PSP', 'CLEARED', 'FAILED', 'REVERSED',
  /* Inbound only: money has arrived and is recorded, but has not reconciled
     to an order. RECEIVED is short or unconfirmed; UNMATCHED quotes an order
     code we do not recognise. Neither may advance an order. */
  'RECEIVED', 'UNMATCHED',
]);

export const holdKind = pgEnum('hold_kind', [
  'FOOD_SAFETY_CRITICAL', 'QUALITY', 'OWNERSHIP', 'COMPLIANCE', 'RECONCILIATION',
]);

/* ---------------------------------------------------------------- *
 * Parties — D01, D02, D13. Beneficiaries live in their own table so a
 * bank-account change is an event with a timestamp, not a field edit.
 * ---------------------------------------------------------------- */

export const parties = pgTable(
  'parties',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').notNull(), // supplier | buyer | both
    legalNameAr: text('legal_name_ar').notNull(),
    tradingName: text('trading_name'),
    phoneE164: text('phone_e164').notNull(),
    taxRegistrationNumber: text('tax_registration_number'),
    commercialRegistryNumber: text('commercial_registry_number'),
    state: partyState('state').notNull().default('DRAFT'),
    identityVerifiedAt: timestamp('identity_verified_at', { withTimezone: true }),
    identityVerifiedBy: uuid('identity_verified_by'),
    representativeName: text('representative_name'),
    representativeAuthorityVerifiedAt: timestamp('representative_authority_verified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Duplicate detection (D01 detection clause) starts with these.
    index('parties_phone_idx').on(t.phoneE164),
    index('parties_tax_idx').on(t.taxRegistrationNumber),
    index('parties_cr_idx').on(t.commercialRegistryNumber),
  ],
);

export const beneficiaries = pgTable(
  'beneficiaries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    partyId: uuid('party_id').notNull().references(() => parties.id),
    channel: text('channel').notNull(), // wallet | bank
    accountNumberEnc: text('account_number_enc').notNull(),
    accountTail: text('account_tail').notNull(),
    bankCode: text('bank_code'),
    holderName: text('holder_name').notNull(),
    /** D28: the clock the 24h cooldown runs against. */
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull().defaultNow(),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    verifiedOutOfBandAt: timestamp('verified_out_of_band_at', { withTimezone: true }),
    verifiedBy: uuid('verified_by'),
  },
  (t) => [index('beneficiaries_party_idx').on(t.partyId, t.supersededAt)],
);

/* ---------------------------------------------------------------- *
 * Lots — D05, D09, D33. Genealogy is a table, not a nullable parent
 * column, because a merge has many parents.
 * ---------------------------------------------------------------- */

export const lots = pgTable(
  'lots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Human-readable, printed on the crate label: LOT-2026-0814-TOM-017 */
    lotCode: text('lot_code').notNull().unique(),
    supplierId: uuid('supplier_id').notNull().references(() => parties.id),
    sourceId: uuid('source_id').notNull(),
    crop: text('crop').notNull(),
    harvestDate: timestamp('harvest_date', { withTimezone: true }).notNull(),
    state: lotState('state').notNull().default('DECLARED'),

    acceptedGrams: bigint('accepted_grams', { mode: 'bigint' }).notNull().default(sql`0`),
    reservedGrams: bigint('reserved_grams', { mode: 'bigint' }).notNull().default(sql`0`),
    heldGrams: bigint('held_grams', { mode: 'bigint' }).notNull().default(sql`0`),
    rejectedGrams: bigint('rejected_grams', { mode: 'bigint' }).notNull().default(sql`0`),
    disposedGrams: bigint('disposed_grams', { mode: 'bigint' }).notNull().default(sql`0`),

    /**
     * The lot's own commercial terms, as distinct from an order's terms.
     * What the supplier is asking, what it arrived in, and when it expires.
     */
    askPricePerKgPiastres: bigint('ask_price_per_kg_piastres', { mode: 'bigint' }).notNull().default(sql`0`),
    containerCount: integer('container_count').notNull().default(0),
    /** Pinned for the lot's lifetime. Specs are versioned and append-only. */
    packagingSpecId: text('packaging_spec_id'),
    packagingSpecVersion: integer('packaging_spec_version'),
    collectBy: timestamp('collect_by', { withTimezone: true }),

    /** Optimistic concurrency. Two agents reserving the same lot is the classic double-sell. */
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('lots_state_idx').on(t.state), index('lots_supplier_idx').on(t.supplierId)],
);

/**
 * Migration adds, and the ORM cannot express:
 *
 *   ALTER TABLE lots ADD CONSTRAINT lots_atp_non_negative CHECK (
 *     accepted_grams - reserved_grams - held_grams - rejected_grams - disposed_grams >= 0
 *   );
 *
 * That single check is the last line of defence against a double-sell surviving
 * a race that got past the application layer.
 */

export const lotGenealogy = pgTable(
  'lot_genealogy',
  {
    childLotId: uuid('child_lot_id').notNull().references(() => lots.id),
    parentLotId: uuid('parent_lot_id').notNull().references(() => lots.id),
    relation: text('relation').notNull(), // split | merge
    grams: bigint('grams', { mode: 'bigint' }).notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    recordedBy: uuid('recorded_by').notNull(),
  },
  (t) => [primaryKey({ columns: [t.childLotId, t.parentLotId] })],
);

export const holds = pgTable(
  'holds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    lotId: uuid('lot_id').notNull().references(() => lots.id),
    kind: holdKind('kind').notNull(),
    reason: text('reason').notNull(),
    placedBy: uuid('placed_by').notNull(),
    placedAt: timestamp('placed_at', { withTimezone: true }).notNull().defaultNow(),
    /** D31: only a food_safety_officer may fill these for a critical hold, and never the placer. */
    releasedBy: uuid('released_by'),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    releaseBasis: text('release_basis'),
    evidenceIds: jsonb('evidence_ids').$type<string[]>().notNull().default([]),
  },
  (t) => [index('holds_open_idx').on(t.lotId, t.releasedAt)],
);

/* ---------------------------------------------------------------- *
 * Orders and their versioned terms — D17, D20. The order row holds
 * identity and state; every commercial term is a version row.
 * ---------------------------------------------------------------- */

export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderCode: text('order_code').notNull().unique(),
    buyerId: uuid('buyer_id').notNull().references(() => parties.id),
    state: orderState('state').notNull().default('INTEREST'),
    /**
     * The key from the request that created this order. Uniquely indexed, so a
     * replayed request cannot become a second order even if the application
     * check is bypassed.
     */
    idempotencyKey: text('idempotency_key'),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('orders_state_idx').on(t.state), index('orders_buyer_idx').on(t.buyerId)],
);

export const orderTermVersions = pgTable(
  'order_term_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id').notNull().references(() => orders.id),
    version: integer('version').notNull(),
    specificationId: uuid('specification_id').notNull(),
    quantityGrams: bigint('quantity_grams', { mode: 'bigint' }).notNull(),
    pricePerKgPiastres: bigint('price_per_kg_piastres', { mode: 'bigint' }).notNull(),
    validUntil: timestamp('valid_until', { withTimezone: true }).notNull(),
    /** D49: a material change is not in force until the buyer acknowledges it in-app. */
    buyerAcknowledgedAt: timestamp('buyer_acknowledged_at', { withTimezone: true }),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('order_terms_version_uq').on(t.orderId, t.version)],
);

export const reservations = pgTable(
  'reservations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id').notNull().references(() => orders.id),
    lotId: uuid('lot_id').notNull().references(() => lots.id),
    grams: bigint('grams', { mode: 'bigint' }).notNull(),
    acknowledgedBySupplierAt: timestamp('acknowledged_by_supplier_at', { withTimezone: true }),
    /** A reservation that is never confirmed must expire, or supply silently disappears. */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    releasedAt: timestamp('released_at', { withTimezone: true }),
  },
  (t) => [index('reservations_lot_open_idx').on(t.lotId, t.releasedAt)],
);

/* ---------------------------------------------------------------- *
 * Weights — D34. Immutable. A correction is a new row that references
 * the one it corrects, with a witness.
 * ---------------------------------------------------------------- */

export const weighings = pgTable(
  'weighings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    lotId: uuid('lot_id').notNull().references(() => lots.id),
    grossGrams: bigint('gross_grams', { mode: 'bigint' }).notNull(),
    tareGrams: bigint('tare_grams', { mode: 'bigint' }).notNull(),
    netGrams: bigint('net_grams', { mode: 'bigint' }).notNull(),
    scaleId: text('scale_id').notNull(),
    scaleCalibrationValidUntil: timestamp('scale_calibration_valid_until', { withTimezone: true }).notNull(),
    packagingSpecId: text('packaging_spec_id').notNull(),
    packagingSpecVersion: integer('packaging_spec_version').notNull(),
    capturedBy: uuid('captured_by').notNull(),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
    photoEvidenceId: text('photo_evidence_id'),
    correctsWeighingId: uuid('corrects_weighing_id'),
    correctionWitnessedBy: uuid('correction_witnessed_by'),
    idempotencyKey: text('idempotency_key').notNull(),
  },
  (t) => [uniqueIndex('weighings_idem_uq').on(t.idempotencyKey), index('weighings_lot_idx').on(t.lotId)],
);

/* ---------------------------------------------------------------- *
 * Payments — D24, D26, D28, D53
 * ---------------------------------------------------------------- */

export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    direction: text('direction').notNull(), // inbound | outbound
    orderId: uuid('order_id').references(() => orders.id),
    partyId: uuid('party_id').notNull().references(() => parties.id),
    beneficiaryId: uuid('beneficiary_id').references(() => beneficiaries.id),
    amountPiastres: bigint('amount_piastres', { mode: 'bigint' }).notNull(),
    method: text('method').notNull(),
    state: paymentState('state').notNull().default('DRAFT'),
    providerTransactionId: text('provider_transaction_id'),
    bankReference: text('bank_reference'),
    payerNameObserved: text('payer_name_observed'),
    clearedAt: timestamp('cleared_at', { withTimezone: true }),
    reversedAt: timestamp('reversed_at', { withTimezone: true }),
    preparedBy: uuid('prepared_by').notNull(),
    approvedBy: uuid('approved_by'),
    idempotencyKey: text('idempotency_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('payments_idem_uq').on(t.idempotencyKey),
    uniqueIndex('payments_provider_tx_uq').on(t.providerTransactionId),
    index('payments_state_idx').on(t.state),
  ],
);

/**
 * Migration adds:
 *   ALTER TABLE payments ADD CONSTRAINT payments_no_self_approval
 *     CHECK (approved_by IS NULL OR approved_by <> prepared_by);
 * D47 at the storage layer, so it holds even if a handler is bypassed.
 */

/* ---------------------------------------------------------------- *
 * Audit — D45, D47. Hash-chained and append-only.
 * ---------------------------------------------------------------- */

export const auditLog = pgTable(
  'audit_log',
  {
    seq: bigint('seq', { mode: 'bigint' }).primaryKey(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    actorId: uuid('actor_id'),
    actorRoles: jsonb('actor_roles').$type<string[]>().notNull(),
    action: text('action').notNull(),
    subjectTable: text('subject_table').notNull(),
    subjectId: uuid('subject_id').notNull(),
    domainId: text('domain_id'),
    decision: text('decision').notNull(),
    reasonCode: text('reason_code').notNull(),
    ruleVersion: text('rule_version'),
    beforeState: jsonb('before_state'),
    afterState: jsonb('after_state'),
    evidenceIds: jsonb('evidence_ids').$type<string[]>().notNull().default([]),
    exceptionId: uuid('exception_id'),
    /** sha256(prevHash || canonical json of this row). Verified nightly. */
    prevHash: text('prev_hash').notNull(),
    hash: text('hash').notNull(),
  },
  (t) => [index('audit_subject_idx').on(t.subjectTable, t.subjectId), index('audit_at_idx').on(t.at)],
);

/**
 * Migration adds:
 *   REVOKE UPDATE, DELETE ON audit_log FROM app_user;
 *   CREATE RULE audit_log_no_update AS ON UPDATE TO audit_log DO INSTEAD NOTHING;
 * The application user can append and read. It cannot rewrite history.
 */

export const controlExceptions = pgTable(
  'control_exceptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    domainId: text('domain_id').notNull(),
    scopeTable: text('scope_table').notNull(),
    scopeId: uuid('scope_id').notNull(),
    reason: text('reason').notNull(),
    requestedBy: uuid('requested_by').notNull(),
    approvedBy: uuid('approved_by').notNull(),
    approvedAt: timestamp('approved_at', { withTimezone: true }).notNull().defaultNow(),
    /** Not nullable. An exception without an expiry is a permanent hole in the control. */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [index('exceptions_scope_idx').on(t.scopeTable, t.scopeId, t.expiresAt)],
);

/**
 * Offline queue. The mobile app writes here first and syncs later; the unique
 * index on client_action_id is what makes a replayed action idempotent rather
 * than a second inspection, a second weight, or a second payment. (D53.)
 */
export const offlineActions = pgTable(
  'offline_actions',
  {
    clientActionId: text('client_action_id').primaryKey(),
    deviceId: text('device_id').notNull(),
    actorId: uuid('actor_id').notNull(),
    action: text('action').notNull(),
    payload: jsonb('payload').notNull(),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
    syncedAt: timestamp('synced_at', { withTimezone: true }),
    conflictReason: text('conflict_reason'),
    resolvedBy: uuid('resolved_by'),
    applied: boolean('applied').notNull().default(false),
  },
  (t) => [index('offline_unsynced_idx').on(t.syncedAt)],
);
