-- Whether this device may copy the account's titles and text into Spotlight.
--
-- Off by default, and per device rather than per account: a system index lives
-- on one machine and is readable by anyone sitting at it, so consenting on a
-- personal laptop should say nothing about a shared one in the sixth form
-- centre.
ALTER TABLE device_settings
  ADD COLUMN spotlight INTEGER NOT NULL DEFAULT 0 CHECK (spotlight IN (0,1));
