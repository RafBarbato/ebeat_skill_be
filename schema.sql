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

-- =====================================================================
-- Stato di riproduzione condiviso tra app beatly e skill Alexa.
-- Le colonne sono state aggiunte in più migration successive; questo file
-- è uno snapshot DDL del repo a scopo documentativo. La tabella
-- current_track è creata e gestita anche dall'app.
-- =====================================================================

-- Tabella stato traccia corrente (single row per user).
CREATE TABLE IF NOT EXISTS current_track (
  user_id                    TEXT PRIMARY KEY,
  url                        TEXT,
  url_expires_at             TIMESTAMPTZ,
  "offset"                   BIGINT,
  track_id                   BIGINT,
  track_title                TEXT,
  track_artist               TEXT,
  track_duration             BIGINT,         -- secondi (caso 5/10 clamp offset)
  youtube_id                 TEXT,
  loop_mode                  BOOLEAN NOT NULL DEFAULT FALSE,
  active_device              TEXT,           -- caso 12: alexa:<id> | app:<id> | NULL
  is_playing                 BOOLEAN NOT NULL DEFAULT FALSE, -- casi 11/12
  playback_state_changed_at  TIMESTAMPTZ,
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Coda tracce successive precaricate dall'app (caso 7).
-- L'app riempie con N=3-5 righe; la skill promuove la position=1 e cancella.
CREATE TABLE IF NOT EXISTS playback_queue (
  user_id        TEXT        NOT NULL,
  position       INTEGER     NOT NULL,
  youtube_id     TEXT,
  url            TEXT,
  url_expires_at TIMESTAMPTZ,
  track_id       BIGINT,
  track_title    TEXT,
  track_artist   TEXT,
  track_duration BIGINT,
  added_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, position)
);

CREATE INDEX IF NOT EXISTS playback_queue_user_idx ON playback_queue(user_id);

ALTER TABLE playback_queue ENABLE ROW LEVEL SECURITY;

-- Realtime: permette all'app di subscribe ai cambi (mutex device, queue).
-- ALTER PUBLICATION fallisce se la tabella è già nella publication: in
-- caso eseguire prima un check su pg_publication_tables.
ALTER PUBLICATION supabase_realtime ADD TABLE current_track;
ALTER PUBLICATION supabase_realtime ADD TABLE playback_queue;
