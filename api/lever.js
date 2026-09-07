// MARTEAU — POST /api/lever
//
// Lève une réserve. C'est le geste qui fait bouger la jauge, et la jauge
// est LE VERROU : le définitif ne se génère qu'à zéro réserve, et la
// réserve « validation par l'associé » est ouverte d'office. Il n'y a
// donc pas de mécanisme d'approbation séparé — il y a ce fichier.
//
// Arbitrages appliqués (mémo § 8.2) :
//   • le collaborateur lève SEUL, sans validation préalable — le dossier
//     n'est jamais bloqué ; la levée se discute APRÈS COUP en réunion,
//     sur la note générée depuis le journal ;
//   • le MOTIF est obligatoire et journalisé : il alimente la piste
//     d'audit chaînée ;
//   • les réserves « sous code » (validation associé, DVF, état
//     hypothécaire négatif) exigent le code unique MARTEAU_CODE_LEVEE —
//     variable Vercel, jamais dans le code, même mécanique que DECA ;
//   • pas de code par associé : la levée sous code est IMPUTÉE à
//     l'associé en charge tel qu'il figure au dossier, qui est déjà une
//     donnée du dossier.

import { db, journaliser } from '../lib/db.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ erreur: 'POST attendu' });

  const { dossier, reserve, motif, qui, code } = req.body ?? {};
  if (!dossier || !reserve) return res.status(400).json({ erreur: 'dossier et reserve requis' });
  if (!motif || String(motif).trim().length < 5) {
    return res.status(400).json({ erreur: 'un motif de levée est requis — il est journalisé' });
  }
  if (!qui) return res.status(400).json({ erreur: 'qui est requis' });

  try {
    const sql = db();

    const [d] = await sql`
      SELECT id, reference, associe_en_charge FROM marteau_dossier
       WHERE reference = ${dossier}
    `;
    if (!d) return res.status(404).json({ erreur: `dossier ${dossier} inconnu` });

    const [r] = await sql`
      SELECT id, code, libelle, levee_sous_code, levee_le FROM marteau_reserve
       WHERE dossier_id = ${d.id} AND code = ${reserve}
       ORDER BY ouverte_le DESC LIMIT 1
    `;
    if (!r) return res.status(404).json({ erreur: `réserve ${reserve} inconnue sur ce dossier` });
    if (r.levee_le) return res.status(409).json({ erreur: 'réserve déjà levée' });

    // Sous code : le code doit exister ET correspondre. Un code absent de
    // la configuration refuse toute levée sous code — mieux qu'une porte
    // ouverte par défaut.
    let leveePar = String(qui).trim().toUpperCase();
    if (r.levee_sous_code) {
      const attendu = process.env.MARTEAU_CODE_LEVEE;
      if (!attendu) {
        return res.status(503).json({
          erreur: 'levée sous code impossible — MARTEAU_CODE_LEVEE non configurée sur le projet',
        });
      }
      if (String(code ?? '') !== attendu) {
        // Journalisé aussi : une tentative refusée est un événement qui
        // engage, et le motif tapé ne l'est pas — on ne garde que le fait.
        await journaliser(d.id, leveePar, 'levée refusée — code invalide', { reserve: r.code });
        return res.status(403).json({ erreur: 'code invalide' });
      }
      leveePar = d.associe_en_charge;
    }

    await sql`
      UPDATE marteau_reserve
         SET levee_le = now(), levee_par = ${leveePar}, motif_levee = ${String(motif).trim()}
       WHERE id = ${r.id}
    `;

    await journaliser(d.id, leveePar, 'réserve levée', {
      reserve: r.code, libelle: r.libelle, motif: String(motif).trim(),
      sous_code: r.levee_sous_code, declenchee_par: String(qui).trim().toUpperCase(),
    });

    const [{ restantes }] = await sql`
      SELECT count(*)::int AS restantes FROM marteau_reserve
       WHERE dossier_id = ${d.id} AND levee_le IS NULL
    `;
    const [{ tete }] = await sql`SELECT marteau_journal_tete() AS tete`;

    return res.status(200).json({
      dossier: d.reference, reserve: r.code, levee_par: leveePar,
      restantes,
      // Zéro réserve = le définitif devient possible. C'est la seule
      // condition, et elle se lit ici.
      definitif_possible: restantes === 0,
      journal_tete: tete,
    });
  } catch (e) {
    console.error('[MARTEAU] lever', e);
    return res.status(500).json({ erreur: e.message });
  }
}
