-- =====================================================================
-- MARTEAU — migration 007 : ce que REDPAR dit de la parcelle
-- =====================================================================
--
-- `photo.js` rend pour chaque parcelle le code de droit (P = pleine
-- propriété, sinon usufruit, nue-propriété, bail emphytéotique, AOT…),
-- la nature de culture, la contenance et l'adresse. `collecter.js` les
-- laissait tomber. Or le code de droit est LA donnée qui allume le voyant
-- « nature du droit détenu » de la famille 5 — celui des pastilles orange
-- de la façade. Sans lui, l'analyse ne peut pas commencer.

BEGIN;

ALTER TABLE marteau_parcelle
  ADD COLUMN droit      text,
  ADD COLUMN nature     text,
  ADD COLUMN contenance numeric(14,2),
  ADD COLUMN adresse    text;

COMMENT ON COLUMN marteau_parcelle.droit IS
  'Code de droit MAJIC via REDPAR. P = pleine propriété. Tout autre code '
  'signale un droit démembré ou précaire : famille 5, voyant nature_droit, '
  'orange.';

COMMIT;
