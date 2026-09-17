-- pragma: foreign_keys = off
--
-- A fourth kind of mark: text written straight onto the page.
--
-- The kind column carries a CHECK constraint, and SQLite has no way to widen
-- one in place, so the table is rebuilt. Cards point at annotations with
-- ON DELETE SET NULL, which would fire the moment the old table is dropped —
-- hence the pragma above, and the foreign_key_check the migrator runs before
-- it commits.
CREATE TABLE annotations_new (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_id      TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  page         INTEGER NOT NULL CHECK (page >= 1),
  kind         TEXT NOT NULL CHECK (kind IN ('highlight','ink','comment','text')),
  -- quads for highlights, a path for ink, an anchor point for comments,
  -- an anchor point and a type size for text
  geometry     TEXT NOT NULL DEFAULT '{}',
  color        TEXT,
  quoted_text  TEXT,
  note         TEXT,
  card_id      TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

INSERT INTO annotations_new
  (id, user_id, file_id, page, kind, geometry, color, quoted_text, note, card_id, created_at, updated_at)
SELECT id, user_id, file_id, page, kind, geometry, color, quoted_text, note, card_id, created_at, updated_at
  FROM annotations;

DROP TABLE annotations;
ALTER TABLE annotations_new RENAME TO annotations;

CREATE INDEX idx_annotations_file ON annotations(file_id, page);
CREATE INDEX idx_annotations_user ON annotations(user_id);
