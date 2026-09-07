// BODACC — annonces civiles et commerciales, API Opendatasoft de la DILA.
// Gratuit, sans clé.
//
// Rôle dans MARTEAU : le MOUVEMENT postérieur au dépôt des statuts —
// cessions de parts, fusions, changements de dénomination. L'INPI donne
// l'état initial solide, le BODACC dit ce qui a bougé depuis.
//
// Deux règles à ne pas perdre :
//   • la clé de recherche est le SIREN, JAMAIS le nom : une société a pu
//     changer de dénomination ou fusionner plusieurs fois, et chercher le
//     dernier nom fait rater la parcelle oubliée ;
//   • l'INPI fait foi comme dénomination affichée ; quand le BODACC est
//     plus récent, il sort en SIGNAL DE DIVERGENCE, pas en correction
//     silencieuse.
//
// Pas de cache : c'est cette source qui sert à détecter la fraîcheur.

const BASE = 'https://bodacc-datadila.opendatasoft.com/api/explore/v2.1'
  + '/catalog/datasets/annonces-commerciales/records';

export async function annonces(siren, signal) {
  const url = new URL(BASE);
  url.searchParams.set('where', `registre LIKE "${siren}"`);
  url.searchParams.set('order_by', 'dateparution DESC');
  url.searchParams.set('limit', '100');

  const r = await fetch(url, { signal, headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`BODACC ${r.status}`);
  const { results = [] } = await r.json();

  return results.map((a) => ({
    date: a.dateparution,
    famille: a.familleavis_lib,
    denomination: a.commercant ?? null,
    tribunal: a.tribunal ?? null,
    // Le contenu utile est un JSON imbriqué dont la forme varie selon la
    // famille d'avis : on le conserve brut plutôt que de deviner.
    brut: a.listepersonnes ?? a.modificationsgenerales ?? null,
  }));
}

// Dénominations successives, de la plus ancienne à la plus récente.
// Alimente l'affichage « anciennement X, puis Y » avec les dates.
export function denominationsSuccessives(annoncesTriees) {
  const vues = [];
  for (const a of [...annoncesTriees].reverse()) {
    if (a.denomination && a.denomination !== vues.at(-1)?.denomination) {
      vues.push({ denomination: a.denomination, du: a.date, source: 'bodacc' });
    }
  }
  return vues;
}
