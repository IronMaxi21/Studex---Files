-- How a document draws itself, kept with the document rather than the device.
--
-- 'bulleted' marks every top-level block — headings and tables included — the
-- way an outliner does. It is a property of the notes, not of the machine
-- reading them, so it travels with the document.
ALTER TABLE documents ADD COLUMN style TEXT NOT NULL DEFAULT 'standard'
  CHECK (style IN ('standard','bulleted'));
