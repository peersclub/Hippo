-- Partner-staff logins for the partner portal (services/portal). Created by
-- operator invite (password_hash NULL + invite_token_hash set); claimed via
-- the portal, which sets the password and burns the token. The plaintext
-- invite token is never stored — only its sha256.
CREATE TABLE IF NOT EXISTS partner_admins (
  email              TEXT PRIMARY KEY,
  partner_id         TEXT NOT NULL REFERENCES partners(partner_id) ON DELETE CASCADE,
  password_hash      TEXT,
  role               TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'viewer')),
  invite_token_hash  TEXT UNIQUE,
  invite_expires_at  BIGINT,
  created_at         BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS partner_admins_partner_idx ON partner_admins (partner_id);

-- The portal's own-activity audit view filters on detail->>'partnerId'.
CREATE INDEX IF NOT EXISTS admin_audit_partner_idx ON admin_audit ((detail->>'partnerId'));
