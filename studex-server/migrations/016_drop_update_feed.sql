-- The per-Mac update channel is gone.
--
-- Where a build looks for a newer one is no longer something anyone sets: the
-- releases are a table in the Supabase project the app already signs in
-- against, so a build that can sign in can find its own updates. The column is
-- dropped rather than left empty, because a setting nothing reads is a setting
-- that will be read again by mistake.
ALTER TABLE device_settings DROP COLUMN update_feed_url;
