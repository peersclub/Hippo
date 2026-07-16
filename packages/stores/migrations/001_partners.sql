-- Partner registry — replaces the gateway's hardcoded PARTNERS array
-- (services/gateway/src/plugins/auth.ts anticipated exactly this table).
CREATE TABLE IF NOT EXISTS partners (
  partner_id        text PRIMARY KEY,
  partner_key       text NOT NULL UNIQUE,
  jwt_secret        text NOT NULL,
  venue_name        text NOT NULL,
  locales           jsonb NOT NULL DEFAULT '[]',
  suggested_queries jsonb NOT NULL DEFAULT '[]',
  plan_id           text,
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at        bigint NOT NULL
);
