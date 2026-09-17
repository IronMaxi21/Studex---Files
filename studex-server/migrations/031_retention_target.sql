-- The recall probability the schedule aims for, per account.
--
-- FSRS spaces reviews to land each card at a chosen retention rather than
-- growing intervals by a fixed ratio, so this is a real dial: higher means the
-- scheduler brings cards back sooner and you forget less at the cost of more
-- reviews; lower means fewer reviews and more forgetting. 0.9 is the FSRS
-- default and the point most study schedules are built around.
--
-- Bounded to 0.70..0.99 to match the range intervalForRetention clamps to —
-- outside it the maths stops being meaningful and the interval either collapses
-- or runs away.
ALTER TABLE user_settings ADD COLUMN retention_target REAL NOT NULL DEFAULT 0.9
  CHECK (retention_target >= 0.7 AND retention_target <= 0.99);
