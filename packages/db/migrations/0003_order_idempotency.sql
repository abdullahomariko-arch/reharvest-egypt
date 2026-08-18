-- 0003_order_idempotency.sql
--
-- Orders had nowhere to store the idempotency key that created them.
--
-- The repository was looking the key up against reservation and order UUIDs,
-- which never matched, so a replayed order request fell straight through to the
-- reservation logic and came back as "not enough available" — because the first
-- attempt had already taken the stock. The buyer sees a refusal for an order
-- they successfully placed.
--
-- The unique index is the real fix. Even if the application check is bypassed,
-- the database will not write the same order twice.

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS idempotency_key text;

CREATE UNIQUE INDEX IF NOT EXISTS orders_idempotency_key_uq
  ON orders (idempotency_key) WHERE idempotency_key IS NOT NULL;
