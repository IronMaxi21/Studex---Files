-- Sync had no clock. Nothing called it, so two Macs drifted apart until
-- somebody remembered to press "Sync now" — which is a backup command, not
-- sync. This column is how often the server should run one on its own.
--
-- Zero means never, and the value is in minutes so the setting reads the same
-- way it is written. Fifteen is the default because the loop only ever does
-- anything for an account that has already been linked to a Supabase project,
-- which is itself the decision to sync; an account that signs in locally has
-- nowhere to sync to and the loop skips it entirely.
ALTER TABLE user_settings
  ADD COLUMN auto_sync_minutes INTEGER NOT NULL DEFAULT 15
  CHECK (auto_sync_minutes >= 0 AND auto_sync_minutes <= 1440);
