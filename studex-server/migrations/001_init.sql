-- Studex core schema.
-- Conventions:
--   * ids are opaque UUIDv4 text (unguessable, so a leaked id is not an oracle)
--   * timestamps are INTEGER epoch milliseconds (UTC)
--   * every user-owned row carries user_id and cascades on account deletion

PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id                 TEXT PRIMARY KEY,
  email              TEXT NOT NULL,
  email_normalized   TEXT NOT NULL UNIQUE,
  password_hash      TEXT NOT NULL,
  display_name       TEXT NOT NULL,
  plan               TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free','pro')),
  plan_renews_at     INTEGER,
  storage_used_bytes INTEGER NOT NULL DEFAULT 0 CHECK (storage_used_bytes >= 0),
  storage_quota_bytes INTEGER NOT NULL,
  failed_login_count INTEGER NOT NULL DEFAULT 0,
  locked_until       INTEGER,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

-- Opaque session tokens are stored only as SHA-256 hashes: a database leak
-- does not yield usable session cookies.
CREATE TABLE sessions (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash         TEXT NOT NULL UNIQUE,
  csrf_token_hash    TEXT NOT NULL,
  created_at         INTEGER NOT NULL,
  last_used_at       INTEGER NOT NULL,
  idle_expires_at    INTEGER NOT NULL,
  absolute_expires_at INTEGER NOT NULL,
  revoked_at         INTEGER,
  ip                 TEXT,
  user_agent         TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id, revoked_at);

-- Sliding-window record of authentication attempts, keyed by account and by
-- client ip, so neither a single account nor a single source can be ground on.
CREATE TABLE auth_attempts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  scope       TEXT NOT NULL CHECK (scope IN ('account','ip')),
  key         TEXT NOT NULL,
  succeeded   INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_auth_attempts_lookup ON auth_attempts(scope, key, created_at);

CREATE TABLE subjects (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  color      TEXT NOT NULL DEFAULT 'accent',
  position   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (user_id, name)
);

CREATE TABLE folders (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id  TEXT REFERENCES folders(id) ON DELETE CASCADE,
  subject_id TEXT REFERENCES subjects(id) ON DELETE SET NULL,
  name       TEXT NOT NULL,
  -- NULL means "inherit from parent"; the API resolves the effective colour.
  color      TEXT,
  pinned     INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0,1)),
  position   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_folders_user_parent ON folders(user_id, parent_id);

CREATE TABLE files (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  folder_id      TEXT REFERENCES folders(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('canvas','doc','pdf','deck')),
  title          TEXT NOT NULL,
  -- Per the design: colour is inherited from the folder unless a file overrides it.
  color_override TEXT,
  pinned         INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0,1)),
  trashed_at     INTEGER,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX idx_files_user_folder ON files(user_id, folder_id, trashed_at);
CREATE INDEX idx_files_user_updated ON files(user_id, updated_at DESC);
CREATE INDEX idx_files_user_pinned ON files(user_id, pinned);

-- Block-based editor content. Blocks are validated against a discriminated
-- union before they are stored, so this is never arbitrary caller JSON.
CREATE TABLE documents (
  file_id    TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  blocks     TEXT NOT NULL DEFAULT '[]',
  revision   INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

CREATE TABLE canvases (
  file_id     TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  objects     TEXT NOT NULL DEFAULT '[]',
  viewport    TEXT NOT NULL DEFAULT '{"x":0,"y":0,"zoom":1}',
  revision    INTEGER NOT NULL DEFAULT 1,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE pdf_files (
  file_id      TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  storage_key  TEXT NOT NULL UNIQUE,
  byte_size    INTEGER NOT NULL CHECK (byte_size > 0),
  sha256       TEXT NOT NULL,
  page_count   INTEGER,
  original_name TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE TABLE annotations (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_id      TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  page         INTEGER NOT NULL CHECK (page >= 1),
  kind         TEXT NOT NULL CHECK (kind IN ('highlight','ink','comment')),
  -- quads for highlights, a path for ink, an anchor point for comments
  geometry     TEXT NOT NULL DEFAULT '{}',
  color        TEXT,
  quoted_text  TEXT,
  note         TEXT,
  card_id      TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX idx_annotations_file ON annotations(file_id, page);
CREATE INDEX idx_annotations_user ON annotations(user_id);

CREATE TABLE decks (
  file_id      TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  description  TEXT,
  updated_at   INTEGER NOT NULL
);

-- SM-2 scheduling state lives on the card: it is strictly 1:1 and read on
-- every queue build, so a join would buy nothing.
CREATE TABLE cards (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  deck_id           TEXT NOT NULL REFERENCES decks(file_id) ON DELETE CASCADE,
  front             TEXT NOT NULL,
  back              TEXT NOT NULL,
  topic             TEXT,
  -- provenance: made from a canvas node, a doc block or a PDF highlight
  source_file_id    TEXT REFERENCES files(id) ON DELETE SET NULL,
  source_annotation_id TEXT REFERENCES annotations(id) ON DELETE SET NULL,
  state             TEXT NOT NULL DEFAULT 'new' CHECK (state IN ('new','learning','review','relearning')),
  ease_factor       REAL NOT NULL DEFAULT 2.5,
  interval_days     REAL NOT NULL DEFAULT 0,
  repetitions       INTEGER NOT NULL DEFAULT 0,
  lapses            INTEGER NOT NULL DEFAULT 0,
  due_at            INTEGER NOT NULL,
  last_reviewed_at  INTEGER,
  suspended         INTEGER NOT NULL DEFAULT 0 CHECK (suspended IN (0,1)),
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX idx_cards_queue ON cards(user_id, suspended, due_at);
CREATE INDEX idx_cards_deck ON cards(deck_id);

CREATE TABLE review_logs (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  card_id       TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  rating        INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 4),
  mode          TEXT NOT NULL CHECK (mode IN ('review','test')),
  duration_ms   INTEGER NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
  interval_before REAL NOT NULL DEFAULT 0,
  interval_after  REAL NOT NULL DEFAULT 0,
  reviewed_at   INTEGER NOT NULL
);
CREATE INDEX idx_review_logs_user_time ON review_logs(user_id, reviewed_at);
CREATE INDEX idx_review_logs_card ON review_logs(card_id, reviewed_at);

CREATE TABLE test_sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  deck_id      TEXT REFERENCES decks(file_id) ON DELETE SET NULL,
  correct      INTEGER NOT NULL DEFAULT 0 CHECK (correct >= 0),
  missed       INTEGER NOT NULL DEFAULT 0 CHECK (missed >= 0),
  avg_time_ms  INTEGER NOT NULL DEFAULT 0 CHECK (avg_time_ms >= 0),
  score_pct    REAL NOT NULL DEFAULT 0 CHECK (score_pct BETWEEN 0 AND 100),
  started_at   INTEGER NOT NULL,
  ended_at     INTEGER
);
CREATE INDEX idx_test_sessions_user ON test_sessions(user_id, started_at DESC);

CREATE TABLE events (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject_id   TEXT REFERENCES subjects(id) ON DELETE SET NULL,
  file_id      TEXT REFERENCES files(id) ON DELETE SET NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('exam','deadline','study_block','class')),
  title        TEXT NOT NULL,
  location     TEXT,
  starts_at    INTEGER NOT NULL,
  ends_at      INTEGER,
  all_day      INTEGER NOT NULL DEFAULT 0 CHECK (all_day IN (0,1)),
  status       TEXT CHECK (status IN ('ready','on_track','behind','drafting','done')),
  source       TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','timetable_sync')),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  CHECK (ends_at IS NULL OR ends_at >= starts_at)
);
CREATE INDEX idx_events_user_time ON events(user_id, starts_at);

CREATE TABLE study_sessions (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject_id     TEXT REFERENCES subjects(id) ON DELETE SET NULL,
  file_id        TEXT REFERENCES files(id) ON DELETE SET NULL,
  event_id       TEXT REFERENCES events(id) ON DELETE SET NULL,
  planned_minutes INTEGER NOT NULL DEFAULT 25 CHECK (planned_minutes > 0),
  elapsed_seconds INTEGER NOT NULL DEFAULT 0 CHECK (elapsed_seconds >= 0),
  cycle_index    INTEGER NOT NULL DEFAULT 1 CHECK (cycle_index >= 1),
  cycle_total    INTEGER NOT NULL DEFAULT 4 CHECK (cycle_total >= 1),
  status         TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','paused','completed','abandoned')),
  started_at     INTEGER NOT NULL,
  -- when running, the wall-clock instant the current run segment began
  resumed_at     INTEGER,
  ended_at       INTEGER
);
CREATE INDEX idx_study_sessions_user ON study_sessions(user_id, started_at DESC);

-- "Theme and accent follow your account everywhere."
CREATE TABLE user_settings (
  user_id            TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  theme              TEXT NOT NULL DEFAULT 'dark' CHECK (theme IN ('dark','light','system')),
  accent             TEXT NOT NULL DEFAULT '#9184d9',
  daily_new_cards    INTEGER NOT NULL DEFAULT 20 CHECK (daily_new_cards >= 0),
  daily_review_limit INTEGER NOT NULL DEFAULT 200 CHECK (daily_review_limit >= 0),
  notifications      TEXT NOT NULL DEFAULT '{}',
  timezone           TEXT NOT NULL DEFAULT 'UTC',
  updated_at         INTEGER NOT NULL
);

-- "Layout choices are per-device."
CREATE TABLE device_settings (
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id     TEXT NOT NULL,
  shell_layout  TEXT NOT NULL DEFAULT 'folder_tree' CHECK (shell_layout IN ('folder_tree','icon_rail','workspace_tabs')),
  canvas_chrome TEXT NOT NULL DEFAULT 'floating_dock' CHECK (canvas_chrome IN ('floating_dock','tool_column')),
  canvas_grid   TEXT NOT NULL DEFAULT 'dots' CHECK (canvas_grid IN ('dots','lines','plain')),
  density       TEXT NOT NULL DEFAULT 'comfortable' CHECK (density IN ('compact','comfortable')),
  show_minimap  INTEGER NOT NULL DEFAULT 1 CHECK (show_minimap IN (0,1)),
  focus_mode    INTEGER NOT NULL DEFAULT 0 CHECK (focus_mode IN (0,1)),
  reduce_motion INTEGER NOT NULL DEFAULT 0 CHECK (reduce_motion IN (0,1)),
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (user_id, device_id)
);

-- Share links carry only a hash of the secret, like sessions.
CREATE TABLE shares (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type   TEXT NOT NULL CHECK (target_type IN ('file','folder')),
  target_id     TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  permission    TEXT NOT NULL DEFAULT 'view' CHECK (permission IN ('view')),
  expires_at    INTEGER,
  revoked_at    INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_shares_target ON shares(target_type, target_id);

-- Full-text search over titles, document text, annotations and cards.
-- Maintained by the application layer, which owns the text extraction.
CREATE VIRTUAL TABLE search_index USING fts5(
  title,
  body,
  user_id UNINDEXED,
  entity_type UNINDEXED,
  entity_id UNINDEXED,
  file_id UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- FTS5 cannot index its UNINDEXED columns, so deleting by entity would be a
-- full scan. This side table maps an entity to its fts rowid for O(1) removal.
CREATE TABLE search_docs (
  entity_id   TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  fts_rowid   INTEGER NOT NULL
);
CREATE INDEX idx_search_docs_user ON search_docs(user_id);
