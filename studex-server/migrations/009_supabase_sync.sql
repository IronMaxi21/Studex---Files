-- The Supabase session belonging to each linked account.
--
-- Row-level security in the Supabase project is written against auth.uid(),
-- which is only non-null when a request carries that user's own JWT. The
-- server holds the publishable anon key and nothing else, so without these
-- tokens every policy correctly refuses it. Keeping them is what lets the
-- server act as the user rather than as an anonymous caller.
--
-- Both tokens are stored sealed, never in the clear: this database sits in
-- Application Support beside the notes, and a refresh token is a long-lived
-- credential to someone's account. The sealing key is derived from
-- SESSION_SECRET, so a database lifted on its own yields nothing.
CREATE TABLE supabase_tokens (
  user_id       TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  access_token  TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  -- Epoch ms at which the access token stops being accepted.
  expires_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- What the last push established about each local row: which library_items row
-- represents it upstream, and the hash of the content last uploaded for it.
--
-- Keyed by (kind, local_id) rather than added as columns on files and folders
-- because sync is not the app's business: dropping this table loses nothing
-- but the knowledge of what has already been sent, and the next push rebuilds
-- it by re-uploading.
CREATE TABLE sync_state (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 'folder' or 'file'; the local table the id belongs to.
  scope      TEXT NOT NULL CHECK (scope IN ('folder','file')),
  local_id   TEXT NOT NULL,
  remote_id  TEXT NOT NULL,
  -- sha256 of the body last uploaded. NULL for folders, which have no body.
  content_hash TEXT,
  synced_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, scope, local_id)
);
CREATE INDEX idx_sync_state_remote ON sync_state(user_id, remote_id);

-- When a push last completed for this account, so the UI can say so and a
-- failed run can be distinguished from one that never happened.
CREATE TABLE sync_runs (
  user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  pushed      INTEGER NOT NULL DEFAULT 0,
  removed     INTEGER NOT NULL DEFAULT 0,
  error       TEXT
);
