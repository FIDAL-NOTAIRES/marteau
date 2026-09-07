// Accès à la base. Une seule porte : aucun autre fichier n'importe
// @neondatabase/serverless directement, pour que la question « où se
// connecte-t-on ? » n'ait qu'une réponse.
//
// Rappel : la base est PARTAGÉE avec MATRICE et PARTAGE AMIABLE. Toutes
// les tables de MARTEAU portent le préfixe marteau_ ; ne jamais toucher
// aux tables sans préfixe ni aux matrice_*.

import { neon } from '@neondatabase/serverless';

let _sql;

export function db() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL absente — la fonction ne peut pas servir');
  }
  _sql ??= neon(process.env.DATABASE_URL);
  return _sql;
}

// Piste d'audit. Seule écriture possible dans marteau_journal : la table
// refuse UPDATE, DELETE et TRUNCATE par trigger. Ne journaliser QUE ce
// qui engage — sinon le journal devient illisible et perd son usage.
//
// Ne jamais y écrire une valeur sensible : le journal est inaltérable,
// donc une erreur de contenu ne se corrige pas.
export async function journaliser(dossierId, qui, quoi, detail = {}) {
  const sql = db();
  await sql`
    INSERT INTO marteau_journal (dossier_id, qui, quoi, detail)
    VALUES (${dossierId}, ${qui}, ${quoi}, ${JSON.stringify(detail)}::jsonb)
  `;
}
