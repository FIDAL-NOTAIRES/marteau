-- =====================================================================
-- MARTEAU — migration 001 : modèle de données initial
-- =====================================================================
--
-- Base Neon PARTAGÉE. Les tables sans préfixe (demandes, journal,
-- parametres, rapports) appartiennent à PARTAGE AMIABLE et les tables
-- matrice_* à MATRICE : ne rien y toucher. Toutes les tables créées ici
-- portent donc le préfixe marteau_, pour la même raison qui a imposé
-- matrice_ en son temps.
--
-- Ordre de lecture : référentiel figé, puis périmètre (dossier, sociétés,
-- parcelles), puis analyse (voyants, pièces, réserves), puis mémoire
-- (photos, rapports, journal), puis collecte.
--
-- Convention : tout identifiant technique est un bigint généré. Les clés
-- métier (SIREN, code parcelle) sont contraintes mais jamais primaires —
-- une même parcelle peut apparaître dans deux dossiers.

BEGIN;

-- ---------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------

-- Quatre crans, et l'ordre de la déclaration est l'ordre de gravité :
-- il sert au calcul de la pastille de synthèse d'une commune, où la
-- couleur la plus grave l'emporte. `canard < jaune < orange < carmin`
-- se compare directement sur un enum Postgres.
CREATE TYPE marteau_couleur AS ENUM ('canard', 'jaune', 'orange', 'carmin');

-- D'où vient une parcelle ou une société dans le périmètre. Tracé parce
-- que la piste d'audit doit dire si l'entrée est une saisie humaine ou
-- une détection automatique — c'est une exigence explicite du mémo.
CREATE TYPE marteau_origine AS ENUM (
  'accroche',      -- ramassée par l'accroche large (REDPAR)
  'saisie',        -- ajoutée à la main
  'orpheline',     -- détectée par SIREN, absente du portefeuille déclaré
  'titre',         -- lue dans une pièce déposée
  'inpi',          -- statuts et actes
  'bodacc'         -- mouvement postérieur au dépôt
);

CREATE TYPE marteau_etat_rapport AS ENUM ('provisoire', 'definitif');

-- ---------------------------------------------------------------------
-- 1. Référentiel figé des dix familles
-- ---------------------------------------------------------------------
--
-- Table de référence, pas de données de dossier. Elle existe pour que
-- l'ordre du rapport soit une donnée et non une constante recopiée dans
-- chaque écran : l'ordre est FIXE, identique d'un rapport à l'autre, et
-- il a déjà bougé trois fois en une semaine.
--
-- `note_fixe` porte le texte qui s'affiche en tête de famille et rappelle
-- pourquoi la vérification est faite — texte indépendant des données.
-- Il est NULL à la création : ces dix notes n'ont jamais été rédigées.

CREATE TABLE marteau_famille (
  numero        smallint PRIMARY KEY CHECK (numero BETWEEN 1 AND 10),
  code          text NOT NULL UNIQUE,
  libelle       text NOT NULL,
  note_fixe     text,
  -- Une famille descriptive ne peut pas porter de carmin (famille 2), et
  -- la fiscalité non plus : un régime coûteux est un paramètre de
  -- négociation, pas une discordance. La contrainte est portée par la
  -- donnée pour qu'aucun écran ne puisse la contourner.
  carmin_admis  boolean NOT NULL DEFAULT true,
  -- Familles qui s'ouvrent en jaune sur tout le portefeuille faute de
  -- source publique : diagnostics, organisation de l'ensemble, exploitation.
  ouvre_en_jaune boolean NOT NULL DEFAULT false
);

INSERT INTO marteau_famille (numero, code, libelle, carmin_admis, ouvre_en_jaune) VALUES
  (1,  'identite',      'Identité des sociétés auditées',        true,  false),
  (2,  'designation',   'Identification et désignation du bien', false, false),
  (3,  'propriete',     'Propriété',                             true,  false),
  (4,  'organisation',  'Organisation de l''ensemble immobilier',true,  true),
  (5,  'hypothecaire',  'État hypothécaire et servitudes',       true,  false),
  (6,  'urbanisme',     'Urbanisme et autorisations',            true,  false),
  (7,  'diagnostics',   'Diagnostics',                           true,  true),
  (8,  'environnement', 'Situation environnementale',            true,  false),
  (9,  'exploitation',  'Exploitation et contrats en cours',     true,  true),
  (10, 'fiscalite',     'Fiscalité',                             false, false);

-- Certaines familles portent PLUSIEURS voyants distincts, et il ne faut
-- pas les fondre en un seul : la famille 9 en a deux (exploitation pure,
-- contrats), la 6 en a quatre, la 10 en a deux. Un voyant est l'unité
-- qui prend une couleur ; la famille n'est qu'un regroupement de rendu.
CREATE TABLE marteau_voyant_ref (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  famille       smallint NOT NULL REFERENCES marteau_famille(numero),
  code          text NOT NULL,
  libelle       text NOT NULL,
  rang          smallint NOT NULL,
  UNIQUE (famille, code)
);

INSERT INTO marteau_voyant_ref (famille, code, libelle, rang) VALUES
  (1,  'identite',      'Identité et immatriculation',            1),
  (1,  'rbe',           'Cohérence RBE holding / filiales',       2),
  (2,  'designation',   'Désignation et recoupement',             1),
  (3,  'origine',       'Origine de propriété',                   1),
  (3,  'cadastre_pf',   'Divergence cadastre / publicité foncière',2),
  (4,  'regime',        'Régime de l''ensemble immobilier',       1),
  (4,  'gestion',       'Alertes de gestion',                     2),
  (5,  'inscriptions',  'Inscriptions et prêts',                  1),
  (5,  'servitudes',    'Servitudes et accès',                    2),
  (5,  'nature_droit',  'Nature du droit détenu',                 3),
  (6,  'autorisations', 'Autorisations d''urbanisme',             1),
  (6,  'zone',          'Organisation de la zone',                2),
  (6,  'usage',         'Usage et destination',                   3),
  (6,  'assurance',     'Assurance construction',                 4),
  (7,  'diagnostics',   'Dossier de diagnostics techniques',      1),
  (8,  'risques',       'Risques et pollution',                   1),
  (8,  'bati',          'Péril et insalubrité',                   2),
  (9,  'exploitation',  'Occupation et baux',                     1),
  (9,  'contrats',      'Contrats en cours',                      2),
  (10, 'actif',         'Fiscalité de l''actif',                  1),
  (10, 'cession',       'Fiscalité de la cession',                2);

-- ---------------------------------------------------------------------
-- 2. Périmètre
-- ---------------------------------------------------------------------

CREATE TABLE marteau_dossier (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  reference          text NOT NULL UNIQUE,
  siren_tete         text NOT NULL CHECK (siren_tete ~ '^[0-9]{9}$'),
  denomination_tete  text,
  -- L'associé en charge est une donnée du dossier : c'est ce qui permet
  -- d'imputer une levée de réserve sans code par associé.
  associe_en_charge  text NOT NULL,
  collaborateur      text,
  ouvert_le          timestamptz NOT NULL DEFAULT now(),
  clos_le            timestamptz
);

CREATE TABLE marteau_societe (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dossier_id         bigint NOT NULL REFERENCES marteau_dossier(id) ON DELETE CASCADE,
  siren              text NOT NULL CHECK (siren ~ '^[0-9]{9}$'),
  denomination       text,
  -- « anciennement X, puis Y » avec les dates : [{denomination, du, au, source}]
  denominations_anterieures jsonb NOT NULL DEFAULT '[]'::jsonb,
  forme              text,
  siege              text,
  -- Profondeur dans l'arborescence. 0 = société tête. La descente
  -- s'arrête dès qu'elle atteint une personne physique : il n'y a donc
  -- jamais de ligne pour une personne physique dans cette table.
  niveau             smallint NOT NULL DEFAULT 0,
  siren_parent       text CHECK (siren_parent ~ '^[0-9]{9}$'),
  -- Affiché tel quel, jamais utilisé pour consolider à 100 %. NULL quand
  -- la détention n'est pas connue, ce qui est le cas le plus fréquent
  -- depuis l'abandon de la source DGFiP.
  detention_pct      numeric(5,2),
  origine            marteau_origine NOT NULL,
  -- Empreinte des bénéficiaires effectifs, pour le contrôle de cohérence
  -- dans les deux sens. Comparée à chaque actualisation de l'audit, pas
  -- seulement à la première génération.
  rbe_empreinte      text,
  comptes_deposes    text CHECK (comptes_deposes IN ('accessibles','confidentiels','absents')),
  collecte_complete  boolean NOT NULL DEFAULT false,
  UNIQUE (dossier_id, siren)
);

-- Regroupement des parcelles contiguës d'un même propriétaire. Créée
-- AVANT tout test d'accès : une parcelle sans façade sur voie n'est pas
-- enclavée si le vendeur possède la voisine qui donne sur la rue. Sans
-- cette table, MARTEAU produit des faux positifs d'enclavement en série.
CREATE TABLE marteau_unite_fonciere (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dossier_id    bigint NOT NULL REFERENCES marteau_dossier(id) ON DELETE CASCADE,
  siren         text NOT NULL,
  libelle       text,
  -- Résultat du test, porté par l'unité et non par la parcelle.
  facade_voie   boolean,
  calcule_le    timestamptz
);

-- Groupe fonctionnel — les nébuleuses de la carte. Notion d'USAGE, pas
-- juridique : ni le propriétaire, ni l'acte. Ne se déduit pas des seules
-- données ; MARTEAU peut proposer, mais rien n'existe sans validation.
CREATE TABLE marteau_groupe (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dossier_id    bigint NOT NULL REFERENCES marteau_dossier(id) ON DELETE CASCADE,
  nom           text NOT NULL,
  propose       boolean NOT NULL DEFAULT false,
  valide        boolean NOT NULL DEFAULT false,
  motif_proposition text
);

CREATE TABLE marteau_parcelle (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dossier_id         bigint NOT NULL REFERENCES marteau_dossier(id) ON DELETE CASCADE,
  code_parcelle      text NOT NULL,
  commune_insee      text NOT NULL CHECK (commune_insee ~ '^[0-9AB][0-9]{4}$'),
  commune_nom        text,
  siren_proprietaire text,
  unite_fonciere_id  bigint REFERENCES marteau_unite_fonciere(id) ON DELETE SET NULL,
  groupe_id          bigint REFERENCES marteau_groupe(id) ON DELETE SET NULL,
  origine            marteau_origine NOT NULL,
  -- Une parcelle retirée du périmètre n'est pas supprimée : le retrait
  -- est un événement de la piste d'audit, la ligne reste lisible.
  en_perimetre       boolean NOT NULL DEFAULT true,
  retiree_le         timestamptz,
  retiree_par        text,
  -- Valeur : DVF en socle opposable, surcharge manuelle qui prime. Il
  -- faut TRACER laquelle a servi, sans quoi l'audit n'est pas
  -- justifiable après coup.
  valeur_dvf         numeric(14,2),
  valeur_saisie      numeric(14,2),
  valeur_source      text CHECK (valeur_source IN ('dvf','saisie')),
  valeur_origine_saisie text,
  UNIQUE (dossier_id, code_parcelle)
);

CREATE INDEX ON marteau_parcelle (dossier_id, commune_insee);
CREATE INDEX ON marteau_parcelle (dossier_id, siren_proprietaire);

-- ---------------------------------------------------------------------
-- 3. Analyse
-- ---------------------------------------------------------------------

-- Un voyant allumé, à un niveau donné. Le niveau varie : l'identité
-- porte sur une société, la désignation sur une parcelle, la fiscalité
-- de cession sur le dossier. D'où deux références nullables plutôt que
-- trois tables — mais une contrainte impose qu'exactement une soit
-- renseignée, sinon on ne sait plus de quoi le voyant parle.
--
-- `phrase_code` désigne le bloc de la bibliothèque, il ne le contient
-- pas : la bibliothèque de phrases vit dans le DÉPÔT, versionnée avec le
-- code. Mettre les phrases en base les rendrait modifiables sans revue,
-- alors que c'est une bibliothèque fixe sans génération libre. La base
-- ne garde que le code du bloc et les valeurs à substituer.
CREATE TABLE marteau_voyant (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dossier_id    bigint NOT NULL REFERENCES marteau_dossier(id) ON DELETE CASCADE,
  voyant_ref_id bigint NOT NULL REFERENCES marteau_voyant_ref(id),
  societe_id    bigint REFERENCES marteau_societe(id) ON DELETE CASCADE,
  parcelle_id   bigint REFERENCES marteau_parcelle(id) ON DELETE CASCADE,
  couleur       marteau_couleur NOT NULL,
  phrase_code   text NOT NULL,
  -- Les [précisions] des phrases à trous, et la donnée qui a déclenché.
  precisions    jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Motif d'impossibilité : jamais un simple « aucun élément relevé »,
  -- toujours la RAISON de l'absence d'information.
  motif_absence text,
  maj_le        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT marteau_voyant_portee CHECK (
    (societe_id IS NOT NULL)::int + (parcelle_id IS NOT NULL)::int <= 1
  )
);

CREATE INDEX ON marteau_voyant (dossier_id, voyant_ref_id);

-- Le registre de suivi. UNIQUE pour tout le cabinet, filtré par dossier :
-- la relance s'organise par collaborateur, et un collaborateur travaille
-- sur plusieurs dossiers. Tableau unique toutes familles confondues.
--
-- Il recense toutes les pièces demandées ET toutes celles qui sont
-- demandables — pas seulement celles auxquelles on a pensé.
CREATE TABLE marteau_piece (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dossier_id         bigint NOT NULL REFERENCES marteau_dossier(id) ON DELETE CASCADE,
  famille            smallint NOT NULL REFERENCES marteau_famille(numero),
  parcelle_id        bigint REFERENCES marteau_parcelle(id) ON DELETE CASCADE,
  societe_id         bigint REFERENCES marteau_societe(id) ON DELETE CASCADE,
  libelle            text NOT NULL,
  -- Deux natures, deux vocabulaires de statut. L'état hypothécaire n'est
  -- pas une pièce à relancer mais une analyse à confirmer, et son cycle
  -- commence avant l'envoi, dans le logiciel métier.
  nature             text NOT NULL DEFAULT 'piece'
                       CHECK (nature IN ('piece','etat_hypothecaire')),
  destinataire_type  text CHECK (destinataire_type IN
                       ('mairie','prefecture_ars','publicite_fonciere','client','expert_comptable')),
  destinataire       text,
  statut             text NOT NULL,
  -- Le compteur des 15 jours court depuis le PREMIER envoi. Une relance
  -- ne le remet pas à zéro, sinon un dossier relancé paraît toujours frais.
  premier_envoi_le   timestamptz,
  dernier_envoi_le   timestamptz,
  relances           smallint NOT NULL DEFAULT 0,
  -- Une pièce est marquée reçue par DÉPÔT DU FICHIER : le fichier fait
  -- la preuve, il n'y a pas de case à cocher.
  fichier_url        text,
  depose_le          timestamptz,
  depose_par         text,
  -- Après dépôt, MARTEAU demande si la réponse est négative (canard) ou
  -- positive (carmin) : une question, deux boutons.
  reponse            text CHECK (reponse IN ('negative','positive')),
  CONSTRAINT marteau_piece_statut CHECK (
    CASE nature
      WHEN 'piece' THEN statut IN ('demandable','demandee','relancee','recue')
      WHEN 'etat_hypothecaire' THEN statut IN ('a_saisir','saisie','recu_a_analyser','analyse')
    END
  ),
  -- Un fichier déposé sans réponse qualifiée laisse le voyant en
  -- suspens : on interdit l'état intermédiaire silencieux.
  CONSTRAINT marteau_piece_depot CHECK (
    (fichier_url IS NULL) = (depose_le IS NULL)
  )
);

CREATE INDEX ON marteau_piece (dossier_id, statut);
CREATE INDEX ON marteau_piece (statut, premier_envoi_le);

-- Les réserves. La jauge est le verrou : le définitif exige zéro réserve,
-- et la réserve « validation par l'associé » est ouverte d'office, donc
-- aucun définitif ne sort sans l'associé. Pas de mécanisme d'approbation
-- séparé à construire.
CREATE TABLE marteau_reserve (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dossier_id       bigint NOT NULL REFERENCES marteau_dossier(id) ON DELETE CASCADE,
  code             text NOT NULL,
  libelle          text NOT NULL,
  -- La divergence DVF est UNE seule réserve portant ses deux niveaux
  -- (parcelle et portefeuille) : elle se lève d'un bloc, motivation unique.
  detail           jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Réserves dont la levée exige le code : validation associé, DVF,
  -- état hypothécaire négatif.
  levee_sous_code  boolean NOT NULL DEFAULT false,
  ouverte_le       timestamptz NOT NULL DEFAULT now(),
  levee_le         timestamptz,
  -- L'associé en charge tel qu'il figure au dossier, pas un code par associé.
  levee_par        text,
  motif_levee      text,
  CONSTRAINT marteau_reserve_levee CHECK (
    (levee_le IS NULL) = (levee_par IS NULL)
    AND (levee_le IS NULL OR motif_levee IS NOT NULL)
  )
);

CREATE UNIQUE INDEX ON marteau_reserve (dossier_id, code) WHERE levee_le IS NULL;

-- ---------------------------------------------------------------------
-- 4. Mémoire : photos, rapports, journal
-- ---------------------------------------------------------------------

-- Photo figée. Le rapport se génère à partir d'elle, jamais du flux
-- vivant : il reste cohérent même si le tableau de bord continue de
-- bouger, et il ne se contredit pas entre génération et envoi.
CREATE TABLE marteau_photo (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dossier_id     bigint NOT NULL REFERENCES marteau_dossier(id) ON DELETE CASCADE,
  prise_le       timestamptz NOT NULL DEFAULT now(),
  origine        text NOT NULL CHECK (origine IN ('point_equipe','manuelle')),
  motif          text,
  -- État complet gelé. Volontairement dénormalisé : une photo doit
  -- rester lisible même si les tables évoluent.
  etat           jsonb NOT NULL,
  -- Deux jauges DISTINCTES, jamais un pourcentage unique : on peut avoir
  -- reçu toutes les pièces sans avoir levé toutes les réserves, quand une
  -- pièce reçue confirme justement un problème.
  jauge_pieces   numeric(5,2),
  jauge_reserves numeric(5,2)
);

CREATE TABLE marteau_rapport (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dossier_id    bigint NOT NULL REFERENCES marteau_dossier(id) ON DELETE CASCADE,
  photo_id      bigint NOT NULL REFERENCES marteau_photo(id),
  etat          marteau_etat_rapport NOT NULL,
  version       integer NOT NULL,
  genere_le     timestamptz NOT NULL DEFAULT now(),
  genere_par    text NOT NULL,
  fichier_url   text,
  -- Le document d'écarts est un FICHIER SÉPARÉ, pas un encart : il se lit
  -- juste avant le rapport, et il est produit même sans écart.
  ecarts_url    text,
  ecarts_vs_rapport_id bigint REFERENCES marteau_rapport(id),
  UNIQUE (dossier_id, version)
);

-- Piste d'audit INALTÉRABLE. Ce qui engage, pas tout : sinon le journal
-- devient illisible.
CREATE TABLE marteau_journal (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dossier_id  bigint NOT NULL REFERENCES marteau_dossier(id) ON DELETE CASCADE,
  le          timestamptz NOT NULL DEFAULT clock_timestamp(),
  qui         text NOT NULL,
  quoi        text NOT NULL,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX ON marteau_journal (dossier_id, le DESC);

-- Aucune ligne ne peut être modifiée ni effacée, Y COMPRIS par
-- l'administrateur. Sans cela la piste d'audit perd toute valeur de
-- preuve. Un trigger plutôt qu'une simple révocation de droits : la
-- révocation se rend, le trigger se voit dans le schéma.
CREATE FUNCTION marteau_journal_inalterable() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'marteau_journal est inaltérable : ni modification ni suppression (tentative %)',
    TG_OP;
END;
$$;

CREATE TRIGGER marteau_journal_pas_de_maj
  BEFORE UPDATE OR DELETE ON marteau_journal
  FOR EACH ROW EXECUTE FUNCTION marteau_journal_inalterable();

CREATE TRIGGER marteau_journal_pas_de_troncature
  BEFORE TRUNCATE ON marteau_journal
  FOR EACH STATEMENT EXECUTE FUNCTION marteau_journal_inalterable();

-- ---------------------------------------------------------------------
-- 5. Collecte
-- ---------------------------------------------------------------------
--
-- Une ligne par appel de source, pour que l'organigramme d'avancement
-- soit une lecture de la base et non un état en mémoire — la promesse
-- d'affichage au fil de l'eau suppose que l'écran puisse être rechargé.
CREATE TABLE marteau_appel (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dossier_id    bigint NOT NULL REFERENCES marteau_dossier(id) ON DELETE CASCADE,
  societe_id    bigint REFERENCES marteau_societe(id) ON DELETE CASCADE,
  source        text NOT NULL,
  -- 'echec' sort en ORANGE sur l'organigramme, jamais en carmin : le
  -- carmin reste réservé aux vrais signaux de risque de l'audit.
  statut        text NOT NULL CHECK (statut IN ('en_cours','ok','lent','echec')),
  tentatives    smallint NOT NULL DEFAULT 0,
  premier_essai timestamptz NOT NULL DEFAULT now(),
  dernier_essai timestamptz,
  ms            integer,
  erreur        text,
  -- Cache : une heure pour les sources qui bougent peu, très court ou nul
  -- pour le BODACC puisque c'est lui qui sert à détecter la fraîcheur.
  expire_le     timestamptz
);

CREATE INDEX ON marteau_appel (dossier_id, statut);

COMMIT;

-- =====================================================================
-- Ce que cette migration NE fait pas, volontairement
-- =====================================================================
--
-- * Les dix `note_fixe` sont NULL : ces textes n'ont jamais été rédigés.
--   Le rendu par famille en dépend (note en tête, résultat après).
--
-- * La bibliothèque de phrases n'est pas en base — décision de conception
--   assumée ci-dessus, à valider : le dépôt la versionne, la base ne
--   garde que `phrase_code` et `precisions`.
--
-- * Aucune table de paramètres : les seuils (20 % DVF, 20 % plus-value,
--   15 jours, 30 secondes) sont des constantes du dépôt. Si JFD doit
--   pouvoir les changer sans déploiement, il faut une table dédiée —
--   à trancher, mais il est administrateur unique, donc rien n'oblige.
--
-- * Rien sur la taxe foncière : application distincte, appelée par
--   MARTEAU. Seul le test de couverture vit ici, comme un voyant de la
--   famille 10.
