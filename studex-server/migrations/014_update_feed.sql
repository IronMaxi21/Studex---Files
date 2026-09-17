-- Where this installation looks for its own updates.
--
-- Per device rather than per account: two Macs can legitimately be on
-- different channels, and the one place a build knows about is the default it
-- was compiled with. Null means "use that default".
ALTER TABLE device_settings ADD COLUMN update_feed_url TEXT;
