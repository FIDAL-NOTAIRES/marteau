-- MARTEAU — migration 011 (14/10/2026) : rapport de RISQUES du portefeuille.
-- Idempotente.
-- MARTEAU commande le portefeuille à RISQUES (mode différé, arbitrages des 14-16/09/2026)
-- et garde ici le numéro de travail, puis les adresses du rapport et des états des
-- risques par bien, valables trente jours.
ALTER TABLE marteau_dossier ADD COLUMN IF NOT EXISTS risques jsonb;
