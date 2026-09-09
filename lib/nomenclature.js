// Plan de nommage documentaire et TABLE DE CORRESPONDANCE entre les deux
// axes de familles — LA source, versionnée avec le code (mémo v5 § 15 et
// § 21). Convention de nommage : fiche OUT.IA.2.1.1 v2.
//
// Pourquoi ici et pas en base : c'est un référentiel FIXE. Le mettre en
// base le rendrait modifiable sans revue, et un rangement qui change sans
// commit est un rangement dont personne ne peut dire depuis quand il est
// faux.
//
// ┌───────────────────────────────────────────────────────────────────┐
// │ AVERTISSEMENT — DEUX AXES DE FAMILLES QUI NE COÏNCIDENT PAS       │
// │                                                                   │
// │ Axe d'ANALYSE      : 10 familles de risque, 21 voyants, en base   │
// │                      (marteau_famille, marteau_voyant_ref).       │
// │                      C'est lui qui produit les couleurs.          │
// │ Axe DOCUMENTAIRE   : les codes 010 à 100, qui rangent les pièces  │
// │                      et composent le nom de fichier.              │
// │                                                                   │
// │ Les familles 2 et 3 sont INVERSÉES entre les deux axes :          │
// │   analyse 2 = désignation   ↔  documentaire 030 = cadastre        │
// │   analyse 3 = propriété     ↔  documentaire 020 = titres         │
// │                                                                   │
// │ NE JAMAIS déduire un code documentaire d'un famille.numero × 10.  │
// │ C'est le piège le plus coûteux de la nomenclature : il ne se voit │
// │ qu'au moment où une pièce est rangée au mauvais endroit.          │
// └───────────────────────────────────────────────────────────────────┘

// ---------------------------------------------------------------------
// 1. Les dix familles documentaires
// ---------------------------------------------------------------------

export const FAMILLES_DOC = {
  '010': "Identité de la société et pièces sociales",
  '020': "Titres et origine de propriété",
  '030': "Désignation et cadastre",
  '040': "Copropriété et lotissement",
  '050': "Hypothécaire et servitudes",
  '060': "Urbanisme",
  '070': "Diagnostics",
  '080': "Environnement et risques",
  '090': "Exploitation, baux et contrats",
  '100': "Fiscalité",
};

// ---------------------------------------------------------------------
// 2. Les sous-familles
// ---------------------------------------------------------------------
//
// Le code à trois chiffres est une POSITION DANS L'ARBORESCENCE —
// dizaine = famille, unité = sous-famille. Ce n'est pas un matricule de
// document : la même pièce reçue deux fois porte deux fois le même code.
//
// `voyants` est la liste des voyants de l'axe d'ANALYSE que la
// sous-famille alimente. C'est une relation à part entière, pas une
// conséquence du rangement : voir § 4 pour les croisements.
//
// `codes` est la liste des codes lettres admis pour cette sous-famille.
// `visa` à false = la sous-famille n'est JAMAIS visée au rapport d'audit.

export const SOUS_FAMILLES = {
  // ----------------------------------------- 010 identité et pièces sociales
  '011': {
    libelle: "Identité de la société",
    codes: ['KBIS', 'STA', 'SIREN', 'PAPP'],
    voyants: ['identite'],
  },
  '012': {
    libelle: "Nomination et délégations de pouvoir",
    codes: ['NOMM', 'DELE'],
    voyants: ['identite'],
  },
  '013': {
    libelle: "Conformité",
    codes: ['RBE', 'LCB'],
    voyants: ['identite', 'rbe'],
    visa: false, // mémo § 15.3 : le rapport ne vise que 011 et 012.
  },

  // -------------------------------------------- 020 titres et propriété
  '021': {
    libelle: "Titre immédiat",
    codes: ['OP'],
    voyants: ['designation', 'origine', 'servitudes', 'actif'],
  },
  '022': {
    libelle: "Origine trentenaire",
    codes: ['OPA'],
    voyants: ['origine'],
  },
  '023': {
    libelle: "Titres d'occupation dont la société est bénéficiaire",
    codes: ['AOT', 'BE', 'BAC', 'CDP'],
    voyants: ['nature_droit'],
  },

  // ---------------------------------------- 030 désignation et cadastre
  '031': { libelle: "Plan",                    codes: ['PLAN'], voyants: ['designation'] },
  '032': { libelle: "Historique cadastral",    codes: ['CAD'],  voyants: ['designation', 'cadastre_pf'] },
  '033': { libelle: "Extrait de matrice",      codes: ['EM', 'M1'], voyants: ['designation', 'actif'] },
  '034': {
    libelle: "Documents d'arpentage et procès-verbaux de délimitation",
    codes: ['ARP', 'PVD'],
    voyants: ['designation'],
  },

  // ------------------------------------ 040 copropriété et lotissement
  '041': {
    libelle: "Lotissement",
    codes: ['CDC', 'ARL'],
    voyants: ['regime', 'zone'],
  },
  '042': {
    libelle: "Copropriété",
    codes: ['RCP', 'EDD', 'EDDRCP', 'PVAG'],
    voyants: ['regime', 'gestion'],
  },

  // ------------------------------------ 050 hypothécaire et servitudes
  '051': {
    libelle: "État hypothécaire",
    codes: ['EHF'],
    voyants: ['inscriptions', 'actif'],
  },
  '052': { libelle: "Servitudes", codes: ['SERV'], voyants: ['servitudes'] },
  '053': {
    libelle: "Mainlevées et remboursements de prêt",
    codes: ['MLV', 'PRET'],
    voyants: ['inscriptions'],
  },

  // ------------------------------------------------------ 060 urbanisme
  '061': {
    libelle: "Règles d'urbanisme",
    codes: ['CUA', 'CUB', 'PLU'],
    // `usage` a été RETIRÉ ici le 09/09/2026 (arbitrage JFD) : le PLU et le
    // certificat d'urbanisme disent le ZONAGE, mais c'est l'AUTORISATION
    // (062) qui définit l'usage et la destination. Ne pas le remettre.
    voyants: ['zone'],
  },
  '062': {
    libelle: "Autorisations d'urbanisme",
    codes: ['PC', 'PCM', 'PA', 'DP', 'PD', 'DAACT', 'NCC'],
    voyants: ['autorisations', 'usage'],
    parAutorisation: true, // voir composerNom : le numéro d'autorisation
  },

  // ---------------------------------------------------- 070 diagnostics
  '071': {
    libelle: "Dossier de diagnostic technique",
    codes: ['DTA', 'DPE', 'CREP', 'ETAT', 'ELEC', 'GAZ', 'CARREZ', 'BOUTIN'],
    voyants: ['diagnostics'],
  },
  '072': {
    libelle: "Anciens diagnostics et autres documents",
    codes: ['DTA', 'DPE', 'CREP', 'ETAT', 'ELEC', 'GAZ', 'CARREZ', 'BOUTIN'],
    voyants: ['diagnostics'],
  },

  // ---------------------------------------- 080 environnement et risques
  '081': { libelle: "État des risques et pollutions", codes: ['ERP'], voyants: ['risques'] },
  '082': {
    libelle: "Arrêtés et mesures de police administrative",
    codes: ['ARRETE'],
    voyants: ['risques', 'bati', 'diagnostics'],
  },
  '083': {
    libelle: "Bases environnementales",
    codes: ['CASIAS', 'BASOL', 'ICPE', 'GEORISQUES'],
    voyants: ['risques'],
  },

  // ------------------------------------- 090 exploitation et contrats
  '091': { libelle: "Baux commerciaux et professionnels", codes: ['BAIL'], voyants: ['exploitation'] },
  '092': { libelle: "Baux d'habitation",                  codes: ['BAIL'], voyants: ['exploitation'] },
  '093': {
    libelle: "Conventions et contrats d'exploitation",
    codes: ['CONV'],
    voyants: ['exploitation'],
  },
  '094': {
    libelle: "Contrats de services attachés à l'immeuble",
    codes: ['CONTRAT'],
    voyants: ['contrats'],
  },
  '095': {
    libelle: "Contrats d'assurance et sinistralité",
    codes: ['ASSUR', 'SINIS'],
    voyants: ['assurance', 'contrats'],
  },

  // ----------------------------------------------------- 100 fiscalité
  '101': { libelle: "Taxe foncière et CFE",          codes: ['TF', 'CFE'], voyants: ['actif'] },
  '102': { libelle: "Fiscalité de la mutation",      codes: ['TVA'],       voyants: ['cession'] },
};

// ---------------------------------------------------------------------
// 3. Les vingt-et-un voyants de l'axe d'analyse
// ---------------------------------------------------------------------
//
// Recopiés du référentiel en base (marteau_voyant_ref) pour que ce
// fichier soit vérifiable seul. `verifier()` s'assure qu'aucun voyant
// n'est orphelin et qu'aucune sous-famille ne pointe vers un voyant
// inexistant.

export const VOYANTS = {
  identite:     { famille: 1,  libelle: "Identité et immatriculation" },
  rbe:          { famille: 1,  libelle: "Cohérence RBE holding / filiales" },
  designation:  { famille: 2,  libelle: "Désignation et recoupement" },
  origine:      { famille: 3,  libelle: "Origine de propriété" },
  cadastre_pf:  { famille: 3,  libelle: "Divergence cadastre / publicité foncière" },
  regime:       { famille: 4,  libelle: "Régime de l'ensemble immobilier" },
  gestion:      { famille: 4,  libelle: "Alertes de gestion" },
  inscriptions: { famille: 5,  libelle: "Inscriptions et prêts" },
  servitudes:   { famille: 5,  libelle: "Servitudes et accès" },
  nature_droit: { famille: 5,  libelle: "Nature du droit détenu" },
  autorisations:{ famille: 6,  libelle: "Autorisations d'urbanisme" },
  zone:         { famille: 6,  libelle: "Organisation de la zone" },
  usage:        { famille: 6,  libelle: "Usage et destination" },
  assurance:    { famille: 6,  libelle: "Assurance construction" },
  diagnostics:  { famille: 7,  libelle: "Dossier de diagnostics techniques" },
  risques:      { famille: 8,  libelle: "Risques et pollution" },
  bati:         { famille: 8,  libelle: "Péril et insalubrité" },
  exploitation: { famille: 9,  libelle: "Occupation et baux" },
  contrats:     { famille: 9,  libelle: "Contrats en cours" },
  actif:        { famille: 10, libelle: "Fiscalité de l'actif" },
  cession:      { famille: 10, libelle: "Fiscalité de la cession" },
};

// ---------------------------------------------------------------------
// 4. Les croisements — à lire avant de toucher au tableau ci-dessus
// ---------------------------------------------------------------------
//
// Ce sont les rattachements qu'on ne devine pas à la lecture des
// libellés. Les supprimer par « simplification » casserait l'analyse
// sans casser aucun test de rangement.
//
// (a) LE TITRE (021) ALIMENTE QUATRE FAMILLES D'ANALYSE — désignation,
//     propriété, servitudes, fiscalité de l'actif. La désignation PART
//     du titre ; le cadastre et la BDNB ne font que le recouper (mémo
//     § 5.2). Une seule pièce déposée doit donc faire bouger quatre
//     voyants.
//
// (b) LE LOTISSEMENT (041) EST RANGÉ EN FAMILLE 4 MAIS SE LIT EN
//     FAMILLE 6. Le cahier des charges et l'arrêté de lotir se classent
//     avec la copropriété, parce que c'est là qu'on va les chercher ;
//     ils alimentent le voyant `zone` (organisation de la zone).
//
// (c) L'ASSURANCE CONSTRUCTION (095) SE COUPE EN DEUX : dommages-ouvrage
//     et décennale → `assurance` (famille 6), croisées avec les permis ;
//     multirisque et sinistralité → `contrats` (famille 9). Le code
//     lettre départage : ASSUR/SINIS ne suffisent pas, il faut le type
//     en clair. En attendant, les deux voyants sont alimentés et
//     l'humain tranche.
//
// (d) L'ÉTAT HYPOTHÉCAIRE (051) SORT EN DOUBLE sur une hypothèque légale
//     du Trésor : `inscriptions` (famille 5) pour la mainlevée à
//     organiser, `actif` (famille 10) pour la cause. PAS de renvoi de
//     l'une vers l'autre (mémo § 5.10).
//
// ARBITRÉ le 09/09/2026 par JFD — les trois rattachements qui étaient une
// lecture de Claude sont désormais tranchés. Conservés ici parce que ce
// sont ceux qu'on serait tenté de « corriger » par erreur :
//   - 021 → `usage` : ÉCARTÉ. L'usage ne se lit pas au titre, il vient du
//     permis. La 021 reste sur ses quatre voyants (designation, origine,
//     servitudes, actif).
//   - 061 → `usage` : ÉCARTÉ pour le même motif. La 061 ne porte que
//     `zone`. C'est la 062 qui alimente `usage`.
//   - 033 → `actif` : RETENU, en plus de `designation`. L'extrait de
//     matrice est d'abord un sujet cadastre, et il porte aussi la valeur
//     locative cadastrale. Le dédoublement est LOGIQUE : un seul fichier
//     physique reste rangé en 033 au Drive, jamais un doublon de pièce.

// ---------------------------------------------------------------------
// 5. Interrogation de la table
// ---------------------------------------------------------------------

const RE_CODE = /^\d{3}$/;

// Famille documentaire d'un code de sous-famille : la DIZAINE.
// 011 → 010, 095 → 090, 101 → 100. Attention au 100 : sa dizaine est
// zéro sur trois chiffres, d'où le traitement à part.
export function familleDe(code) {
  if (!RE_CODE.test(String(code))) return null;
  const n = Number(code);
  if (n >= 101 && n <= 109) return '100';
  const dizaine = Math.floor(n / 10) * 10;
  return String(dizaine).padStart(3, '0');
}

export function sousFamille(code) {
  return SOUS_FAMILLES[String(code)] ?? null;
}

// Les voyants qu'une sous-famille alimente.
export function voyantsAlimentesPar(code) {
  const sf = sousFamille(code);
  if (!sf) return [];
  return sf.voyants.map((v) => ({ voyant: v, famille: VOYANTS[v].famille }));
}

// L'inverse : les sous-familles qui alimentent un voyant. C'est ce qui
// permet de dire au collaborateur QUELLE pièce ferait bouger CE voyant.
export function sousFamillesPour(voyant) {
  return Object.entries(SOUS_FAMILLES)
    .filter(([, sf]) => sf.voyants.includes(voyant))
    .map(([code]) => code);
}

// Les sous-familles visées au rapport d'audit (013 en est exclue).
export function visablesAuRapport() {
  return Object.entries(SOUS_FAMILLES)
    .filter(([, sf]) => sf.visa !== false)
    .map(([code]) => code);
}

// Chemin Drive d'une pièce : il SE DÉDUIT du code, jamais l'inverse. Le
// code appartient à la pièce ; si c'était le dossier qui le portait, une
// pièce mal rangée changerait de code.
export function cheminDrive(code) {
  const fam = familleDe(code);
  const sf = sousFamille(code);
  if (!fam || !sf) return null;
  return [`${fam} ${FAMILLES_DOC[fam]}`, `${code} ${sf.libelle}`];
}

// ---------------------------------------------------------------------
// 6. Composition et lecture du nom de fichier
// ---------------------------------------------------------------------
//
// Ordre : numéro de GROUPE, code à trois chiffres, code lettre, date au
// format AAAAMMJJ en fin de nom (tri chronologique naturel dans chaque
// sous-famille).
//
// La 062 insère en plus le NUMÉRO D'AUTORISATION EN ENTIER, avant le
// code de pièce : on classe par opération de construction, pas par
// catégorie de document — un permis, sa DAACT et son attestation de
// non-contestation forment un dossier qui se lit ensemble.
//
// SÉPARATEUR : le TIRET BAS, tranché par JFD le 09/09/2026 et inscrit à
// la fiche OUT.IA.2.1.1 v2. Écartés : l'espace (fragile en URL et en
// ligne de commande) et le tiret simple (déjà présent dans certains
// numéros d'autorisation). La v1 de la fiche collait le groupe au code
// (« 0042OP »), illisible à quatre blocs.
//
// ATTENTION — SEP est lu par composerNom ET par analyserNom. Changer
// cette constante seule ne suffit PAS : la lecture inverse découpait le
// nom sur l'espace en dur, ce qui cassait tout le rangement dès que le
// séparateur changeait. Les deux sont désormais liés à SEP.
//
// COROLLAIRE pour la 062 : le numéro d'autorisation ne doit contenir NI
// espace NI tiret bas parasite — on écrit PC05935026A0042, pas
// « PC 059 350 26 A0042 ». normaliserAutorisation s'en charge.
const SEP = '_';

export function composerNom({ groupe, code, piece, date, autorisation }) {
  const sf = sousFamille(code);
  if (!sf) throw new Error(`code de sous-famille inconnu : ${code}`);
  if (!sf.codes.includes(piece)) {
    throw new Error(`code de pièce ${piece} non admis en ${code} (admis : ${sf.codes.join(', ')})`);
  }
  if (sf.parAutorisation && !autorisation) {
    throw new Error(`la sous-famille ${code} exige un numéro d'autorisation`);
  }
  const blocs = [String(groupe).padStart(4, '0'), String(code)];
  if (sf.parAutorisation) blocs.push(normaliserAutorisation(autorisation));
  blocs.push(piece, normaliserDate(date));
  return blocs.join(SEP);
}

// Lecture inverse — indispensable au module documents : c'est elle qui
// permet de RANGER une pièce déjà nommée sans redemander son code, et de
// repérer celles qui ne respectent pas le plan.
export function analyserNom(nom) {
  const brut = String(nom).trim();
  const blocs = brut.split(SEP);
  if (blocs.length < 4) {
    // Les fichiers antérieurs au 09/09/2026 ne sont PAS repris (clause de
    // non-rétroactivité, fiche § 1.1). On les distingue quand même d'un
    // nom simplement illisible, pour que le module documents puisse le
    // dire à l'écran au lieu d'afficher un échec muet.
    if (brut.split(/\s+/).length >= 4) {
      return { conforme: false, motif: 'nom sous l\'ancienne convention (séparateur espace)' };
    }
    return { conforme: false, motif: 'moins de quatre blocs' };
  }
  const [groupe, code] = blocs;
  const date = blocs[blocs.length - 1];
  if (!/^\d{4}$/.test(groupe)) return { conforme: false, motif: 'numéro de groupe absent ou mal formé' };
  if (!RE_CODE.test(code)) return { conforme: false, motif: 'code de sous-famille absent ou mal formé' };
  const sf = sousFamille(code);
  if (!sf) return { conforme: false, motif: `sous-famille ${code} inconnue` };
  if (!/^\d{8}$/.test(date)) return { conforme: false, motif: 'date absente ou hors format AAAAMMJJ' };
  const milieu = blocs.slice(2, -1);
  const piece = milieu[milieu.length - 1];
  const autorisation = sf.parAutorisation ? milieu.slice(0, -1).join(SEP) || null : null;
  if (!sf.codes.includes(piece)) {
    return { conforme: false, motif: `code de pièce ${piece} non admis en ${code}` };
  }
  return {
    conforme: true,
    groupe, code, piece, date, autorisation,
    famille: familleDe(code),
    voyants: voyantsAlimentesPar(code),
    chemin: cheminDrive(code),
  };
}

// Le numéro d'autorisation est écrit EN ENTIER (choix de lisibilité), mais
// il ne peut porter aucun séparateur sous peine de rendre le nom
// indécoupable. On retire espaces, tirets et tirets bas : PC 059 350 26
// A0042 → PC05935026A0042.
function normaliserAutorisation(a) {
  const s = String(a).replace(/[\s_-]/g, '').toUpperCase();
  if (!s) throw new Error(`numéro d'autorisation illisible : ${a}`);
  return s;
}

function normaliserDate(d) {
  if (d instanceof Date) {
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  }
  const s = String(d).replace(/[^0-9]/g, '');
  if (s.length !== 8) throw new Error(`date illisible : ${d}`);
  return s;
}

// ---------------------------------------------------------------------
// 7. Arborescence Drive créée d'avance
// ---------------------------------------------------------------------
//
// Les GRANDES CATÉGORIES sont intangibles : elles restent même vides,
// c'est le repère visuel de consultation. Les sous-familles sont du
// confort de consultation et sont ÉLAGABLES — l'élagage est cosmétique
// et ne dit rien à l'audit.
//
// LIVRABLES est à part : c'est ce que l'étude PRODUIT (rapports,
// documents d'écarts, tableaux de concordance), pas ce qu'elle collecte.

export function arborescence({ elaguer = [] } = {}) {
  const arbre = Object.entries(FAMILLES_DOC).map(([fam, libelle]) => ({
    nom: `${fam} ${libelle}`,
    intangible: true,
    enfants: Object.entries(SOUS_FAMILLES)
      .filter(([code]) => familleDe(code) === fam && !elaguer.includes(code))
      .map(([code, sf]) => ({ nom: `${code} ${sf.libelle}`, intangible: false })),
  }));
  arbre.push({ nom: 'LIVRABLES', intangible: true, enfants: [] });
  return arbre;
}

// Nom du dossier Drive d'un audit : référence en tête pour que le tri
// alphabétique soit chronologique, dénomination derrière pour l'œil.
export function nomDossierDrive(reference, denomination) {
  return `${reference} - ${denomination}`;
}

// ---------------------------------------------------------------------
// 8. Vérification de cohérence
// ---------------------------------------------------------------------
//
// À appeler depuis /api/sante : un voyant orphelin est une pièce que
// personne ne demandera jamais, et le défaut est silencieux — le rapport
// sort, simplement il ne dit rien sur ce voyant.

export function verifier() {
  const anomalies = [];

  for (const [code, sf] of Object.entries(SOUS_FAMILLES)) {
    if (!familleDe(code)) anomalies.push(`${code} : famille indéterminable`);
    if (!sf.voyants?.length) anomalies.push(`${code} : n'alimente aucun voyant`);
    for (const v of sf.voyants ?? []) {
      if (!VOYANTS[v]) anomalies.push(`${code} : voyant « ${v} » inconnu du référentiel`);
    }
    if (!sf.codes?.length) anomalies.push(`${code} : aucun code lettre admis`);
  }

  for (const v of Object.keys(VOYANTS)) {
    if (sousFamillesPour(v).length === 0) {
      anomalies.push(`voyant « ${v} » (famille ${VOYANTS[v].famille}) : aucune sous-famille ne l'alimente`);
    }
  }

  return {
    sain: anomalies.length === 0,
    familles: Object.keys(FAMILLES_DOC).length,
    sous_familles: Object.keys(SOUS_FAMILLES).length,
    voyants: Object.keys(VOYANTS).length,
    anomalies,
  };
}
