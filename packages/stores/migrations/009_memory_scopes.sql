-- Freeform memory "documents" per scope — the layered context a super-admin
-- edits and the gateway composes into the prompt (super-admin → host → user →
-- session, super-admin binding). These are DISTINCT from users_memory (the
-- structured persona: level/assets/threads); this is editable prose per scope.
-- Session-scope lives in a later migration (it also stores the composed
-- snapshot for the inspector).

-- Global (super-admin) — a single platform-wide document. Single row, id='global'.
CREATE TABLE IF NOT EXISTS memory_global (
  id         text NOT NULL PRIMARY KEY,  -- always 'global'
  body       text NOT NULL DEFAULT '',
  updated_at bigint NOT NULL
);

-- Host (partner) — one document per partner. Venue-wide context.
CREATE TABLE IF NOT EXISTS memory_host (
  partner_id text NOT NULL PRIMARY KEY,
  body       text NOT NULL DEFAULT '',
  updated_at bigint NOT NULL
);

-- User note — a freeform note alongside the structured persona, per (partner,user).
CREATE TABLE IF NOT EXISTS memory_user_notes (
  partner_id text NOT NULL,
  user_id    text NOT NULL,
  body       text NOT NULL DEFAULT '',
  updated_at bigint NOT NULL,
  PRIMARY KEY (partner_id, user_id)
);

CREATE INDEX IF NOT EXISTS memory_user_notes_partner_idx ON memory_user_notes (partner_id);
