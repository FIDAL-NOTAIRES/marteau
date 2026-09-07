// MARTEAU — GET /api/reunion
//
// La note du point d'équipe, générée pour le prochain mardi ou jeudi.
// Forme arrêtée le 04/09/2026 (mémo § 10.2) :
//
//   • PAGE DE GARDE portant la DATE DE LA RÉUNION visée — pas la date de
//     génération, la génération étant automatique — et la liste des
//     dossiers, chacun suivi entre parenthèses de son nombre de points ;
//   • UNE LISTE PAR DOSSIER, assemblées, pas de groupement par collaborateur ;
//   • tous les points en attente restent visibles, CATÉGORISÉS en deux
//     blocs : moins de 15 jours d'attente, plus de 15 jours — le compteur
//     court depuis le PREMIER envoi, une relance ne le remet pas à zéro ;
//   • les relances sont PROPOSÉES, jamais envoyées d'ici ;
//   • une ligne d'état hypothécaire restée « à saisir » plus d'un jour
//     ouvré remonte en ALERTE : rien n'est parti, l'horloge des 10 jours
//     ne tourne pas ;
//   • les réserves levées depuis la dernière réunion sont listées avec
//     qui et pourquoi — la levée se discute APRÈS COUP, ici.
//
// Lecture seule. Rien n'est écrit, rien n'est envoyé.

import { db } from '../lib/db.js';

// Prochain mardi (2) ou jeudi (4), strictement après aujourd'hui.
function prochaineReunion(depuis = new Date()) {
  const d = new Date(depuis); d.setHours(0, 0, 0, 0);
  for (let i = 1; i <= 7; i += 1) {
    const c = new Date(d); c.setDate(d.getDate() + i);
    if (c.getDay() === 2 || c.getDay() === 4) return c;
  }
  return d;
}
// Réunion précédente : le mardi ou jeudi le plus récent, aujourd'hui inclus.
function reunionPrecedente(depuis = new Date()) {
  const d = new Date(depuis); d.setHours(0, 0, 0, 0);
  for (let i = 0; i <= 7; i += 1) {
    const c = new Date(d); c.setDate(d.getDate() - i);
    if (c.getDay() === 2 || c.getDay() === 4) return c;
  }
  return d;
}
const joursOuvres = (depuis, jusqu) => {
  let n = 0; const c = new Date(depuis); c.setHours(0, 0, 0, 0);
  const fin = new Date(jusqu); fin.setHours(0, 0, 0, 0);
  while (c < fin) { c.setDate(c.getDate() + 1); if (c.getDay() !== 0 && c.getDay() !== 6) n += 1; }
  return n;
};

export default async function handler(req, res) {
  try {
    const sql = db();
    const maintenant = new Date();
    const reunion = prochaineReunion(maintenant);
    const precedente = reunionPrecedente(maintenant);

    const dossiers = await sql`
      SELECT id, reference, denomination_tete, siren_tete, associe_en_charge, collaborateur
        FROM marteau_dossier WHERE clos_le IS NULL ORDER BY reference
    `;

    const sortie = [];
    for (const d of dossiers) {
      const pieces = await sql`
        SELECT id, famille, libelle, nature, destinataire_type, statut, premier_envoi_le, dernier_envoi_le, relances
          FROM marteau_piece WHERE dossier_id = ${d.id}
           AND statut IN ('demandee','relancee','saisie','recu_a_analyser','a_saisir')
         ORDER BY premier_envoi_le NULLS FIRST, famille
      `;
      const reserves = await sql`
        SELECT code, libelle, levee_sous_code, ouverte_le, levee_le, levee_par, motif_levee
          FROM marteau_reserve WHERE dossier_id = ${d.id}
         ORDER BY ouverte_le
      `;

      const attente = (p) => p.premier_envoi_le ? Math.floor((maintenant - new Date(p.premier_envoi_le)) / 86400000) : null;
      const enAttente = pieces.filter((p) => p.statut !== 'a_saisir').map((p) => ({
        id: p.id, famille: p.famille, libelle: p.libelle, destinataire: p.destinataire_type,
        statut: p.statut, jours: attente(p), relances: p.relances,
        // La relance est PROPOSÉE au-delà de 15 jours, déclenchée d'un clic ailleurs.
        relance_proposee: p.statut === 'demandee' || p.statut === 'relancee' ? (attente(p) ?? 0) > 15 : false,
      }));

      // Alerte : état hypothécaire toujours « à saisir » après plus d'un jour ouvré.
      const alertes = pieces.filter((p) => p.statut === 'a_saisir').map((p) => ({
        libelle: p.libelle,
        motif: 'état hypothécaire toujours à saisir au logiciel métier — rien n\'est parti, l\'horloge des 10 jours ne tourne pas',
      }));

      const levees = reserves.filter((r) => r.levee_le && new Date(r.levee_le) >= precedente)
        .map((r) => ({ libelle: r.libelle, levee_par: r.levee_par, motif: r.motif_levee, le: r.levee_le, sous_code: r.levee_sous_code }));
      const ouvertes = reserves.filter((r) => !r.levee_le).map((r) => ({ libelle: r.libelle, ouverte_le: r.ouverte_le, sous_code: r.levee_sous_code }));

      const points = enAttente.length + alertes.length + levees.length;
      if (!points && !ouvertes.length) continue;

      sortie.push({
        reference: d.reference, denomination: d.denomination_tete, siren: d.siren_tete,
        associe: d.associe_en_charge, collaborateur: d.collaborateur, points,
        moins_15: enAttente.filter((p) => (p.jours ?? 0) <= 15),
        plus_15: enAttente.filter((p) => (p.jours ?? 0) > 15),
        alertes, reserves_ouvertes: ouvertes, reserves_levees: levees,
      });
    }

    return res.status(200).json({
      // La page de garde porte la date de la RÉUNION, pas celle de génération.
      reunion_le: reunion.toISOString().slice(0, 10),
      depuis_le: precedente.toISOString().slice(0, 10),
      genere_le: maintenant.toISOString(),
      garde: sortie.map((s) => ({ reference: s.reference, denomination: s.denomination, points: s.points })),
      dossiers: sortie,
    });
  } catch (e) {
    console.error('[MARTEAU] reunion', e);
    return res.status(500).json({ erreur: e.message });
  }
}
