-- Workspace preferences that had nowhere to live.
--
-- The canvas grid also gains 'squares', which the new-canvas sheet offers and
-- the old CHECK constraint would have rejected. SQLite cannot alter a CHECK in
-- place, so the column is rebuilt: copied to a temporary column, dropped, and
-- added back with the wider constraint.
ALTER TABLE device_settings ADD COLUMN doc_width TEXT NOT NULL DEFAULT 'regular'
  CHECK (doc_width IN ('narrow','regular','wide'));
ALTER TABLE device_settings ADD COLUMN doc_type_size TEXT NOT NULL DEFAULT 'regular'
  CHECK (doc_type_size IN ('small','regular','large'));

ALTER TABLE device_settings ADD COLUMN canvas_grid_next TEXT NOT NULL DEFAULT 'dots'
  CHECK (canvas_grid_next IN ('dots','lines','plain','squares'));
UPDATE device_settings SET canvas_grid_next = canvas_grid;
ALTER TABLE device_settings DROP COLUMN canvas_grid;
ALTER TABLE device_settings RENAME COLUMN canvas_grid_next TO canvas_grid;
