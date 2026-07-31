-- In-panel username + 4-digit-PIN identity (demo-grade). A trader claims a
-- username inside the Hippo panel; memory/persona/learned facts then key to
-- `id:<username_lower>` so identity travels across browsers/devices. PINs are
-- stored scrypt-hashed (salthex:keyhex — see packages/stores/src/password.ts),
-- never in plaintext. Usernames are unique per partner, case-insensitively:
-- username_lower is the key, username preserves the display casing.
CREATE TABLE IF NOT EXISTS user_identities (
  partner_id     text   NOT NULL,
  username_lower text   NOT NULL,
  username       text   NOT NULL,
  pin_hash       text   NOT NULL,
  created_at     bigint NOT NULL,
  last_seen_at   bigint NOT NULL,
  PRIMARY KEY (partner_id, username_lower)
);

-- Maps a host/cookie user (the session's sub: venue_user_id from the partner
-- JWT) to its claimed identity, so the same browser auto-restores the identity
-- at the next session start without re-entering the PIN. One link per sub;
-- signout deletes the row.
CREATE TABLE IF NOT EXISTS user_identity_links (
  partner_id     text NOT NULL,
  sub            text NOT NULL,
  username_lower text NOT NULL,
  PRIMARY KEY (partner_id, sub)
);
