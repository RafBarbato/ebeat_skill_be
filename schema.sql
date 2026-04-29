-- Tabelle per la persistenza dei token OAuth della skill Alexa.
-- RLS attivo senza policy: accesso solo via service_role key.

CREATE TABLE IF NOT EXISTS alexa_auth_codes (
  code        TEXT PRIMARY KEY,
  user_id     UUID NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS alexa_refresh_tokens (
  token         TEXT PRIMARY KEY,
  user_id       UUID NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS alexa_refresh_tokens_user_id_idx ON alexa_refresh_tokens(user_id);

ALTER TABLE alexa_auth_codes      ENABLE ROW LEVEL SECURITY;
ALTER TABLE alexa_refresh_tokens  ENABLE ROW LEVEL SECURITY;
