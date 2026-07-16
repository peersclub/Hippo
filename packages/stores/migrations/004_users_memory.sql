-- The Postgres users_memory table services/memory/src/store.ts:10-13 promises:
-- persona blobs behind the same PersonaStore surface, per-partner scoped.
CREATE TABLE IF NOT EXISTS users_memory (
  partner_id text NOT NULL,
  user_id    text NOT NULL,
  persona    jsonb NOT NULL,
  updated_at bigint NOT NULL,
  PRIMARY KEY (partner_id, user_id)
);

CREATE INDEX IF NOT EXISTS users_memory_partner_idx ON users_memory (partner_id);
