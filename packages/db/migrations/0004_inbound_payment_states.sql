-- 0004_inbound_payment_states.sql
--
-- The payment_state enum was designed around outbound payouts: draft, awaiting
-- cooldown, pending approval, approved, submitted, cleared. Inbound money has a
-- state those do not cover — it has arrived and been recorded, but has not
-- reconciled to an order yet.
--
-- Without these two values there is nowhere to put a deposit that came in short,
-- or money that arrived quoting an order code we do not recognise. The pressure
-- would be to force it to CLEARED (which would advance an order that was never
-- paid in full) or to drop it (which loses real money). Both are worse than
-- adding a state.

ALTER TYPE payment_state ADD VALUE IF NOT EXISTS 'RECEIVED';
ALTER TYPE payment_state ADD VALUE IF NOT EXISTS 'UNMATCHED';
