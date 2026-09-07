-- =====================================================================
-- MARTEAU — migration 006 : niveau de confiance d'un lien sociétaire
-- =====================================================================
--
-- Lacune trouvée en fusionnant le modèle de données avec la couche de
-- collecte écrite le 1er septembre.
--
-- `api/liens.js` distingue DEUX NIVEAUX qui ne doivent jamais être
-- mélangés dans un audit :
--
--   structuree — le SIREN vient d'un champ JSON du BODACC. C'est un FAIT.
--   texte      — le rôle (absorbante / absorbée) vient de la lecture du
--                descriptif de l'acte. C'est une LECTURE, à confirmer.
--
-- La colonne `origine` disait d'où venait l'information ; elle ne disait
-- pas si c'était un fait ou une lecture. Un audit notarial ne peut pas
-- reposer sur une extraction de texte libre sans le dire.

BEGIN;

ALTER TABLE marteau_societe
  -- NOM : `niveau_confiance`, et non `niveau` — cette dernière existe
  -- déjà depuis la 001 et porte la PROFONDEUR dans l'arborescence.
  -- Deux notions distinctes, deux colonnes.
  ADD COLUMN niveau_confiance text NOT NULL DEFAULT 'structuree'
    CHECK (niveau_confiance IN ('structuree', 'texte')),
  -- Rôle lu dans l'avis de fusion, quand il y en a un. Nullable : la
  -- plupart des liens sociétaires n'en portent pas.
  ADD COLUMN role_fusion text
    CHECK (role_fusion IN ('absorbante', 'absorbee')),
  -- Liens vers les annonces qui établissent le lien. Plafonnés à trois
  -- côté collecte : une dénomination portée par cinquante annonces n'a
  -- pas besoin de cinquante liens pour être justifiable.
  ADD COLUMN sources_bodacc jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN marteau_societe.niveau_confiance IS
  'structuree = le SIREN vient d''un champ JSON du BODACC, c''est un fait. '
  'texte = le rôle vient de la lecture du descriptif de l''acte, à confirmer '
  'sur l''acte lui-même. Ne jamais présenter les deux au même rang.';

-- Même distinction sur la parcelle : une parcelle entrée au périmètre
-- sur une lecture de texte n'a pas le même statut qu'une parcelle
-- remontée par le cadastre.
ALTER TABLE marteau_parcelle
  ADD COLUMN a_confirmer boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN marteau_parcelle.a_confirmer IS
  'Vrai quand l''entrée au périmètre repose sur une lecture de texte libre '
  'et non sur un champ structuré. La machine propose, l''humain décide.';

COMMIT;

-- Contrôle :
--   SELECT column_name, data_type FROM information_schema.columns
--    WHERE table_name = 'marteau_societe' AND column_name IN
--          ('niveau_confiance','role_fusion','sources_bodacc');
-- Trois lignes attendues.
