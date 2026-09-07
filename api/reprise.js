// Reprise des appels en souffrance. Appelé par cron toutes les deux
// minutes (vercel.json).
//
// Raison d'être : l'arbitrage prévoit une TROISIÈME tentative à deux
// minutes, et deux minutes ne tiennent pas dans une invocation
// serverless. La règle est respectée, son exécution est déportée ici.
//
// Au-delà de trois tentatives, la source passe en échec définitif : elle
// devient VISIBLE dans le rapport et la main passe à l'humain via le
// registre de suivi. On ne réessaie pas indéfiniment.

import { db } from '../lib/db.js';
import { TENTATIVES_MAX, appelBorne } from '../lib/collecte.js';
import { annonces } from '../lib/sources/bodacc.js';
import { parcellesParSiren } from '../lib/sources/redpar.js';

const SOURCES = {
  bodacc: (siren) => (signal) => annonces(siren, signal),
  redpar: (siren) => (signal) => parcellesParSiren(siren, signal),
};

export default async function handler(req, res) {
  // Le cron Vercel présente CRON_SECRET en Authorization. Sans ce
  // contrôle, n'importe qui peut déclencher la reprise.
  if (process.env.CRON_SECRET
      && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ erreur: 'non autorisé' });
  }

  try {
    const sql = db();

    const enSouffrance = await sql`
      SELECT a.id, a.source, a.tentatives, a.dossier_id, a.societe_id, s.siren
        FROM marteau_appel a
        JOIN marteau_societe s ON s.id = a.societe_id
       WHERE a.statut IN ('lent', 'en_cours')
         AND a.tentatives < ${TENTATIVES_MAX}
         AND a.dernier_essai < now() - interval '2 minutes'
       LIMIT 20
    `;

    const reprises = [];
    for (const a of enSouffrance) {
      const fabrique = SOURCES[a.source];
      if (!fabrique) continue;

      const v = await appelBorne(a.source, fabrique(a.siren));
      const definitif = v.statut !== 'ok' && a.tentatives + 1 >= TENTATIVES_MAX;

      await sql`
        UPDATE marteau_appel
           SET statut = ${definitif ? 'echec' : v.statut},
               tentatives = tentatives + 1,
               dernier_essai = now(),
               ms = ${v.ms},
               erreur = ${v.erreur ?? null}
         WHERE id = ${a.id}
      `;

      reprises.push({ source: a.source, siren: a.siren, statut: v.statut, definitif });
    }

    return res.status(200).json({ examines: enSouffrance.length, reprises });
  } catch (e) {
    console.error('[MARTEAU] reprise', e);
    return res.status(500).json({ erreur: e.message });
  }
}
