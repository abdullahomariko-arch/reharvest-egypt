-- 0010_staff_sessions.sql
--
-- Server-side sessions for the ops console.
--
-- Stored rather than stateless because a stateless token cannot be logged out.
-- When a finance user leaves, or a laptop is lost, revocation has to take effect
-- immediately — not whenever the token happens to expire.

CREATE TABLE IF NOT EXISTS staff_sessions (
  id            text PRIMARY KEY,
  user_id       uuid NOT NULL,
  display_name  text NOT NULL,
  party_id      uuid NOT NULL,
  roles         jsonb NOT NULL,
  -- Per-session, so a token lifted from one session is useless in another.
  csrf_token    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz
);

-- Session lookup happens on every console request, including the idle check.
CREATE INDEX IF NOT EXISTS staff_sessions_live_idx
  ON staff_sessions (expires_at) WHERE revoked_at IS NULL;

COMMENT ON COLUMN staff_sessions.last_seen_at IS
  'Sliding idle window. Someone working through a payment run must not be '
  'logged out mid-approval, but an abandoned session on a shared office machine '
  'must not stay live all day.';
