-- Deleting a file has to take everything that came from it out of search.
--
-- An entity is removed from the index by its own id, which is fine one at a
-- time but leaves a file's annotations, cards and document text behind when the
-- file itself goes: they are separate entities that merely share a file_id, and
-- the FTS table stores file_id UNINDEXED, so finding them meant a full scan.
-- Recording the file on the side table makes the sweep a lookup.
ALTER TABLE search_docs ADD COLUMN file_id TEXT;

UPDATE search_docs
   SET file_id = (SELECT s.file_id FROM search_index s WHERE s.rowid = search_docs.fts_rowid);

CREATE INDEX idx_search_docs_file ON search_docs(file_id);
