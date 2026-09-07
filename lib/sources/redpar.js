// REDPAR — données de parcelle et de bâti par société.
//
// RÈGLE FONDATRICE : MARTEAU appelle, il ne duplique jamais. On
// n'interroge donc PAS MAJIC ici — REDPAR l'exploite déjà, avec sa base
// FPMU issue des fichiers officiels DGFiP. Toute logique parcellaire
// réécrite dans MARTEAU serait une divergence à maintenir.
//
// Les PLANS suivent la même porte : MARTEAU les demande à REDPAR, qui
// appelle PAINT en interne. Un seul constructeur de polygone, donc aucune
// différence de colorisation possible entre le plan annexé et les
// parcelles auditées.
//
// Limites de MAJIC à porter au rapport, elles ne viennent pas de nous :
// sociétés unipersonnelles et entrepreneurs individuels exclus du
// fichier, photographie au 1er janvier donc jusqu'à un an de décalage.

const BASE = process.env.REDPAR_URL ?? 'https://redpar-backend.vercel.app';

export async function parcellesParSiren(siren, signal) {
  const r = await fetch(`${BASE}/api/parcelles?siren=${siren}`, {
    signal,
    headers: { accept: 'application/json' },
  });
  // Un échec doit être EXPLICITE, jamais silencieux : la parcelle reste
  // identifiée comme non traitée plutôt que d'être éditée sur une donnée
  // manquante.
  if (!r.ok) throw new Error(`REDPAR ${r.status}`);
  return r.json();
}

// Regroupement en UNITÉS FONCIÈRES — parcelles contiguës appartenant au
// MÊME propriétaire.
//
// À exécuter AVANT tout test d'accès. Une parcelle sans façade sur voie
// n'est pas enclavée si le vendeur possède la voisine qui donne sur la
// rue : tester parcelle par parcelle produirait des faux positifs
// d'enclavement en série.
//
// La contiguïté réelle demande la géométrie ; à défaut, on regroupe par
// propriétaire et par section cadastrale, ce qui est une approximation
// SÛRE DANS LE BON SENS — elle regroupe un peu large, donc elle rate des
// enclavements plutôt que d'en inventer. À remplacer par un ST_Touches
// dès que les géométries sont disponibles.
export function unitesFoncieres(parcelles) {
  const lots = new Map();
  for (const p of parcelles) {
    const cle = `${p.siren}|${p.commune_insee}|${p.section ?? ''}`;
    if (!lots.has(cle)) lots.set(cle, []);
    lots.get(cle).push(p);
  }
  return [...lots.entries()].map(([cle, membres]) => {
    const [siren, commune] = cle.split('|');
    return {
      siren,
      commune,
      parcelles: membres,
      approximation: 'section cadastrale — en attente des géométries',
    };
  });
}
