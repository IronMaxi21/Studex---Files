-- A focus session may carry a goal ("finish the Organic deck") and, once it
-- ends, whether the student says they met it: NULL unanswered, 0 no, 1 yes.
ALTER TABLE study_sessions ADD COLUMN goal TEXT;
ALTER TABLE study_sessions ADD COLUMN goal_met INTEGER CHECK (goal_met IN (0, 1));
