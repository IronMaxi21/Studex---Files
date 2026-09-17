-- Conversations with the study tutor, so one can be picked up again later.
--
-- A conversation is kept whole, as one JSON array of turns, because it is only
-- ever read and written whole: the panel shows every turn of the chat it has
-- open, and a turn on its own means nothing. The title is the first question,
-- cut short, so the history list needs no second query.
CREATE TABLE ai_chats (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  -- [{ "role": "user" | "assistant", "content": "...", "context": "..." }]
  messages    TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX idx_ai_chats_user ON ai_chats(user_id, updated_at);
