-- The habit loop: a weekly study goal (minutes; 0 is no goal) and whether
-- earned streak freezes may bridge a missed day. Freezes themselves are not
-- stored — they are derived from the activity history each time, so there is
-- no balance to drift out of step with what actually happened.
ALTER TABLE user_settings ADD COLUMN weekly_goal_minutes INTEGER NOT NULL DEFAULT 0
  CHECK (weekly_goal_minutes >= 0 AND weekly_goal_minutes <= 6000);
ALTER TABLE user_settings ADD COLUMN streak_freeze INTEGER NOT NULL DEFAULT 1
  CHECK (streak_freeze IN (0, 1));
