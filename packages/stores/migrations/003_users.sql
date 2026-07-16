-- Lazily-populated end-user registry: upserted by the gateway on
-- authenticated session create (venueUserId only — anonymous dev sessions
-- are ephemeral by design and never recorded).
CREATE TABLE IF NOT EXISTS users (
  partner_id text NOT NULL,
  user_id    text NOT NULL,
  first_seen bigint NOT NULL,
  last_seen  bigint NOT NULL,
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked')),
  PRIMARY KEY (partner_id, user_id)
);

CREATE INDEX IF NOT EXISTS users_partner_idx ON users (partner_id, last_seen DESC);
