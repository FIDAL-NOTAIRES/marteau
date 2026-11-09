-- MARTEAU — migration 012 (09/11/2026) : trois informations saisies à
-- l'OUVERTURE du dossier. Idempotente.
--
-- type_operation : arbitrage vocal du 09/11/2026 — MARTEAU demande à
--   l'ouverture s'il s'agit d'une VENTE DE L'IMMEUBLE ou d'une CESSION DE
--   PARTS, et adapte les couleurs pièce par pièce selon le cas.
-- date_signature_prevue : arbitrage du 09/11/2026 — facultative ; elle
--   commande notamment l'agrément du cessionnaire (orange dès l'ouverture,
--   rouge à dix jours de la signature).
-- delai_audit_jours : arbitrage du 09/09/2026 — liste fermée de sept
--   valeurs, l'échéance de l'audit en découle (ouvert_le + délai).
--
-- Les trois colonnes restent NULLABLES : les dossiers ouverts avant cette
-- migration n'ont pas ces informations, et MARTEAU doit les lire quand
-- même. L'obligation de saisie vit dans api/dossier.js, pas ici.
ALTER TABLE marteau_dossier
  ADD COLUMN IF NOT EXISTS type_operation text
    CHECK (type_operation IN ('vente_immeuble', 'cession_parts')),
  ADD COLUMN IF NOT EXISTS date_signature_prevue date,
  ADD COLUMN IF NOT EXISTS delai_audit_jours smallint
    CHECK (delai_audit_jours IN (10, 20, 30, 60, 90, 120, 180));
