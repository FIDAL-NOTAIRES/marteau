-- =====================================================================
-- MARTEAU — migration 009 : le module Documents
-- =====================================================================
--
-- Deux manques, révélés par les arbitrages du 10/09/2026.
--
-- 1. LE NUMÉRO DE GROUPE N'EXISTAIT PAS. marteau_groupe ne portait qu'un
--    nom. Or composerNom() attend un numéro à quatre chiffres en tête de
--    chaque nom de fichier, et ce numéro est UNIQUE SUR TOUT LE DOSSIER
--    D'AUDIT — pas par société. Sans collision entre silos, le SIREN n'a
--    pas à figurer dans le nom de fichier.
--
-- 2. AUCUNE TABLE NE PORTAIT LES FICHIERS DÉPOSÉS. marteau_piece existe
--    déjà mais c'est la liste des pièces À DEMANDER : elle suit un cycle
--    de relance (demandable → demandee → relancee → recue). Un document
--    déposé n'est pas une demande — il en est parfois la réponse, et
--    parfois il arrive sans que rien n'ait été demandé.
--
-- ---------------------------------------------------------------------
-- CE QUE MARTEAU NE STOCKE PAS
--
-- Le fichier lui-même. Exemplaire unique, celui du Drive : on garde
-- l'empreinte (pour reconnaître un doublon et servir le cache de
-- lecture), l'identifiant Drive (pour y retourner) et le résultat de
-- lecture. Jamais l'octet.
--
-- ---------------------------------------------------------------------
-- PIÈGE — LES DEUX AXES DE FAMILLES
--
-- `code` est le code DOCUMENTAIRE à trois chiffres (010 à 100), celui du
-- plan de nommage. Ce n'est PAS marteau_famille.numero × 10 : les
-- familles 2 et 3 sont inversées entre l'axe d'analyse et l'axe
-- documentaire. On ne met donc aucune clé étrangère vers
-- marteau_famille ici, et aucune vue ne doit en dériver une.
-- Voir l'avertissement en tête de lib/nomenclature.js.

BEGIN;

-- ---------------------------------------------------------------------
-- 1. Le numéro de groupe
-- ---------------------------------------------------------------------
--
-- 0 = PROVISOIRE. Une pièce peut être déposée avant que les unités
-- foncières soient validées : elle est nommée avec 0000, et renommée
-- automatiquement quand la numérotation définitive tombe — même
-- mécanisme que la renumérotation géographique, table de concordance
-- comprise.

ALTER TABLE marteau_groupe
  ADD COLUMN numero smallint NOT NULL DEFAULT 0 CHECK (numero BETWEEN 0 AND 9999);

COMMENT ON COLUMN marteau_groupe.numero IS
  'Numéro à quatre chiffres en tête des noms de fichiers. Unique sur tout '
  'le dossier d''audit, toutes sociétés confondues. 0 = provisoire, en '
  'attente de validation des unités foncières.';

-- L''unicité ne porte que sur les numéros attribués : plusieurs groupes
-- peuvent être provisoires en même temps.
CREATE UNIQUE INDEX marteau_groupe_numero_unique
  ON marteau_groupe (dossier_id, numero)
  WHERE numero > 0;

-- ---------------------------------------------------------------------
-- 2. Les documents déposés
-- ---------------------------------------------------------------------

CREATE TABLE marteau_document (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dossier_id    bigint NOT NULL REFERENCES marteau_dossier(id) ON DELETE CASCADE,

  -- Le dépôt se fait TOUJOURS dans un groupe : le collaborateur choisit
  -- son groupe avant de poser ses fichiers. Pas de bac en vrac au niveau
  -- du dossier d'audit — le bac à qualifier est par groupe.
  groupe_id     bigint NOT NULL REFERENCES marteau_groupe(id) ON DELETE CASCADE,

  -- La société dont relève la pièce. Renseignée au classement : une
  -- pièce de la famille 010 est dupliquée dans chaque groupe de la même
  -- société, et il faut pouvoir propager son remplacement.
  societe_id    bigint REFERENCES marteau_societe(id) ON DELETE SET NULL,

  -- ------------------------------------------------- ce que le fichier est
  nom_depose    text NOT NULL,          -- nom d'origine, gardé tel quel
  octets        bigint NOT NULL CHECK (octets > 0),
  mime          text,
  empreinte     text NOT NULL CHECK (empreinte ~ '^[0-9a-f]{64}$'),

  -- ------------------------------------------------- ce que le rangement dit
  -- Nuls tant que la pièce est au bac à qualifier.
  code          text CHECK (code ~ '^[0-9]{3}$'),
  piece         text CHECK (piece = upper(piece)),
  date_piece    date,
  autorisation  text,                   -- 062 seulement : permis, DP, DAACT
  nom_range     text,                   -- composé par composerNom()

  -- ------------------------------------------------- corps et annexes
  -- La scission d'un titre produit DEUX fichiers réels. L'annexe reste
  -- rattachée à la famille du TITRE, sans aucune exception : même un DPE
  -- annexé, même un règlement de copropriété annexé. Seul le FAIT extrait
  -- remonte vers la famille concernée, avec renvoi en note. Un fichier,
  -- une seule adresse Drive.
  role          text NOT NULL DEFAULT 'corps' CHECK (role IN ('corps','annexe')),
  parent_id     bigint REFERENCES marteau_document(id) ON DELETE CASCADE,

  -- Copie de propagation : la famille 010 est dupliquée dans chaque
  -- groupe en COPIE RÉELLE, pas en raccourci, pour qu'un groupe soit
  -- autoportant et extractible seul en data room.
  copie_de_id   bigint REFERENCES marteau_document(id) ON DELETE SET NULL,

  -- ------------------------------------------------- Drive et lecture
  drive_id      text,                   -- nul jusqu'au dépôt effectif
  drive_chemin  text,
  lecture       jsonb,                  -- résultat de lecture, en cache par empreinte
  lu_le         timestamptz,

  statut        text NOT NULL DEFAULT 'a_qualifier'
                  CHECK (statut IN ('a_qualifier','range','perime')),

  depose_par    text NOT NULL,
  depose_le     timestamptz NOT NULL DEFAULT now(),
  range_le      timestamptz,

  -- Un document rangé porte forcément son rangement complet : on refuse
  -- l'état intermédiaire silencieux, où une pièce paraît classée sans
  -- savoir où elle est.
  CONSTRAINT marteau_document_range CHECK (
    statut <> 'range'
    OR (code IS NOT NULL AND piece IS NOT NULL
        AND date_piece IS NOT NULL AND nom_range IS NOT NULL)
  ),

  -- Une annexe sans titre n'a pas de famille : elle emprunte celle du
  -- corps, donc elle ne peut pas exister seule.
  CONSTRAINT marteau_document_annexe CHECK (
    role <> 'annexe' OR parent_id IS NOT NULL
  )
);

-- Le même fichier déposé deux fois dans le MÊME groupe est un doublon.
-- Dans deux groupes différents, c'est la duplication voulue de la 010 :
-- l'unicité ne porte donc pas sur le dossier.
CREATE UNIQUE INDEX marteau_document_empreinte_groupe
  ON marteau_document (groupe_id, empreinte);

CREATE INDEX ON marteau_document (dossier_id, statut);
CREATE INDEX ON marteau_document (groupe_id, code);
CREATE INDEX ON marteau_document (empreinte);

COMMENT ON TABLE marteau_document IS
  'Les fichiers déposés dans l''audit. Exemplaire unique sur le Drive : '
  'ni contenu ni copie en base, seulement l''empreinte, l''identifiant '
  'Drive et le résultat de lecture.';

COMMENT ON COLUMN marteau_document.code IS
  'Code DOCUMENTAIRE à trois chiffres (010 à 100). N''est PAS '
  'marteau_famille.numero × 10 : les familles 2 et 3 sont inversées '
  'entre les deux axes.';

COMMIT;

-- Contrôle :
--   SELECT count(*) FROM information_schema.columns
--    WHERE table_name = 'marteau_document';
-- Vingt-quatre colonnes attendues.
--
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'marteau_groupe' AND column_name = 'numero';
-- Une ligne attendue.
