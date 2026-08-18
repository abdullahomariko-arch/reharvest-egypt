-- 0002_lot_terms.sql
--
-- A lot's own commercial terms had nowhere to live.
--
-- `order_term_versions` holds the terms of an *order* — what a specific buyer
-- agreed. But a lot has terms before any order exists: what the supplier is
-- asking, how many crates it came in, and the date after which it is worthless.
-- Reading those back off the order table meant a freshly listed lot reported a
-- price of zero, which is exactly what happened the first time the API ran
-- against a real database.
--
-- These are lot facts, so they live on the lot.

ALTER TABLE lots
  ADD COLUMN IF NOT EXISTS ask_price_per_kg_piastres bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS container_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS packaging_spec_id text,
  ADD COLUMN IF NOT EXISTS packaging_spec_version integer,
  ADD COLUMN IF NOT EXISTS collect_by timestamptz;

-- Backfill before the constraint goes on. Rows that predate this migration have
-- no ask price, and the constraint below would reject them — which it should,
-- because a lot on the market with no price is not sellable. Existing rows are
-- parked back in DECLARED so a human sets a real price rather than inheriting a
-- silent zero.
UPDATE lots
   SET state = 'DECLARED'
 WHERE ask_price_per_kg_piastres = 0
   AND state NOT IN ('DECLARED', 'DISPOSED', 'EXPIRED', 'CONSUMED');

-- A listed lot must carry a real price. The default of 0 exists only so the
-- column can be added to existing rows; new rows are held to the real rule.
ALTER TABLE lots
  ADD CONSTRAINT lots_ask_price_positive_when_listed CHECK (
    state = 'DECLARED' OR ask_price_per_kg_piastres > 0
  );

-- The packaging spec a lot was accepted under is pinned for its lifetime.
-- Specs are versioned and append-only: a lot accepted under plastic_standard v2
-- must keep settling against v2 forever, even after v3 changes the tare. Losing
-- this is a silent repricing of everything already in the yard.
ALTER TABLE lots
  ADD CONSTRAINT lots_spec_is_complete CHECK (
    (packaging_spec_id IS NULL) = (packaging_spec_version IS NULL)
  );

CREATE INDEX IF NOT EXISTS lots_collect_by_idx ON lots (collect_by)
  WHERE state IN ('AVAILABLE', 'PARTIALLY_RESERVED');
