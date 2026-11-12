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
import { lirePiece, LECTURE_VERSION, extraitsClauses } from '../lib/lecture.js';
import { journaliserAnonymisation } from '../lib/google.js';
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
      // 10/11/2026 — essai du raccordement au journal de l'anonymisation
      // (tableur du Drive de JFD, compte de service) : une ligne « ESSAI ».
      if (String(q.essai_journal ?? '') === '1') {
        const u = await journaliserAnonymisation({ outil: 'MARTEAU', type: 'ESSAI', fichier: 'essai de raccordement', elements_retires: 0, version: '—' });
        return res.status(200).json({ ok: true, ecrit: u });
      }
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
      case 'lire':       return await lire(res, corps);
      case 'clauses':    return await clauses(res, corps);
      case 'journal_anonymisation': {
        // Ligne rendue par la bibliothèque d'anonymisation (r.journal),
        // inscrite au tableur du Drive. Rien d'autre n'est accepté.
        const l = corps.ligne || {};
        const u = await journaliserAnonymisation({
          date: l.date, outil: String(l.outil || 'MARTEAU').slice(0, 40), type: String(l.type || '').slice(0, 40),
          fichier: String(l.fichier || '').slice(0, 200), elements_retires: l.elements_retires,
          detail: l.detail && typeof l.detail === 'object' ? l.detail : null, version: String(l.version || '').slice(0, 20),
        });
        return res.status(200).json({ ok: true, ecrit: u });
      }
      case 'inventaire': return await inventaire(res, {
        dossier: String(corps.dossier ?? '').trim(),
        groupe: corps.groupe ? Number(corps.groupe) : null,
        bac: Boolean(corps.bac),
      });
      default:
        return res.status(400).json({
          erreur: 'action attendue : deposer | classer | renommer | lire | inventaire',
        });
    }
  } catch (e) {
    console.error('[MARTEAU] documents', e);
    return res.status(500).json({ erreur: e.message });
  }
}

// =====================================================================
// lire (10/11/2026)
// =====================================================================
//
// Lecture AU DÉPÔT, découplée du Drive (arbitrage de JFD du 09/11/2026) :
// le navigateur extrait le texte de la pièce qu'il a sous la main (pdf.js)
// et l'envoie ici avec l'identifiant du document déposé. Le fichier
// lui-même ne transite pas. Le résultat va dans marteau_document.lecture ;
// le texte n'est PAS conservé (seul le Drive garde la pièce).
//
// Cache par empreinte : une pièce identique déjà lue (même version du
// socle) n'est pas relue, son résultat est recopié.

const TEXTE_MAX = 300000; // caractères ; au-delà, la fin est ignorée et on le dit

async function lire(res, corps) {
  const sql = db();
  const id = Number(corps.document);
  const qui = String(corps.qui ?? '').trim();
  if (!Number.isInteger(id)) return res.status(400).json({ erreur: 'document requis' });
  if (!qui) return res.status(400).json({ erreur: 'qui requis' });

  const [doc] = await sql`
    SELECT id, dossier_id, empreinte, nom_depose FROM marteau_document WHERE id = ${id}
  `;
  if (!doc) return res.status(404).json({ erreur: `document ${id} inconnu` });

  let lecture = null;
  const [deja] = await sql`
    SELECT lecture FROM marteau_document
     WHERE empreinte = ${doc.empreinte} AND id <> ${doc.id}
       AND lecture IS NOT NULL AND (lecture->>'version')::int = ${LECTURE_VERSION}::int
     ORDER BY lu_le DESC LIMIT 1
  `;
  if (deja) {
    lecture = { ...deja.lecture, recopiee: true };
  } else if (corps.format_non_lu) {
    lecture = { version: LECTURE_VERSION, statut: 'format_non_lu', nature: { code: 'non_reconnue', libelle: 'Format non lu' },
      format: String(corps.format_non_lu).slice(0, 40) };
  } else {
    let texte = String(corps.texte ?? '');
    const tronque = texte.length > TEXTE_MAX;
    if (tronque) texte = texte.slice(0, TEXTE_MAX);
    const pages = Number.isInteger(Number(corps.pages)) && Number(corps.pages) > 0 ? Number(corps.pages) : null;
    lecture = lirePiece(texte, { pages });
    if (tronque) lecture.tronque = true;
  }

  await sql`UPDATE marteau_document SET lecture = ${JSON.stringify(lecture)}::jsonb, lu_le = now() WHERE id = ${doc.id}`;
  await journaliser(doc.dossier_id, qui.toUpperCase(), 'pièce lue', {
    document: Number(doc.id), nom: doc.nom_depose, statut: lecture.statut,
    nature: lecture.nature ? lecture.nature.code : null, recopiee: Boolean(lecture.recopiee),
  });
  // 11/11/2026 — étape B : les passages des clauses repérées sont rendus au
  // navigateur (jamais conservés), pour anonymisation puis envoi à Claude
  // sur validation de JFD.
  const extraits = lecture.statut === 'lue' && lecture.nature && lecture.nature.code === 'bail'
    ? extraitsClauses(String(corps.texte ?? '').slice(0, TEXTE_MAX)) : [];
  return res.status(200).json({ document: Number(doc.id), lecture, extraits });
}

// =====================================================================
// clauses (11/11/2026) — sens des clauses par Claude
// =====================================================================
//
// Modèle validé par JFD le 10/11/2026, calqué sur FUSION : le code a lu ce
// qu'il pouvait ; seuls les passages des clauses repérées partent, APRÈS
// anonymisation dans le navigateur (bibliothèque commune), avec compteur et
// coût estimé affichés, et sur VALIDATION DE JFD SEUL. Claude rend des
// données structurées, jamais une couleur : les règles restent en code.

const MODELE = 'claude-sonnet-5-5';
const CONSIGNE = `Tu lis des extraits anonymisés de baux français pour un office notarial.
Réponds UNIQUEMENT par un objet JSON, sans texte autour, de la forme :
{"indexation":{"present":true|false,"periodicite":"annuelle"|"triennale"|"autre"|null,"indice":"ILC"|"ILAT"|"ICC"|"IRL"|null,"trimestre_reference":"4T2018"|null,"plafond_ou_plancher":true|false,"resume":"…"},
 "changement_controle":{"present":true|false,"effet":"resiliation"|"agrement"|"information"|"autre"|null,"resume":"…"},
 "droit_preference":{"present":true|false,"fondement":"legal"|"contractuel"|null,"exclu_ou_renonce":true|false,"resume":"…"}}
Règles : n'invente rien ; si une clause n'est pas dans les extraits, "present":false et "resume":"" ; chaque résumé tient en une phrase française, sans nom de personne.`;

async function clauses(res, corps) {
  const sql = db();
  const id = Number(corps.document);
  const qui = String(corps.qui ?? '').trim().toUpperCase();
  if (!Number.isInteger(id)) return res.status(400).json({ erreur: 'document requis' });
  if (qui !== 'JFD') return res.status(403).json({ erreur: "l'envoi à Claude est réservé à JFD" });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ erreur: 'ANTHROPIC_API_KEY absente des variables Vercel' });
  const extraits = Array.isArray(corps.extraits) ? corps.extraits.slice(0, 6) : [];
  const anonym = corps.anonymisation || {};
  if (!extraits.length) return res.status(400).json({ erreur: 'aucun extrait' });
  if (!anonym.version) return res.status(400).json({ erreur: "extraits non anonymisés : envoi refusé" });

  const [doc] = await sql`SELECT id, dossier_id, nom_depose, lecture FROM marteau_document WHERE id = ${id}`;
  if (!doc) return res.status(404).json({ erreur: `document ${id} inconnu` });

  const texte = extraits.map((e) => `--- ${String(e.clause || '').slice(0, 40)} ---\n${String(e.texte || '').slice(0, 4000)}`).join('\n\n');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODELE, max_tokens: 1200, system: CONSIGNE, messages: [{ role: 'user', content: texte }] }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return res.status(502).json({ erreur: 'Claude : ' + ((d.error && d.error.message) || r.status) });
  const brut = (d.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').replace(/```json|```/g, '').trim();
  let analyse;
  try { analyse = JSON.parse(brut); } catch { return res.status(502).json({ erreur: 'réponse de Claude illisible', brut: brut.slice(0, 500) }); }

  const usage = d.usage || {};
  const cout = Math.round(((usage.input_tokens || 0) * 2 + (usage.output_tokens || 0) * 10) / 1e6 * 10000) / 10000;
  const lecture = { ...(doc.lecture || {}), clauses_analyse: {
    ...analyse, modele: MODELE, le: new Date().toISOString(),
    anonymisation: { version: String(anonym.version).slice(0, 20), type: String(anonym.type || '').slice(0, 40) },
    jetons: { entree: usage.input_tokens || 0, sortie: usage.output_tokens || 0 }, cout_dollars: cout,
  } };
  await sql`UPDATE marteau_document SET lecture = ${JSON.stringify(lecture)}::jsonb WHERE id = ${doc.id}`;
  await journaliser(doc.dossier_id, qui, 'clauses lues par Claude', {
    document: Number(doc.id), nom: doc.nom_depose, modele: MODELE, extraits: extraits.length,
    jetons: lecture.clauses_analyse.jetons, cout_dollars: cout, anonymisation: lecture.clauses_analyse.anonymisation,
  });
  return res.status(200).json({ document: Number(doc.id), analyse: lecture.clauses_analyse });
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

  let [g] = await sql`
    SELECT id, numero, nom FROM marteau_groupe
     WHERE dossier_id = ${d.id} AND numero = ${numeroGroupe}
     ORDER BY id LIMIT 1
  `;
  // 10/11/2026 — arbitrage du 10/09 : une pièce déposée AVANT la validation
  // des unités foncières prend le numéro de groupe 0000 et sera renommée
  // quand la numérotation définitive tombera. Aucun écran ne crée encore
  // les groupes : le groupe provisoire 0 est donc créé au premier dépôt.
  if (!g && numeroGroupe === 0) {
    [g] = await sql`
      INSERT INTO marteau_groupe (dossier_id, nom, numero)
      VALUES (${d.id}, 'Groupe provisoire (avant validation des unités foncières)', 0)
      RETURNING id, numero, nom
    `;
  }
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

  // 10/11/2026 — la liste des groupes, pour le choix du groupe au dépôt.
  const groupes = await sql`
    SELECT numero, nom FROM marteau_groupe WHERE dossier_id = ${d.id} ORDER BY numero, id
  `;

  const lignes = await sql`
    SELECT dc.id, dc.nom_depose, dc.nom_range, dc.code, dc.piece, dc.date_piece,
           dc.role, dc.parent_id, dc.statut, dc.octets, dc.drive_id, dc.drive_chemin,
           dc.depose_par, dc.depose_le, dc.lecture, dc.lu_le,
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
    groupes: groupes.map((g) => ({ numero: g.numero, nom: g.nom })),
    // 10/11/2026 — toutes les pièces déposées avec leur lecture, pour la
    // liste « Pièces déposées » de la page du dossier.
    deposees: lignes.map((l) => ({
      document: Number(l.id), nom: l.nom_depose, groupe: l.groupe_numero, statut: l.statut,
      depose_par: l.depose_par, depose_le: l.depose_le, lu_le: l.lu_le, lecture: l.lecture || null,
    })),
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
