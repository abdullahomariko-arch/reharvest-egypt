-- 0009_encryption_mandatory.sql
--
-- Makes encryption metadata mandatory. Run only after the backfill.
--
--   npx tsx scripts/beneficiary-keys.ts status     # what still needs backfilling
--   npx tsx scripts/beneficiary-keys.ts backfill --id <uuid> --account <number>
--   npx tsx scripts/beneficiary-keys.ts verify     # prove every row opens
--
-- The guard below aborts with a readable message rather than letting the
-- NOT NULL fail with a constraint error nobody can act on. Ordering matters:
-- if this ran before the backfill, deployment would fail at the worst moment
-- and the obvious fix — dropping the constraint — leaves plaintext rows behind
-- permanently.

DO $$
DECLARE
  unencrypted int;
BEGIN
  SELECT count(*) INTO unencrypted
    FROM beneficiaries
   WHERE account_number_iv IS NULL OR encryption_key_id IS NULL;

  IF unencrypted > 0 THEN
    RAISE EXCEPTION
      'Refusing to make encryption mandatory: % beneficiary row(s) are not encrypted yet. '
      'Run: npx tsx scripts/beneficiary-keys.ts status, backfill each row, then re-run this migration.',
      unencrypted
      USING ERRCODE = 'restrict_violation';
  END IF;
END
$$;

ALTER TABLE beneficiaries
  ALTER COLUMN account_number_iv SET NOT NULL,
  ALTER COLUMN encryption_key_id SET NOT NULL;

-- The tail is what every screen displays, so it must always be present and must
-- look like a tail. A blank tail means a screen shows nothing where an account
-- should be, and finance cannot confirm the account over the phone.
ALTER TABLE beneficiaries
  ADD CONSTRAINT beneficiaries_tail_present CHECK (char_length(account_tail) = 4);
