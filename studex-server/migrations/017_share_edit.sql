-- pragma: foreign_keys = off
--
-- A share can now carry an edit scope.
--
-- The column has always been here, and has always been checked against a list
-- of exactly one value. Widening that list is the whole migration: everything
-- else about a share — the hashed token, the expiry, the revocation — already
-- works the same way whichever scope it grants.
--
-- SQLite cannot alter a CHECK constraint in place, so the table is rebuilt.
-- Nothing references `shares`, which is what makes that a copy rather than a
-- cascade; the pragma above is still lifted because dropping the old table
-- would otherwise be judged against the foreign key it holds on `users`.
CREATE TABLE shares_new (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type   TEXT NOT NULL CHECK (target_type IN ('file','folder')),
  target_id     TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  permission    TEXT NOT NULL DEFAULT 'view' CHECK (permission IN ('view','edit')),
  expires_at    INTEGER,
  revoked_at    INTEGER,
  created_at    INTEGER NOT NULL
);

-- Every existing link stays exactly as view-only as it was when it was made.
-- Widening the constraint must not widen a single share that already exists.
INSERT INTO shares_new (id, user_id, target_type, target_id, token_hash, permission, expires_at, revoked_at, created_at)
SELECT id, user_id, target_type, target_id, token_hash, permission, expires_at, revoked_at, created_at
FROM shares;

DROP TABLE shares;
ALTER TABLE shares_new RENAME TO shares;
CREATE INDEX idx_shares_target ON shares(target_type, target_id);
