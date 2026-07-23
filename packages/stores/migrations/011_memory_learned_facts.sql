-- Auto-learned facts — the provenance-tracked store for facts Hippo learns on
-- its own (Track 2 of auto-learning memory). Kept DELIBERATELY SEPARATE from
-- the freeform prose bodies (memory_global / memory_host / memory_user_notes):
-- auto-learning writes here and never touches what a super-admin typed, so
-- provenance stays clean and admin prose is never clobbered.
--
-- Two scopes carry auto-learned facts: USER (partner_id + user_id) and SESSION
-- (session_id). The `source` column records provenance ('auto' vs 'admin');
-- admin-authored facts must never be overwritten by an auto observation. The
-- unique index below keys a fact by (scope + scope-keys + type + value) so
-- re-observing a fact UPSERTs its confidence/timestamp rather than duplicating.
CREATE TABLE IF NOT EXISTS memory_learned_facts (
  id          bigserial PRIMARY KEY,
  scope       text   NOT NULL,               -- 'user' | 'session'
  partner_id  text   NOT NULL DEFAULT '',    -- set for scope='user' (also kept for session filtering)
  user_id     text,                          -- set for scope='user', NULL otherwise
  session_id  text,                          -- set for scope='session', NULL otherwise
  fact_type   text   NOT NULL,
  fact_value  text   NOT NULL,
  confidence  real   NOT NULL DEFAULT 0,
  source      text   NOT NULL DEFAULT 'auto', -- 'auto' | 'admin'
  created_at  bigint NOT NULL,
  updated_at  bigint NOT NULL
);

-- Upsert key: identical (scope, scope-keys, type, value) re-observation collides
-- and updates in place. user_id/session_id are nullable, so COALESCE them to ''
-- for a stable key the ON CONFLICT target can match.
CREATE UNIQUE INDEX IF NOT EXISTS memory_learned_facts_key_idx
  ON memory_learned_facts (
    scope, partner_id, COALESCE(user_id, ''), COALESCE(session_id, ''), fact_type, fact_value
  );

-- Lookup indexes for the two read paths.
CREATE INDEX IF NOT EXISTS memory_learned_facts_user_idx
  ON memory_learned_facts (partner_id, user_id) WHERE scope = 'user';
CREATE INDEX IF NOT EXISTS memory_learned_facts_session_idx
  ON memory_learned_facts (session_id) WHERE scope = 'session';
