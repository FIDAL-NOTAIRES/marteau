// MARTEAU — lib/lecture.js — SOCLE DE LECTURE DES PIÈCES (10/11/2026)
//
// Chaîne validée par JFD le 09/11/2026 :
//   1) le CODE extrait le texte (côté navigateur, pdf.js), reconnaît la
//      nature de la pièce et relève ce qui se lit sûrement : dates,
//      montants, numéros, références cadastrales ;
//   2) ANONYMISATION (brique commune), puis
//   3) CLAUDE, seulement pour ce que le code ne lit pas sûrement — il rend
//      des données, jamais une couleur ;
//   4) les RÈGLES s'appliquent en code (api/analyser.js) et posent les
//      voyants.
// Ce fichier porte l'étape 1. Les étapes 2 et 3 viendront avec les baux.
//
// Principe : on ne devine pas. Un champ qu'aucun motif sûr ne donne reste
// NUL, et la règle dit alors « lecture partielle », jamais un résultat.
// Une pièce sans couche de texte (numérisation) est signalée telle quelle.

export const LECTURE_VERSION = 3; // 2 : baux et quittances (10/11/2026) ; 3 : titre de propriété reconnu (13/11/2026)

// ---------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------

export function plat(s) {
  return String(s ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[’']/g, "'")
    .toUpperCase();
}

// Dénomination comparable : sans accents, sans ponctuation, sans forme
// sociale (SCI, SAS…) ni article. Sert à rapprocher un souscripteur d'une
// société du périmètre sans faire dépendre le résultat d'une virgule.
const FORMES = /\b(SOCIETE CIVILE IMMOBILIERE|SOCIETE PAR ACTIONS SIMPLIFIEE|SOCIETE A RESPONSABILITE LIMITEE|SOCIETE ANONYME|SOCIETE EN NOM COLLECTIF|SOCIETE CIVILE|SCI|SCCV|SAS|SASU|SARL|EURL|SA|SNC|SC|SCPI|STE|SOCIETE|LA|LE|LES|L|DE|DU|DES|D|ET)\b/g;
export function denomComparable(s) {
  return plat(s).replace(/[^A-Z0-9 ]/g, ' ').replace(FORMES, ' ').replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------
// Reconnaissance de la nature
// ---------------------------------------------------------------------
//
// Chaque nature porte des indices FORTS (une seule occurrence suffit à
// la désigner) et des indices d'appoint. La nature retenue est celle du
// meilleur score ; en dessous du seuil, la pièce reste « non reconnue » —
// le collaborateur la qualifie, comme au bac à qualifier.

const NATURES = [
  // 13/11/2026 — reconnu pour être rapproché du registre ; la LECTURE du
  // contenu d'un titre (désignation, origine) n'est pas encore codée.
  { code: 'titre_propriete', libelle: 'Titre de propriété', sous_famille: '021',
    forts: [/ACTE DE VENTE/, /ATTESTATION (IMMOBILIERE|DE PROPRIETE)/, /ORIGINE DE PROPRIETE/, /ACTE D'ACQUISITION/],
    appoint: [/VENDEUR/, /ACQUEREUR/, /DESIGNATION/, /\bPRIX\b/, /NOTAIRE/, /PUBLICITE FONCIERE/, /EFFET RELATIF/] },
  { code: 'assurance_immeuble', libelle: "Attestation d'assurance de l'immeuble", sous_famille: '095',
    forts: [/ATTESTATION D'ASSURANCE/, /MULTIRISQUE(S)? (IMMEUBLE|PROFESSIONNELLE|BUREAUX|HABITATION)/, /PROPRIETAIRE NON OCCUPANT/],
    appoint: [/ASSUREUR/, /SOUSCRIPTEUR/, /\bASSURE\b/, /POLICE/, /CONTRAT N/, /GARANTIES?/, /INCENDIE/, /DEGATS? DES EAUX/, /RESPONSABILITE CIVILE/, /PERIODE DE VALIDITE|VALABLE (DU|JUSQU)/] },
  { code: 'dommages_ouvrage', libelle: 'Attestation dommages-ouvrage', sous_famille: '095',
    forts: [/DOMMAGES?[- ]OUVRAGE/], appoint: [/DECENNALE/, /CHANTIER/, /MAITRE D'OUVRAGE/] },
  { code: 'bail', libelle: 'Bail', sous_famille: '091',
    forts: [/BAIL COMMERCIAL/, /BAIL PROFESSIONNEL/, /BAIL D'HABITATION/, /CONTRAT DE LOCATION/, /BAIL EN DATE/],
    appoint: [/BAILLEUR/, /PRENEUR/, /LOYER/, /DEPOT DE GARANTIE/, /INDEXATION|INDICE/, /DESTINATION DES LIEUX/] },
  { code: 'quittance', libelle: 'Quittance ou avis d\u2019échéance de loyer', sous_famille: '091',
    forts: [/QUITTANCE DE LOYER/, /AVIS D'ECHEANCE/], appoint: [/LOYER/, /CHARGES/, /PERIODE/] },
  { code: 'pv_ag_copro', libelle: "Procès-verbal d'assemblée générale de copropriété", sous_famille: '042',
    forts: [/PROCES[- ]VERBAL DE L'ASSEMBLEE GENERALE/, /ASSEMBLEE GENERALE (ORDINAIRE|EXTRAORDINAIRE) DES COPROPRIETAIRES/],
    appoint: [/SYNDIC/, /RESOLUTION/, /TANTIEMES|MILLIEMES/, /COPROPRIETAIRES/] },
  { code: 'reglement_copro', libelle: 'Règlement de copropriété et état descriptif', sous_famille: '042',
    forts: [/REGLEMENT DE COPROPRIETE/, /ETAT DESCRIPTIF DE DIVISION/], appoint: [/LOT N/, /PARTIES COMMUNES/, /TANTIEMES|MILLIEMES/] },
  { code: 'permis', libelle: "Arrêté d'autorisation d'urbanisme", sous_famille: '062',
    forts: [/PERMIS DE CONSTRUIRE/, /DECLARATION PREALABLE/, /PERMIS D'AMENAGER/],
    appoint: [/ARRETE/, /LE MAIRE/, /CODE DE L'URBANISME/, /\bPC ?\d{3}/] },
  { code: 'daact', libelle: "Déclaration attestant l'achèvement et la conformité", sous_famille: '062',
    forts: [/DECLARATION ATTESTANT L'ACHEVEMENT/, /\bDAACT\b/, /CERTIFICAT DE CONFORMITE/, /NON[- ]CONTESTATION DE LA CONFORMITE/], appoint: [/ACHEVEMENT/] },
  { code: 'certificat_urbanisme', libelle: "Certificat d'urbanisme", sous_famille: '061',
    forts: [/CERTIFICAT D'URBANISME/], appoint: [/L\.? ?410-1/, /DROIT DE PREEMPTION/] },
  { code: 'etat_risques', libelle: 'État des risques', sous_famille: '081',
    forts: [/ETAT DES RISQUES/, /ERRIAL|\bERP\b/], appoint: [/PLAN DE PREVENTION/, /SISMICITE/, /RADON/] },
  { code: 'dpe', libelle: 'Diagnostic de performance énergétique', sous_famille: '071',
    forts: [/DIAGNOSTIC DE PERFORMANCE ENERGETIQUE/, /\bDPE\b/], appoint: [/CLASSE ENERGIE|ETIQUETTE/, /KWH/] },
  { code: 'amiante', libelle: 'Repérage amiante', sous_famille: '071',
    forts: [/AMIANTE/], appoint: [/REPERAGE/, /DOSSIER TECHNIQUE/] },
  { code: 'kbis', libelle: 'Extrait K-bis', sous_famille: '011',
    forts: [/EXTRAIT KBIS|EXTRAIT K BIS|EXTRAIT D'IMMATRICULATION PRINCIPALE/], appoint: [/GREFFE/, /REGISTRE DU COMMERCE/] },
  { code: 'statuts', libelle: 'Statuts', sous_famille: '011',
    forts: [/\bSTATUTS\b/], appoint: [/OBJET SOCIAL/, /CAPITAL SOCIAL/, /GERANCE|GERANT/, /ARTICLE 1/] },
  { code: 'taxe_fonciere', libelle: 'Avis de taxe foncière', sous_famille: '101',
    forts: [/TAXES? FONCIERES?/], appoint: [/AVIS D'IMPOSITION/, /PROPRIETES BATIES/] },
  { code: 'cfe', libelle: 'Avis de cotisation foncière des entreprises', sous_famille: '101',
    forts: [/COTISATION FONCIERE DES ENTREPRISES/, /\bCFE\b/], appoint: [/AVIS D'IMPOSITION/] },
  { code: 'tableau_amortissement', libelle: "Tableau d'amortissement ou capital restant dû", sous_famille: '053',
    forts: [/TABLEAU D'AMORTISSEMENT/, /CAPITAL RESTANT DU/], appoint: [/ECHEANCE/, /TAUX/, /PRET/] },
  { code: 'mainlevee', libelle: 'Mainlevée', sous_famille: '053',
    forts: [/MAINLEVEE/], appoint: [/INSCRIPTION/, /RADIATION/] },
];

const SEUIL = 3; // un indice fort vaut 3, un indice d'appoint vaut 1

export function reconnaitre(texte) {
  const T = plat(texte).slice(0, 20000); // la nature se lit dans les premières pages
  let meilleure = null;
  for (const n of NATURES) {
    let score = 0;
    const indices = [];
    for (const r of n.forts) if (r.test(T)) { score += 3; indices.push(r.source); }
    for (const r of n.appoint) if (r.test(T)) { score += 1; indices.push(r.source); }
    if (!meilleure || score > meilleure.score) meilleure = { ...n, score, indices };
  }
  if (!meilleure || meilleure.score < SEUIL) return { code: 'non_reconnue', libelle: 'Pièce non reconnue', score: meilleure ? meilleure.score : 0 };
  return { code: meilleure.code, libelle: meilleure.libelle, sous_famille: meilleure.sous_famille, score: meilleure.score };
}

// ---------------------------------------------------------------------
// Motifs sûrs communs
// ---------------------------------------------------------------------

const MOIS = { JANVIER: 1, FEVRIER: 2, MARS: 3, AVRIL: 4, MAI: 5, JUIN: 6, JUILLET: 7, AOUT: 8, SEPTEMBRE: 9, OCTOBRE: 10, NOVEMBRE: 11, DECEMBRE: 12 };
const DATE_NUM = '(\\d{1,2})[/.\\-](\\d{1,2})[/.\\-](\\d{4})';
const DATE_LIT = '(1ER|\\d{1,2}) (JANVIER|FEVRIER|MARS|AVRIL|MAI|JUIN|JUILLET|AOUT|SEPTEMBRE|OCTOBRE|NOVEMBRE|DECEMBRE) (\\d{4})';
const DATE = `(?:${DATE_NUM}|${DATE_LIT})`;

function iso(j, m, a) {
  j = Number(j); m = Number(m); a = Number(a);
  if (!(a >= 1900 && a <= 2100 && m >= 1 && m <= 12 && j >= 1 && j <= 31)) return null;
  const d = new Date(Date.UTC(a, m - 1, j));
  if (d.getUTCMonth() !== m - 1) return null; // 31/02 refusé
  return d.toISOString().slice(0, 10);
}
function dateDe(groupes) {
  // groupes : [jNum, mNum, aNum, jLit, mLit, aLit]
  if (groupes[0]) return iso(groupes[0], groupes[1], groupes[2]);
  if (groupes[3]) return iso(groupes[3] === '1ER' ? 1 : groupes[3], MOIS[groupes[4]], groupes[5]);
  return null;
}

export function dates(T) {
  const r = new RegExp(DATE, 'g');
  const out = [];
  let m;
  while ((m = r.exec(T))) { const d = dateDe(m.slice(1)); if (d) out.push(d); }
  return out;
}

export function refsCadastrales(T) {
  // « section AB n° 123 », « AB 123 », « cadastrée section ZC numéro 45 »
  const r = /SECTION\s+([A-Z0-9]{1,2})\s*(?:N[°O]?|NUMERO|NUMEROS)?\s*(\d{1,4})/g;
  const out = new Set();
  let m;
  while ((m = r.exec(T))) out.add(`${m[1].padStart(2, '0')} ${m[2].padStart(4, '0')}`);
  return [...out].slice(0, 200);
}

export function sirens(T) {
  const r = /\b(\d{3}) ?(\d{3}) ?(\d{3})\b/g;
  const out = new Set();
  let m;
  while ((m = r.exec(T))) {
    const s = m[1] + m[2] + m[3];
    // clé de Luhn : écarte les suites de chiffres qui ne sont pas des SIREN
    let somme = 0;
    for (let i = 0; i < 9; i++) { let c = Number(s[8 - i]); if (i % 2) { c *= 2; if (c > 9) c -= 9; } somme += c; }
    if (somme % 10 === 0) out.add(s);
  }
  return [...out].slice(0, 50);
}

// Ce qui suit un intitulé, sur la même ligne (ou la ligne suivante si
// l'intitulé est seul sur la sienne). Les lignes du texte extrait sont
// conservées par le navigateur, une ligne par ligne visuelle.
function apres(lignes, motif) {
  for (let i = 0; i < lignes.length; i++) {
    const L = lignes[i];
    const m = L.match(motif);
    if (!m) continue;
    let reste = L.slice(m.index + m[0].length).replace(/^[\s:\-–—]+/, '').trim();
    if (!reste && i + 1 < lignes.length) reste = lignes[i + 1].trim();
    if (reste) return reste.slice(0, 200);
  }
  return null;
}

// ---------------------------------------------------------------------
// Attestation d'assurance de l'immeuble
// ---------------------------------------------------------------------
//
// Champs relevés : assureur, numéro de contrat, souscripteur (l'assuré),
// adresse du risque, date de début et date de fin de validité. La règle
// (api/analyser.js) juge : au nom de la société, couvrant les biens du
// dossier, en cours de validité.

const ASSUREURS = ['AXA', 'ALLIANZ', 'GENERALI', 'MMA', 'MAAF', 'GMF', 'GROUPAMA', 'COVEA', 'AVIVA', 'ABEILLE', 'MAIF', 'MACIF',
  'MATMUT', 'SMABTP', 'SMA', 'CHUBB', 'ZURICH', 'AIG', 'HISCOX', 'QBE', 'SWISS LIFE', 'AREAS', 'HELVETIA', 'MUTUELLE DE POITIERS',
  'THELEM', 'CREDIT AGRICOLE ASSURANCES', 'PACIFICA', 'BPCE ASSURANCES', 'SOGESSUR', 'ALBINGIA', 'LLOYD', 'MILLENIUM', 'LEADER UNDERWRITING'];

function lireAssurance(texte) {
  const lignes = texte.split(/\r?\n/).map((l) => plat(l).replace(/\s+/g, ' ').trim()).filter(Boolean);
  const T = lignes.join('\n');
  const champs = {};

  champs.assureur = apres(lignes, /\bASSUREUR\b/) || apres(lignes, /\b(COMPAGNIE|SOCIETE D'ASSURANCES?)\b/)
    || ASSUREURS.find((a) => new RegExp('\\b' + a + '\\b').test(T)) || null;

  const pol = T.match(/(?:POLICE|CONTRAT)\s*(?:D'ASSURANCE\s*)?(?:N[°O]|NUMERO|REF(?:ERENCE)?)\s*[:.]?\s*([A-Z0-9][A-Z0-9\-\/. ]{3,30}[A-Z0-9])/);
  champs.numero_contrat = pol ? pol[1].trim() : null;

  champs.souscripteur = apres(lignes, /\b(SOUSCRIPTEUR|ASSURE|NOM DE L'ASSURE|AU PROFIT DE|ETABLIE AU NOM DE)\b/);

  champs.adresse_risque = apres(lignes, /\b(ADRESSE DU RISQUE|SITUATION DU RISQUE|LIEU DU RISQUE|BIENS? ASSURES?|ADRESSE DES LOCAUX|RISQUE ASSURE|SITUE(E)? AU)\b/);

  // Période : « du JJ/MM/AAAA au JJ/MM/AAAA », « valable jusqu'au … »,
  // « date d'échéance : … ». En l'absence de motif, rien n'est inféré.
  const per = T.match(new RegExp(`\\bDU ${DATE} AU ${DATE}`));
  if (per) {
    champs.date_debut = dateDe(per.slice(1, 7));
    champs.date_fin = dateDe(per.slice(7, 13));
  } else {
    const fin = T.match(new RegExp(`(?:VALABLE JUSQU'AU|JUSQU'AU|DATE D'ECHEANCE|ECHEANCE|EXPIRE LE|FIN DE VALIDITE)\\s*:?\\s*${DATE}`));
    const deb = T.match(new RegExp(`(?:A COMPTER DU|EFFET(?: AU| LE| DU)?|DATE D'EFFET|PRISE D'EFFET)\\s*:?\\s*${DATE}`));
    champs.date_fin = fin ? dateDe(fin.slice(1)) : null;
    champs.date_debut = deb ? dateDe(deb.slice(1)) : null;
  }
  // Tacite reconduction : l'échéance lue n'est pas une fin de couverture.
  champs.tacite_reconduction = /TACITE RECONDUCTION|RECONDUCTIBLE/.test(T);
  return champs;
}

// ---------------------------------------------------------------------
// Baux (10/11/2026) — relevé par le code seul
// ---------------------------------------------------------------------
//
// Champs : bailleur, preneur, nature du bail, date d'effet, durée, échéance
// calculée, loyer annuel, indice et trimestre de référence, dépôt de
// garantie. Clauses REPÉRÉES (présence d'un passage, sans interprétation) :
// indexation, changement de contrôle, droit de préférence. Le sens exact de
// ces passages relèvera de Claude, après anonymisation (étape suivante) ;
// le texte lui-même n'est pas conservé.

const NOMBRES = { UN: 1, DEUX: 2, TROIS: 3, QUATRE: 4, CINQ: 5, SIX: 6, SEPT: 7, HUIT: 8, NEUF: 9, DIX: 10, ONZE: 11, DOUZE: 12, QUINZE: 15, VINGT: 20 };
const FORME = '(?:SCI|SCCV|SAS|SASU|SARL|EURL|SA|SNC|SCP|SELARL|SOCIETE CIVILE IMMOBILIERE|SOCIETE)';

export function montant(chaine) {
  if (!chaine) return null;
  const n = Number(String(chaine).replace(/[\s\u00a0.]/g, '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

function partie(T, role) {
  // « LA SOCIETE SCI DES LILAS …, ci-après dénommée « le Bailleur » »
  const r = new RegExp('(' + FORME + '\\s+[A-Z0-9\'& .\\-]{2,70}?)\\s*[,(](?:(?!CI-APRES|\\bET\\b)[^]){0,400}?CI-APRES[^]{0,40}?' + role, 'g');
  let m, dernier = null;
  while ((m = r.exec(T))) dernier = m[1];
  return dernier ? dernier.replace(/^SOCIETE\s+/, '').replace(/\s+/g, ' ').trim() : null;
}

function dateFin(debut, ans) {
  if (!debut || !ans) return null;
  const [a, m, j] = debut.split('-').map(Number);
  const d = new Date(Date.UTC(a + ans, m - 1, j));
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function extrait(T, motif, rayon = 300) {
  const m = T.match(motif);
  if (!m) return null;
  return { position: m.index };
}

function lireBail(texte) {
  const T = plat(texte).replace(/[ \t]+/g, ' ');
  const c = {};
  c.nature_bail = /BAIL COMMERCIAL|STATUT DES BAUX COMMERCIAUX|L\.? ?145-/.test(T) ? 'commercial'
    : /BAIL PROFESSIONNEL/.test(T) ? 'professionnel'
    : /BAIL D'HABITATION|LOI (?:N° ?)?89-462|6 JUILLET 1989/.test(T) ? 'habitation' : null;
  c.bailleur = partie(T, 'BAILLEUR');
  c.preneur = partie(T, '(?:PRENEUR|LOCATAIRE)');
  const eff = T.match(new RegExp(`(?:A COMPTER DU|PRENDRA EFFET (?:LE|A COMPTER DU)|PRISE D'EFFET(?: LE| AU)?|COMMENCERA A COURIR (?:LE|A COMPTER DU)|DATE D'EFFET)\\s*:?\\s*${DATE}`));
  c.date_effet = eff ? dateDe(eff.slice(1)) : null;
  const dur = T.match(/DUREE (?:DE |D'|EST FIXEE A )?(\d{1,2}|UN|DEUX|TROIS|QUATRE|CINQ|SIX|SEPT|HUIT|NEUF|DIX|ONZE|DOUZE|QUINZE|VINGT)\s*(?:\(\d{1,2}\)\s*)?(?:ANNEES|ANS)\b/);
  c.duree_ans = dur ? (Number(dur[1]) || NOMBRES[dur[1]] || null) : null;
  c.echeance = dateFin(c.date_effet, c.duree_ans);
  const loy = T.match(/LOYER (?:ANNUEL|DE BASE|PRINCIPAL)?[^0-9\n]{0,90}?(\d{1,3}(?:[ .\u00a0]?\d{3})*(?:,\d{1,2})?)\s*(?:€|EUROS?)\s*(HORS TAXES|HT|HC|HORS CHARGES|TTC|TOUTES TAXES)?/);
  c.loyer = loy ? montant(loy[1]) : null;
  c.loyer_mention = loy && loy[2] ? loy[2] : null;
  c.loyer_periode = /LOYER (?:ANNUEL|PAR AN)|PAR AN\b|ANNUELLEMENT/.test(T) ? 'annuel' : (/LOYER MENSUEL|PAR MOIS/.test(T) ? 'mensuel' : null);
  const ind = T.match(/\b(ILC|ILAT|ICC|IRL)\b|INDICE DES LOYERS COMMERCIAUX|INDICE DES LOYERS DES ACTIVITES TERTIAIRES|INDICE DU COUT DE LA CONSTRUCTION|INDICE DE REFERENCE DES LOYERS/);
  c.indice = ind ? (ind[1] || ({ 'INDICE DES LOYERS COMMERCIAUX': 'ILC', 'INDICE DES LOYERS DES ACTIVITES TERTIAIRES': 'ILAT', 'INDICE DU COUT DE LA CONSTRUCTION': 'ICC', 'INDICE DE REFERENCE DES LOYERS': 'IRL' })[ind[0]]) : null;
  const tri = T.match(/(1ER|PREMIER|1|2EME|2E|DEUXIEME|2|3EME|3E|TROISIEME|3|4EME|4E|QUATRIEME|4)\s*(?:ER|E|EME)?\s+TRIMESTRE\s+(?:DE L'ANNEE\s+)?(\d{4})/);
  if (tri) c.trimestre_reference = ({ '1ER': 1, PREMIER: 1, '1': 1, '2EME': 2, '2E': 2, DEUXIEME: 2, '2': 2, '3EME': 3, '3E': 3, TROISIEME: 3, '3': 3, '4EME': 4, '4E': 4, QUATRIEME: 4, '4': 4 })[tri[1]] + 'T' + tri[2];
  const dg = T.match(/DEPOT DE GARANTIE[^0-9\n]{0,120}?(\d{1,3}(?:[ .\u00a0]?\d{3})*(?:,\d{1,2})?)\s*(?:€|EUROS?)/);
  c.depot_garantie = dg ? montant(dg[1]) : null;
  c.clauses = {
    indexation: !!extrait(T, /INDEXATION|ECHELLE MOBILE|REVISION (?:ANNUELLE|TRIENNALE)|VARIERA (?:AUTOMATIQUEMENT|CHAQUE ANNEE)/),
    changement_controle: !!extrait(T, /CHANGEMENT DE CONTROLE|MODIFICATION (?:DU CONTROLE|DE LA REPARTITION DU CAPITAL)|CESSION (?:DE LA MAJORITE|DU CONTROLE)/),
    droit_preference: !!extrait(T, /DROIT DE PREFERENCE|L\.? ?145-46-1|DROIT DE PREEMPTION DU (?:PRENEUR|LOCATAIRE)/)
  };
  return c;
}

// 11/11/2026 — étape B : passages des clauses à faire lire par Claude.
// Rendus au navigateur au moment du dépôt, JAMAIS conservés en base : le
// navigateur les anonymise puis, sur validation de JFD, les envoie.
const CLAUSES = [
  { clause: 'indexation', motif: /INDEXATION|ECHELLE MOBILE|REVISION (?:ANNUELLE|TRIENNALE)|VARIERA (?:AUTOMATIQUEMENT|CHAQUE ANNEE)/ },
  { clause: 'changement_controle', motif: /CHANGEMENT DE CONTROLE|MODIFICATION (?:DU CONTROLE|DE LA REPARTITION DU CAPITAL)|CESSION (?:DE LA MAJORITE|DU CONTROLE)/ },
  { clause: 'droit_preference', motif: /DROIT DE PREFERENCE|L\.? ?145-46-1|DROIT DE PREEMPTION DU (?:PRENEUR|LOCATAIRE)/ },
];
export function extraitsClauses(texte, rayon = 700) {
  const brut = String(texte ?? '');
  // plat() conserve la longueur (une lettre accentuée → une lettre), donc les
  // positions trouvées dans le texte aplati valent dans le texte d'origine.
  const T = plat(brut);
  const out = [];
  for (const c of CLAUSES) {
    const m = T.match(c.motif);
    if (!m) continue;
    const debut = Math.max(0, m.index - 150), fin = Math.min(brut.length, m.index + rayon);
    out.push({ clause: c.clause, texte: brut.slice(debut, fin).replace(/\s+/g, ' ').trim() });
  }
  return out;
}

// Quittance ou avis d'échéance : période, loyer hors charges, total.
function lireQuittance(texte) {
  const T = plat(texte).replace(/[ \t]+/g, ' ');
  const c = {};
  const per = T.match(new RegExp(`(?:PERIODE|POUR LA PERIODE|DU)\\s*:?\\s*(?:DU\\s+)?${DATE}\\s+AU\\s+${DATE}`));
  if (per) { c.periode_debut = dateDe(per.slice(1, 7)); c.periode_fin = dateDe(per.slice(7, 13)); }
  const mois = T.match(/(?:MOIS DE|TERME DE|ECHEANCE DE)\s+(JANVIER|FEVRIER|MARS|AVRIL|MAI|JUIN|JUILLET|AOUT|SEPTEMBRE|OCTOBRE|NOVEMBRE|DECEMBRE)\s+(\d{4})/);
  if (!per && mois) c.periode_debut = iso(1, MOIS[mois[1]], mois[2]);
  const loy = T.match(/LOYER(?: PRINCIPAL| HORS CHARGES| HT| HC)?[^0-9\n]{0,40}?(\d{1,3}(?:[ .\u00a0]?\d{3})*,\d{2})/);
  c.loyer = loy ? montant(loy[1]) : null;
  const tot = T.match(/(?:TOTAL|MONTANT TOTAL|NET A PAYER|SOMME DE)[^0-9\n]{0,40}?(\d{1,3}(?:[ .\u00a0]?\d{3})*,\d{2})/);
  c.total = tot ? montant(tot[1]) : null;
  c.periodicite = /TRIMESTRE|TRIMESTRIEL/.test(T) ? 'trimestrielle' : (/MENSUEL|MOIS DE/.test(T) ? 'mensuelle' : null);
  return c;
}

// ---------------------------------------------------------------------
// Point d'entrée
// ---------------------------------------------------------------------

export function lirePiece(texte, { pages = null } = {}) {
  const brut = String(texte ?? '');
  const utile = brut.replace(/\s+/g, '');
  const parPage = pages ? utile.length / pages : utile.length;
  if (utile.length < 40 || (pages && parPage < 30)) {
    return { version: LECTURE_VERSION, statut: 'sans_texte', nature: { code: 'non_reconnue', libelle: 'Pièce sans texte lisible' },
      pages, caracteres: utile.length };
  }
  const nature = reconnaitre(brut);
  const T = plat(brut);
  const lecture = {
    version: LECTURE_VERSION,
    statut: 'lue',
    nature,
    pages,
    caracteres: utile.length,
    communs: { dates: dates(T).slice(0, 60), references_cadastrales: refsCadastrales(T), sirens: sirens(T) },
    champs: {},
  };
  if (nature.code === 'assurance_immeuble') lecture.champs = lireAssurance(brut);
  else if (nature.code === 'bail') lecture.champs = lireBail(brut);
  else if (nature.code === 'quittance') lecture.champs = lireQuittance(brut);
  return lecture;
}
