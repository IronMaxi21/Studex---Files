-- A student's own FSRS weights, fitted to their review history by
-- "Tune my scheduler". NULL means the published defaults.
ALTER TABLE user_settings ADD COLUMN fsrs_weights TEXT;
ALTER TABLE user_settings ADD COLUMN fsrs_tuned_at INTEGER;
ALTER TABLE user_settings ADD COLUMN fsrs_tuned_reviews INTEGER;
