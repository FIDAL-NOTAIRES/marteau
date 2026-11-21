-- MARTEAU — migration 015 (21/11/2026) : PROCÉDURE COLLECTIVE au BODACC. Idempotente.
--
-- Décision de JFD du 20/11/2026 (liste des contradictions, cas 2) : une
-- procédure collective publiée, que les pièces ne mentionnent pas, est une
-- DIVERGENCE GRAVE. Jusqu'ici MARTEAU lisait le BODACC sans regarder la
-- nature des jugements ; la collecte la relève désormais et la garde sur la
-- société auditée :
--   { en_cours, nature, date, tribunal, source, annonces }
-- NULL = aucune annonce de procédure collective lue.
ALTER TABLE marteau_societe
  ADD COLUMN IF NOT EXISTS procedure_collective jsonb;
