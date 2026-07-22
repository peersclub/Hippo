-- Per-session composed-memory snapshot: the EXACT layered block that was sent
-- to the model for a session, so the admin inspector and the in-session card
-- show real history, not a re-derivation. Also carries the session's own
-- freeform note (edited on the live session). Ephemeral by nature but kept
-- durable for the inspector; partner/user columns let the panel filter.
CREATE TABLE IF NOT EXISTS memory_session (
  session_id text NOT NULL PRIMARY KEY,
  partner_id text NOT NULL DEFAULT '',
  user_id    text NOT NULL DEFAULT '',
  note       text NOT NULL DEFAULT '',
  composed   text NOT NULL DEFAULT '',
  updated_at bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS memory_session_partner_idx ON memory_session (partner_id);
