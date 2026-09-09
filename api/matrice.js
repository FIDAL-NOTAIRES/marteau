// MARTEAU — POST /api/matrice
//
// Le raccord vers MATRICE. On APPELLE, on ne recopie pas : le routage, le
// referentiel, la deduction par voisinage et l'apprentissage vivent dans MATRICE
// et nulle part ailleurs. Une regle de securite ecrite en deux endroits derive.
//
// JETON MACHINE (09/09/2026). L'appel passe desormais par la porte dediee
// /api/import-marteau de MATRICE, avec un secret qui n'ouvre QUE cette porte.
// Le verrou de recette MATRICE_MOT_DE_PASSE n'est plus en cause : il reste
// absent cote MATRICE, et doit le rester — il ouvrirait toute l'application.
//
// TOUJOURS EN SIMULATION : rien n'est ecrit, aucun courriel ne part. C'est la
// ROUTE de MATRICE qui l'impose, pas ce fichier — un raccord qui se contente de
// promettre « je n'ecris pas » ne protege personne.
const MATRICE = process.env.MATRICE_BASE || 'https://matrice-black.vercel.app';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ erreur: 'POST attendu' });

  const jeton = process.env.MATRICE_JETON;
  const { dossier, societe, siren, communes, auteur } = req.body || {};

  // Les initiales de qui a clique. Elles voyagent jusqu'au journal de MATRICE
  // (« marteau:ND ») : la machine appelle, mais quelqu'un a demande.
  const initiales = String(auteur || process.env.MATRICE_AUTEUR || 'JFD')
    .trim().toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);

  if (!societe || !Array.isArray(communes) || communes.length === 0) {
    return res.status(400).json({ erreur: 'societe et communes requis' });
  }
  if (initiales.length < 2) {
    return res.status(400).json({ erreur: 'initiales du demandeur requises (2 a 4 lettres)' });
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

  if (!jeton) {
    return res.status(503).json({
      erreur: 'Jeton machine MATRICE non configure',
      detail: 'Poser MATRICE_JETON_MARTEAU sur le projet matrice ET MATRICE_JETON sur le projet '
        + 'marteau (meme valeur). Ne PAS poser MATRICE_MOT_DE_PASSE : c\'est le verrou de recette, '
        + 'il ouvrirait toute l\'application.',
      charge_prete: charge,
    });
  }

  try {
    const r = await fetch(new URL('/api/import-marteau', MATRICE), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-matrice-jeton': jeton,
        'x-matrice-auteur': initiales,
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
