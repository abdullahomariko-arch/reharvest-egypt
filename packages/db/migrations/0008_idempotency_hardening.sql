-- 0008_idempotency_hardening.sql
--
-- Rebuilds the idempotency table around defects reproduced through the HTTP
-- routes, not through unit tests.
--
-- DEFECT: the key was global.
--   Two different users sending the same Idempotency-Key got the same response.
--   Reproduced: user B posted an order with user A's key and received A's order
--   back, including A's order code. A key chosen by one client must never
--   address another client's result, so the stored key is now scoped to the
--   authenticated actor, the HTTP method and the route.
--
-- DEFECT: the request body was never hashed.
--   The middleware called get(key) and put(key, response) with no body, so a
--   replay with a different amount silently returned the first response. Body
--   hashing was implemented but never wired to the routes.
--
-- DEFECT: the key was recorded only after the work finished.
--   Two concurrent requests could both start executing. Reservation now happens
--   BEFORE the operation runs, so the second request finds an IN_PROGRESS row.
--
-- DEFECT: an expired row blocked reuse.
--   The primary key persisted after expiry, so ON CONFLICT DO NOTHING silently
--   dropped the new response. Expiry is now handled by the reservation upsert.

DROP TABLE IF EXISTS idempotency_keys;

CREATE TABLE idempotency_keys (
  -- Scoped: actor + method + path + client key. Not the client key alone.
  scoped_key      text PRIMARY KEY,
  actor_id        uuid NOT NULL,
  method          text NOT NULL,
  request_path    text NOT NULL,
  client_key      text NOT NULL,
  request_hash    text NOT NULL,
  state           text NOT NULL CHECK (state IN ('IN_PROGRESS', 'COMPLETED')),
  response_status integer,
  response_body   jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  expires_at      timestamptz NOT NULL,

  -- A completed row must carry the response it is meant to replay. Without this
  -- a crash between reservation and completion could leave a row that replays
  -- an empty success.
  CONSTRAINT idempotency_completed_has_response CHECK (
    state <> 'COMPLETED' OR response_status IS NOT NULL
  )
);

CREATE INDEX idempotency_keys_expiry_idx ON idempotency_keys (expires_at);

COMMENT ON COLUMN idempotency_keys.scoped_key IS
  'sha256 of actor_id, method, path and the client-supplied key. Scoping is '
  'what stops one client addressing another client''s stored response.';

COMMENT ON COLUMN idempotency_keys.state IS
  'IN_PROGRESS is written before the operation runs, so a concurrent duplicate '
  'is detected rather than executing alongside it. COMPLETED carries the '
  'response to replay.';
