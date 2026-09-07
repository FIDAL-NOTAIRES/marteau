// MARTEAU — POST /api/matrice
// Le raccord vers MATRICE. On APPELLE, on ne recopie pas : le routage, le
// referentiel, la deduction par voisinage et l'apprentissage vivent dans MATRICE
// et nulle part ailleurs. Une regle de securite ecrite en deux endroits derive.
//
// TOUJOURS EN SIMULATION depuis MARTEAU : rien n'est ecrit, aucun courriel ne
// part. Engager le portefeuille reste un geste fait dans MATRICE, par un humain.
const MATRICE = process.env.MATRICE_BASE
  || 'https://matrice-jean-francoisdumetz-7391s-projects.vercel.app';
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ erreur: 'POST attendu' });
  const passe = process.env.MATRICE_PASSE;
  const auteur = String(process.env.MATRICE_AUTEUR || 'JFD').trim().toUpperCase();
  const { dossier, societe, siren, communes } = req.body || {};
  if (!societe || !Array.isArray(communes) || communes.length === 0) {
    return res.status(400).json({ erreur: 'societe et communes requis' });
  }
  const charge = {
    dossier: dossier || `MARTEAU-${new Date().toISOString().slice(0, 10)}`,
    societe, siren: siren || null, simulation: true,
    communes: communes.map((c) => ({
      code_insee: String(c.code_insee),
      nom_commune: c.nom_commune || null,
      nb_lots: Number(c.nb_lots) || 0,
    })),
  };
  if (!passe) {
    return res.status(503).json({
      erreur: 'Verrou MATRICE non configure',
      detail: 'MATRICE tourne en mode Entra (MATRICE_MOT_DE_PASSE absent). Pour le raccord machine : '
        + 'poser MATRICE_MOT_DE_PASSE sur le projet matrice ET MATRICE_PASSE sur le projet marteau.',
      charge_prete: charge,
    });
  }
  try {
    const r = await fetch(new URL('/api/importer', MATRICE), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-matrice-passe': passe,
        'x-matrice-auteur': auteur,
      },
      body: JSON.stringify(charge),
    });
    const corps = await r.json().catch(() => ({ erreur: `reponse illisible (HTTP ${r.status})` }));
    if (!r.ok) {
      return res.status(r.status).json({
        erreur: corps.erreur || `MATRICE a refuse (HTTP ${r.status})`,
        ...corps, charge_prete: charge,
      });
    }
    return res.status(200).json({ ...corps, charge_prete: charge });
  } catch (err) {
    return res.status(502).json({
      erreur: 'MATRICE indisponible — demandes de matrices a retraiter',
      motif: String(err && err.message || err), charge_prete: charge,
    });
  }
}
