-- MARTEAU — migration 013 (21/11/2026) : NUMÉRO DE DOSSIER KIVIA. Idempotente.
--
-- Arbitrage de JFD du 21/11/2026 : pas d'ouverture de dossier sans le
-- notaire en charge NI le numéro du dossier dans le logiciel métier Kivia ;
-- les dossiers déjà ouverts le demandent dès qu'on les rouvre.
--
-- La colonne reste NULLABLE : les dossiers ouverts avant cette migration
-- ne l'ont pas, et MARTEAU doit les lire quand même (c'est la page du
-- dossier qui bloque tant qu'il manque). L'obligation à la création vit
-- dans api/dossier.js, comme pour la migration 012.
ALTER TABLE marteau_dossier
  ADD COLUMN IF NOT EXISTS numero_kivia text
    CHECK (numero_kivia IS NULL OR length(btrim(numero_kivia)) BETWEEN 1 AND 40);
