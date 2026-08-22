-- Split into a second file: Postgres will not let a new enum value be used in
-- the same transaction that added it.
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS reconciled_at timestamptz,
  ADD COLUMN IF NOT EXISTS reconciled_by uuid;

-- A payment attached to an order must say when and by whom, so a manual
-- allocation always has a name against it.
ALTER TABLE payments
  ADD CONSTRAINT payments_reconciliation_complete CHECK (
    state NOT IN ('RECONCILED') OR (reconciled_at IS NOT NULL AND order_id IS NOT NULL)
  );

-- Coverage queries scan by order; this keeps that cheap as payments accumulate.
CREATE INDEX IF NOT EXISTS payments_order_reconciled_idx
  ON payments (order_id) WHERE state IN ('RECONCILED', 'CLEARED');
