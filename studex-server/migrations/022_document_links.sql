-- Where one page names another.
--
-- Derived data: every row here can be rebuilt by re-reading the documents, and
-- is, on every save. It exists because the question a backlinks panel asks —
-- "which pages point at this one?" — is the reverse of the way the link is
-- written, and answering it by scanning every document's JSON would mean
-- parsing the whole library to draw one panel.
--
-- The target is stored as the title that was typed rather than as a file id,
-- because that is what `[[ ]]` actually holds and because a link is allowed to
-- name a page that does not exist yet: writing `[[Krebs cycle]]` before there
-- is a page called that is how most of them get made. The title is folded to
-- lower case in `target_key` so the lookup is case-insensitive without asking
-- SQLite to collate, and kept as written in `target` so the panel can show it
-- the way the student typed it.
CREATE TABLE document_links (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_id     TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  target      TEXT NOT NULL,
  target_key  TEXT NOT NULL,
  PRIMARY KEY (file_id, target_key)
) WITHOUT ROWID;

-- The panel's query: everything pointing at one title, for one account.
CREATE INDEX document_links_target ON document_links(user_id, target_key);

-- The tags a page carries.
--
-- Separate from links rather than one table with a "kind" column: a tag names
-- a category and a link names a page, they are searched for differently, and
-- the one place they would have shared — the target — means a different thing
-- in each. Tags are stored folded to lower case, because `##Biology` and
-- `##biology` are the same tag to everyone except a database.
CREATE TABLE document_tags (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  tag     TEXT NOT NULL,
  PRIMARY KEY (file_id, tag)
) WITHOUT ROWID;

CREATE INDEX document_tags_tag ON document_tags(user_id, tag);
