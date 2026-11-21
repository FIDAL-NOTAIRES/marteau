-- MARTEAU — migration 014 (21/11/2026) : COMPTEUR DE JUSTIFICATIFS, gestes. Idempotente.
--
-- Arbitrages de JFD des 20 et 21/11/2026 : une information peut être
-- VALIDÉE À LA MAIN (motif obligatoire), une divergence LEVÉE (motif
-- obligatoire ; grave : associé seul), le rapport client est bloqué sous
-- le seuil (85 % par défaut, modifiable par dossier par l'administrateur)
-- et demande l'ACCORD DU NOTAIRE du seuil à 99 %.
--
-- Tous ces gestes tiennent dans UNE colonne du dossier (comme FUSION les
-- tient dans l'état du dossier) :
--   { main:{id:{motif,par,le,libelle}}, levees:{…}, seuil, seuilLeve, accord }
-- Chaque geste est par ailleurs inscrit au journal chaîné.
ALTER TABLE marteau_dossier
  ADD COLUMN IF NOT EXISTS compteur jsonb NOT NULL DEFAULT '{}'::jsonb;
