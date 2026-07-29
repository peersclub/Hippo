-- Durable host-venue book of record — the production home for the state the
-- demo venue previously kept only in memory (open positions, resting orders,
-- wallets, pending handoffs, the admin drawer config and the order-id
-- counter — all wiped on every container restart). One JSONB row per venue
-- instance; the venue writes a debounced snapshot after every mutation and
-- restores the row at boot, so a restart no longer erases the trader's book.
CREATE TABLE IF NOT EXISTS host_venue_state (
  venue_id   text   PRIMARY KEY,
  state      jsonb  NOT NULL,
  updated_at bigint NOT NULL
);
