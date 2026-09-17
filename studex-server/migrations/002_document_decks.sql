-- A document that makes flashcards while you write needs somewhere to put
-- them. The deck is an ordinary file, so the link is a column on files rather
-- than a table of its own: at most one generated deck per source document,
-- created the first time a line is turned into a card.
ALTER TABLE files ADD COLUMN source_file_id TEXT REFERENCES files(id) ON DELETE SET NULL;
CREATE INDEX idx_files_source ON files(user_id, source_file_id);
