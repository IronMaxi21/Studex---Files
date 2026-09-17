-- Every call made to a model, one row each.
--
-- `ai_usage` counts requests against the month's allowance; this says what
-- those requests actually were. With three models behind three roles, and a
-- backup behind each, "why was that answer odd" starts with "which model wrote
-- it", and the only honest answer is a row written at the time. A request that
-- fell back to its backup leaves two rows: the one that failed and the one that
-- answered.
CREATE TABLE ai_calls (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- What the person asked for: spec_import, cards, quiz, explain, plan, dedupe.
  feature       TEXT NOT NULL,
  -- reader, writer or checker.
  role          TEXT NOT NULL,
  model         TEXT NOT NULL,
  ok            INTEGER NOT NULL CHECK (ok IN (0, 1)),
  status        INTEGER,
  error         TEXT,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  -- US dollars as OpenRouter reports them. Zero on the free variants.
  cost          REAL NOT NULL DEFAULT 0,
  duration_ms   INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE INDEX idx_ai_calls_user ON ai_calls(user_id, created_at);

-- Where on the specification a topic came from: its reference ("3.1.2") and
-- the page of the document it was read from. Both optional, and both only ever
-- written by an import — a topic typed by hand has neither, and needs neither.
ALTER TABLE topics ADD COLUMN spec_ref TEXT;
ALTER TABLE topics ADD COLUMN spec_page INTEGER;
