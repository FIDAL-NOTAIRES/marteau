// MARTEAU — /api/dossier — ROUTE UNIQUE DU CYCLE DE VIE D'UN DOSSIER
//
// Fusion du 10/09/2026 de quatre routes : api/dossier.js (ouverture),
// api/etat.js (lecture), api/lever.js (levée de réserve) et
// api/demander.js (pièces). Motif : le plan Hobby de Vercel plafonne à
// DOUZE fonctions par déploiement et la treizième fait échouer le build
// à « Deploying outputs », sans message utile. Le projet était à douze
// sur douze ; cette fusion libère TROIS places, nécessaires à l'écran
// d'accueil et au module Documents.
//
// C'est un regroupement, PAS une réécriture. Chaque action ci-dessous
// est le corps de l'ancienne fonction, déplacé sans changement de
// comportement. Les arbitrages qu'elles portent sont rappelés en tête de
// chaque bloc, parce que c'est précisément ce qu'une fusion fait perdre.
//
// ---------------------------------------------------------------------
// SURFACE D'APPEL
//
//   GET  /api/dossier?dossier=2026-0001      → lecture d'un dossier
//   GET  /api/dossier?liste=1                → dossiers en cours
//   GET  /api/dossier?liste=1&clos=1         → dossiers clos
//
//   POST /api/dossier  { action, ... }
//     ouvrir    { siren, denomination?, associe, collaborateur?, qui }
//     lister    { clos? }
//     lire      { dossier }
//     lever     { dossier, reserve, motif, qui, code? }
//     preparer  { dossier, pieces[], qui }
//     marquer   { dossier, pieces[], qui }
//     saisir    { dossier, pieces[], qui }
//
// COMPATIBILITÉ : un POST sans `action` mais avec `siren` vaut `ouvrir`,
// et les GET de lecture sont inchangés. La façade existante continue donc
// d'ouvrir un dossier et de le relire sans modification. En revanche ses
// appels à /api/lever et /api/demander devront être repointés ici avant
// que ces deux fichiers soient supprimés.
//
// CE FICHIER NE CONTIENT PAS LA CLÔTURE. `clore` vit dans lib/, hors du
// décompte des fonctions : on n'y touche pas.

import { db, journaliser } from '../lib/db.js';
import { rendre } from '../lib/phrases.js';

const estSiren = (v) => /^\d{9}$/.test(String(v ?? ''));
const aujourdhui = () => new Date().toLocaleDateString('fr-FR');
const majuscule = (v) => String(v ?? '').trim().toUpperCase();

// Gravité croissante. Sert deux fois : la couleur d'une famille est la
// plus grave de ses voyants, celle d'un dossier la plus grave de ses
// familles. Jamais une moyenne — une moyenne de voyants ne veut rien dire.
const ORDRE = { canard: 0, jaune: 1, orange: 2, carmin: 3 };

// Destinataires rédigeables. Les mairies n'y sont PAS : la demande mairie
// part commune par commune via l'annuaire de la DILA, avec bascule mail →
// courrier, et c'est une brique à part (mémo § 10.1).
const DESTINATAIRES = {
  client: {
    titre: 'Demande de pièces au client',
    intro: (d) => `Dans le cadre de l'audit du patrimoine immobilier de ${d.denomination_tete ?? d.siren_tete} (dossier ${d.reference}), nous vous remercions de bien vouloir nous communiquer les pièces suivantes :`,
    fin: 'Ces pièces peuvent nous être adressées par retour de courriel. Nous restons à votre disposition pour toute précision.',
  },
  expert_comptable: {
    titre: "Demande de pièces à l'expert-comptable",
    intro: (d) => `Dans le cadre de l'audit du patrimoine immobilier de ${d.denomination_tete ?? d.siren_tete} (dossier ${d.reference}), et afin de déterminer le régime fiscal applicable à une éventuelle cession, nous vous remercions de bien vouloir nous communiquer :`,
    fin: "Ces éléments permettront d'anticiper l'imposition de la plus-value dans la détermination du prix net vendeur. Nous restons à votre disposition.",
  },
};

// =====================================================================
// Aiguillage
// =====================================================================

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const q = req.query ?? {};
      if (String(q.liste ?? '') === '1') {
        return await lister(res, { clos: String(q.clos ?? '') === '1' });
      }
      const ref = String(q.dossier ?? '').trim();
      if (!ref) return res.status(400).json({ erreur: 'dossier requis, ou liste=1' });
      return await lire(res, ref);
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ erreur: 'GET ou POST attendu' });
    }

    const corps = req.body ?? {};
    // Compatibilité : l'ancienne façade poste { siren, associe, qui } sans
    // action. On ne la casse pas.
    const action = corps.action ?? (corps.siren ? 'ouvrir' : null);

    switch (action) {
      case 'ouvrir':   return await ouvrir(res, corps);
      case 'lister':   return await lister(res, { clos: Boolean(corps.clos) });
      case 'lire':     {
        const ref = String(corps.dossier ?? '').trim();
        if (!ref) return res.status(400).json({ erreur: 'dossier requis' });
        return await lire(res, ref);
      }
      case 'lever':    return await lever(res, corps);
      case 'preparer':
      case 'marquer':
      case 'saisir':   return await pieces(res, corps, action);
      default:
        return res.status(400).json({
          erreur: 'action attendue : ouvrir | lister | lire | lever | preparer | marquer | saisir',
        });
    }
  } catch (e) {
    console.error('[MARTEAU] dossier', e);
    return res.status(500).json({ erreur: e.message });
  }
}

// =====================================================================
// ouvrir — ex api/dossier.js
// =====================================================================
//
// Premier geste qui ÉCRIT. Trois choses, dans cet ordre, et l'ordre
// compte pour la piste d'audit :
//   1. le dossier est créé, référence AAAA-NNNN attribuée en base (même
//      forme que MATRICE : une seule logique à retenir) ;
//   2. la RÉSERVE SYSTÉMATIQUE « validation par le notaire associé en
//      charge » est ouverte d'office — c'est elle qui empêche tout
//      définitif sans l'associé, la jauge étant le verrou ;
//   3. l'ouverture est journalisée : première ligne de la chaîne du
//      dossier, souvent la première du journal tout entier.
//
// La collecte n'est PAS lancée ici : l'écran enchaîne par un appel à
// /api/collecter. Si la collecte échoue, le dossier existe quand même —
// c'est voulu, le rapport doit toujours pouvoir sortir.

async function ouvrir(res, { siren, denomination, associe, collaborateur, qui }) {
  if (!estSiren(siren)) return res.status(400).json({ erreur: 'siren requis (9 chiffres)' });
  if (!associe) return res.status(400).json({ erreur: 'associé en charge requis' });

  const auteur = majuscule(qui || collaborateur || associe);
  const sql = db();

  // Un dossier déjà ouvert sur ce SIREN et non clos est repris, pas
  // doublé : l'audit relancé repart de l'état précédent (mémo § 4.6).
  const [existant] = await sql`
    SELECT id, reference FROM marteau_dossier
     WHERE siren_tete = ${siren} AND clos_le IS NULL
     ORDER BY ouvert_le DESC LIMIT 1
  `;
  if (existant) {
    return res.status(200).json({ dossier: existant.reference, repris: true });
  }

  // Référence AAAA-NNNN. Le verrou consultatif évite que deux ouvertures
  // simultanées tirent le même numéro ; le volume (~30 audits par mois)
  // rend son coût nul. NE PAS « simplifier » le WITH v / FROM n, v : la
  // clause de verrou doit rester dans la même transaction que la lecture
  // du maximum, sans quoi deux dossiers peuvent porter la même référence.
  const annee = new Date().getFullYear();
  const [d] = await sql`
    WITH v AS (SELECT pg_advisory_xact_lock(hashtext('marteau_dossier_ref'))),
    n AS (
      SELECT coalesce(max(substring(reference FROM 6)::int), 0) + 1 AS suivant
        FROM marteau_dossier WHERE reference LIKE ${annee + '-%'}
    )
    INSERT INTO marteau_dossier
      (reference, siren_tete, denomination_tete, associe_en_charge, collaborateur)
    SELECT ${annee} || '-' || lpad(n.suivant::text, 4, '0'),
           ${siren}, ${denomination ?? null},
           ${majuscule(associe)},
           ${collaborateur ? majuscule(collaborateur) : null}
      FROM n, v
    RETURNING id, reference
  `;

  // Réserve systématique. Levable par le seul associé, sous code.
  await sql`
    INSERT INTO marteau_reserve (dossier_id, code, libelle, levee_sous_code)
    VALUES (${d.id}, 'validation_associe',
            'Validation par le notaire associé en charge du dossier', true)
  `;

  await journaliser(d.id, auteur, 'dossier ouvert', {
    siren, denomination: denomination ?? null, associe: majuscule(associe),
  });

  const [{ tete }] = await sql`SELECT marteau_journal_tete() AS tete`;
  return res.status(201).json({ dossier: d.reference, repris: false, journal_tete: tete });
}

// =====================================================================
// lister — l'écran d'accueil
// =====================================================================
//
// Une ligne par dossier, avec de quoi peindre le BANDEAU DE COULEUR de
// la ligne (arbitrage du 10/09 : les pastilles étaient trop petites) et
// les deux jauges. Volontairement pauvre : le détail se lit sur la page
// dédiée du dossier, un clic sur la ligne y mène — pas de dépliage en
// place (arbitrage du 10/09).
//
// Les dossiers CLOS ne sortent pas par défaut : ils sont derrière le
// filtre `clos=1`.

async function lister(res, { clos = false } = {}) {
  const sql = db();
  const lignes = await sql`
    SELECT d.reference, d.siren_tete, d.denomination_tete,
           d.associe_en_charge, d.collaborateur, d.ouvert_le, d.clos_le,
           (SELECT count(*) FROM marteau_reserve r
             WHERE r.dossier_id = d.id AND r.levee_le IS NULL)::int AS reserves_ouvertes,
           (SELECT count(*) FROM marteau_reserve r
             WHERE r.dossier_id = d.id)::int AS reserves_total,
           (SELECT count(*) FROM marteau_piece p
             WHERE p.dossier_id = d.id
               AND p.statut IN ('demandee','relancee','recue','saisie','recu_a_analyser','analyse'))::int AS pieces_demandees,
           (SELECT count(*) FROM marteau_piece p
             WHERE p.dossier_id = d.id AND p.statut IN ('recue','analyse'))::int AS pieces_recues,
           (SELECT count(*) FROM marteau_piece p
             WHERE p.dossier_id = d.id AND p.statut IN ('demandable','a_saisir'))::int AS pieces_demandables,
           (SELECT count(*) FROM marteau_parcelle pa
             WHERE pa.dossier_id = d.id AND pa.en_perimetre)::int AS parcelles,
           (SELECT count(*) FROM marteau_voyant v
             WHERE v.dossier_id = d.id AND v.couleur = 'carmin')::int AS carmin,
           (SELECT count(*) FROM marteau_voyant v
             WHERE v.dossier_id = d.id AND v.couleur = 'orange')::int AS orange,
           (SELECT count(*) FROM marteau_voyant v
             WHERE v.dossier_id = d.id AND v.couleur = 'jaune')::int AS jaune,
           (SELECT count(*) FROM marteau_voyant v
             WHERE v.dossier_id = d.id AND v.couleur = 'canard')::int AS canard
      FROM marteau_dossier d
     -- NE PAS revenir à un fragment SQL imbriqué ici (une sous-requête
     -- interpolee depuis un autre gabarit) : le pilote Neon le serialise
     -- comme un PARAMETRE et non comme du SQL, et la requete part en
     -- « invalid input syntax for type boolean ». On compare donc le
     -- predicat au drapeau.
     WHERE (d.clos_le IS NOT NULL) = ${clos}::boolean
     ORDER BY d.ouvert_le DESC
  `;

  const dossiers = lignes.map((l) => ({
    reference: l.reference,
    siren: l.siren_tete,
    denomination: l.denomination_tete,
    associe: l.associe_en_charge,
    collaborateur: l.collaborateur,
    ouvert_le: l.ouvert_le,
    clos_le: l.clos_le,
    parcelles: l.parcelles,
    // Un dossier reste PROVISOIRE tant qu'une réserve est ouverte. Deux
    // états, pas plus.
    etat: l.reserves_ouvertes ? 'provisoire' : 'definitif_possible',
    jauges: {
      pieces: { recues: l.pieces_recues, demandees: l.pieces_demandees, demandables: l.pieces_demandables },
      reserves: { levees: l.reserves_total - l.reserves_ouvertes, total: l.reserves_total },
    },
    voyants: { carmin: l.carmin, orange: l.orange, jaune: l.jaune, canard: l.canard },
    // Couleur du bandeau de la ligne : la plus grave. `null` = dossier
    // ouvert mais jamais analysé, ce qui n'est pas « tout va bien » et ne
    // doit pas se peindre en canard.
    couleur: l.carmin ? 'carmin' : l.orange ? 'orange' : l.jaune ? 'jaune' : l.canard ? 'canard' : null,
  }));

  return res.status(200).json({ clos, nombre: dossiers.length, dossiers });
}

// =====================================================================
// lire — ex api/etat.js
// =====================================================================
//
// Relit ce que la base sait d'un dossier. Lecture seule, aucune écriture,
// aucun appel externe : c'est l'écran qui survit au rechargement, celui
// que le collaborateur ouvre le matin.

async function lire(res, ref) {
  const sql = db();

  const [d] = await sql`
    SELECT id, reference, siren_tete, denomination_tete, associe_en_charge,
           collaborateur, ouvert_le, clos_le
      FROM marteau_dossier WHERE reference = ${ref}
  `;
  if (!d) return res.status(404).json({ erreur: `dossier ${ref} inconnu` });

  const societes = await sql`
    SELECT siren, denomination, niveau, niveau_confiance, role_fusion,
           origine, sources_bodacc, collecte_complete, denominations_anterieures,
           etat_administratif, creee_le, siege_registre, dirigeants
      FROM marteau_societe WHERE dossier_id = ${d.id}
     ORDER BY niveau, siren
  `;

  const [parc] = await sql`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE a_confirmer)::int AS a_confirmer,
           count(DISTINCT commune_insee)::int AS communes
      FROM marteau_parcelle WHERE dossier_id = ${d.id} AND en_perimetre
  `;

  const reserves = await sql`
    SELECT code, libelle, detail, levee_sous_code, ouverte_le, levee_le, levee_par, motif_levee
      FROM marteau_reserve WHERE dossier_id = ${d.id}
     ORDER BY ouverte_le
  `;
  const ouvertes = reserves.filter((r) => !r.levee_le).length;

  // Jauge pièces : reçues / DEMANDÉES. Les demandables n'y entrent pas —
  // on ne compte pas comme attendue une pièce qu'on n'a pas demandée.
  const [pieces] = await sql`
    SELECT count(*) FILTER (WHERE statut IN ('demandee','relancee','recue','saisie','recu_a_analyser','analyse'))::int AS demandees,
           count(*) FILTER (WHERE statut IN ('recue','analyse'))::int AS recues,
           count(*) FILTER (WHERE statut IN ('demandable','a_saisir'))::int AS demandables
      FROM marteau_piece WHERE dossier_id = ${d.id}
  `;
  const registre = await sql`
    SELECT id, famille, libelle, nature, destinataire_type, statut,
           premier_envoi_le, relances, depose_le
      FROM marteau_piece WHERE dossier_id = ${d.id}
     ORDER BY famille, id
  `;

  const journal = await sql`
    SELECT id, le, qui, quoi, detail, empreinte
      FROM marteau_journal WHERE dossier_id = ${d.id}
     ORDER BY id DESC LIMIT 20
  `;
  const ruptures = await sql`SELECT id, motif FROM marteau_journal_verifier()`;
  const [{ tete }] = await sql`SELECT marteau_journal_tete() AS tete`;

  // Les dix familles, dans l'ordre FIXE, chacune avec sa note fixe en tête
  // et ses voyants rendus par la bibliothèque. Une famille sans voyant
  // n'est pas omise : elle est dite « non analysée ».
  const familles = await sql`SELECT numero, code, libelle, note_fixe FROM marteau_famille ORDER BY numero`;
  const voyants = await sql`
    SELECT v.couleur, v.phrase_code, v.precisions, v.maj_le, r.famille, r.code AS voyant, r.libelle
      FROM marteau_voyant v JOIN marteau_voyant_ref r ON r.id = v.voyant_ref_id
     WHERE v.dossier_id = ${d.id} ORDER BY r.famille, r.rang, v.id
  `;
  const dix = familles.map((f) => {
    const vs = voyants.filter((v) => v.famille === f.numero).map((v) => ({
      voyant: v.voyant, libelle: v.libelle, couleur: v.couleur,
      texte: rendre(v.phrase_code, v.precisions).texte,
    }));
    // La couleur de la famille est la plus grave de ses voyants. C'est
    // elle qui peint le bandeau de la famille (arbitrage du 10/09).
    const pire = vs.reduce((m, v) => (ORDRE[v.couleur] > ORDRE[m] ? v.couleur : m), vs.length ? 'canard' : null);
    return { numero: f.numero, code: f.code, libelle: f.libelle, note_fixe: f.note_fixe, couleur: pire, voyants: vs };
  });

  const appels = await sql`
    SELECT source, statut, tentatives, dernier_essai, ms, erreur
      FROM marteau_appel WHERE dossier_id = ${d.id}
     ORDER BY dernier_essai DESC LIMIT 10
  `;

  return res.status(200).json({
    dossier: {
      reference: d.reference, siren: d.siren_tete, denomination: d.denomination_tete,
      associe: d.associe_en_charge, collaborateur: d.collaborateur,
      ouvert_le: d.ouvert_le, clos_le: d.clos_le,
      // Deux états, pas plus : provisoire tant qu'une réserve est ouverte.
      etat: ouvertes ? 'provisoire' : 'definitif_possible',
    },
    // Deux jauges DISTINCTES, jamais un pourcentage unique.
    jauges: {
      pieces:   { recues: pieces.recues, demandees: pieces.demandees, demandables: pieces.demandables },
      reserves: { levees: reserves.length - ouvertes, total: reserves.length },
    },
    parcelles: parc,
    societes,
    familles: dix,
    reserves,
    registre,
    appels,
    journal: {
      lignes: journal.reverse(),
      chaine: ruptures.length ? { etat: 'ROMPUE', ruptures } : { etat: 'intègre' },
      tete,
    },
  });
}

// =====================================================================
// lever — ex api/lever.js
// =====================================================================
//
// Lève une réserve. C'est le geste qui fait bouger la jauge, et la jauge
// est LE VERROU : le définitif ne se génère qu'à zéro réserve, et la
// réserve « validation par l'associé » est ouverte d'office. Il n'y a
// donc pas de mécanisme d'approbation séparé — il y a cette action.
//
// Arbitrages appliqués (mémo § 8.2) :
//   • le collaborateur lève SEUL, sans validation préalable — le dossier
//     n'est jamais bloqué ; la levée se discute APRÈS COUP en réunion,
//     sur la note générée depuis le journal ;
//   • le MOTIF est obligatoire et journalisé ;
//   • les réserves « sous code » (validation associé, DVF, état
//     hypothécaire négatif) exigent MARTEAU_CODE_LEVEE — variable
//     Vercel, jamais dans le code ;
//   • pas de code par associé : la levée sous code est IMPUTÉE à
//     l'associé en charge tel qu'il figure au dossier.

async function lever(res, { dossier, reserve, motif, qui, code }) {
  if (!dossier || !reserve) return res.status(400).json({ erreur: 'dossier et reserve requis' });
  if (!motif || String(motif).trim().length < 5) {
    return res.status(400).json({ erreur: 'un motif de levée est requis — il est journalisé' });
  }
  if (!qui) return res.status(400).json({ erreur: 'qui est requis' });

  const sql = db();
  const [d] = await sql`
    SELECT id, reference, associe_en_charge FROM marteau_dossier
     WHERE reference = ${dossier}
  `;
  if (!d) return res.status(404).json({ erreur: `dossier ${dossier} inconnu` });

  const [r] = await sql`
    SELECT id, code, libelle, levee_sous_code, levee_le FROM marteau_reserve
     WHERE dossier_id = ${d.id} AND code = ${reserve}
     ORDER BY ouverte_le DESC LIMIT 1
  `;
  if (!r) return res.status(404).json({ erreur: `réserve ${reserve} inconnue sur ce dossier` });
  if (r.levee_le) return res.status(409).json({ erreur: 'réserve déjà levée' });

  // Sous code : le code doit exister ET correspondre. Un code absent de la
  // configuration REFUSE toute levée sous code (503) — mieux qu'une porte
  // ouverte par défaut. Le 503 et le 403 sont deux choses différentes :
  // « pas configuré » n'est pas « code faux ». Ne pas les confondre.
  let leveePar = majuscule(qui);
  if (r.levee_sous_code) {
    const attendu = process.env.MARTEAU_CODE_LEVEE;
    if (!attendu) {
      return res.status(503).json({
        erreur: 'levée sous code impossible — MARTEAU_CODE_LEVEE non configurée sur le projet',
      });
    }
    if (String(code ?? '') !== attendu) {
      // Journalisé aussi : une tentative refusée est un événement qui
      // engage. Le motif tapé ne l'est pas — on ne garde que le fait.
      await journaliser(d.id, leveePar, 'levée refusée — code invalide', { reserve: r.code });
      return res.status(403).json({ erreur: 'code invalide' });
    }
    leveePar = d.associe_en_charge;
  }

  await sql`
    UPDATE marteau_reserve
       SET levee_le = now(), levee_par = ${leveePar}, motif_levee = ${String(motif).trim()}
     WHERE id = ${r.id}
  `;

  await journaliser(d.id, leveePar, 'réserve levée', {
    reserve: r.code, libelle: r.libelle, motif: String(motif).trim(),
    sous_code: r.levee_sous_code, declenchee_par: majuscule(qui),
  });

  const [{ restantes }] = await sql`
    SELECT count(*)::int AS restantes FROM marteau_reserve
     WHERE dossier_id = ${d.id} AND levee_le IS NULL
  `;
  const [{ tete }] = await sql`SELECT marteau_journal_tete() AS tete`;

  return res.status(200).json({
    dossier: d.reference, reserve: r.code, levee_par: leveePar, restantes,
    // Zéro réserve = le définitif devient possible. Seule condition.
    definitif_possible: restantes === 0,
    journal_tete: tete,
  });
}

// =====================================================================
// preparer / marquer / saisir — ex api/demander.js
// =====================================================================
//
//   preparer — rédige la demande, groupée par destinataire, SANS RIEN
//              ÉCRIRE. Le collaborateur la relit, la colle dans son mail.
//   marquer  — pose premier_envoi_le (s'il est vide), dernier_envoi_le,
//              le statut, et journalise. C'est ce clic qui fait courir
//              les quinze jours et alimente la jauge pièces.
//   saisir   — constate la saisie de l'état hypothécaire au logiciel
//              métier. Il n'est pas rédigé, il est saisi.
//
// RÈGLE D'ENVOI (mémo § 10.4), respectée par construction : MARTEAU ne
// transmet rien à un tiers. Il rédige, le collaborateur envoie depuis sa
// propre boîte. La machine n'écrit à un tiers que lorsqu'elle est sûre
// des deux bouts — ici elle n'écrit à personne, donc pas de question.

async function pieces(res, { dossier, pieces: liste, qui }, action) {
  if (!dossier || !qui) return res.status(400).json({ erreur: 'dossier et qui sont requis' });
  const ids = (Array.isArray(liste) ? liste : []).map(Number).filter(Number.isInteger);
  if (!ids.length) return res.status(400).json({ erreur: 'aucune pièce désignée' });

  const sql = db();
  const [d] = await sql`
    SELECT id, reference, siren_tete, denomination_tete, collaborateur
      FROM marteau_dossier WHERE reference = ${dossier}
  `;
  if (!d) return res.status(404).json({ erreur: `dossier ${dossier} inconnu` });

  const lignes = await sql`
    SELECT id, famille, libelle, nature, destinataire_type, statut
      FROM marteau_piece WHERE dossier_id = ${d.id} AND id = ANY(${ids})
     ORDER BY destinataire_type, famille, id
  `;
  if (!lignes.length) return res.status(404).json({ erreur: 'pièces inconnues sur ce dossier' });

  // ------------------------------------------------------------ saisir
  if (action === 'saisir') {
    const eh = lignes.filter((l) => l.nature === 'etat_hypothecaire' && l.statut === 'a_saisir');
    if (!eh.length) {
      return res.status(409).json({ erreur: 'aucun état hypothécaire « à saisir » parmi les pièces désignées' });
    }
    await sql`
      UPDATE marteau_piece
         SET statut = 'saisie', premier_envoi_le = now(), dernier_envoi_le = now()
       WHERE id = ANY(${eh.map((l) => l.id)})
    `;
    await journaliser(d.id, majuscule(qui), 'état hypothécaire saisi au logiciel métier', {
      pieces: eh.map((l) => l.id),
    });
    return res.status(200).json({ dossier: d.reference, saisies: eh.length });
  }

  // Seules les pièces à destinataire rédigeable et encore demandables.
  const redigeables = lignes.filter((l) => DESTINATAIRES[l.destinataire_type] && l.statut === 'demandable');
  // Les ÉCARTÉES sont une sortie à part entière, pas un déchet : elles
  // portent leur motif à l'écran, sans quoi le collaborateur croirait à
  // un envoi complet.
  const ecartees = lignes.filter((l) => !redigeables.includes(l)).map((l) => ({
    id: l.id, libelle: l.libelle,
    motif: l.statut !== 'demandable' ? `déjà ${l.statut}`
      : l.destinataire_type === 'mairie' ? 'demande mairie — brique séparée (commune par commune)'
      : l.nature === 'etat_hypothecaire' ? 'état hypothécaire — à saisir au logiciel métier'
      : 'destinataire non rédigeable',
  }));

  // -------------------------------------------------------- rédaction
  const parDest = {};
  for (const l of redigeables) (parDest[l.destinataire_type] ??= []).push(l);
  const demandes = Object.entries(parDest).map(([dest, ls]) => {
    const g = DESTINATAIRES[dest];
    const corps = [
      'Madame, Monsieur,', '',
      g.intro(d), '',
      ...ls.map((l) => `— ${l.libelle}`), '',
      g.fin, '',
      'Bien cordialement,',
    ].join('\n');
    return {
      destinataire: dest, titre: g.titre, objet: `${d.reference} — ${g.titre}`,
      pieces: ls.map((l) => l.id), corps,
    };
  });

  if (action === 'preparer') {
    return res.status(200).json({ dossier: d.reference, demandes, ecartees, ecrit: false });
  }

  // ---------------------------------------------------------- marquer
  const marquees = redigeables.map((l) => l.id);
  if (marquees.length) {
    // premier_envoi_le n'est posé QU'UNE FOIS : les quinze jours courent
    // depuis le PREMIER envoi, une relance ne remet pas le compteur à
    // zéro. C'est ce coalesce qui porte le compte de la note de réunion.
    await sql`
      UPDATE marteau_piece
         SET statut = 'demandee',
             premier_envoi_le = coalesce(premier_envoi_le, now()),
             dernier_envoi_le = now(),
             destinataire = coalesce(destinataire, ${majuscule(qui)})
       WHERE id = ANY(${marquees})
    `;
    await journaliser(d.id, majuscule(qui), 'pièces demandées', {
      pieces: marquees, destinataires: Object.keys(parDest),
      // Le collaborateur a envoyé depuis sa boîte : la machine constate,
      // elle n'a pas transmis.
      envoi: 'par le collaborateur, depuis sa boîte',
    });
  }

  const [{ tete }] = await sql`SELECT marteau_journal_tete() AS tete`;
  return res.status(200).json({
    dossier: d.reference, demandes, ecartees, ecrit: true,
    marquees: marquees.length, journal_tete: tete,
  });
}
