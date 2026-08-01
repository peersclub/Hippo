-- Price alerts (migration 017). One row per alert a trader armed
-- conversationally ("alert me when BTC crosses 70k"). Rows are keyed by the
-- session's EFFECTIVE user key at creation time (`id:<username_lower>` when an
-- in-panel identity is active, else the host-minted sub / anonymous session
-- id), so alerts travel with the person exactly like memory and uploads do.
-- `condition` is the RESOLVED boundary ('above'/'below' — "crosses" is
-- resolved against the live price at creation); `delivered` tracks whether the
-- triggered frame reached a live session, so a trader who closed the tab is
-- still told on their next session start.
CREATE TABLE IF NOT EXISTS alerts (
  id           text    PRIMARY KEY,
  partner_id   text    NOT NULL,
  user_key     text    NOT NULL,
  symbol       text    NOT NULL, -- "BTC/USDT"
  condition    text    NOT NULL CHECK (condition IN ('above', 'below')),
  price        numeric NOT NULL,
  state        text    NOT NULL CHECK (state IN ('armed', 'triggered', 'cancelled')),
  created_at   bigint  NOT NULL,
  triggered_at bigint,           -- set when state flips to 'triggered'
  delivered    boolean NOT NULL DEFAULT false
);

-- The poll loop reads every armed alert each tick.
CREATE INDEX IF NOT EXISTS alerts_state_idx ON alerts (state);

-- Per-user reads: the armed cap check, conversational cancel, and the
-- session-start sweep of undelivered triggered alerts.
CREATE INDEX IF NOT EXISTS alerts_partner_user_idx ON alerts (partner_id, user_key);
