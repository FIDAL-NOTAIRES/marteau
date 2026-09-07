// Regroupement des parcelles en UNITÉS FONCIÈRES.
//
// Les appels à REDPAR eux-mêmes vivent dans api/photo.js et api/liens.js :
// ce fichier ne fait que du calcul sur ce qu'ils rendent. Rappel de la
// règle fondatrice — MARTEAU appelle, il ne duplique jamais.

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
