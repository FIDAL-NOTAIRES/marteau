-- =====================================================================
-- MARTEAU — migration 005 : chaînage par empreinte de la piste d'audit
-- =====================================================================
--
-- POURQUOI.
--
-- Le trigger de la migration 001 refuse UPDATE, DELETE et TRUNCATE sur
-- marteau_journal. Mais un trigger est désactivable par le propriétaire
-- de la table — et sur Neon, TOUT rôle créé depuis la console hérite de
-- `neon_superuser`, appartenance qui ne peut pas être révoquée, pas même
-- par `neondb_owner`. La tentative d'un rôle applicatif restreint
-- (migration 004) est donc sans effet : il n'existe pas, sur cette
-- plateforme, de rôle privé du droit de baisser le garde-fou.
--
-- Le trigger protège contre l'accident. Il ne prouve rien.
--
-- Le chaînage change la nature de la garantie : chaque ligne porte
-- l'empreinte de la précédente. Une ligne réécrite ou supprimée casse la
-- chaîne, et la cassure se constate par un simple calcul — y compris par
-- celui qui a désactivé le trigger, puisqu'il ne peut pas la réparer
-- sans recalculer toute la suite.
--
-- CE QUE ÇA NE FAIT PAS. Quelqu'un qui recalcule l'ensemble de la chaîne
-- après réécriture produit un journal cohérent. La garantie n'est donc
-- complète que si l'empreinte de tête est ANCRÉE À L'EXTÉRIEUR de la
-- base. Deux ancrages sont prévus, l'un et l'autre gratuits :
--   • /api/sante l'expose, donc elle passe dans les journaux Vercel ;
--   • chaque rapport généré la porte, donc elle est figée dans un PDF
--     qui sort de l'étude et que l'étude ne détient plus seule.
-- C'est cet ancrage, et non le chaînage seul, qui donne sa valeur à la
-- piste d'audit.

BEGIN;

ALTER TABLE marteau_journal
  ADD COLUMN empreinte            text,
  ADD COLUMN empreinte_precedente text;

-- Sérialisation. Isolée dans sa propre fonction parce qu'elle doit être
-- IDENTIQUE à l'écriture et à la vérification : deux sérialisations qui
-- divergent d'un espace rendraient toute la chaîne fausse, et le défaut
-- serait indétectable autrement qu'en relisant les deux fonctions.
--
-- `le` est rendu en ISO 8601 à la microseconde : le type timestamptz a
-- cette précision, et tronquer ferait collisionner deux événements
-- proches.
CREATE FUNCTION marteau_journal_serialiser(
  p_precedente text, p_dossier bigint, p_le timestamptz,
  p_qui text, p_quoi text, p_detail jsonb
) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT concat_ws('|',
    coalesce(p_precedente, 'GENESE'),
    p_dossier::text,
    to_char(p_le AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
    p_qui, p_quoi, p_detail::text)
$$;

CREATE FUNCTION marteau_journal_empreinte(
  p_precedente text, p_dossier bigint, p_le timestamptz,
  p_qui text, p_quoi text, p_detail jsonb
) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(sha256(convert_to(
    marteau_journal_serialiser(p_precedente, p_dossier, p_le, p_qui, p_quoi, p_detail),
    'UTF8')), 'hex')
$$;

-- Pose l'empreinte à l'insertion. Le verrou consultatif sérialise les
-- écritures concurrentes : sans lui, deux insertions simultanées liraient
-- la même empreinte précédente et la chaîne fourcherait. Le volume est
-- de l'ordre de trente audits par mois, le coût du verrou est nul.
CREATE FUNCTION marteau_journal_chainer() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE precedente text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('marteau_journal'));

  SELECT empreinte INTO precedente
    FROM marteau_journal ORDER BY id DESC LIMIT 1;

  NEW.empreinte_precedente := precedente;
  NEW.empreinte := marteau_journal_empreinte(
    precedente, NEW.dossier_id, NEW.le, NEW.qui, NEW.quoi, NEW.detail);

  RETURN NEW;
END;
$$;

CREATE TRIGGER marteau_journal_chainage
  BEFORE INSERT ON marteau_journal
  FOR EACH ROW EXECUTE FUNCTION marteau_journal_chainer();

-- Reprise des lignes déjà présentes, dans l'ordre des identifiants.
-- Le trigger d'inaltérabilité doit être écarté le temps de la reprise :
-- c'est la dernière fois qu'on le baisse, et c'est pour poser la
-- garantie, pas pour la contourner.
ALTER TABLE marteau_journal DISABLE TRIGGER marteau_journal_pas_de_maj;

DO $$
DECLARE l record; precedente text := NULL;
BEGIN
  FOR l IN SELECT * FROM marteau_journal ORDER BY id LOOP
    UPDATE marteau_journal
       SET empreinte_precedente = precedente,
           empreinte = marteau_journal_empreinte(
             precedente, l.dossier_id, l.le, l.qui, l.quoi, l.detail)
     WHERE id = l.id
    RETURNING empreinte INTO precedente;
  END LOOP;
END $$;

ALTER TABLE marteau_journal ENABLE TRIGGER marteau_journal_pas_de_maj;

ALTER TABLE marteau_journal
  ALTER COLUMN empreinte SET NOT NULL;

-- Vérification de la chaîne. Rend UNE LIGNE PAR RUPTURE, et rien du tout
-- quand tout est en ordre — de sorte qu'un résultat vide soit la bonne
-- nouvelle, et qu'on n'ait pas à lire une colonne de « vrai » pour s'en
-- assurer.
CREATE FUNCTION marteau_journal_verifier()
  RETURNS TABLE (id bigint, le timestamptz, motif text)
  LANGUAGE plpgsql AS $$
DECLARE l record; attendue text := NULL;
BEGIN
  FOR l IN SELECT * FROM marteau_journal ORDER BY marteau_journal.id LOOP
    IF l.empreinte_precedente IS DISTINCT FROM attendue THEN
      RETURN QUERY SELECT l.id, l.le,
        'chaînon rompu — la ligne ne suit pas la précédente'::text;
    ELSIF l.empreinte <> marteau_journal_empreinte(
            l.empreinte_precedente, l.dossier_id, l.le,
            l.qui, l.quoi, l.detail) THEN
      RETURN QUERY SELECT l.id, l.le,
        'contenu réécrit — l''empreinte ne correspond pas aux données'::text;
    END IF;
    attendue := l.empreinte;
  END LOOP;
END;
$$;

-- Empreinte de tête : la valeur à ancrer hors de la base.
CREATE FUNCTION marteau_journal_tete() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT empreinte FROM marteau_journal ORDER BY id DESC LIMIT 1
$$;

COMMENT ON COLUMN marteau_journal.empreinte IS
  'Empreinte SHA-256 de la ligne, chaînée sur la précédente. Toute '
  'réécriture ou suppression rompt la chaîne — voir '
  'marteau_journal_verifier(). La garantie suppose que '
  'marteau_journal_tete() soit ancrée hors de la base.';

COMMIT;

-- ---------------------------------------------------------------------
-- Contrôles attendus
-- ---------------------------------------------------------------------
--
-- 1. La chaîne est saine — la requête ne rend AUCUNE ligne :
--
--      SELECT * FROM marteau_journal_verifier();
--
-- 2. La détection fonctionne. À ne faire qu'une fois, et à lire jusqu'au
--    bout : la réécriture volontaire ci-dessous CASSE la chaîne pour de
--    bon, la ligne ne pourra pas être remise en état.
--
--      INSERT INTO marteau_dossier (reference, siren_tete, associe_en_charge)
--        VALUES ('TEST-0002', '000000000', 'JFD');
--      INSERT INTO marteau_journal (dossier_id, qui, quoi)
--        SELECT id, 'JFD', 'essai chainage' FROM marteau_dossier
--         WHERE reference = 'TEST-0002';
--      SELECT * FROM marteau_journal_verifier();          -- vide
--
--      ALTER TABLE marteau_journal DISABLE TRIGGER marteau_journal_pas_de_maj;
--      UPDATE marteau_journal SET quoi = 'réécrit' WHERE quoi = 'essai chainage';
--      ALTER TABLE marteau_journal ENABLE TRIGGER marteau_journal_pas_de_maj;
--
--      SELECT * FROM marteau_journal_verifier();          -- une ligne :
--                                                         -- « contenu réécrit »
--
--    C'est exactement ce qu'on voulait : le garde-fou baissé n'empêche
--    pas la réécriture, mais il ne la cache plus.
