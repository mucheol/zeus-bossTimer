ALTER TABLE boss_updates ADD COLUMN undo_of INTEGER REFERENCES boss_updates(id);
CREATE UNIQUE INDEX boss_updates_undo ON boss_updates(undo_of) WHERE undo_of IS NOT NULL;
