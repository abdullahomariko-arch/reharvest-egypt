-- 0001_invariants.sql
--
-- Everything in this file is a rule the ORM cannot express, and every one of
-- them is a last line of defence rather than a nicety. The application checks
-- these too; the difference is that the application loses races and Postgres
-- does not.
--
-- Run after 0000_init.sql.

/* ------------------------------------------------------------------ *
 * D09 / D14 — a lot can never be over-committed.
 *
 * This single constraint is what stops a double-sell surviving a race that
 * got past the service layer and the version compare-and-swap. If both of
 * those fail, the transaction aborts here instead of promising 800kg to two
 * kitchens.
 * ------------------------------------------------------------------ */

ALTER TABLE lots
  ADD CONSTRAINT lots_atp_non_negative CHECK (
    accepted_grams - reserved_grams - held_grams - rejected_grams - disposed_grams >= 0
  );

-- Weight is never negative, in any column, ever.
ALTER TABLE lots
  ADD CONSTRAINT lots_weights_non_negative CHECK (
    accepted_grams >= 0 AND reserved_grams >= 0 AND held_grams >= 0
    AND rejected_grams >= 0 AND disposed_grams >= 0
  );

/* ------------------------------------------------------------------ *
 * D34 — a weighing must be physically possible.
 *
 * Tare below gross, net derived exactly. A row that fails this arithmetic
 * is not a rounding problem, it is the wrong crate template, and it must
 * never reach a settlement calculation.
 * ------------------------------------------------------------------ */

ALTER TABLE weighings
  ADD CONSTRAINT weighings_net_is_positive CHECK (net_grams > 0);

ALTER TABLE weighings
  ADD CONSTRAINT weighings_net_derives_from_gross CHECK (net_grams = gross_grams - tare_grams);

ALTER TABLE weighings
  ADD CONSTRAINT weighings_tare_below_gross CHECK (tare_grams < gross_grams);

-- A correction must name the weighing it corrects AND the person who witnessed
-- it. A correction with no witness is an edit.
ALTER TABLE weighings
  ADD CONSTRAINT weighings_correction_needs_witness CHECK (
    corrects_weighing_id IS NULL OR correction_witnessed_by IS NOT NULL
  );

/* ------------------------------------------------------------------ *
 * D28 — nobody approves their own payment.
 *
 * The control every auditor looks for first, and the one that is trivially
 * bypassed if it lives only in application code that somebody later
 * refactors.
 * ------------------------------------------------------------------ */

ALTER TABLE payments
  ADD CONSTRAINT payments_no_self_approval CHECK (
    approved_by IS NULL OR prepared_by IS NULL OR approved_by <> prepared_by
  );

ALTER TABLE payments
  ADD CONSTRAINT payments_amount_positive CHECK (amount_piastres > 0);

/* ------------------------------------------------------------------ *
 * D53 — the audit log is append-only.
 *
 * Revoking UPDATE and DELETE from the application role is the point. An
 * audit trail the application can rewrite is not an audit trail, and this
 * is the difference between "we log things" and evidence.
 *
 * The application connects as reharvest_app. Migrations run as the owner.
 * ------------------------------------------------------------------ */

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'reharvest_app') THEN
    CREATE ROLE reharvest_app LOGIN;
  END IF;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO reharvest_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO reharvest_app;

REVOKE UPDATE, DELETE ON audit_log FROM reharvest_app;
REVOKE UPDATE, DELETE ON weighings FROM reharvest_app;

-- Belt and braces: even the owner cannot quietly edit history through normal
-- statements. A genuine correction is a new row that references the old one.
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'Table % is append-only. Record a correction row that references the original instead.',
    TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER weighings_append_only
  BEFORE UPDATE OR DELETE ON weighings
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

/* ------------------------------------------------------------------ *
 * D28 — the beneficiary cooldown, enforced in the database.
 *
 * A payout cannot be released within 24 hours of the beneficiary's bank
 * details changing. The standard fraud is a WhatsApp message with "new
 * account details" an hour before the payment run.
 * ------------------------------------------------------------------ */

CREATE OR REPLACE FUNCTION assert_beneficiary_cooldown() RETURNS trigger AS $$
DECLARE
  changed_at timestamptz;
BEGIN
  IF NEW.state IN ('APPROVED', 'SUBMITTED_TO_PSP', 'CLEARED') THEN
    SELECT b.effective_from INTO changed_at
      FROM beneficiaries b
     WHERE b.id = NEW.beneficiary_id;

    IF changed_at IS NOT NULL AND changed_at > now() - interval '24 hours' THEN
      RAISE EXCEPTION
        'Beneficiary details changed less than 24 hours ago. Payout is blocked until the cooldown expires.'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER payments_beneficiary_cooldown
  BEFORE INSERT OR UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION assert_beneficiary_cooldown();

/* ------------------------------------------------------------------ *
 * Concurrency.
 *
 * Two agents reserving the same lot is the classic double-sell. The service
 * uses a version compare-and-swap; this index makes that read cheap under
 * the contention it is designed for.
 * ------------------------------------------------------------------ */

CREATE INDEX IF NOT EXISTS lots_version_idx ON lots (id, version);

-- Open reservations only. A partial index keeps the hot path small as
-- released reservations accumulate over a season.
CREATE INDEX IF NOT EXISTS reservations_open_idx
  ON reservations (lot_id) WHERE released_at IS NULL;
