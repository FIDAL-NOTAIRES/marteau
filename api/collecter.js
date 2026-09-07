// Lancement de la collecte sur un dossier.
//
// Rend la main dès que les sources bornées ont répondu, et laisse les
// reprises au cron (api/reprise.js) : le rapport doit toujours pouvoir
// sortir, donc on ne fait jamais attendre l'appelant pour une source qui
// traîne.

import { db, journaliser } from '../lib/db.js';
import { collecterSociete, parLots, PARALLELISME_REDPAR } from '../lib/collecte.js';
import { annonces } from '../lib/sources/bodacc.js';
import { parcellesParSiren } from '../lib/sources/redpar.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ erreur: 'POST attendu' });
  }

  const { dossier, qui } = req.body ?? {};
  if (!dossier || !qui) {
    return res.status(400).json({ erreur: 'dossier et qui sont requis' });
  }

  try {
    const sql = db();

    const [d] = await sql`
      SELECT id, reference, siren_tete FROM marteau_dossier
       WHERE reference = ${dossier}
    `;
    if (!d) return res.status(404).json({ erreur: `dossier ${dossier} inconnu` });

    const societes = await sql`
      SELECT id, siren FROM marteau_societe
       WHERE dossier_id = ${d.id} ORDER BY niveau, siren
    `;
    if (!societes.length) {
      return res.status(409).json({
        erreur: 'aucune société au périmètre — lancer l\'accroche large d\'abord',
      });
    }

    // Plafond à 4 sociétés en simultané : ne pas saturer nos propres API.
    const sorties = await parLots(societes, PARALLELISME_REDPAR, (s) =>
      collecterSociete(d.id, s.id, {
        bodacc: (signal) => annonces(s.siren, signal),
        redpar: (signal) => parcellesParSiren(s.siren, signal),
      }));

    const completes = sorties.filter((s) => s.complete).length;

    // Journalisé parce que ça engage : c'est le moment où l'état du
    // dossier change. Le détail des verdicts reste hors journal, il vit
    // dans marteau_appel et bougera encore.
    await journaliser(d.id, qui, 'collecte lancée', {
      societes: societes.length, completes,
    });

    return res.status(200).json({
      dossier: d.reference,
      societes: societes.length,
      completes,
      // Bascule automatique vers le rapport dès la dernière société
      // complète — et on bascule même s'il reste de l'orange.
      bascule: completes === societes.length,
      detail: sorties,
    });
  } catch (e) {
    console.error('[MARTEAU] collecter', e);
    return res.status(500).json({ erreur: e.message });
  }
}
