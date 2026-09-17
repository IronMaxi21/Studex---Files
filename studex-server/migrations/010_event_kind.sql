-- pragma: foreign_keys=off
--
-- A general event. Until now everything in the calendar had to be an exam, a
-- deadline, a class or a study block, so an open evening or a lab induction
-- had to be filed as something it was not.
--
-- SQLite cannot alter a CHECK constraint in place, so the table is rebuilt.
-- study_sessions.event_id references this table ON DELETE SET NULL, and
-- dropping a parent table with foreign keys enforced fires that action — which
-- would quietly unlink every focus session from the event it was booked for.
-- Hence the directive above: the runner drops enforcement for this file only,
-- and runs foreign_key_check before it commits.

CREATE TABLE events_new (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject_id   TEXT REFERENCES subjects(id) ON DELETE SET NULL,
  file_id      TEXT REFERENCES files(id) ON DELETE SET NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('exam','deadline','study_block','class','event')),
  title        TEXT NOT NULL,
  location     TEXT,
  starts_at    INTEGER NOT NULL,
  ends_at      INTEGER,
  all_day      INTEGER NOT NULL DEFAULT 0 CHECK (all_day IN (0,1)),
  status       TEXT CHECK (status IN ('ready','on_track','behind','drafting','done')),
  source       TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','timetable_sync')),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  CHECK (ends_at IS NULL OR ends_at >= starts_at)
);

INSERT INTO events_new
  (id, user_id, subject_id, file_id, kind, title, location, starts_at, ends_at,
   all_day, status, source, created_at, updated_at)
SELECT
   id, user_id, subject_id, file_id, kind, title, location, starts_at, ends_at,
   all_day, status, source, created_at, updated_at
FROM events;

DROP TABLE events;
ALTER TABLE events_new RENAME TO events;
CREATE INDEX idx_events_user_time ON events(user_id, starts_at);
