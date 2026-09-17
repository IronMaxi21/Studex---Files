-- The topic matrix: every topic on the specification, and how well it is known.
--
-- This is the revision spreadsheet that nearly every student ends up building
-- by hand — a row per topic, a confidence rating against it, and a date to come
-- back to it — with the one part that never survives contact with a spreadsheet
-- automated: the date. In a spreadsheet the next-review column is filled in by
-- the person who least wants to be honest about it, and it rots within a
-- fortnight. Here it is derived: rate a topic and the date follows from the
-- rating, so the only thing asked of the student is the one thing only they can
-- answer.
--
-- Deliberately not the flashcard scheduler. FSRS grades one fact against a
-- memory model, and it is the right tool for a fact. A topic is not a fact: it
-- is a lump of the specification that takes an hour, and the honest question
-- about it is "could I answer a question on this in an exam tomorrow". Five
-- fixed steps against that question is a scale a person can actually hold in
-- their head, and a schedule they can predict is a schedule they keep.
CREATE TABLE topics (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject_id    TEXT REFERENCES subjects(id) ON DELETE SET NULL,
  -- The heading a topic sits under: a paper, a module, a unit. Free text and
  -- optional, because every board divides its course differently and a student
  -- who does not care to divide theirs at all should not have to.
  unit          TEXT,
  name          TEXT NOT NULL,
  -- 0 means unrated: on the matrix but never yet judged, which is a different
  -- thing from judged badly and is why 0 is not the bottom of the 1-5 scale.
  confidence    INTEGER NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 5),
  last_rated_at INTEGER,
  -- Derived from the confidence on every rating, and stored rather than
  -- computed on read so that the matrix can be sorted and filtered by it in SQL.
  next_due_at   INTEGER,
  -- Where the topic is written up, so the matrix is a way into the notes rather
  -- than a second place to keep them.
  file_id       TEXT REFERENCES files(id) ON DELETE SET NULL,
  notes         TEXT,
  position      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX idx_topics_user_due ON topics(user_id, next_due_at);
CREATE INDEX idx_topics_user_subject ON topics(user_id, subject_id, position);

-- Every rating ever given, kept.
--
-- The matrix shows where a topic stands; this is how it got there, and it is
-- the more useful of the two by March. A topic that has gone 2, 3, 2, 3 all year
-- is not the same as one that has gone 2, 2, 3, 4, and only the second is
-- actually being learnt — but the matrix, which holds one number, cannot tell
-- them apart.
CREATE TABLE topic_ratings (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  topic_id   TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  confidence INTEGER NOT NULL CHECK (confidence >= 1 AND confidence <= 5),
  rated_at   INTEGER NOT NULL
);

CREATE INDEX idx_topic_ratings_topic ON topic_ratings(topic_id, rated_at);
