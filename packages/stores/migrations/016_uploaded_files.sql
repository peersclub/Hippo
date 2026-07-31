-- Durable upload library (migration 016). One row per accepted upload — the
-- lasting record behind the SDK's "Files" view and the terminal in-thread
-- chip. Rows are keyed by the session's EFFECTIVE user key at upload time
-- (`id:<username_lower>` when an in-panel identity is active, else the
-- host-minted sub / anonymous session id), so a trader's library travels with
-- the person exactly like memory does. File BYTES are never stored — only the
-- descriptive record plus a short analysis summary.
CREATE TABLE IF NOT EXISTS uploaded_files (
  partner_id   text   NOT NULL,
  file_id      text   NOT NULL,
  user_key     text   NOT NULL,
  name         text   NOT NULL,
  size_bytes   bigint NOT NULL,
  size_display text   NOT NULL,
  mime         text   NOT NULL,
  kind         text   NOT NULL, -- 'csv' | 'image'
  status       text   NOT NULL, -- 'analyzing' | 'analyzed' | 'failed'
  reason       text,            -- server-authored failure reason
  summary      text,            -- short plain-text excerpt of the analysis brief
  created_at   bigint NOT NULL,
  PRIMARY KEY (partner_id, file_id)
);

-- The list API reads one user's files newest-first.
CREATE INDEX IF NOT EXISTS uploaded_files_user_idx
  ON uploaded_files (partner_id, user_key, created_at DESC);
