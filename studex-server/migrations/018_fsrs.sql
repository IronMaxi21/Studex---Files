-- FSRS replaces SM-2, which means a card is described by memory state rather
-- than by a single ease multiplier.
--
-- Stability is how many days it takes for recall probability to fall to 90%.
-- Difficulty is how much harder than average this particular card is, on a
-- 1..10 scale. Both are NULL until a card's first review, because FSRS derives
-- its opening state from the first grade rather than from a default.
ALTER TABLE cards ADD COLUMN stability REAL;
ALTER TABLE cards ADD COLUMN difficulty REAL;

-- Cards already in the review pool carry real history, and throwing it away
-- would reset every schedule a user has built up. SM-2's interval is, by
-- construction, the point at which recall was expected to be around 90% — the
-- same thing stability measures — so it seeds stability directly. Ease runs
-- 1.3..3.0 with higher meaning easier, so it maps onto difficulty inverted.
--
-- These are estimates. They put each card near where it was rather than
-- exactly where FSRS would have placed it, and the next few reviews correct
-- them, which is precisely what FSRS's update rules are for.
UPDATE cards
SET stability = MAX(interval_days, 0.1),
    difficulty = MIN(10.0, MAX(1.0, 10.0 - (ease_factor - 1.3) * (9.0 / 1.7)))
WHERE state IN ('review', 'relearning') AND interval_days > 0;
