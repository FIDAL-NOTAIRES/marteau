// MARTEAU — GET /api/etat?dossier=2026-0001
//
// Relit ce que la base sait d'un dossier. Lecture seule, aucune écriture,
// aucun appel externe : c'est l'écran qui survit au rechargement, celui
// que le collaborateur ouvre le matin.
//
// Ce qu'il rend est ce que le mémo appelle le tableau de bord vivant :
// les deux jauges, les réserves ouvertes, les sociétés du périmètre avec
// leur niveau de confiance, et la queue du journal chaîné avec son état.

import { db } from '../lib/db.js';
import { rendre } from '../lib/phrases.js';

export default async function handler(req, res) {
  const ref = String(req.query?.dossier ?? '').trim();
  if (!ref) return res.status(400).json({ erreur: 'dossier requis' });

  try {
    const sql = db();

    const [d] = await sql`
      SELECT id, reference, siren_tete, denomination_tete, associe_en_charge,
             collaborateur, ouvert_le, clos_le
        FROM marteau_dossier WHERE reference = ${ref}
    `;
    if (!d) return res.status(404).json({ erreur: `dossier ${ref} inconnu` });

    const societes = await sql`
      SELECT siren, denomination, niveau, niveau_confiance, role_fusion,
             origine, sources_bodacc, collecte_complete, denominations_anterieures
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
    // on ne compte pas comme attendue une pièce qu'on n'a pas encore demandée.
    const [pieces] = await sql`
      SELECT count(*) FILTER (WHERE statut IN ('demandee','relancee','recue','saisie','recu_a_analyser','analyse'))::int AS demandees,
             count(*) FILTER (WHERE statut IN ('recue','analyse'))::int AS recues,
             count(*) FILTER (WHERE statut IN ('demandable','a_saisir'))::int AS demandables
        FROM marteau_piece WHERE dossier_id = ${d.id}
    `;
    const registre = await sql`
      SELECT id, famille, libelle, nature, destinataire_type, statut, premier_envoi_le, relances, depose_le
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

    // Les dix familles, dans l'ordre FIXE, chacune avec sa note fixe en
    // tête et ses voyants rendus par la bibliothèque. Une famille sans
    // voyant n'est pas omise : elle est dite « non analysée ».
    const familles = await sql`SELECT numero, code, libelle, note_fixe FROM marteau_famille ORDER BY numero`;
    const voyants = await sql`
      SELECT v.couleur, v.phrase_code, v.precisions, v.maj_le, r.famille, r.code AS voyant, r.libelle
        FROM marteau_voyant v JOIN marteau_voyant_ref r ON r.id = v.voyant_ref_id
       WHERE v.dossier_id = ${d.id} ORDER BY r.famille, r.rang, v.id
    `;
    const ordre = { canard: 0, jaune: 1, orange: 2, carmin: 3 };
    const dix = familles.map((f) => {
      const vs = voyants.filter((v) => v.famille === f.numero).map((v) => ({
        voyant: v.voyant, libelle: v.libelle, couleur: v.couleur,
        texte: rendre(v.phrase_code, v.precisions).texte,
      }));
      // La couleur de la famille est la plus grave de ses voyants.
      const pire = vs.reduce((m, v) => (ordre[v.couleur] > ordre[m] ? v.couleur : m), vs.length ? 'canard' : null);
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
  } catch (e) {
    console.error('[MARTEAU] etat', e);
    return res.status(500).json({ erreur: e.message });
  }
}
