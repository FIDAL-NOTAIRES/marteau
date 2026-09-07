// Orchestrateur de la couche de collecte.
//
// Les arbitrages qu'il applique, et qu'il ne faut pas défaire sans les
// rouvrir explicitement :
//
//   • sources interrogées EN PARALLÈLE, jamais en série — la promesse de
//     photographie à une heure en dépend ;
//   • 30 secondes par source, puis DEUX tentatives automatiques espacées,
//     puis une TROISIÈME à 2 minutes ;
//   • une source LENTE qui répond n'est pas en échec : elle s'affiche en
//     retard sans bloquer les autres ;
//   • au-delà, la source passe en échec VISIBLE dans le rapport et la
//     main passe à l'humain ;
//   • cache d'une heure pour les sources qui bougent peu, nul pour le
//     BODACC puisque c'est lui qui sert à détecter la fraîcheur ;
//   • appels à REDPAR plafonnés à 4 sociétés en simultané.
//
// CONSÉQUENCE TECHNIQUE À CONNAÎTRE : la troisième tentative à 2 minutes
// ne peut PAS tenir dans une invocation serverless (60 s au plafond).
// Elle est donc déportée sur api/reprise.js, appelé par cron toutes les
// deux minutes, qui reprend les appels laissés en 'en_cours' ou 'lent'
// avec moins de trois tentatives. L'arbitrage est respecté ; c'est son
// exécution qui change de place.

import { db } from './db.js';

export const TIMEOUT_MS = 30_000;
export const TENTATIVES_MAX = 3;
export const PARALLELISME_REDPAR = 4;

// Durée de cache par source. Ce qui n'est pas listé n'est pas caché.
export const CACHE_MS = {
  cadastre: 3_600_000,
  georisques: 3_600_000,
  inpi: 3_600_000,
  bdnb: 3_600_000,
  dvf: 3_600_000,
  bodacc: 0,
};

// Enveloppe un appel de source : borne le temps, ne lève jamais, rend
// toujours un verdict lisible. Le reste du code n'a donc pas à savoir
// comment une source échoue.
export async function appelBorne(nom, fn, ms = TIMEOUT_MS) {
  const t0 = Date.now();
  const abandon = new AbortController();
  const minuteur = setTimeout(() => abandon.abort(), ms);
  try {
    const donnees = await fn(abandon.signal);
    return { nom, statut: 'ok', donnees, ms: Date.now() - t0 };
  } catch (e) {
    clearTimeout(minuteur);
    // Un abandon sur délai n'est pas la même chose qu'une erreur de la
    // source : le premier peut valoir une reprise, le second est souvent
    // définitif. Le rapport doit pouvoir dire lequel.
    const statut = e.name === 'AbortError' ? 'lent' : 'echec';
    return { nom, statut, erreur: e.message, ms: Date.now() - t0 };
  } finally {
    clearTimeout(minuteur);
  }
}

// Lit le cache. Un appel 'ok' non expiré dispense de rappeler la source.
export async function depuisCache(dossierId, societeId, source) {
  if (!CACHE_MS[source]) return null;
  const sql = db();
  const [ligne] = await sql`
    SELECT id, ms FROM marteau_appel
     WHERE dossier_id = ${dossierId}
       AND societe_id IS NOT DISTINCT FROM ${societeId}
       AND source = ${source}
       AND statut = 'ok'
       AND expire_le > now()
     ORDER BY dernier_essai DESC LIMIT 1
  `;
  return ligne ?? null;
}

export async function enregistrer(dossierId, societeId, verdict) {
  const sql = db();
  const cache = CACHE_MS[verdict.nom] ?? 0;
  const [ligne] = await sql`
    INSERT INTO marteau_appel
      (dossier_id, societe_id, source, statut, tentatives,
       dernier_essai, ms, erreur, expire_le)
    VALUES
      (${dossierId}, ${societeId}, ${verdict.nom}, ${verdict.statut}, 1,
       now(), ${verdict.ms}, ${verdict.erreur ?? null},
       ${cache && verdict.statut === 'ok'
          ? new Date(Date.now() + cache).toISOString() : null})
    RETURNING id
  `;
  return ligne.id;
}

// Collecte d'une société : toutes ses sources d'un coup, résultats au fil
// de l'eau côté base pour que l'écran puisse être rechargé sans perdre
// l'avancement.
export async function collecterSociete(dossierId, societeId, sources) {
  const verdicts = await Promise.all(
    Object.entries(sources).map(async ([nom, fn]) => {
      const cache = await depuisCache(dossierId, societeId, nom);
      if (cache) return { nom, statut: 'ok', cache: true, ms: cache.ms };
      const v = await appelBorne(nom, fn);
      await enregistrer(dossierId, societeId, v);
      return v;
    }),
  );

  const complete = verdicts.every((v) => v.statut === 'ok');
  if (complete) {
    const sql = db();
    await sql`
      UPDATE marteau_societe SET collecte_complete = true WHERE id = ${societeId}
    `;
  }

  return { societeId, complete, verdicts };
}

// Plafonne la simultanéité. Écrit à la main plutôt qu'avec une
// dépendance : quatre lignes valent mieux qu'un paquet à suivre.
export async function parLots(items, taille, fn) {
  const sorties = [];
  for (let i = 0; i < items.length; i += taille) {
    sorties.push(...await Promise.all(items.slice(i, i + taille).map(fn)));
  }
  return sorties;
}
