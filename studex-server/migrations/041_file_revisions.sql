-- A file is one file everywhere.
--
-- Sync used to answer "both Macs changed this" by making a second copy called
-- "… (from another device)", which left the library holding two of something
-- the person thinks of as one thing, and only one of them syncing onward. Now
-- the synced version wins and the version that was replaced is kept here, so
-- nothing is lost and nothing is duplicated: the file keeps its identity and
-- its earlier states sit behind it.
--
-- Bodies live in the blob store like any other content. These copies are not
-- charged against the storage quota: they are made by the app to protect work
-- the person did not choose to overwrite, and are pruned to the most recent
-- few per file.
CREATE TABLE file_revisions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_id      TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  storage_key  TEXT NOT NULL,
  byte_size    INTEGER NOT NULL,
  sha256       TEXT NOT NULL,
  -- Why the previous state was kept: 'sync' (replaced by another device's
  -- version) or 'restore' (replaced by an older version being brought back).
  reason       TEXT NOT NULL CHECK (reason IN ('sync','restore')),
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_file_revisions_file ON file_revisions(file_id, created_at DESC);
