-- =====================================================================
-- MARTEAU — migration 003 : les dix notes fixes de tête de famille
-- =====================================================================
--
-- Texte FIXE, indépendant des données, affiché en tête de chaque famille
-- avant tout résultat. Il répond à une seule question : pourquoi cette
-- vérification est-elle faite ? Le résultat vient après.
--
-- Registre voulu : celui d'un notaire qui explique sa diligence à un
-- avocat ou à un client, pas celui d'une notice technique. Aucune de ces
-- notes ne mentionne une source, un outil ou un seuil — ce qui varie n'a
-- rien à faire dans un texte fixe.

BEGIN;

UPDATE marteau_famille SET note_fixe =
'La cession d''un actif immobilier suppose que le vendeur soit bien celui '
'qu''il déclare être et qu''il ait capacité de disposer du bien. Cette '
'première vérification confronte la société désignée au titre à celle qui '
'est effectivement immatriculée, examine sa forme, son siège et sa '
'représentation légale, et s''assure qu''aucune procédure ni formalité en '
'cours n''affecte son pouvoir de vendre. Elle constitue également la '
'diligence d''identification requise au titre de la lutte contre le '
'blanchiment.'
WHERE code = 'identite';

UPDATE marteau_famille SET note_fixe =
'Un acte ne peut porter que sur un bien exactement désigné. Cette famille '
'établit la désignation à partir du titre de propriété, seul document qui '
'engage, puis la recoupe avec les données publiques disponibles afin de '
'faire apparaître les écarts de nature, de contenance ou de références de '
'parcelle. Le plan cadastral n''a qu''une valeur informative et n''est pas '
'opposable : il sert au recoupement, jamais de fondement à la désignation. '
'Aucun écart relevé ici n''est en soi un obstacle ; il appelle une '
'explication avant la rédaction.'
WHERE code = 'designation';

UPDATE marteau_famille SET note_fixe =
'La sécurité de l''acquisition repose sur la continuité du droit de '
'propriété. L''origine de propriété est donc examinée sur les trente '
'dernières années, durée au terme de laquelle la prescription acquisitive '
'purge les vices affectant les titres antérieurs. Cet examen vérifie que '
'chaque mutation a été régulièrement publiée et qu''aucune interruption ne '
'subsiste dans la chaîne. Une divergence entre le propriétaire figurant au '
'cadastre et celui résultant du titre est également relevée : elle '
'n''affecte pas la propriété, mais elle éclaire la fiscalité locale et '
'révèle les mutations récentes.'
WHERE code = 'propriete';

UPDATE marteau_famille SET note_fixe =
'Lorsque le bien s''inscrit dans un ensemble plus vaste — copropriété, '
'division en volumes, association syndicale — sa jouissance et sa '
'cessibilité dépendent de règles collectives qui ne figurent pas au titre. '
'Cette famille examine le régime applicable, ce que le vendeur doit à la '
'collectivité des propriétaires, et les décisions déjà votées dont la '
'charge se transmettra à l''acquéreur. Les documents n''existent qu''entre '
'les mains du vendeur ou du syndic : la vérification reste ouverte jusqu''à '
'leur communication.'
WHERE code = 'organisation';

UPDATE marteau_famille SET note_fixe =
'Le bien doit être transmis libre de toute charge non révélée, et il doit '
'être desservi. Cette famille examine les inscriptions grevant l''immeuble '
'et les modalités de leur mainlevée, les servitudes qui le grèvent comme '
'celles qui le desservent, les clauses des prêts en cours susceptibles '
'd''être affectées par la cession, et la nature exacte du droit détenu par '
'la société auditée, qui n''est pas toujours la pleine propriété. La '
'desserte s''apprécie sur l''ensemble des parcelles contiguës appartenant au '
'même propriétaire, et non parcelle par parcelle.'
WHERE code = 'hypothecaire';

UPDATE marteau_famille SET note_fixe =
'Une construction doit avoir été autorisée, et l''usage qui en est fait '
'doit correspondre à la destination autorisée. Cette famille rassemble les '
'autorisations délivrées sur le bien, les règles propres à la zone dans '
'laquelle il se situe, la conformité de l''usage constaté à la destination '
'déclarée, et les garanties d''assurance attachées aux travaux récents. Une '
'irrégularité non traitée expose l''acquéreur, la prescription en matière '
'd''urbanisme ne couvrant pas toutes les situations.'
WHERE code = 'urbanisme';

UPDATE marteau_famille SET note_fixe =
'Le vendeur doit à l''acquéreur une information technique sur l''état du '
'bien, dont l''étendue conditionne la portée de sa garantie. La liste des '
'diagnostics attendus n''est pas la même pour tous les biens : elle se '
'détermine au regard de l''usage résultant du titre et des autorisations, '
'et de la situation du bien au regard des arrêtés préfectoraux applicables. '
'Les diagnostics eux-mêmes ne peuvent être établis que par un '
'professionnel mandaté par le vendeur : cette famille reste ouverte '
'jusqu''à leur réception, et le fait qu''elle le soit n''est pas une '
'anomalie.'
WHERE code = 'diagnostics';

UPDATE marteau_famille SET note_fixe =
'La situation du bien au regard des risques naturels, miniers et '
'technologiques, ainsi que l''état des sols, font l''objet d''une '
'information obligatoire de l''acquéreur. Cette famille rassemble les '
'vérifications faites par l''étude à partir des bases publiques, ainsi que '
'les contraintes administratives pesant sur l''immeuble lui-même. Ces '
'vérifications ne se substituent pas à l''état des risques que le vendeur '
'doit produire : elles servent à le recouper, et une divergence entre les '
'deux appelle une explication.'
WHERE code = 'environnement';

UPDATE marteau_famille SET note_fixe =
'La cession d''un bien occupé transmet à l''acquéreur les droits des '
'occupants et les contrats attachés à l''immeuble. Cette famille examine à '
'quel titre le bien est occupé, si ce titre est transmissible, et quels '
'engagements de durée ou de préavis suivront le bien. Certains droits sont '
'consentis en considération de la personne de leur titulaire et ne se '
'transmettent pas : leur sort doit être réglé avant la cession, non '
'découvert après.'
WHERE code = 'exploitation';

UPDATE marteau_famille SET note_fixe =
'Le coût fiscal de l''opération se détermine à deux niveaux : le régime '
'sous lequel l''actif a été acquis et détenu, qui se lit dans les titres, '
'et le régime applicable à la cession, qui dépend de la qualité du vendeur. '
'Cette famille rassemble les éléments permettant d''anticiper ce coût et '
'les engagements souscrits lors de l''acquisition dont l''inexécution '
'exposerait à un redressement. Elle n''établit aucun calcul : elle '
'identifie ce qui devra être pris en compte dans la détermination du prix '
'net vendeur.'
WHERE code = 'fiscalite';

COMMIT;

-- ---------------------------------------------------------------------
-- Contrôle attendu
-- ---------------------------------------------------------------------
--
--   SELECT numero, code, length(note_fixe) AS caracteres
--     FROM marteau_famille ORDER BY numero;
--
-- Dix lignes, aucune longueur nulle. Les notes tiennent entre 400 et 600
-- caractères, soit quatre à six lignes à l'écran — assez pour justifier
-- la diligence, assez court pour être lu.
