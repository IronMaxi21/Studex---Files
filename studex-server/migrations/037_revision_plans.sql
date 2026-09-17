-- Revision sessions written from an exam's plan remember which exam they are
-- for, so the plan can be looked at, reshuffled or cleared as one thing
-- rather than hunted for block by block. Losing the exam leaves the sessions
-- in place: they are still time the student set aside.
ALTER TABLE events ADD COLUMN plan_exam_id TEXT REFERENCES events(id) ON DELETE SET NULL;
CREATE INDEX idx_events_plan_exam ON events(plan_exam_id) WHERE plan_exam_id IS NOT NULL;
-- What a planned session is for: the topics and deck it was built around.
ALTER TABLE events ADD COLUMN plan_focus TEXT;
