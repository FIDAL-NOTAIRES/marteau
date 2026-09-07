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

// Les volets repris sont NOS fonctions, pas les sources externes : la
// reprise doit refaire exactement ce que la collecte a fait, sinon elle
// écrirait autre chose que ce qu'elle remplace.
const base = () => process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000';

const notre = (chemin, siren) => async (signal) => {
  const r = await fetch(`${base()}${chemin}?siren=${siren}`,
    { signal, headers: { Accept: 'application/json' } });
  const d = await r.json();
  if (!r.ok) throw new Error(d.erreur || d.motif || `HTTP ${r.status}`);
  return d;
};

const SOURCES = {
  photo: (siren) => notre('/api/photo', siren),
  liens: (siren) => notre('/api/liens', siren),
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
      SELECT a.id, a.source, a.tentatives, a.dossier_id, d.siren_tete AS siren
        FROM marteau_appel a
        JOIN marteau_dossier d ON d.id = a.dossier_id
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
