-- Admin-panel operator identity + audit trail. password_hash is scrypt
-- (salthex:keyhex) — plaintext never stored. Every mutating admin action
-- writes one admin_audit row.
CREATE TABLE IF NOT EXISTS admin_operators (
  email         text PRIMARY KEY,
  password_hash text NOT NULL,
  role          text NOT NULL DEFAULT 'operator' CHECK (role IN ('owner', 'operator')),
  created_at    bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_audit (
  id             bigserial PRIMARY KEY,
  operator_email text NOT NULL,
  action         text NOT NULL,
  target         text NOT NULL,
  detail         jsonb NOT NULL DEFAULT '{}',
  ts             bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS admin_audit_ts_idx ON admin_audit (ts DESC);
