-- Reading typeface and line spacing, per device.
--
-- Document width and type size already live here (migration 005); the typeface
-- itself was always the system font. This makes it a choice: a serif for long
-- reading, a rounded humanist sans, a monospace for code, and OpenDyslexic for
-- students who read better with it. 'system' keeps the existing document face.
--
-- It is a per-device setting rather than an account one because it is an
-- accessibility and comfort choice tied to the screen in front of the student,
-- not something that should follow them onto a shared machine.
ALTER TABLE device_settings ADD COLUMN doc_font TEXT NOT NULL DEFAULT 'system'
  CHECK (doc_font IN ('system','serif','sans','mono','dyslexic'));
ALTER TABLE device_settings ADD COLUMN line_spacing TEXT NOT NULL DEFAULT 'normal'
  CHECK (line_spacing IN ('tight','normal','relaxed','loose'));
