-- Reporting indexes for the usage tables (no schema changes).
--
-- mau_events is PK'd (partner_id, user_key, month) with a per-partner month
-- index (006), but a cross-partner month rollup ("MAU this month, every
-- partner") has no leading-column match and scans. Index the month alone.
CREATE INDEX IF NOT EXISTS mau_events_month_idx ON mau_events (month);

-- users is indexed (partner_id, last_seen DESC) (003); the admin panel's
-- cross-partner "recently seen" listing orders by last_seen alone, which that
-- composite index cannot serve without a full scan.
CREATE INDEX IF NOT EXISTS users_last_seen_idx ON users (last_seen DESC);
