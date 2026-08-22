-- 0014_provider_calls.sql
--
-- Records what the fake disbursement provider was asked to do, so tests can
-- assert on the *provider's* view rather than on the API's own response.
--
-- This matters: an endpoint can return a tidy 200 describing what it intended
-- while having sent something else entirely. The only way to prove the amount
-- and account number came from the database and not from the request body is to
-- look at what actually reached the provider.
--
-- Test-support only. It is created by a migration rather than by a test so the
-- fake behaves identically in CI and locally, and so the columns are typed.

CREATE TABLE IF NOT EXISTS provider_calls (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL,
  amount_piastres bigint NOT NULL,
  account_number  text NOT NULL,
  holder_name     text,
  bank_code       text,
  called_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS provider_calls_key_idx ON provider_calls (idempotency_key);

-- Lets a test ask the fake provider to hang or reject for one settlement.
CREATE TABLE IF NOT EXISTS provider_behaviour (
  idempotency_key text PRIMARY KEY,
  behaviour       text NOT NULL CHECK (behaviour IN ('timeout', 'reject'))
);
