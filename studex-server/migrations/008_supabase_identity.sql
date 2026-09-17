-- Links a local account to the Supabase identity that authenticates it.
--
-- The local users row stays the owner of everything: files, folders, decks and
-- the storage quota all foreign-key to users.id, and moving that to a Supabase
-- uuid would mean rewriting every table. So Supabase authenticates, and this
-- column records which Supabase identity maps to which local account.
--
-- NULL means the row is authenticated locally by password_hash, which is what
-- every existing account is and what a self-hosted install without Supabase
-- configured continues to be.
ALTER TABLE users ADD COLUMN supabase_user_id TEXT;

-- Partial: one local account per Supabase identity, while leaving every
-- password-authenticated row (all NULL) free of the constraint.
CREATE UNIQUE INDEX idx_users_supabase ON users(supabase_user_id)
  WHERE supabase_user_id IS NOT NULL;
