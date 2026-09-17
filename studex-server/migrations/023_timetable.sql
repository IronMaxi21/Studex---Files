-- A school timetable, which is not a diary.
--
-- Everything the calendar holds is dated: an exam is on the 14th of May and
-- nowhere else. A school timetable is the opposite — it is a pattern that
-- repeats, and on a two-week cycle it repeats over a fortnight rather than a
-- week. Writing it out as dated events would mean inventing a row for every
-- lesson of every week of the year, and re-inventing them all when a set
-- changes room in March. So the pattern is stored once, as a pattern, and the
-- date is worked out when it is drawn.

-- When the bells go.
--
-- Per account rather than a constant, because period 1 starts at 08:40 in one
-- school and 09:15 in the next, and because a sixth form with five periods and
-- a school with six should not both be drawn on somebody else's grid. The times
-- are wall clock text, 'HH:MM', not offsets from midnight: they are read off a
-- printed timetable and typed in, they never move with the clocks, and an hour
-- that is written 09:00 should still say 09:00 the morning the clocks change.
CREATE TABLE timetable_periods (
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idx       INTEGER NOT NULL CHECK (idx >= 0 AND idx < 20),
  label     TEXT NOT NULL,
  starts_at TEXT NOT NULL CHECK (starts_at GLOB '[0-2][0-9]:[0-5][0-9]'),
  ends_at   TEXT NOT NULL CHECK (ends_at GLOB '[0-2][0-9]:[0-5][0-9]'),
  PRIMARY KEY (user_id, idx)
) WITHOUT ROWID;

-- One lesson in the pattern: week A or B, a day, a period.
--
-- `subject` is free text and `subject_id` is optional, because the two do
-- different jobs. The text is what is printed on the timetable — 'Physics',
-- 'Further Maths Set 2' — and has to be typeable the moment the grid is opened,
-- before anything else in Studex exists. The id is the link to a subject in the
-- library, which is what makes a lesson able to colour itself like the rest of
-- that subject's work and what a revision plan can count against. A lesson with
-- neither is not possible; a lesson with only the text is the normal case.
--
-- UNIQUE on (week, day, period) is the grid itself: a cell holds one lesson, and
-- writing in a cell that is already filled edits what is there rather than
-- stacking a second lesson behind it.
CREATE TABLE lessons (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  week       TEXT NOT NULL CHECK (week IN ('A','B')),
  day        INTEGER NOT NULL CHECK (day >= 0 AND day <= 6),
  period     INTEGER NOT NULL CHECK (period >= 0 AND period < 20),
  subject    TEXT NOT NULL,
  subject_id TEXT REFERENCES subjects(id) ON DELETE SET NULL,
  room       TEXT,
  teacher    TEXT,
  color      TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (user_id, week, day, period)
);

CREATE INDEX idx_lessons_user_week ON lessons(user_id, week, day, period);

-- Which fortnight is which.
--
-- A two-week timetable is only usable if the app can answer "is this week A or
-- B", and nothing in the pattern can say so on its own: it has to be anchored to
-- a real Monday that was a week A. Stored as epoch milliseconds of that Monday;
-- NULL means nobody has said yet, and the current week is treated as A until
-- somebody corrects it — which is the same answer they would give if asked, half
-- the time, and costs one click to fix when it is wrong.
ALTER TABLE user_settings ADD COLUMN week_a_start INTEGER;
