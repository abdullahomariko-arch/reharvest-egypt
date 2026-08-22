-- 0012_payout_lifecycle.sql
--
-- Approval and submission are different events and now have different columns.
--
-- Previously "approved" was the last thing recorded, so a payout that had been
-- sent to the provider looked identical to one merely agreed. A timeout then
-- looked identical to "never sent", and the natural response — retry — pays the
-- supplier twice.

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS submitted_at timestamptz;

-- A submitted payout must have been approved first, and by someone.
ALTER TABLE payments
  ADD CONSTRAINT payments_submitted_requires_approval CHECK (
    submitted_at IS NULL OR approved_by IS NOT NULL
  );

CREATE INDEX IF NOT EXISTS payments_in_flight_idx
  ON payments (submitted_at) WHERE state = 'SUBMITTED_TO_PSP';

COMMENT ON COLUMN payments.submitted_at IS
  'When the transfer was handed to the provider. A row with this set and a '
  'non-final state is money in flight: reconcile against the provider report '
  'rather than retrying.';
