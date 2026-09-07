-- =====================================================================
-- MARTEAU — migration 002 : un dossier se clôt, il ne se supprime pas
-- =====================================================================
--
-- Défaut constaté à la recette du 7 septembre 2026 : la migration 001
-- déclarait `marteau_journal.dossier_id ... ON DELETE CASCADE`, alors que
-- le trigger d'inaltérabilité refuse toute suppression de ligne. La
-- suppression d'un dossier échouait donc, avec un message qui parlait du
-- journal — diagnostic trompeur pour qui n'a pas le schéma en tête.
--
-- Arbitrage : c'est la CASCADE qui avait tort, pas le trigger. Si effacer
-- un dossier suffisait à faire disparaître sa piste d'audit, la règle
-- « aucune ligne ne peut être effacée » ne vaudrait plus rien. Un dossier
-- se clôt par `marteau_dossier.clos_le`.
--
-- La contrainte passe donc en RESTRICT, et le message d'erreur devient
-- lisible : c'est la clé étrangère qui refuse, non un trigger obscur.

BEGIN;

ALTER TABLE marteau_journal
  DROP CONSTRAINT marteau_journal_dossier_id_fkey,
  ADD  CONSTRAINT marteau_journal_dossier_id_fkey
       FOREIGN KEY (dossier_id) REFERENCES marteau_dossier(id) ON DELETE RESTRICT;

COMMENT ON TABLE marteau_journal IS
  'Piste d''audit inaltérable. Ni UPDATE, ni DELETE, ni TRUNCATE (trigger). '
  'Empêche par ricochet la suppression d''un dossier : un dossier se clôt '
  'par marteau_dossier.clos_le.';

COMMENT ON COLUMN marteau_dossier.clos_le IS
  'Clôture du dossier. Seule façon de le retirer du travail courant — la '
  'suppression est refusée par la piste d''audit.';

COMMIT;

-- ---------------------------------------------------------------------
-- Nettoyage du dossier de recette TEST-0001
-- ---------------------------------------------------------------------
--
-- À exécuter SÉPARÉMENT, et une seule fois. C'est la seule manière de
-- retirer une ligne de journal, et elle est délibérément inconfortable :
-- le propriétaire de la table désactive le trigger, supprime, le
-- réactive. Si cette manœuvre devient une habitude, c'est le signe qu'il
-- faut un rôle applicatif restreint plutôt qu'un garde-fou négociable.
--
--   ALTER TABLE marteau_journal DISABLE TRIGGER marteau_journal_pas_de_maj;
--   DELETE FROM marteau_journal
--    WHERE dossier_id IN (SELECT id FROM marteau_dossier WHERE reference = 'TEST-0001');
--   ALTER TABLE marteau_journal ENABLE TRIGGER marteau_journal_pas_de_maj;
--   DELETE FROM marteau_dossier WHERE reference = 'TEST-0001';
--
-- Contrôle attendu ensuite : zéro ligne dans les deux tables pour
-- TEST-0001, et le trigger de nouveau actif —
--   SELECT tgenabled FROM pg_trigger WHERE tgname = 'marteau_journal_pas_de_maj';
-- doit rendre 'O'.
