// MARTEAU — POST /api/demander
//
// Fait passer des pièces de « demandable » à « demandée ». Deux actions :
//
//   preparer — rédige la demande, groupée par destinataire, SANS RIEN
//              ÉCRIRE. Le collaborateur la relit, la colle dans son mail.
//   marquer  — pose premier_envoi_le (s'il est vide), dernier_envoi_le,
//              le statut, et journalise. C'est ce clic qui fait courir les
//              quinze jours et alimente la jauge pièces.
//
// RÈGLE D'ENVOI (mémo § 10.4), respectée par construction : MARTEAU ne
// transmet rien à un tiers. Il rédige, le collaborateur envoie depuis sa
// propre boîte. La machine n'écrit à un tiers que lorsqu'elle est sûre des
// deux bouts — ici elle n'écrit à personne, donc pas de question.
//
// L'état hypothécaire a son cycle propre : « à saisir » → « saisie » au
// logiciel métier. Il n'est pas rédigé, il est saisi ; l'action `saisir`
// ne fait que constater la saisie.
//
// Les mairies ne sont PAS traitées ici : la demande mairie part commune
// par commune, via l'annuaire de la DILA, avec bascule mail → courrier.
// C'est une brique à part (mémo § 10.1).

import { db, journaliser } from '../lib/db.js';

const DESTINATAIRES = {
  client: {
    titre: 'Demande de pièces au client',
    intro: (d) => `Dans le cadre de l'audit du patrimoine immobilier de ${d.denomination_tete ?? d.siren_tete} (dossier ${d.reference}), nous vous remercions de bien vouloir nous communiquer les pièces suivantes :`,
    fin: 'Ces pièces peuvent nous être adressées par retour de courriel. Nous restons à votre disposition pour toute précision.',
  },
  expert_comptable: {
    titre: "Demande de pièces à l'expert-comptable",
    intro: (d) => `Dans le cadre de l'audit du patrimoine immobilier de ${d.denomination_tete ?? d.siren_tete} (dossier ${d.reference}), et afin de déterminer le régime fiscal applicable à une éventuelle cession, nous vous remercions de bien vouloir nous communiquer :`,
    fin: "Ces éléments permettront d'anticiper l'imposition de la plus-value dans la détermination du prix net vendeur. Nous restons à votre disposition.",
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ erreur: 'POST attendu' });
  const { dossier, pieces, qui, action } = req.body ?? {};
  if (!dossier || !qui) return res.status(400).json({ erreur: 'dossier et qui sont requis' });
  if (!['preparer', 'marquer', 'saisir'].includes(action)) {
    return res.status(400).json({ erreur: 'action attendue : preparer | marquer | saisir' });
  }
  const ids = (Array.isArray(pieces) ? pieces : []).map(Number).filter(Number.isInteger);
  if (!ids.length) return res.status(400).json({ erreur: 'aucune pièce désignée' });

  try {
    const sql = db();
    const [d] = await sql`
      SELECT id, reference, siren_tete, denomination_tete, collaborateur FROM marteau_dossier
       WHERE reference = ${dossier}
    `;
    if (!d) return res.status(404).json({ erreur: `dossier ${dossier} inconnu` });

    const lignes = await sql`
      SELECT id, famille, libelle, nature, destinataire_type, statut
        FROM marteau_piece WHERE dossier_id = ${d.id} AND id = ANY(${ids})
       ORDER BY destinataire_type, famille, id
    `;
    if (!lignes.length) return res.status(404).json({ erreur: 'pièces inconnues sur ce dossier' });

    // ---------------------------------------------------------- saisir
    if (action === 'saisir') {
      const eh = lignes.filter((l) => l.nature === 'etat_hypothecaire' && l.statut === 'a_saisir');
      if (!eh.length) return res.status(409).json({ erreur: 'aucun état hypothécaire « à saisir » parmi les pièces désignées' });
      await sql`
        UPDATE marteau_piece SET statut = 'saisie', premier_envoi_le = now(), dernier_envoi_le = now()
         WHERE id = ANY(${eh.map((l) => l.id)})
      `;
      await journaliser(d.id, String(qui).trim().toUpperCase(), 'état hypothécaire saisi au logiciel métier', {
        pieces: eh.map((l) => l.id),
      });
      return res.status(200).json({ dossier: d.reference, saisies: eh.length });
    }

    // Seules les pièces à destinataire rédigeable et encore demandables.
    const redigeables = lignes.filter((l) => DESTINATAIRES[l.destinataire_type] && l.statut === 'demandable');
    const ecartees = lignes.filter((l) => !redigeables.includes(l)).map((l) => ({
      id: l.id, libelle: l.libelle,
      motif: l.statut !== 'demandable' ? `déjà ${l.statut}`
        : l.destinataire_type === 'mairie' ? 'demande mairie — brique séparée (commune par commune)'
        : l.nature === 'etat_hypothecaire' ? 'état hypothécaire — à saisir au logiciel métier'
        : 'destinataire non rédigeable',
    }));

    // ----------------------------------------------------- rédaction
    const parDest = {};
    for (const l of redigeables) (parDest[l.destinataire_type] ??= []).push(l);
    const demandes = Object.entries(parDest).map(([dest, ls]) => {
      const g = DESTINATAIRES[dest];
      const corps = [
        'Madame, Monsieur,', '',
        g.intro(d), '',
        ...ls.map((l) => `— ${l.libelle}`), '',
        g.fin, '',
        'Bien cordialement,',
      ].join('\n');
      return { destinataire: dest, titre: g.titre, objet: `${d.reference} — ${g.titre}`, pieces: ls.map((l) => l.id), corps };
    });

    if (action === 'preparer') {
      return res.status(200).json({ dossier: d.reference, demandes, ecartees, ecrit: false });
    }

    // ------------------------------------------------------- marquer
    const marquees = redigeables.map((l) => l.id);
    if (marquees.length) {
      // premier_envoi_le n'est posé qu'une fois : les 15 jours courent
      // depuis le PREMIER envoi, une relance ne remet pas le compteur à zéro.
      await sql`
        UPDATE marteau_piece
           SET statut = 'demandee',
               premier_envoi_le = coalesce(premier_envoi_le, now()),
               dernier_envoi_le = now(),
               destinataire = coalesce(destinataire, ${String(qui).trim().toUpperCase()})
         WHERE id = ANY(${marquees})
      `;
      await journaliser(d.id, String(qui).trim().toUpperCase(), 'pièces demandées', {
        pieces: marquees, destinataires: Object.keys(parDest),
        // Le collaborateur a envoyé depuis sa boîte : la machine constate,
        // elle n'a pas transmis.
        envoi: 'par le collaborateur, depuis sa boîte',
      });
    }
    const [{ tete }] = await sql`SELECT marteau_journal_tete() AS tete`;
    return res.status(200).json({ dossier: d.reference, demandes, ecartees, ecrit: true, marquees: marquees.length, journal_tete: tete });
  } catch (e) {
    console.error('[MARTEAU] demander', e);
    return res.status(500).json({ erreur: e.message });
  }
}
