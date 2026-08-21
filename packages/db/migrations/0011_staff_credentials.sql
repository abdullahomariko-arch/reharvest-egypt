-- 0011_staff_credentials.sql
--
-- Credentials for the ops console.
--
-- Separate from `parties` because a party is a business — a packhouse, a kitchen
-- — while a credential belongs to a person. Conflating them means a supplier
-- company having a passphrase, which is not a thing that makes sense.

CREATE TABLE IF NOT EXISTS staff_credentials (
  identifier      text PRIMARY KEY,
  user_id         uuid NOT NULL,
  display_name    text NOT NULL,
  party_id        uuid NOT NULL,
  roles           jsonb NOT NULL,
  -- scrypt$N$r$p$salt$hash. Parameters travel with the record so tuning them
  -- later does not invalidate existing credentials.
  passphrase_hash text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- Disabling rather than deleting keeps the audit trail resolvable: entries
  -- reference user_id, and a deleted row makes historical decisions anonymous.
  disabled_at     timestamptz
);

ALTER TABLE staff_credentials
  ADD CONSTRAINT staff_credentials_hash_format CHECK (passphrase_hash LIKE 'scrypt$%');
