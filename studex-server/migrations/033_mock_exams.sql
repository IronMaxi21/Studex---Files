-- Mock-exam mode.
--
-- Test mode (migration 001, test_sessions) tests one deck, one card at a time,
-- and throws the result away once the score is shown. A mock exam is the harder,
-- more useful thing: a timed paper built from a whole subject's cards, sat under
-- exam conditions, and — the part that earns its keep — marked back into the
-- topic matrix so that sitting the paper updates what the student is told to
-- revise next. Practising under exam conditions is the single habit most
-- associated with better marks, so the result is not merely shown, it is fed
-- back into the schedule the same way a topic self-rating is.
--
-- Each question keeps the free-text topic label of the card it came from, so the
-- final per-topic breakdown can find the matching row in `topics` (same subject,
-- same name) and re-rate it from how the paper actually went.
CREATE TABLE mock_exams (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject_id    TEXT REFERENCES subjects(id) ON DELETE SET NULL,
  title         TEXT NOT NULL,
  duration_min  INTEGER NOT NULL DEFAULT 0 CHECK (duration_min >= 0),
  score_pct     REAL CHECK (score_pct IS NULL OR score_pct BETWEEN 0 AND 100),
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER
);

CREATE INDEX idx_mock_exams_user ON mock_exams(user_id, started_at DESC);

CREATE TABLE mock_exam_questions (
  id           TEXT PRIMARY KEY,
  exam_id      TEXT NOT NULL REFERENCES mock_exams(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  card_id      TEXT REFERENCES cards(id) ON DELETE SET NULL,
  topic        TEXT,
  prompt       TEXT NOT NULL,
  answer       TEXT NOT NULL,
  position     INTEGER NOT NULL,
  correct      INTEGER CHECK (correct IN (0, 1)),
  answered_at  INTEGER
);

CREATE INDEX idx_mock_questions_exam ON mock_exam_questions(exam_id, position);
