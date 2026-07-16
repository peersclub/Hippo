-- B2B plans: what a partner (exchange) subscribes to. End-users inherit
-- their partner's plan. mau_quota backs the gateway's MAU billable-unit
-- counters (telemetry.ts); entitlements is a pass-through feature-flag blob.
CREATE TABLE IF NOT EXISTS plans (
  plan_id            text PRIMARY KEY,
  name               text NOT NULL,
  tier               text NOT NULL,
  mau_quota          integer,
  price_monthly_usd  numeric,
  entitlements       jsonb NOT NULL DEFAULT '{}',
  created_at         bigint NOT NULL
);

ALTER TABLE partners
  ADD CONSTRAINT partners_plan_fk
  FOREIGN KEY (plan_id) REFERENCES plans(plan_id);
