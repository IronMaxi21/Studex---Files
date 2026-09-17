-- A canvas keeps its own paper.
--
-- The background pattern was a device-wide preference, so every canvas on a
-- machine looked the same and the choice followed the machine rather than the
-- work. Squared paper for working through a proof and plain for a mind map is
-- a property of the canvas, not of the laptop it is opened on.
ALTER TABLE canvases ADD COLUMN background TEXT NOT NULL DEFAULT 'dots'
  CHECK (background IN ('dots','plain','lines','squares'));
