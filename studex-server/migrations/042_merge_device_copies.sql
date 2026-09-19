-- Clearing out the copies the old sync behaviour left behind.
--
-- Before 041, "both Macs changed this file" was answered by making a second
-- file called "… (from another device)". 041 stopped that happening, but it
-- could not do anything about the ones already sitting in people's libraries,
-- so they are still there: two of something the person thinks of as one thing,
-- and only one of the two syncing onward.
--
-- Two cases, and they want opposite answers:
--
--   The original is still there. The copy is redundant — its contents are an
--   older state of a file that still exists, and 041's revision history is
--   where that belongs now. It goes to the trash rather than being deleted,
--   because this is the app throwing away something the person never asked it
--   to make, and being wrong about that must be recoverable. Trash is emptied
--   on the person's schedule, not ours.
--
--   The original is gone — renamed, or deleted while the copy was kept. Then
--   the copy is the only version of that work in the library, and trashing it
--   would be destroying the thing this is supposed to protect. It keeps its
--   contents and gets its name back instead.
--
-- Folders were never given this suffix, so only files are considered. Anything
-- already in the trash is left exactly where it is.

-- Case two first: rename the orphans, while the suffix is still there to
-- match on. Doing this after the trashing below would be wrong — a copy
-- trashed in the same pass would then be renamed as though it had survived.
UPDATE files
   SET title = substr(title, 1, length(title) - length(' (from another device)')),
       updated_at = CAST(strftime('%s','now') AS INTEGER) * 1000
 WHERE trashed_at IS NULL
   AND title LIKE '% (from another device)'
   AND NOT EXISTS (
     SELECT 1 FROM files AS original
      WHERE original.user_id = files.user_id
        AND original.trashed_at IS NULL
        AND original.id <> files.id
        AND original.kind = files.kind
        AND original.folder_id IS files.folder_id
        AND original.title = substr(files.title, 1, length(files.title) - length(' (from another device)'))
   );

-- Case one: everything still carrying the suffix now has an original beside
-- it, so it is a duplicate. To the trash.
UPDATE files
   SET trashed_at = CAST(strftime('%s','now') AS INTEGER) * 1000
 WHERE trashed_at IS NULL
   AND title LIKE '% (from another device)';
