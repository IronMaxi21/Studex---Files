-- Card templates, per deck.
--
-- Every card was a question and an answer and nothing else, so a French
-- vocabulary deck and an A-level physics deck looked identical and neither
-- looked right. A deck may now carry a template: how its cards are set (left or
-- centred, small to large type), whether a sitting shows the back first, and up
-- to two extra fields — a pronunciation line, a worked answer — named by the
-- student.
--
-- The template is JSON validated by the server before it is stored (never raw
-- caller JSON), and null means "the default look", which is every deck that
-- existed before this migration. The extra fields are columns on the card so
-- they are searchable and travel with the card when it moves deck; a card in a
-- deck whose template has no extra fields simply leaves them null.
ALTER TABLE decks ADD COLUMN template TEXT;
ALTER TABLE cards ADD COLUMN extra1 TEXT;
ALTER TABLE cards ADD COLUMN extra2 TEXT;
