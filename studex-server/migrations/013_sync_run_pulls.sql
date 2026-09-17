-- What the last run brought down as well as what it sent up.
--
-- sync_runs was written when sync only went one way, so it could describe a
-- push and nothing else. A student who has just set a second Mac up wants to
-- be told how much arrived, and one who has been editing in two places wants
-- to know whether anything had to be kept twice.
ALTER TABLE sync_runs ADD COLUMN pulled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sync_runs ADD COLUMN conflicts INTEGER NOT NULL DEFAULT 0;
