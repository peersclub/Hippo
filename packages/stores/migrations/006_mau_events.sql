-- Durable per-partner MAU: one row per distinct (partner, user, month).
-- The gateway's in-process Telemetry set stays the fast enforcement path;
-- this table makes it restart-proof (hydrated at boot) and gives the admin
-- panel counts that survive gateway restarts/downtime.
CREATE TABLE IF NOT EXISTS mau_events (
  partner_id text NOT NULL,
  user_key   text NOT NULL,
  month      text NOT NULL, -- "YYYY-MM"
  PRIMARY KEY (partner_id, user_key, month)
);

CREATE INDEX IF NOT EXISTS mau_events_partner_month_idx ON mau_events (partner_id, month);
