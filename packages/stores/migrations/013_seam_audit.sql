-- Durable seam audit trail — the production home for the compliance record
-- the seam previously kept only as a bounded in-memory tail (lost on every
-- pod restart). One row per prepare/confirm/cancel/delivery, each carrying
-- the idempotency key minted at record time (BE doc §7). Writes are
-- fire-and-forget from the trade path; reads serve GET /internal/audit.
CREATE TABLE IF NOT EXISTS seam_audit (
  id              bigserial PRIMARY KEY,
  ts              bigint NOT NULL,
  kind            text   NOT NULL,  -- 'prepare' | 'confirm' | 'cancel' | 'event_delivered' | 'event_delivery_failed'
  ticket_id       text   NOT NULL,
  idempotency_key text   NOT NULL,
  detail          text
);

-- Read paths: the audit endpoint pages newest-first; per-ticket lookups
-- reconstruct a single order's lifecycle.
CREATE INDEX IF NOT EXISTS seam_audit_ts_idx ON seam_audit (ts DESC);
CREATE INDEX IF NOT EXISTS seam_audit_ticket_idx ON seam_audit (ticket_id);
