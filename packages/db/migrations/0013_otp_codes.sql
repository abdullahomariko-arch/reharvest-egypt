-- 0013_otp_codes.sql
--
-- One-time sign-in codes for the mobile app, replacing a hard-coded demo list
-- of phone numbers that granted a session to anyone who knew them.
--
-- Codes are stored hashed. A database dump should not be a list of live sign-in
-- codes for every supplier and buyer on the platform.

CREATE TABLE IF NOT EXISTS otp_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164  text NOT NULL,
  code_hash   text NOT NULL,
  party_id    uuid NOT NULL REFERENCES parties(id),
  attempts    integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz
);

-- Rate limiting counts recent rows per number, and verification finds the
-- newest live code for a number.
CREATE INDEX IF NOT EXISTS otp_codes_phone_idx ON otp_codes (phone_e164, created_at DESC);

COMMENT ON TABLE otp_codes IS
  'Codes are single-use and attempt-counted, so guessing is bounded by the '
  'code lifetime rather than by the attacker''s patience.';
