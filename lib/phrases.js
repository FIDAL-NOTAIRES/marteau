// Bibliothèque des phrases pré-écrites — LA source, versionnée avec le
// code. La base ne garde que le code du bloc et les valeurs à substituer
// (marteau_voyant.phrase_code, marteau_voyant.precisions).
//
// Pourquoi ici et pas en base : c'est une bibliothèque FIXE, sans
// génération libre (mémo § 7.1). Un texte modifiable sans revue serait
// une phrase modifiable sans que personne le voie. Ici, toute retouche
// passe par un commit.
//
// Chaque bloc porte : la famille (1-10), le voyant de cette famille, la
// couleur, et le texte. Les crochets {nom} sont substitués par les
// précisions du voyant. Une précision manquante laisse le crochet
// visible — VOLONTAIREMENT : un rapport avec « [précision] » se voit à
// la relecture, un rapport avec un trou ne se voit pas.
//
// Règle du 04/09/2026 : jamais un simple « aucun élément relevé ». Quand
// une vérification n'a pas pu être faite, la RAISON est dans la phrase.

export const PHRASES = {
  // ---------------------------------------------------- 1. identité
  identite_canard: { famille: 1, voyant: 'identite', couleur: 'canard',
    texte: "L'identité de la société propriétaire a été vérifiée sur la base de l'extrait K-bis obtenu par l'étude et des données du registre national des entreprises. Dénomination, SIREN, forme sociale, siège et représentation légale sont concordants." },
  identite_attente: { famille: 1, voyant: 'identite', couleur: 'jaune',
    texte: "La vérification de l'identité de la société est en cours, dans l'attente de la réception de l'extrait K-bis sollicité par l'étude à la date du {date}." },
  // Variante SANS DATE (08/11/2026) : le K-bis n'a pas de ligne au
  // registre des pièces, aucune date de demande n'est donc connue. Dater
  // la phrase du jour de l'analyse affirmait une diligence non faite.
  identite_a_solliciter: { famille: 1, voyant: 'identite', couleur: 'jaune',
    texte: "La vérification de l'identité de la société est en cours, dans l'attente de l'extrait K-bis, à obtenir par l'étude." },
  identite_procedure: { famille: 1, voyant: 'identite', couleur: 'orange',
    texte: "L'extrait K-bis fait apparaître une procédure ou une formalité en cours — {precision} — dont l'incidence sur la capacité de la société à disposer du bien reste à analyser." },
  identite_discordance: { famille: 1, voyant: 'identite', couleur: 'carmin',
    texte: "Une discordance est relevée entre la société désignée comme propriétaire au titre et la société immatriculée sous le SIREN {siren}." },
  identite_cessee: { famille: 1, voyant: 'identite', couleur: 'orange',
    texte: "La société auditée est déclarée cessée
