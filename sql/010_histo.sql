-- MARTEAU — migration 010 (11/10/2026, complétée le 13/10/2026) : filiation cadastrale lue dans HISTO
-- Arbitrage JFD du 11/10/2026 : à la collecte, MARTEAU interroge HISTO sur les
-- parcelles du périmètre ; toute parcelle issue d'un mouvement cadastral
-- (division, réunion, remaniement…) allume un voyant JAUNE en famille 2.
-- HISTO n'est qu'un appui : c'est l'état hypothécaire qui fait foi.
-- La réponse est GARDÉE avec la parcelle pour que l'analyse, qui ne lit que
-- la base, puisse la reprendre à chaque recalcul.
-- 13/10/2026 — contrat 1.2 de HISTO : les BESOINS repérés (état hypothécaire,
-- document d'arpentage) sont gardés à part, dans `histo_besoins`. HISTO signale
-- le besoin, MARTEAU pilote la formalité.
ALTER TABLE marteau_parcelle ADD COLUMN IF NOT EXISTS histo jsonb;
ALTER TABLE marteau_parcelle ADD COLUMN IF NOT EXISTS histo_besoins jsonb;
ALTER TABLE marteau_parcelle ADD COLUMN IF NOT EXISTS histo_lu_le timestamptz;
