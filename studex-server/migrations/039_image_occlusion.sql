-- Image occlusion: a card that hides one labelled region of a diagram.
-- JSON of { imageId, masks, target, mode, sourcePage }; NULL for text cards.
ALTER TABLE cards ADD COLUMN occlusion TEXT;
