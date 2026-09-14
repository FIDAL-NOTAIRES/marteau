// MARTEAU — /api/documents — ROUTE UNIQUE DU MODULE DOCUMENTS
//
// Une seule fonction pour tous les gestes documentaires, comme
// /api/dossier l'est pour le cycle de vie. Motif : le plan Hobby de
// Vercel plafonne à DOUZE fonctions par déploiement. Le regroupement du
// 10/09/2026 a ramené le projet à neuf ; une route par geste (déposer,
// classer, renommer, inventorier) l'aurait aussitôt ramené à treize et
// fait échouer le build à « Deploying outputs », sans message utile.
//
// Ce découpage est une contrainte d'hébergement, pas un choix métier :
// il ne change ni l'analyse ni la collecte, seulement le nombre
// d'adresses par lesquelles on entre.
//
// ---------------------------------------------------------------------
// SURFACE D'APPEL
//
//   GET  /api/documents?dossier=2026-0001            → inventaire complet
//   GET  /api/documents?dossier=2026-0001&groupe=12  → inventaire d'un groupe
//   GET  /api/documents?dossier=2026-0001&bac=1      → seulement le bac à qualifier
//
//   POST /api/documents { action, ... }
//     deposer     { dossier, groupe, fichiers[], qui }
//     classer     { document, code, piece, date, autorisation?, societe?, qui }
//     renommer    { document, code?, piece?, date?, autorisation?, qui }
//     inventaire  { dossier, groupe?, bac? }
//
// `fichiers[]` : { nom, octets, mime?, empreinte } — l'empreinte SHA-256
// est calculée PAR LE NAVIGATEUR avant l'envoi. Le fichier lui-même ne
// transite pas par cette route : elle enregistre ce qu'on sait du
// fichier, le dépôt effectif sur Drive est le second incrément.
//
// ---------------------------------------------------------------------
// CE QUE CETTE ROUTE NE FAIT PAS ENCORE
//
//   — le téléversement réel vers Drive (drive_id reste nul) ;
//   — la scission corps/annexes d'un titre ;
//   — la propagation d'une pièce 010 dans les autres groupes ;
//   — la lecture du contenu.
//
// Les colonnes qui les porteront existent déjà en base (migration 009) :
// c'est voulu, pour ne pas enchaîner deux migrations sur la même table.

import { db, journaliser } from '../lib/db.js';
import {
  FAMILLES_DOC,
  SOUS_FAMILLES,
  ORDRE_FAMILLES,
  familleDe,
  sousFamille,
  cheminDrive,
  composerNom,
  analyserNom,
} from '../lib/nomenclature.js';

const SEP = '_';

// =====================================================================
// Aiguillage
// =====================================================================

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const q = req.query ?? {};
      const ref = String(q.dossier ?? '').trim();
      if (!ref) return res.status(400).json({ erreur: 'dossier requis' });
      return await inventaire(res, {
        dossier: ref,
        groupe: q.groupe ? Number(q.groupe) : null,
        bac: String(q.bac ?? '') === '1',
      });
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ erreur: 'GET ou POST attendu' });
    }

    const corps = req.body ?? {};
    switch (corps.action) {
      case 'deposer':    return await deposer(res, corps);
      case 'classer':    return await classer(res, corps, { renommage: false });
      case 'renommer':   return await classer(res, corps, { renommage: true });
      case 'inventaire': return await inventaire(res, {
        dossier: String(corps.dossier ?? '').trim(),
        groupe: corps.groupe ? Number(corps.groupe) : null,
        bac: Boolean(corps.bac),
      });
      default:
        return res.status(400).json({
          erreur: 'action attendue : deposer | classer | renommer | inventaire',
        });
    }
  } catch (e) {
    console.error('[MARTEAU] documents', e);
    return res.status(500).json({ erreur: e.message });
  }
}

// =====================================================================
// deposer
// =====================================================================
//
// Glisser-déposer multi-fichiers depuis l'écran d'un GROUPE. Le
// collaborateur ne choisit jamais la famille : il pose, MARTEAU propose.
// Rien n'est rangé ici — tout entre au bac à qualifier du groupe, et la
// proposition est rendue à l'écran pour confirmation en un clic.
//
// Le groupe est obligatoire : il n'y a pas de dépôt en vrac au niveau du
// dossier d'audit, parce qu'une pièce sans groupe n'a pas de numéro et
// donc pas de nom.

async function deposer(res, corps) {
  const sql = db();
  const ref = String(corps.dossier ?? '').trim();
  const numeroGroupe = Number(corps.groupe);
  const qui = String(corps.qui ?? '').trim();
  const fichiers = Array.isArray(corps.fichiers) ? corps.fichiers : [];

  if (!ref) return res.status(400).json({ erreur: 'dossier requis' });
  if (!Number.isInteger(numeroGroupe)) return res.status(400).json({ erreur: 'groupe requis' });
  if (!qui) return res.status(400).json({ erreur: 'qui requis' });
  if (!fichiers.length) return res.status(400).json({ erreur: 'aucun fichier' });

  const [d] = await sql`SELECT id, reference FROM marteau_dossier WHERE reference = ${ref}`;
  if (!d) return res.status(404).json({ erreur: `dossier ${ref} inconnu` });

  const [g] = await sql`
    SELECT id, numero, nom FROM marteau_groupe
     WHERE dossier_id = ${d.id} AND numero = ${numeroGroupe}
  `;
  if (!g) return res.status(404).json({ erreur: `groupe ${numeroGroupe} inconnu dans ${ref}` });

  const deposes = [];
  const refuses = [];

  for (const f of fichiers) {
    const nom = String(f?.nom ?? '').trim();
    const octets = Number(f?.octets);
    const empreinte = String(f?.empreinte ?? '').trim().toLowerCase();

    if (!nom || !Number.isFinite(octets) || octets <= 0 || !/^[0-9a-f]{64}$/.test(empreinte)) {
      refuses.push({ nom: nom || '(sans nom)', motif: 'nom, taille ou empreinte illisible' });
      continue;
    }

    // Doublon dans le MÊME groupe. Dans un autre groupe, c'est la
    // duplication voulue de la famille 010 : on ne la bloque pas.
    const [deja] = await sql`
      SELECT id, nom_depose, statut FROM marteau_document
       WHERE groupe_id = ${g.id} AND empreinte = ${empreinte}
    `;
    if (deja) {
      refuses.push({
        nom,
        motif: `déjà présent dans ce groupe sous « ${deja.nom_depose} »`,
        document: Number(deja.id),
      });
      continue;
    }

    const [ins] = await sql`
      INSERT INTO marteau_document
        (dossier_id, groupe_id, nom_depose, octets, mime, empreinte, depose_par)
      VALUES
        (${d.id}, ${g.id}, ${nom}, ${octets}, ${f?.mime ?? null}, ${empreinte}, ${qui})
      RETURNING id
    `;

    deposes.push({
      document: Number(ins.id),
      nom,
      octets,
      proposition: proposer(nom),
    });
  }

  if (deposes.length) {
    await journaliser(d.id, qui, 'documents.deposer', {
      groupe: g.numero,
      nombre: deposes.length,
      noms: deposes.map((x) => x.nom),
    });
  }

  return res.status(200).json({
    dossier: d.reference,
    groupe: { numero: g.numero, nom: g.nom, provisoire: g.numero === 0 },
    deposes,
    refuses,
  });
}

// =====================================================================
// classer / renommer
// =====================================================================
//
// Le renommage a lieu DÈS LE CLASSEMENT, sans attendre validation : un
// fichier qui porte son nom définitif est un fichier qu'on retrouve. Si
// la détection était fausse, la correction produit un SECOND renommage
// et le journal garde les deux noms — c'est la trace qui permet de dire
// plus tard sous quel nom une pièce a circulé.
//
// Une seule fonction sert les deux actions : classer, c'est nommer une
// pièce qui sort du bac ; renommer, c'est la renommer une fois rangée.
// Le traitement est identique, seule la trace au journal diffère.

async function classer(res, corps, { renommage }) {
  const sql = db();
  const id = Number(corps.document);
  const qui = String(corps.qui ?? '').trim();

  if (!Number.isInteger(id)) return res.status(400).json({ erreur: 'document requis' });
  if (!qui) return res.status(400).json({ erreur: 'qui requis' });

  const [doc] = await sql`
    SELECT dc.*, g.numero AS groupe_numero, g.nom AS groupe_nom, d.reference
      FROM marteau_document dc
      JOIN marteau_groupe   g ON g.id = dc.groupe_id
      JOIN marteau_dossier  d ON d.id = dc.dossier_id
     WHERE dc.id = ${id}
  `;
  if (!doc) return res.status(404).json({ erreur: `document ${id} inconnu` });

  if (renommage && doc.statut === 'a_qualifier') {
    return res.status(409).json({
      erreur: 'ce document est encore au bac à qualifier — utiliser classer',
    });
  }

  // Une annexe n'a pas de famille propre : elle emprunte celle du titre,
  // sans aucune exception. Même un DPE annexé, même un règlement de
  // copropriété annexé — le fichier ne bouge jamais de la famille du
  // titre. Seul le FAIT extrait remonte vers la famille concernée, avec
  // renvoi en note. Un fichier, une seule adresse Drive.
  if (doc.role === 'annexe') {
    return await classerAnnexe(res, { sql, doc, qui });
  }

  const code = String(corps.code ?? doc.code ?? '').trim();
  const piece = String(corps.piece ?? doc.piece ?? '').trim().toUpperCase();
  const date = corps.date ?? doc.date_piece;
  const autorisation = corps.autorisation ?? doc.autorisation ?? null;

  const sf = sousFamille(code);
  if (!sf) {
    return res.status(400).json({
      erreur: `code de sous-famille inconnu : ${code || '(vide)'}`,
      admis: Object.keys(SOUS_FAMILLES),
    });
  }
  if (!date) return res.status(400).json({ erreur: 'date de la pièce requise' });

  let nom;
  try {
    nom = composerNom({ groupe: doc.groupe_numero, code, piece, date, autorisation });
  } catch (e) {
    return res.status(400).json({ erreur: e.message, admis: sf.codes });
  }

  const chemin = cheminDrive(code);
  const ancien = doc.nom_range;

  // La société n'est renseignée qu'au classement : c'est elle qui
  // permettra de propager le remplacement d'une pièce 010 dans tous les
  // groupes où elle est dupliquée.
  const societe = corps.societe ? Number(corps.societe) : doc.societe_id;

  await sql`
    UPDATE marteau_document
       SET code = ${code},
           piece = ${piece},
           date_piece = ${normaliserDateSql(date)},
           autorisation = ${autorisation},
           nom_range = ${nom},
           drive_chemin = ${chemin ? chemin.join('/') : null},
           societe_id = ${societe ?? null},
           statut = 'range',
           range_le = now()
     WHERE id = ${doc.id}
  `;

  await journaliser(doc.dossier_id, qui, renommage ? 'documents.renommer' : 'documents.classer', {
    document: Number(doc.id),
    groupe: doc.groupe_numero,
    depose: doc.nom_depose,
    ancien_nom: ancien,
    nouveau_nom: nom,
    code,
    famille: familleDe(code),
  });

  return res.status(200).json({
    document: Number(doc.id),
    nom_range: nom,
    ancien_nom: ancien,
    code,
    famille: `${familleDe(code)} ${FAMILLES_DOC[familleDe(code)]}`,
    sous_famille: sf.libelle,
    chemin,
    provisoire: doc.groupe_numero === 0,
    voyants: sf.voyants ?? [],
    vise_au_rapport: sf.visa !== false,
  });
}

// L'annexe suit son titre : même code à trois chiffres, même date, code
// lettre ANX. On ne redemande rien au collaborateur — tout vient du
// parent, et si le parent est renommé, l'annexe l'est avec lui.
async function classerAnnexe(res, { sql, doc, qui }) {
  const [parent] = await sql`
    SELECT id, code, piece, date_piece, autorisation, nom_range, statut
      FROM marteau_document WHERE id = ${doc.parent_id}
  `;
  if (!parent) return res.status(409).json({ erreur: 'titre parent introuvable' });
  if (parent.statut !== 'range' || !parent.nom_range) {
    return res.status(409).json({ erreur: 'ranger le titre avant son annexe' });
  }

  const nom = nommerAnnexe(parent.nom_range);
  const chemin = cheminDrive(parent.code);
  const ancien = doc.nom_range;

  await sql`
    UPDATE marteau_document
       SET code = ${parent.code},
           piece = 'ANX',
           date_piece = ${parent.date_piece},
           autorisation = ${parent.autorisation},
           nom_range = ${nom},
           drive_chemin = ${chemin ? chemin.join('/') : null},
           statut = 'range',
           range_le = now()
     WHERE id = ${doc.id}
  `;

  await journaliser(doc.dossier_id, qui, 'documents.classer', {
    document: Number(doc.id),
    role: 'annexe',
    titre: Number(parent.id),
    ancien_nom: ancien,
    nouveau_nom: nom,
  });

  return res.status(200).json({
    document: Number(doc.id),
    role: 'annexe',
    nom_range: nom,
    ancien_nom: ancien,
    code: parent.code,
    chemin,
    note: "l'annexe reste dans la famille du titre ; seul le fait extrait remonte ailleurs",
  });
}

// ANX n'est admis par aucune sous-famille — c'est voulu : ce n'est pas
// une nature de pièce mais la moitié d'un fichier. On ne peut donc pas
// passer par composerNom, qui vérifie les codes admis. On reprend le nom
// du titre et on remplace le bloc de pièce, avant-dernier par
// construction (groupe _ code [_ autorisation] _ piece _ date).
function nommerAnnexe(nomDuTitre) {
  const blocs = String(nomDuTitre).split(SEP);
  if (blocs.length < 4) throw new Error(`nom de titre illisible : ${nomDuTitre}`);
  blocs[blocs.length - 2] = 'ANX';
  return blocs.join(SEP);
}

// =====================================================================
// inventaire
// =====================================================================
//
// Ce que le groupe contient, famille par famille, plus ce qui attend au
// bac. Les grandes catégories sont rendues MÊME VIDES : c'est le repère
// visuel de consultation, et une famille absente de l'écran est une
// famille que personne ne pense à remplir.

async function inventaire(res, { dossier, groupe, bac }) {
  const sql = db();
  if (!dossier) return res.status(400).json({ erreur: 'dossier requis' });

  const [d] = await sql`SELECT id, reference FROM marteau_dossier WHERE reference = ${dossier}`;
  if (!d) return res.status(404).json({ erreur: `dossier ${dossier} inconnu` });

  const lignes = await sql`
    SELECT dc.id, dc.nom_depose, dc.nom_range, dc.code, dc.piece, dc.date_piece,
           dc.role, dc.parent_id, dc.statut, dc.octets, dc.drive_id, dc.drive_chemin,
           dc.depose_par, dc.depose_le,
           g.numero AS groupe_numero, g.nom AS groupe_nom
      FROM marteau_document dc
      JOIN marteau_groupe g ON g.id = dc.groupe_id
     WHERE dc.dossier_id = ${d.id}
       AND (${groupe === null} OR g.numero = ${groupe ?? 0})
       AND (${!bac} OR dc.statut = 'a_qualifier')
     ORDER BY g.numero, dc.code NULLS FIRST, dc.date_piece, dc.id
  `;

  const aQualifier = lignes
    .filter((l) => l.statut === 'a_qualifier')
    .map((l) => ({
      document: Number(l.id),
      nom: l.nom_depose,
      octets: Number(l.octets),
      groupe: l.groupe_numero,
      depose_par: l.depose_par,
      depose_le: l.depose_le,
      proposition: proposer(l.nom_depose),
    }));

  const ranges = lignes.filter((l) => l.statut === 'range');

  // ORDRE_FAMILLES et non Object.keys : voir le piège documenté en tête de
  // lib/nomenclature.js — sans lui, la fiscalité sort avant l'identité.
  const familles = ORDRE_FAMILLES.map((fam) => ({
    code: fam,
    libelle: FAMILLES_DOC[fam],
    pieces: ranges
      .filter((l) => familleDe(l.code) === fam)
      .map((l) => ({
        document: Number(l.id),
        nom: l.nom_range,
        depose: l.nom_depose,
        code: l.code,
        piece: l.piece,
        date: l.date_piece,
        role: l.role,
        titre: l.parent_id ? Number(l.parent_id) : null,
        groupe: l.groupe_numero,
        chemin: l.drive_chemin,
        sur_drive: Boolean(l.drive_id),
      })),
  }));

  return res.status(200).json({
    dossier: d.reference,
    groupe,
    total: lignes.length,
    au_bac: aQualifier.length,
    ranges: ranges.length,
    a_qualifier: aQualifier,
    familles,
  });
}

// =====================================================================
// La proposition
// =====================================================================
//
// MARTEAU propose, le collaborateur confirme. Deux voies, dans cet ordre.
//
// 1. LE NOM EST DÉJÀ CONFORME au plan de nommage : on le relit avec
//    analyserNom et on ne devine rien. C'est le cas d'une pièce qui
//    revient d'un autre dossier ou qu'on redépose.
// 2. SINON, on cherche dans le nom d'origine les mots qui trahissent la
//    nature de la pièce.
//
// Cette table de mots est VOLONTAIREMENT courte et grossière. La vraie
// qualification viendra de la lecture du contenu, au second incrément :
// il ne s'agit ici que d'éviter au collaborateur de choisir dans une
// liste de vingt-neuf sous-familles quand le nom du fichier dit déjà
// « DPE » ou « règlement de copropriété ». Une proposition fausse coûte
// un clic ; une proposition absente en coûte trois.

const INDICES = [
  [/\b(kbis|k-bis|extrait\s*k)\b/i,                      '011', 'KBIS'],
  [/\bstatuts?\b/i,                                      '011', 'STA'],
  [/\b(pouvoir|d[ée]l[ée]gation)\b/i,                    '012', 'DELE'],
  [/\b(b[ée]n[ée]ficiaires?\s*effectifs?|rbe)\b/i,       '013', 'RBE'],
  [/\b(acte\s*de\s*vente|attestation\s*de\s*propri[ée]t[ée]|titre)\b/i, '021', 'OP'],
  [/\b(origine\s*(de\s*)?propri[ée]t[ée]|trentenaire)\b/i, '022', 'OPA'],
  [/\b(bail\s*emphyt[ée]otique)\b/i,                     '023', 'BE'],
  [/\b(aot|concession|convention\s*d.occupation)\b/i,    '023', 'AOT'],
  [/\bplan\b/i,                                          '031', 'PLAN'],
  [/\b(historique\s*cadastral|fiche\s*cadastrale)\b/i,  '032', 'CAD'],
  [/\b(relev[ée]\s*de\s*propri[ée]t[ée]|matrice)\b/i,    '033', 'EM'],
  [/\b(arpentage|bornage|proc[èe]s.verbal\s*de\s*d[ée]limitation)\b/i, '034', 'ARP'],
  [/\b(cahier\s*des\s*charges|lotissement)\b/i,         '041', 'CDC'],
  [/\b(r[èe]glement\s*de\s*copropri[ée]t[ée]|edd|[ée]tat\s*descriptif)\b/i, '042', 'RCP'],
  [/\b([ée]tat\s*hypoth[ée]caire|fiche\s*d.immeuble)\b/i, '051', 'EHF'],
  [/\bservitude/i,                                        '052', 'SERV'],
  [/\b(mainlev[ée]e|remboursement\s*de\s*pr[êe]t)\b/i,   '053', 'MLV'],
  [/\b(certificat\s*d.urbanisme|cua|cub)\b/i,            '061', 'CUA'],
  [/\b(plu|pos|r[èe]glement\s*d.urbanisme)\b/i,          '061', 'PLU'],
  [/\b(permis\s*de\s*construire|pc\s*\d)\b/i,           '062', 'PC'],
  [/\b(d[ée]claration\s*pr[ée]alable)\b/i,               '062', 'DP'],
  [/\bdaact\b/i,                                         '062', 'DAACT'],
  [/\b(dpe|diagnostic\s*de\s*performance)\b/i,          '071', 'DPE'],
  [/\b(amiante|dta)\b/i,                                 '071', 'DTA'],
  [/\b(carrez|loi\s*carrez)\b/i,                         '071', 'CARREZ'],
  [/\b([ée]tat\s*des\s*risques|erp|g[ée]orisques)\b/i,  '081', 'ERP'],
  [/\b(arr[êe]t[ée]|p[ée]ril|insalubrit[ée])\b/i,         '082', 'ARRETE'],
  [/\b(casias|basol|icpe)\b/i,                            '083', null],
  [/\b(bail\s*commercial|bail\s*professionnel)\b/i,     '091', 'BAIL'],
  [/\b(bail\s*d.habitation)\b/i,                         '092', 'BAIL'],
  [/\b(assurance|sinistre)\b/i,                           '095', 'ASSUR'],
  [/\b(taxe\s*fonci[èe]re|cfe)\b/i,                      '101', 'TF'],
  [/\bbail\b/i,                                          '091', 'BAIL'],
];

function proposer(nomDepose) {
  const lu = analyserNom(nomDepose);
  if (lu?.conforme) {
    return {
      origine: 'nom conforme au plan',
      code: lu.code,
      piece: lu.piece,
      date: lu.date,
      autorisation: lu.autorisation,
      confiance: 'haute',
    };
  }

  const sansExt = String(nomDepose).replace(/\.[a-z0-9]{2,4}$/i, '');
  for (const [motif, code, piece] of INDICES) {
    if (motif.test(sansExt)) {
      const sf = sousFamille(code);
      return {
        origine: 'nom du fichier',
        code,
        libelle: sf?.libelle ?? null,
        piece: piece && sf?.codes?.includes(piece) ? piece : null,
        date: dateDansLeNom(sansExt),
        confiance: 'faible',
        admis: sf?.codes ?? [],
      };
    }
  }

  return {
    origine: null,
    code: null,
    date: dateDansLeNom(sansExt),
    confiance: 'nulle',
    note: 'à qualifier à la main',
  };
}

// Une date trouvée dans le nom vaut mieux que rien, mais elle ne vaut pas
// preuve : c'est une proposition, que le collaborateur confirme.
function dateDansLeNom(s) {
  const iso = String(s).match(/\b(20\d{2})[-_]?(0[1-9]|1[0-2])[-_]?(0[1-9]|[12]\d|3[01])\b/);
  if (iso) return `${iso[1]}${iso[2]}${iso[3]}`;
  const fr = String(s).match(/\b(0[1-9]|[12]\d|3[01])[-_./](0[1-9]|1[0-2])[-_./](20\d{2})\b/);
  if (fr) return `${fr[3]}${fr[2]}${fr[1]}`;
  return null;
}

// composerNom accepte AAAAMMJJ ; Postgres veut une date. On repasse par
// la forme ISO plutôt que de laisser le pilote deviner.
function normaliserDateSql(d) {
  const s = String(d).replace(/[^0-9]/g, '');
  if (s.length !== 8) throw new Error(`date illisible : ${d}`);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}
