// MARTEAU — GET /api/photo
// L'ORCHESTRATEUR. Seul endroit qui appelle REDPAR, et il n'absorbe rien de son
// code : decision du memo v1.3 / addendum § 2 — MARTEAU APPELLE, il ne duplique
// pas. REDPAR corrige, MARTEAU en profite sans report.
//
// Pourquoi cote serveur : LOGIS METROPOLE fait 1 636 parcelles et 15 451 locaux.
// Les faire descendre dans le navigateur pour y etre comptes, c'est plusieurs
// megaoctets transportes pour produire un tableau de quarante-huit lignes.
//
// ECHEC EXPLICITE, JAMAIS SILENCIEUX (addendum § 2). Un volet qui ne repond pas
// est nomme dans `indisponible` : ses compteurs sont inconnus, pas nuls.

const REDPAR = process.env.REDPAR_BASE || 'https://redpar-backend.vercel.app';
const LIMITE = 20000;

async function volet(chemin, params) {
  const url = new URL(chemin, REDPAR);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`REDPAR ${chemin} — HTTP ${r.status}`);
  return r.json();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const { siren, nom } = req.query || {};
  if (!siren && !nom) return res.status(400).json({ erreur: 'Parametre siren ou nom requis' });
  const cible = siren ? { siren } : { nom };

  const [pRes, lRes] = await Promise.allSettled([
    volet('/api/parcelles', { ...cible, limite: LIMITE }),
    volet('/api/locaux', { ...cible, limite: LIMITE }),
  ]);

  const indisponible = [];
  if (pRes.status === 'rejected') indisponible.push({ volet: 'parcelles', motif: String(pRes.reason && pRes.reason.message || pRes.reason) });
  if (lRes.status === 'rejected') indisponible.push({ volet: 'locaux', motif: String(lRes.reason && lRes.reason.message || lRes.reason) });

  if (pRes.status === 'rejected' && lRes.status === 'rejected') {
    return res.status(502).json({ erreur: 'REDPAR indisponible — portefeuille a retraiter', indisponible });
  }

  const P = pRes.status === 'fulfilled' ? pRes.value : { results: [] };
  const L = lRes.status === 'fulfilled' ? lRes.value : { results: [] };
  const parcelles = P.results || [];
  const locaux = L.results || [];

  const ech = parcelles[0] || locaux[0] || {};
  const societe = {
    denomination: ech.denomination || (P.resolution && P.resolution.nom_recherche) || nom || null,
    siren: ech.numero_siren || (P.resolution && P.resolution.siren_retenu) || siren || null,
    forme_juridique: ech.forme_juridique || null,
    millesime: P.millesime || L.millesime || null,
  };
  const cands = (P.resolution && P.resolution.candidats) || [];
  const homonymes = cands.length > 1 ? cands : [];

  const communes = new Map();
  const prendre = (code, nomCommune) => {
    if (!communes.has(code)) {
      communes.set(code, {
        code_insee: code, nom_commune: nomCommune, departement: null,
        nb_parcelles: 0, nb_locaux: 0, contenance: 0, parcelles: [], droits: new Set(),
      });
    }
    return communes.get(code);
  };

  for (const p of parcelles) {
    if (!p.code_insee) continue;
    const c = prendre(p.code_insee, p.nom_commune);
    c.departement = c.departement || p.code_departement || null;
    c.nb_parcelles += 1;
    c.contenance += Number(p.contenance_parcelle || p.contenance || 0);
    c.droits.add(p.code_droit || '?');
    if (c.parcelles.length < 600) {
      c.parcelles.push({
        ref: p.code_parcelle, adresse: p.adresse || '',
        contenance: Number(p.contenance_parcelle || p.contenance || 0),
        droit: p.code_droit || '', nature: p.nature_culture || '',
      });
    }
  }

  for (const l of locaux) {
    const code = l.code_insee || String(l.code_parcelle || '').slice(0, 5);
    if (!code) continue;
    const c = prendre(code, l.nom_commune);
    c.departement = c.departement || l.code_departement || null;
    c.nb_locaux += 1;
    c.droits.add(l.code_droit || '?');
  }

  const liste = [...communes.values()]
    .map((c) => ({ ...c, droits: [...c.droits] }))
    .sort((a, b) => (b.nb_parcelles + b.nb_locaux) - (a.nb_parcelles + a.nb_locaux));

  const departements = new Set(liste.map((c) => c.departement).filter(Boolean));

  return res.status(200).json({
    societe, homonymes, genere_le: new Date().toISOString(),
    agregats: {
      communes: liste.length, departements: departements.size,
      parcelles: parcelles.length, locaux: locaux.length,
      contenance_m2: liste.reduce((n, c) => n + c.contenance, 0),
      total_parcelles_annonce: P.total === undefined ? null : P.total,
      total_locaux_annonce: L.total === undefined ? null : L.total,
    },
    tronque: Boolean(P.tronque || L.tronque),
    avertissement: P.avertissement || L.avertissement || null,
    indisponible, communes: liste,
  });
}
