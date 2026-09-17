-- Images placed inside documents.
--
-- An image belongs to the document that holds it rather than to the library:
-- it has no page of its own, is never opened on its own, and should not appear
-- among a student's files. The row cascades with the owning file, and the blob
-- it names is released with it.
CREATE TABLE document_images (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_id       TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  storage_key   TEXT NOT NULL,
  mime          TEXT NOT NULL CHECK (mime IN ('image/png','image/jpeg','image/gif','image/webp')),
  byte_size     INTEGER NOT NULL,
  sha256        TEXT NOT NULL,
  original_name TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_document_images_file ON document_images(file_id);
CREATE INDEX idx_document_images_user ON document_images(user_id);
