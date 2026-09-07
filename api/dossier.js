// MARTEAU — POST /api/dossier
//
// Ouvre un dossier. C'est le premier geste qui ÉCRIT : jusqu'ici la façade
// ne faisait que lire. Trois choses se passent, dans cet ordre, et l'ordre
// compte pour la piste d'audit :
//
//   1. le dossier est créé, avec une référence AAAA-NNNN attribuée en base
//      (même forme que MATRICE, pour que les collaborateurs n'aient qu'une
//      logique à retenir) ;
//   2. la RÉSERVE SYSTÉMATIQUE « validation par le notaire associé en charge »
//      est ouverte d'office — c'est elle qui empêche tout définitif sans
//      l'associé, la jauge étant le verrou ;
//   3. l'ouverture est journalisée : c'est la PREMIÈRE ligne de la chaîne
//      du dossier, et souvent la première du journal tout entier.
//
// La collecte n'est PAS lancée ici : l'écran l'enchaîne par un second
// appel à /api/collecter. Deux fonctions, deux responsabilités — et si la
// collecte échoue, le dossier existe quand même, ce qui est voulu : le
// rapport doit toujours pouvoir sortir.

import { db, journaliser } from '../lib/db.js';

const estSiren = (v) => /^\d{9}$/.test(String(v ?? ''));

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ erreur: 'POST attendu' });

  const { siren, denomination, associe, collaborateur, qui } = req.body ?? {};
  if (!estSiren(siren)) return res.status(400).json({ erreur: 'siren requis (9 chiffres)' });
  if (!associe) return res.status(400).json({ erreur: 'associé en charge requis' });

  const auteur = String(qui || collaborateur || associe).trim().toUpperCase();

  try {
    const sql = db();

    // Un dossier déjà ouvert sur ce SIREN et non clos est repris, pas
    // doublé : l'audit relancé repart de l'état précédent (mémo § 4.6).
    const [existant] = await sql`
      SELECT id, reference FROM marteau_dossier
       WHERE siren_tete = ${siren} AND clos_le IS NULL
       ORDER BY ouvert_le DESC LIMIT 1
    `;
    if (existant) {
      return res.status(200).json({ dossier: existant.reference, repris: true });
    }

    // Référence AAAA-NNNN. Le verrou consultatif évite que deux ouvertures
    // simultanées tirent le même numéro ; le volume (~30 audits par mois)
    // rend son coût nul.
    const annee = new Date().getFullYear();
    const [d] = await sql`
      WITH v AS (SELECT pg_advisory_xact_lock(hashtext('marteau_dossier_ref'))),
      n AS (
        SELECT coalesce(max(substring(reference FROM 6)::int), 0) + 1 AS suivant
          FROM marteau_dossier WHERE reference LIKE ${annee + '-%'}
      )
      INSERT INTO marteau_dossier
        (reference, siren_tete, denomination_tete, associe_en_charge, collaborateur)
      SELECT ${annee} || '-' || lpad(n.suivant::text, 4, '0'),
             ${siren}, ${denomination ?? null},
             ${String(associe).trim().toUpperCase()},
             ${collaborateur ? String(collaborateur).trim().toUpperCase() : null}
        FROM n, v
      RETURNING id, reference
    `;

    // Réserve systématique. Levable par le seul associé, sous code.
    await sql`
      INSERT INTO marteau_reserve (dossier_id, code, libelle, levee_sous_code)
      VALUES (${d.id}, 'validation_associe',
              'Validation par le notaire associé en charge du dossier', true)
    `;

    await journaliser(d.id, auteur, 'dossier ouvert', {
      siren, denomination: denomination ?? null,
      associe: String(associe).trim().toUpperCase(),
    });

    const [{ tete }] = await sql`SELECT marteau_journal_tete() AS tete`;

    return res.status(201).json({ dossier: d.reference, repris: false, journal_tete: tete });
  } catch (e) {
    console.error('[MARTEAU] dossier', e);
    return res.status(500).json({ erreur: e.message });
  }
}
