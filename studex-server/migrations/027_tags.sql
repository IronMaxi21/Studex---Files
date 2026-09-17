-- Tags: the one thing in the library that is allowed to cut across the tree.
--
-- A folder answers "where does this live", and a file lives in exactly one, so
-- the tree can say "Biology" or "Mock exam" but never both about the same page.
-- That is the limit every student hits at about week three, and the usual
-- workaround — a folder called "Biology mocks" beside "Biology" and "Mocks" —
-- multiplies rather than solves it.
--
-- So a tag is a second axis. It is a first-class row rather than a string
-- repeated on each item, because a tag has things of its own: a colour, and a
-- name that can be corrected in one place after being written forty times.
CREATE TABLE tags (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- As typed, which is what is shown.
  name       TEXT NOT NULL,
  -- Folded to lower case, which is what is matched: `##Biology` written in a
  -- document and a "biology" tag picked from a menu are the same tag, and
  -- finding that out at read time would mean scanning every row.
  key        TEXT NOT NULL,
  color      TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, key)
);

CREATE INDEX tags_user ON tags(user_id, key);

-- What carries a tag.
--
-- `item_type` rather than two tables, because every query here is "this tag,
-- everything on it" and splitting that in two would mean a UNION at every call
-- site to answer the one question the feature exists for. The id is therefore
-- not a foreign key — SQLite cannot point at one of two tables — so the two
-- deletes that matter are done by hand in the domain layer, beside the code
-- that removes the folder or the file.
--
-- `source` is how the row got here. 'text' rows are derived from `##tags`
-- written in a document and are rewritten wholesale on every save of that
-- document; 'manual' rows were attached by hand and survive it. Both show on
-- the tag's page, which is the point: writing `##photosynthesis` in one page
-- and tagging a folder "photosynthesis" should land in the same place.
CREATE TABLE tag_items (
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tag_id    TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  item_type TEXT NOT NULL CHECK (item_type IN ('folder', 'file')),
  item_id   TEXT NOT NULL,
  source    TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'text')),
  added_at  INTEGER NOT NULL,
  PRIMARY KEY (tag_id, item_type, item_id)
) WITHOUT ROWID;

-- "What is this item tagged with", which is drawn beside every folder and every
-- open document, so it has to be an index lookup rather than a scan.
CREATE INDEX tag_items_item ON tag_items(user_id, item_type, item_id);
CREATE INDEX tag_items_user ON tag_items(user_id, tag_id);

-- The tags that already existed, which until now were only ever derived from
-- `##name` written in a document and only ever pointed at documents.
--
-- They become ordinary rows in the two tables above, marked 'text' so that the
-- next save of each page still owns them. `document_tags` then goes: keeping a
-- second, narrower copy of the same index would mean two answers to "what is
-- tagged photosynthesis", and the narrower one would always be the wrong one.
INSERT OR IGNORE INTO tags (id, user_id, name, key, color, created_at)
SELECT lower(
         hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2)
         || '-a' || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))
       ),
       user_id, tag, tag, NULL, CAST(strftime('%s', 'now') AS INTEGER) * 1000
  FROM (SELECT DISTINCT user_id, tag FROM document_tags);

INSERT OR IGNORE INTO tag_items (user_id, tag_id, item_type, item_id, source, added_at)
SELECT d.user_id, t.id, 'file', d.file_id, 'text', CAST(strftime('%s', 'now') AS INTEGER) * 1000
  FROM document_tags d
  JOIN tags t ON t.user_id = d.user_id AND t.key = d.tag;

DROP TABLE document_tags;
