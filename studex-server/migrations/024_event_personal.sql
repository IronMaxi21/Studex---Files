-- pragma: foreign_keys=off
--
-- A personal event.
--
-- The calendar is now also the revision timetable, which means everything that
-- can take an evening away from revision has to be able to appear on it. A
-- driving lesson, a shift, a birthday, football — these were being filed as
-- 'event', the catch-all, alongside open evenings and lab inductions, and the
-- one question worth asking of the grid, "which of these evenings is actually
-- mine", could not be answered.
--
-- SQLite cannot alter a CHECK constraint in place, so the table is rebuilt. As
-- in 010, study_sessions.event_id references this table ON DELETE SET NULL, and
-- dropping the parent with foreign keys enforced would quietly unlink every
-- focus session from the event it was booked for — hence the directive above.

CREATE TABLE events_new (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject_id   TEXT REFERENCES subjects(id) ON DELETE SET NULL,
  file_id      TEXT REFERENCES files(id) ON DELETE SET NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('exam','deadline','study_block','class','event','personal')),
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
