-- Who teaches a subject. Asked for when the subject is made, and shown beside
-- its lessons, so the timetable does not have to be told again for every hour.
ALTER TABLE subjects ADD COLUMN teacher TEXT;
