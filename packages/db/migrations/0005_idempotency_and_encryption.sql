-- 0005_idempotency_and_encryption.sql
--
-- Closes two items that were flagged as known-incomplete in the runbook.
--
-- 1. IDEMPOTENCY KEYS IN THE DATABASE
--
-- The store was in-memory, which is correct for exactly one server. Behind a
-- load balancer, two instances do not see each other's replays: a retried
-- payment lands on instance B, which has never seen the key, and processes it
-- a second time. That is a duplicate payout, and it is the kind of bug that
-- only shows up under the traffic where it hurts most.
--
-- The response body is stored so a replay returns the original answer rather
-- than re-executing. The unique constraint on the key is what actually makes
-- this safe under concurrency: two simultaneous requests with the same key
-- race to INSERT, one wins, the other reads the winner's row.

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key             text PRIMARY KEY,
  request_path    text NOT NULL,
  request_hash    text NOT NULL,
  response_status integer NOT NULL,
  response_body   jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idempotency_keys_expiry_idx ON idempotency_keys (expires_at);

COMMENT ON COLUMN idempotency_keys.request_hash IS
  'Hash of the request body. A replay of the same key with a DIFFERENT body is '
  'a client bug or an attack, not a retry, and must be refused rather than '
  'silently returning the first response.';

-- 2. ENCRYPTION AT REST FOR BANK DETAILS
--
-- account_number_enc held plaintext with an "enc:" prefix, which is worse than
-- either honest option because it looks encrypted. Real values are now AES-GCM
-- with the key held outside the database, so a database dump alone does not
-- yield bank account numbers.
--
-- The tail stays in the clear deliberately: finance needs to read "••••7890"
-- back to a supplier on the phone to confirm an account, and decrypting the
-- whole number for that is a worse trade.

ALTER TABLE beneficiaries
  ADD COLUMN IF NOT EXISTS account_number_iv text,
  ADD COLUMN IF NOT EXISTS encryption_key_id text;

-- Both parts or neither. A ciphertext with no IV is unrecoverable, and
-- discovering that during a payment run is not the moment to find out.
ALTER TABLE beneficiaries
  ADD CONSTRAINT beneficiaries_encryption_complete CHECK (
    (account_number_iv IS NULL AND encryption_key_id IS NULL)
    OR (account_number_iv IS NOT NULL AND encryption_key_id IS NOT NULL)
  );

COMMENT ON COLUMN beneficiaries.encryption_key_id IS
  'Which key encrypted this row. Present so keys can be rotated without a '
  'flag day: new rows use the new key, old rows stay readable under the old one.';
