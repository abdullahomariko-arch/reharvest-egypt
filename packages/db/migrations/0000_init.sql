CREATE TYPE "public"."hold_kind" AS ENUM('FOOD_SAFETY_CRITICAL', 'QUALITY', 'OWNERSHIP', 'COMPLIANCE', 'RECONCILIATION');--> statement-breakpoint
CREATE TYPE "public"."lot_state" AS ENUM('DECLARED', 'SOURCE_VERIFIED', 'INSPECTION_PENDING', 'AVAILABLE', 'PARTIALLY_RESERVED', 'FULLY_RESERVED', 'HELD', 'QUARANTINED', 'RELEASED_TO_ORDER', 'CONSUMED', 'DISPOSED', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."order_state" AS ENUM('INTEREST', 'QUOTED', 'CONDITIONAL', 'DEPOSIT_PENDING', 'DEPOSIT_CLEARED', 'CONFIRMED', 'ALLOCATED', 'IN_FULFILMENT', 'DELIVERED_PENDING_ACCEPTANCE', 'ACCEPTED', 'PARTIALLY_ACCEPTED', 'SETTLED', 'CANCELLED', 'DISPUTED');--> statement-breakpoint
CREATE TYPE "public"."party_state" AS ENUM('DRAFT', 'IDENTITY_SUBMITTED', 'UNDER_REVIEW', 'ACTIVE', 'RESTRICTED', 'FROZEN', 'OFFBOARDED');--> statement-breakpoint
CREATE TYPE "public"."payment_state" AS ENUM('DRAFT', 'AWAITING_BENEFICIARY_COOLDOWN', 'PENDING_APPROVAL', 'APPROVED', 'SUBMITTED_TO_PSP', 'CLEARED', 'FAILED', 'REVERSED');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"seq" bigint PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" uuid,
	"actor_roles" jsonb NOT NULL,
	"action" text NOT NULL,
	"subject_table" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"domain_id" text,
	"decision" text NOT NULL,
	"reason_code" text NOT NULL,
	"rule_version" text,
	"before_state" jsonb,
	"after_state" jsonb,
	"evidence_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"exception_id" uuid,
	"prev_hash" text NOT NULL,
	"hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "beneficiaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"party_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"account_number_enc" text NOT NULL,
	"account_tail" text NOT NULL,
	"bank_code" text,
	"holder_name" text NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone,
	"verified_out_of_band_at" timestamp with time zone,
	"verified_by" uuid
);
--> statement-breakpoint
CREATE TABLE "control_exceptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"domain_id" text NOT NULL,
	"scope_table" text NOT NULL,
	"scope_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"requested_by" uuid NOT NULL,
	"approved_by" uuid NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lot_id" uuid NOT NULL,
	"kind" "hold_kind" NOT NULL,
	"reason" text NOT NULL,
	"placed_by" uuid NOT NULL,
	"placed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_by" uuid,
	"released_at" timestamp with time zone,
	"release_basis" text,
	"evidence_ids" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lot_genealogy" (
	"child_lot_id" uuid NOT NULL,
	"parent_lot_id" uuid NOT NULL,
	"relation" text NOT NULL,
	"grams" bigint NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recorded_by" uuid NOT NULL,
	CONSTRAINT "lot_genealogy_child_lot_id_parent_lot_id_pk" PRIMARY KEY("child_lot_id","parent_lot_id")
);
--> statement-breakpoint
CREATE TABLE "lots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lot_code" text NOT NULL,
	"supplier_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"crop" text NOT NULL,
	"harvest_date" timestamp with time zone NOT NULL,
	"state" "lot_state" DEFAULT 'DECLARED' NOT NULL,
	"accepted_grams" bigint DEFAULT 0 NOT NULL,
	"reserved_grams" bigint DEFAULT 0 NOT NULL,
	"held_grams" bigint DEFAULT 0 NOT NULL,
	"rejected_grams" bigint DEFAULT 0 NOT NULL,
	"disposed_grams" bigint DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lots_lot_code_unique" UNIQUE("lot_code")
);
--> statement-breakpoint
CREATE TABLE "offline_actions" (
	"client_action_id" text PRIMARY KEY NOT NULL,
	"device_id" text NOT NULL,
	"actor_id" uuid NOT NULL,
	"action" text NOT NULL,
	"payload" jsonb NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"synced_at" timestamp with time zone,
	"conflict_reason" text,
	"resolved_by" uuid,
	"applied" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_term_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"specification_id" uuid NOT NULL,
	"quantity_grams" bigint NOT NULL,
	"price_per_kg_piastres" bigint NOT NULL,
	"valid_until" timestamp with time zone NOT NULL,
	"buyer_acknowledged_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_code" text NOT NULL,
	"buyer_id" uuid NOT NULL,
	"state" "order_state" DEFAULT 'INTEREST' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_order_code_unique" UNIQUE("order_code")
);
--> statement-breakpoint
CREATE TABLE "parties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"legal_name_ar" text NOT NULL,
	"trading_name" text,
	"phone_e164" text NOT NULL,
	"tax_registration_number" text,
	"commercial_registry_number" text,
	"state" "party_state" DEFAULT 'DRAFT' NOT NULL,
	"identity_verified_at" timestamp with time zone,
	"identity_verified_by" uuid,
	"representative_name" text,
	"representative_authority_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"direction" text NOT NULL,
	"order_id" uuid,
	"party_id" uuid NOT NULL,
	"beneficiary_id" uuid,
	"amount_piastres" bigint NOT NULL,
	"method" text NOT NULL,
	"state" "payment_state" DEFAULT 'DRAFT' NOT NULL,
	"provider_transaction_id" text,
	"bank_reference" text,
	"payer_name_observed" text,
	"cleared_at" timestamp with time zone,
	"reversed_at" timestamp with time zone,
	"prepared_by" uuid NOT NULL,
	"approved_by" uuid,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"lot_id" uuid NOT NULL,
	"grams" bigint NOT NULL,
	"acknowledged_by_supplier_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"released_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "weighings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lot_id" uuid NOT NULL,
	"gross_grams" bigint NOT NULL,
	"tare_grams" bigint NOT NULL,
	"net_grams" bigint NOT NULL,
	"scale_id" text NOT NULL,
	"scale_calibration_valid_until" timestamp with time zone NOT NULL,
	"packaging_spec_id" text NOT NULL,
	"packaging_spec_version" integer NOT NULL,
	"captured_by" uuid NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"photo_evidence_id" text,
	"corrects_weighing_id" uuid,
	"correction_witnessed_by" uuid,
	"idempotency_key" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "beneficiaries" ADD CONSTRAINT "beneficiaries_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holds" ADD CONSTRAINT "holds_lot_id_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."lots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lot_genealogy" ADD CONSTRAINT "lot_genealogy_child_lot_id_lots_id_fk" FOREIGN KEY ("child_lot_id") REFERENCES "public"."lots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lot_genealogy" ADD CONSTRAINT "lot_genealogy_parent_lot_id_lots_id_fk" FOREIGN KEY ("parent_lot_id") REFERENCES "public"."lots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lots" ADD CONSTRAINT "lots_supplier_id_parties_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_term_versions" ADD CONSTRAINT "order_term_versions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_buyer_id_parties_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_beneficiary_id_beneficiaries_id_fk" FOREIGN KEY ("beneficiary_id") REFERENCES "public"."beneficiaries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_lot_id_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."lots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weighings" ADD CONSTRAINT "weighings_lot_id_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."lots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_subject_idx" ON "audit_log" USING btree ("subject_table","subject_id");--> statement-breakpoint
CREATE INDEX "audit_at_idx" ON "audit_log" USING btree ("at");--> statement-breakpoint
CREATE INDEX "beneficiaries_party_idx" ON "beneficiaries" USING btree ("party_id","superseded_at");--> statement-breakpoint
CREATE INDEX "exceptions_scope_idx" ON "control_exceptions" USING btree ("scope_table","scope_id","expires_at");--> statement-breakpoint
CREATE INDEX "holds_open_idx" ON "holds" USING btree ("lot_id","released_at");--> statement-breakpoint
CREATE INDEX "lots_state_idx" ON "lots" USING btree ("state");--> statement-breakpoint
CREATE INDEX "lots_supplier_idx" ON "lots" USING btree ("supplier_id");--> statement-breakpoint
CREATE INDEX "offline_unsynced_idx" ON "offline_actions" USING btree ("synced_at");--> statement-breakpoint
CREATE UNIQUE INDEX "order_terms_version_uq" ON "order_term_versions" USING btree ("order_id","version");--> statement-breakpoint
CREATE INDEX "orders_state_idx" ON "orders" USING btree ("state");--> statement-breakpoint
CREATE INDEX "orders_buyer_idx" ON "orders" USING btree ("buyer_id");--> statement-breakpoint
CREATE INDEX "parties_phone_idx" ON "parties" USING btree ("phone_e164");--> statement-breakpoint
CREATE INDEX "parties_tax_idx" ON "parties" USING btree ("tax_registration_number");--> statement-breakpoint
CREATE INDEX "parties_cr_idx" ON "parties" USING btree ("commercial_registry_number");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_idem_uq" ON "payments" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_provider_tx_uq" ON "payments" USING btree ("provider_transaction_id");--> statement-breakpoint
CREATE INDEX "payments_state_idx" ON "payments" USING btree ("state");--> statement-breakpoint
CREATE INDEX "reservations_lot_open_idx" ON "reservations" USING btree ("lot_id","released_at");--> statement-breakpoint
CREATE UNIQUE INDEX "weighings_idem_uq" ON "weighings" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "weighings_lot_idx" ON "weighings" USING btree ("lot_id");