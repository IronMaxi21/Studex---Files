-- What each account has spent on the model this month.
--
-- Counted here rather than trusted to the interface, because the interface is
-- a folder of JavaScript inside a bundle the person owns. The allowance is the
-- only thing standing between one enthusiastic user and someone else's API
-- bill, so it is enforced on the way in, in the same transaction that records
-- the call.
--
-- The period is a 'YYYY-MM' string in UTC rather than a rolling window: a
-- rolling window means storing every call forever to know what to subtract,
-- and a month that resets on the first is the thing people can actually
-- predict. Old rows are left alone — they are twenty bytes each and they are
-- the only record of what the feature cost.
CREATE TABLE ai_usage (
  user_id       TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period        TEXT    NOT NULL,
  requests      INTEGER NOT NULL DEFAULT 0,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (user_id, period)
) WITHOUT ROWID;
