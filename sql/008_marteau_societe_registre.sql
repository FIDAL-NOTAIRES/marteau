-- =====================================================================
-- MARTEAU — migration 008 : ce que le registre dit de la société
-- =====================================================================
--
-- Découverte du 07/09/2026 : l'annuaire officiel des entreprises donne
-- LOGIS MÉTROPOLE « cessée » — cohérent avec son absorption par Habitat
-- du Nord lue au BODACC. Or rien ne le stockait, et l'analyse de la
-- famille 1 (identité, capacité de disposer) ne pouvait pas le voir.
--
-- On garde ce qui identifie une société et ce qui fonde la famille 1 :
-- l'état administratif, la date de création, le siège, la nature
-- juridique, les dirigeants. Source : API Recherche d'entreprises.

BEGIN;

ALTER TABLE marteau_societe
  ADD COLUMN etat_administratif text CHECK (etat_administratif IN ('active', 'cessee')),
  ADD COLUMN creee_le           date,
  ADD COLUMN siege_registre     text,
  ADD COLUMN nature_juridique   text,
  ADD COLUMN dirigeants         jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN registre_lu_le     timestamptz;

COMMENT ON COLUMN marteau_societe.etat_administratif IS
  'État au registre national : active ou cessée. Une société auditée '
  'cessée met en cause sa capacité à disposer — famille 1.';

COMMIT;

-- Contrôle :
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'marteau_societe' AND column_name IN
--          ('etat_administratif','creee_le','siege_registre','nature_juridique','dirigeants','registre_lu_le');
-- Six lignes attendues.
