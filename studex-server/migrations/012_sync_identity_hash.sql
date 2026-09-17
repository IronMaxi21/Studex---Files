-- What an item was *called*, and where it sat, when the two sides last agreed.
--
-- content_hash covers the body, and deliberately nothing else: push uses it to
-- decide whether to spend an upload, and a rename changes no bytes. But that
-- left a rename invisible to the other direction — the row upstream said the
-- new name while its hash said nothing had happened, so a pull looked at it and
-- concluded there was nothing to do. Identity gets its own base so the same
-- three-way comparison can be made about it: did the name move here, there, or
-- in both places.
ALTER TABLE sync_state ADD COLUMN identity_hash TEXT;

-- Existing rows have no recorded identity, so the next sync in either
-- direction treats naming as unresolved and records it afresh. Folders were
-- briefly hashed into content_hash; that column goes back to meaning bodies
-- only, and a folder has none.
UPDATE sync_state SET content_hash = NULL WHERE scope = 'folder';
