// MARTEAU — POST /api/collecter
//
// COUCHE DE PERSISTANCE. Elle n'interroge aucune source externe : elle
// appelle nos propres /api/photo et /api/liens, écrits le 1er septembre,
// et elle écrit ce qu'ils rendent.
//
// Pourquoi cette séparation. `photo.js` et `liens.js` sont SANS ÉTAT :
// on peut les ouvrir dans un navigateur, les relire, les corriger sans
// rien casser en base. Toute la mécanique d'écriture — journal chaîné,
// registre, voyants — vit ici. Un défaut de lecture d'une source ne
// touche donc jamais la piste d'audit, et inversement.
//
// Conséquence à respecter : ce fichier ne doit JAMAIS appeler REDPAR ni
// le BODACC directement. S'il le fait un jour, la logique existera en
// deux endroits et divergera.

import { db, journaliser } from '../lib/db.js';
import { appelBorne, enregistrer, TENTATIVES_MAX } from '../lib/collecte.js';

// En production, une fonction s'appelle elle-même par son domaine de
// déploiement. VERCEL_URL le donne sans le protocole.
const base = () => process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : 'http://localhost:3000';

const notre = (chemin, params) => async (signal) => {
  const url = new URL(chemin, base());
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  const d = await r.json();
  // Nos fonctions rendent 502 avec un motif quand une source est muette :
  // on relaie le motif plutôt qu'un code, il partira au registre.
  if (!r.ok) throw new Error(d.erreur || d.motif || `HTTP ${r.status}`);
  return d;
};

// ---------------------------------------------------------- reprise
// Reprise des appels en souffrance (3e tentative), fusionnée ici depuis
// api/reprise.js le 07/09/2026 : le plan Hobby de Vercel plafonne à DOUZE
// fonctions par déploiement, et la treizième a fait échouer deux builds.
// Appelée par POST { action: 'reprise' } — à la main ou à l'ouverture du
// dossier ; le cron était de toute façon refusé sur ce plan.
async function reprise(req, res) {
  if (process.env.CRON_SECRET
      && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ erreur: 'non autorisé' });
  }
  const sql = db();
  const enSouffrance = await sql`
    SELECT a.id, a.source, a.tentatives, a.dossier_id, d.siren_tete AS siren
      FROM marteau_appel a JOIN marteau_dossier d ON d.id = a.dossier_id
     WHERE a.statut IN ('lent', 'en_cours') AND a.tentatives < ${TENTATIVES_MAX}
       AND a.dernier_essai < now() - interval '2 minutes'
     LIMIT 20
  `;
  const reprises = [];
  for (const a of enSouffrance) {
    const chemin = a.source === 'photo' ? '/api/photo' : a.source === 'liens' ? '/api/liens' : null;
    if (!chemin) continue;
    const v = await appelBorne(a.source, notre(chemin, { siren: a.siren }));
    const definitif = v.statut !== 'ok' && a.tentatives + 1 >= TENTATIVES_MAX;
    await sql`
      UPDATE marteau_appel
         SET statut = ${definitif ? 'echec' : v.statut}, tentatives = tentatives + 1,
             dernier_essai = now(), ms = ${v.ms}, erreur = ${v.erreur ?? null}
       WHERE id = ${a.id}
    `;
    reprises.push({ source: a.source, siren: a.siren, statut: v.statut, definitif });
  }
  return res.status(200).json({ examines: enSouffrance.length, reprises });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ erreur: 'POST attendu' });

  if (req.body?.action === 'reprise') {
    try { return await reprise(req, res); }
    catch (e) { console.error('[MARTEAU] reprise', e); return res.status(500).json({ erreur: e.message }); }
  }

  const { dossier, qui } = req.body ?? {};
  if (!dossier || !qui) {
    return res.status(400).json({ erreur: 'dossier et qui sont requis' });
  }

  try {
    const sql = db();

    const [d] = await sql`
      SELECT id, reference, siren_tete FROM marteau_dossier
       WHERE reference = ${dossier}
    `;
    if (!d) return res.status(404).json({ erreur: `dossier ${dossier} inconnu` });

    // Les deux volets en parallèle. Chacun est borné et ne lève pas :
    // un échec est nommé, jamais silencieux.
    const [vPhoto, vLiens] = await Promise.all([
      appelBorne('photo', notre('/api/photo', { siren: d.siren_tete })),
      appelBorne('liens', notre('/api/liens', { siren: d.siren_tete })),
    ]);
    await enregistrer(d.id, null, vPhoto);
    await enregistrer(d.id, null, vLiens);

    let parcellesEcrites = 0;
    let societesEcrites = 0;

    // ------------------------------------------------ la société auditée
    if (vPhoto.statut === 'ok') {
      const p = vPhoto.donnees;

      const [tete] = await sql`
        INSERT INTO marteau_societe
          (dossier_id, siren, denomination, forme, niveau_confiance, origine, niveau)
        VALUES
          (${d.id}, ${p.societe.siren ?? d.siren_tete}, ${p.societe.denomination},
           ${p.societe.forme_juridique}, 'structuree', 'accroche', 0)
        ON CONFLICT (dossier_id, siren) DO UPDATE
           SET denomination = EXCLUDED.denomination,
               forme = EXCLUDED.forme
        RETURNING id
      `;
      societesEcrites += 1;

      // Les parcelles, commune par commune. `photo.js` plafonne son
      // détail à 600 par commune et le signale par `tronque` : on écrit
      // ce qu'on a reçu, et le drapeau part au rapport — surtout pas un
      // total silencieusement amputé.
      for (const c of p.communes ?? []) {
        for (const par of c.parcelles ?? []) {
          await sql`
            INSERT INTO marteau_parcelle
              (dossier_id, code_parcelle, commune_insee, commune_nom,
               siren_proprietaire, origine, a_confirmer,
               droit, nature, contenance, adresse)
            VALUES
              (${d.id}, ${par.ref}, ${c.code_insee}, ${c.nom_commune},
               ${p.societe.siren ?? d.siren_tete}, 'accroche', false,
               ${par.droit || null}, ${par.nature || null},
               ${par.contenance ?? null}, ${par.adresse || null})
            ON CONFLICT (dossier_id, code_parcelle) DO UPDATE
               SET droit = EXCLUDED.droit, nature = EXCLUDED.nature,
                   contenance = EXCLUDED.contenance, adresse = EXCLUDED.adresse
          `;
          parcellesEcrites += 1;
        }
      }

      if (p.tronque || p.indisponible?.length) {
        // Journalisé : un audit établi sur un portefeuille tronqué ou
        // partiel doit pouvoir être daté et expliqué après coup.
        await journaliser(d.id, qui, 'photographie partielle', {
          tronque: Boolean(p.tronque),
          indisponible: p.indisponible ?? [],
          annonce: p.agregats?.total_parcelles_annonce ?? null,
          ecrit: parcellesEcrites,
        });
      }
    }

    // -------------------------------------------- les sociétés liées
    if (vLiens.statut === 'ok') {
      const l = vLiens.donnees;

      // Seules les sociétés liées PORTANT DES BIENS entrent : un lien
      // sociétaire sans aucun bien n'a pas à encombrer l'audit. C'est le
      // filtre que liens.js applique déjà pour `alertes_perimetre`.
      for (const a of l.alertes_perimetre ?? []) {
        await sql`
          INSERT INTO marteau_societe
            (dossier_id, siren, denomination, niveau_confiance, role_fusion,
             sources_bodacc, origine, niveau)
          VALUES
            (${d.id}, ${a.siren}, ${a.denomination},
             ${a.a_confirmer ? 'texte' : 'structuree'},
             ${a.roles?.includes('absorbée') ? 'absorbee'
               : a.roles?.includes('absorbante') ? 'absorbante' : null},
             ${JSON.stringify((a.sources ?? []).slice(0, 3))}::jsonb,
             'bodacc', 1)
          ON CONFLICT (dossier_id, siren) DO UPDATE
             SET denomination = coalesce(EXCLUDED.denomination, marteau_societe.denomination),
                 role_fusion  = coalesce(EXCLUDED.role_fusion, marteau_societe.role_fusion)
        `;
        societesEcrites += 1;

        // Réserve d'analyse, formulée comme le mémo l'exige : une
        // divergence entre le portefeuille déclaré et l'état des bases
        // publiques, JAMAIS un oubli du client.
        await sql`
          INSERT INTO marteau_reserve (dossier_id, code, libelle, detail)
          VALUES (${d.id}, ${'orphelines_' + a.siren},
                  'Divergence entre le portefeuille déclaré et l''état résultant des bases publiques — en cours d''analyse, en attente de réception de l''état hypothécaire',
                  ${JSON.stringify(a)}::jsonb)
          ON CONFLICT DO NOTHING
        `;
      }

      // Dénominations successives de la société auditée : c'est cette
      // liste qu'on porte au fichier immobilier, pas seulement le nom
      // du jour.
      if (l.denominations?.length) {
        await sql`
          UPDATE marteau_societe
             SET denominations_anterieures = ${JSON.stringify(l.denominations)}::jsonb
           WHERE dossier_id = ${d.id} AND siren = ${d.siren_tete}
        `;
      }
    }

    // Le drapeau de collecte complète : posé quand les deux volets ont
    // répondu. Il pilote la couleur canard de la société sur l'organigramme.
    if (vPhoto.statut === 'ok' && vLiens.statut === 'ok') {
      await sql`
        UPDATE marteau_societe SET collecte_complete = true
         WHERE dossier_id = ${d.id} AND siren = ${d.siren_tete}
      `;
    }

    await journaliser(d.id, qui, 'collecte lancée', {
      photo: vPhoto.statut, liens: vLiens.statut,
      parcelles: parcellesEcrites, societes: societesEcrites,
    });

    const [{ tete }] = await sql`SELECT marteau_journal_tete() AS tete`;

    return res.status(200).json({
      dossier: d.reference,
      volets: { photo: vPhoto.statut, liens: vLiens.statut },
      ecrit: { parcelles: parcellesEcrites, societes: societesEcrites },
      // Empreinte de tête de la piste d'audit. À ancrer hors de la base :
      // c'est elle, et non le chaînage seul, qui rend une réécriture
      // opposable.
      journal_tete: tete,
    });
  } catch (e) {
    console.error('[MARTEAU] collecter', e);
    return res.status(500).json({ erreur: e.message });
  }
}
