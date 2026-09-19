-- An account holds one live session, so a sign-in on a new device ends the
-- session on the old one. Recording why a session was revoked lets the device
-- that lost it say something true — "signed in somewhere else" rather than the
-- catch-all "your session expired".
ALTER TABLE sessions ADD COLUMN revoked_reason TEXT;
