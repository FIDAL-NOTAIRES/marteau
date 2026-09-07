-- =====================================================================
-- MARTEAU — migration 004 : droits du rôle applicatif
-- =====================================================================
--
-- À exécuter APRÈS avoir créé le rôle `marteau_app` dans l'onglet Roles
-- de Neon.
--
-- POURQUOI CE RÔLE N'EST PAS PROPRIÉTAIRE.
--
-- Seul le propriétaire d'une table peut exécuter
-- `ALTER TABLE ... DISABLE TRIGGER`. Tant que MARTEAU se connecte avec le
-- rôle propriétaire, le trigger d'inaltérabilité du journal est un
-- garde-fou négociable : l'application pourrait le baisser elle-même.
--
-- Les tables restent donc à `neondb_owner`, et `marteau_app` ne reçoit
-- que ce qu'il faut pour travailler. Il ne peut ni modifier le schéma,
-- ni désactiver un trigger, ni vider une table.
--
-- Conséquence à assumer : les migrations futures se jouent avec
-- `neondb_owner`, jamais avec le rôle applicatif. C'est voulu.
--
-- La base étant PARTAGÉE avec MATRICE et PARTAGE AMIABLE, les droits
-- sont accordés table par table sur le seul préfixe marteau_ — surtout
-- pas un GRANT ON ALL TABLES, qui ouvrirait les tables des deux autres.

BEGIN;

GRANT USAGE ON SCHEMA public TO marteau_app;

-- Lecture et écriture sur les seules tables de MARTEAU.
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name LIKE 'marteau\_%'
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO marteau_app', t);
  END LOOP;
END $$;

-- Les colonnes GENERATED ALWAYS AS IDENTITY consomment des séquences :
-- sans ce droit, tout INSERT échoue avec une erreur qui ne parle pas de
-- séquence et coûte une heure à diagnostiquer.
DO $$
DECLARE s text;
BEGIN
  FOR s IN
    SELECT sequence_name FROM information_schema.sequences
     WHERE sequence_schema = 'public' AND sequence_name LIKE 'marteau\_%'
  LOOP
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE public.%I TO marteau_app', s);
  END LOOP;
END $$;

-- Le journal : insertion seulement. La ceinture après les bretelles —
-- le trigger refuse déjà UPDATE et DELETE, mais un droit retiré ne
-- dépend pas d'un trigger qui pourrait être désactivé par ailleurs.
REVOKE UPDATE, DELETE ON marteau_journal FROM marteau_app;

-- Le référentiel des dix familles et des vingt-et-un voyants ne bouge
-- plus : lecture seule pour l'application. Toute évolution passe par une
-- migration, donc par le propriétaire.
REVOKE INSERT, UPDATE, DELETE ON marteau_famille   FROM marteau_app;
REVOKE INSERT, UPDATE, DELETE ON marteau_voyant_ref FROM marteau_app;

-- Droits par défaut sur les tables à venir : sans cette clause, chaque
-- migration future obligerait à repasser un GRANT, et on l'oublierait.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO marteau_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO marteau_app;

COMMIT;

-- ---------------------------------------------------------------------
-- Contrôles attendus
-- ---------------------------------------------------------------------
--
-- 1. Le rôle voit bien les tables de MARTEAU, et RIEN d'autre :
--
--   SELECT table_name,
--          has_table_privilege('marteau_app', 'public.' || table_name, 'SELECT') AS lecture,
--          has_table_privilege('marteau_app', 'public.' || table_name, 'UPDATE') AS ecriture
--     FROM information_schema.tables
--    WHERE table_schema = 'public' ORDER BY table_name;
--
--   Attendu : lecture ET écriture vraies sur les marteau_* (sauf
--   marteau_famille, marteau_voyant_ref et marteau_journal en écriture),
--   et FAUSSES sur toutes les tables de MATRICE et de PARTAGE AMIABLE.
--
-- 2. Le rôle ne peut PAS baisser le garde-fou. Reconnecté en
--    marteau_app, ceci doit échouer :
--
--   ALTER TABLE marteau_journal DISABLE TRIGGER marteau_journal_pas_de_maj;
--
--   Message attendu : « must be owner of table marteau_journal ».
--   C'est ce refus, et lui seul, qui rend la piste d'audit inaltérable.
