// MARTEAU — POST /api/collecter (et GET pour le cron de reprise)
//
// COUCHE DE PERSISTANCE. Elle n'interroge aucune source externe : elle
// appelle nos propres /api/photo, /api/liens et /api/entreprises, et elle
// écrit ce qu'ils rendent.
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
//
// ---------------------------------------------------------------------
// Réécriture du 09/09/2026 — la collecte passe par `collecterSociete`
//
// Ce fichier appelait `appelBorne` et `enregistrer(…, null, …)` à la
// main, donc avec `societe_id` à NULL, puis posait `collecte_complete`
// sur le seul SIREN de tête. Trois conséquences, toutes corrigées ici :
//
//   • les FILIALES restaient jaunes indéfiniment sur l'organigramme,
//     puisque rien ne posait leur drapeau ;
//   • leurs PARCELLES n'étaient jamais photographiées — la descente du
//     mémo § 4.4 (« MARTEAU appelle REDPAR sur chaque société
//     détectée ») n'existait pas ;
//   • le suivi par source ET PAR SOCIÉTÉ, que `marteau_appel.societe_id`
//     permet, n'était pas alimenté : la reprise ne pouvait donc pas
//     savoir quelle société rappeler.
//
// `lib/collecte.js` fait déjà tout cela. On l'utilise.
// ---------------------------------------------------------------------

import { db, journaliser } from '../lib/db.js';
import {
  collecterSociete, parLots, appelBorne,
  PARALLELISME_REDPAR, TENTATIVES_MAX,
} from '../lib/collecte.js';

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

// Budget de temps. Le plafond de la fonction est de 60 s ; on s'arrête à
// 40 pour garder de quoi écrire et journaliser. Les sociétés non
// traitées gardent `collecte_complete` à false et seront reprises au
// prochain appel — c'est le drapeau, et non un curseur, qui porte le
// reste à faire.
const BUDGET_MS = 40_000;

// --------------------------------------------------------------- écriture

// Les parcelles d'une société, commune par commune. `photo.js` plafonne
// son détail à 600 par commune et le signale par `tronque` : on écrit ce
// qu'on a reçu, et le drapeau part au rapport — surtout pas un total
// silencieusement amputé.
//
// MANQUE CONNU (09/09/2026) : l'arbitrage du 08/09 veut qu'on STOCKE
// AUSSI les communes n'ayant que du bâti et des lots de copropriété,
// donc sans aucune parcelle au nom de la société — c'était la cause de
// l'écart 47/48 communes entre la base et la façade. Il n'existe aucune
// table pour les recevoir : `marteau_commune` n'est pas dans le schéma.
// Cela demande une migration, elle n'est pas faite, et une commune sans
// parcelle est donc toujours perdue ici.
async function ecrireParcelles(sql, dossierId, siren, payload, origine) {
  let ecrites = 0;
  for (const c of payload.communes ?? []) {
    for (const par of c.parcelles ?? []) {
      await sql`
        INSERT INTO marteau_parcelle
          (dossier_id, code_parcelle, commune_insee, commune_nom,
           siren_proprietaire, origine, a_confirmer,
           droit, nature, contenance, adresse)
        VALUES
          (${dossierId}, ${par.ref}, ${c.code_insee}, ${c.nom_commune},
           ${siren}, ${origine}, false,
           ${par.droit || null}, ${par.nature || null},
           ${par.contenance ?? null}, ${par.adresse || null})
        ON CONFLICT (dossier_id, code_parcelle) DO UPDATE
           SET droit = EXCLUDED.droit, nature = EXCLUDED.nature,
               contenance = EXCLUDED.contenance, adresse = EXCLUDED.adresse
      `;
      ecrites += 1;
    }
  }
  return ecrites;
}

// Ce que le registre national fonde : l'état administratif, la création,
// le siège, la nature, les dirigeants. Une société cessée doit se voir
// dans l'analyse (famille 1), pas seulement sur une carte au moment du
// choix du SIREN.
async function ecrireRegistre(sql, dossierId, siren, payload) {
  const fiche = (payload.entreprises ?? []).find((x) => x.siren === siren);
  if (!fiche) return false;
  await sql`
    UPDATE marteau_societe
       SET etat_administratif = ${fiche.active ? 'active' : 'cessee'},
           creee_le = ${fiche.creee_le ?? null},
           siege_registre = ${fiche.siege ?? null},
           nature_juridique = ${fiche.nature_juridique ?? null},
           dirigeants = ${JSON.stringify(fiche.dirigeants ?? [])}::jsonb,
           registre_lu_le = now(),
           denomination = coalesce(denomination, ${fiche.denomination ?? null})
     WHERE dossier_id = ${dossierId} AND siren = ${siren}
  `;
  return true;
}

// Le verdict d'une source, retrouvé par son NOM. `collecterSociete` les
// rend dans l'ordre des sources, mais on ne s'appuie pas sur l'ordre :
// un jour quelqu'un ajoutera une source au milieu.
const verdict = (r, nom) => r.verdicts.find((v) => v.nom === nom);

// PIÈGE À CONNAÎTRE : un verdict servi par le CACHE ne porte pas de
// `donnees` (voir `depuisCache` dans lib/collecte.js). Aujourd'hui ni
// 'photo' ni 'liens' ni 'registre' ne figurent dans CACHE_MS, donc le
// cas ne se produit pas. Le jour où l'un d'eux y entre, les parcelles
// cesseraient d'être écrites SANS AUCUNE ERREUR — d'où ce test explicite
// plutôt qu'un accès direct à `v.donnees`.
const donnees = (v) => (v && v.statut === 'ok' && !v.cache ? v.donnees : null);

// ---------------------------------------------------------------- reprise
// Reprise des appels en souffrance (3e tentative), fusionnée ici depuis
// api/reprise.js le 07/09/2026 : le plan Hobby de Vercel plafonne à DOUZE
// fonctions par déploiement, et la treizième a fait échouer deux builds.
//
// Trois déclencheurs (mémo v4 § 11) : à la main, à l'ouverture du
// dossier — tous deux par POST { action: 'reprise' } —, et le CRON
// QUOTIDIEN vers 3 h, qui passe par GET (voir le handler).
//
// L'authentification ne vit plus ici mais dans le handler, et pour une
// raison précise : elle ne doit s'appliquer QU'AU GET. La garde
// précédente était posée dans cette fonction, donc commune aux deux
// chemins — poser CRON_SECRET aurait fait rendre 401 à la façade, qui
// appelle en POST depuis un navigateur et ne peut évidemment pas porter
// le secret.
async function reprise(req, res) {
  const sql = db();
  // Le SIREN à rappeler est celui de la SOCIÉTÉ de l'appel, et non celui
  // de la tête du dossier. Corrigé le 09/09/2026 : depuis que la collecte
  // renseigne `societe_id`, prendre `d.siren_tete` aurait rephotographié
  // la tête tout en marquant l'appel d'une filiale comme abouti.
  const enSouffrance = await sql`
    SELECT a.id, a.source, a.tentatives, a.dossier_id,
           coalesce(s.siren, d.siren_tete) AS siren
      FROM marteau_appel a
      JOIN marteau_dossier d ON d.id = a.dossier_id
      LEFT JOIN marteau_societe s ON s.id = a.societe_id
     WHERE a.statut IN ('lent', 'en_cours') AND a.tentatives < ${TENTATIVES_MAX}
       AND a.dernier_essai < now() - interval '2 minutes'
     LIMIT 20
  `;
  const reprises = [];
  for (const a of enSouffrance) {
    const chemin = a.source === 'photo' ? '/api/photo'
      : a.source === 'liens' ? '/api/liens'
      : a.source === 'registre' ? '/api/entreprises' : null;
    if (!chemin) continue;
    const params = a.source === 'registre' ? { q: a.siren } : { siren: a.siren };
    const v = await appelBorne(a.source, notre(chemin, params));
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

// ---------------------------------------------------------------- handler

export default async function handler(req, res) {
  // ------------------------------------------------------- le cron
  // Un cron Vercel appelle en GET et ne porte AUCUN corps de requête :
  // c'est la seule raison d'accepter autre chose que POST ici. Branché
  // sur le POST, il aurait rendu 405 toutes les nuits, en silence.
  //
  // Vercel joint automatiquement `Authorization: Bearer $CRON_SECRET`
  // dès que la variable est posée sur le projet.
  //
  // GARDE FERMÉE PAR DÉFAUT : variable absente = 401, et non passage
  // libre. C'est l'inverse de l'écriture précédente
  // (`if (process.env.CRON_SECRET && …)`), qui laissait la reprise
  // ouverte à qui trouvait l'URL — la protection de déploiement étant
  // désactivée sur ce projet, l'URL suffisait.
  if (req.method === 'GET') {
    const attendu = process.env.CRON_SECRET;
    if (!attendu || req.headers.authorization !== `Bearer ${attendu}`) {
      return res.status(401).json({ erreur: 'non autorisé' });
    }
    try { return await reprise(req, res); }
    catch (e) {
      console.error('[MARTEAU] reprise (cron)', e);
      return res.status(500).json({ erreur: e.message });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ erreur: 'POST attendu' });

  if (req.body?.action === 'reprise') {
    try { return await reprise(req, res); }
    catch (e) { console.error('[MARTEAU] reprise', e); return res.status(500).json({ erreur: e.message }); }
  }

  const { dossier, qui } = req.body ?? {};
  if (!dossier || !qui) {
    return res.status(400).json({ erreur: 'dossier et qui sont requis' });
  }

  const t0 = Date.now();

  try {
    const sql = db();

    const [d] = await sql`
      SELECT id, reference, siren_tete FROM marteau_dossier
       WHERE reference = ${dossier}
    `;
    if (!d) return res.status(404).json({ erreur: `dossier ${dossier} inconnu` });

    // ------------------------------------------------ la société auditée
    // La ligne société doit EXISTER avant la collecte : `collecterSociete`
    // travaille sur un identifiant, c'est lui qui porte le suivi par
    // source et le drapeau de complétude. On l'insère donc à vide, quitte
    // à la compléter juste après avec ce que la photographie rend.
    const [tete] = await sql`
      INSERT INTO marteau_societe
        (dossier_id, siren, niveau_confiance, origine, niveau)
      VALUES
        (${d.id}, ${d.siren_tete}, 'structuree', 'accroche', 0)
      ON CONFLICT (dossier_id, siren) DO UPDATE
         SET niveau = marteau_societe.niveau
      RETURNING id
    `;

    // Les trois sources de la tête EN PARALLÈLE. Chacune est bornée à
    // 30 s et ne lève pas : un échec est nommé, jamais silencieux. Le
    // drapeau de complétude n'est posé que si les trois aboutissent.
    const rTete = await collecterSociete(d.id, tete.id, {
      photo: notre('/api/photo', { siren: d.siren_tete }),
      liens: notre('/api/liens', { siren: d.siren_tete }),
      registre: notre('/api/entreprises', { q: d.siren_tete }),
    });

    const vPhoto = verdict(rTete, 'photo');
    const vLiens = verdict(rTete, 'liens');
    const vRegistre = verdict(rTete, 'registre');

    let parcellesEcrites = 0;
    let societesEcrites = 0;
    let registres = 0;

    const pTete = donnees(vPhoto);
    if (pTete) {
      await sql`
        UPDATE marteau_societe
           SET denomination = ${pTete.societe.denomination},
               forme = ${pTete.societe.forme_juridique}
         WHERE id = ${tete.id}
      `;
      societesEcrites += 1;
      parcellesEcrites += await ecrireParcelles(
        sql, d.id, pTete.societe.siren ?? d.siren_tete, pTete, 'accroche',
      );

      if (pTete.tronque || pTete.indisponible?.length) {
        // Journalisé : un audit établi sur un portefeuille tronqué ou
        // partiel doit pouvoir être daté et expliqué après coup.
        await journaliser(d.id, qui, 'photographie partielle', {
          siren: d.siren_tete,
          tronque: Boolean(pTete.tronque),
          indisponible: pTete.indisponible ?? [],
          annonce: pTete.agregats?.total_parcelles_annonce ?? null,
          ecrit: parcellesEcrites,
        });
      }
    }

    const regTete = donnees(vRegistre);
    if (regTete && await ecrireRegistre(sql, d.id, d.siren_tete, regTete)) {
      registres += 1;
    }

    // -------------------------------------------- les sociétés liées
    const l = donnees(vLiens);
    if (l) {
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

    // ------------------------------------- descente sur les filiales
    // Mémo § 4.4 : MARTEAU appelle REDPAR sur CHAQUE société détectée.
    // La descente s'arrête aux personnes morales, et le parallélisme est
    // plafonné à quatre — REDPAR est un service de l'étude, pas une
    // ressource infinie.
    //
    // Ne sont reprises que les sociétés dont la collecte n'est PAS
    // complète : relancer une collecte ne rephotographie donc pas tout
    // le périmètre.
    const filiales = await sql`
      SELECT id, siren, origine FROM marteau_societe
       WHERE dossier_id = ${d.id}
         AND siren <> ${d.siren_tete}
         AND collecte_complete IS NOT TRUE
       ORDER BY niveau, siren
    `;

    let filialesTraitees = 0;
    let filialesRestantes = 0;

    await parLots(filiales, PARALLELISME_REDPAR, async (s) => {
      // Budget dépassé : on laisse la société à false et on la compte.
      // Le prochain appel la reprendra — aucun curseur à conserver.
      if (Date.now() - t0 > BUDGET_MS) { filialesRestantes += 1; return; }

      const r = await collecterSociete(d.id, s.id, {
        photo: notre('/api/photo', { siren: s.siren }),
        registre: notre('/api/entreprises', { q: s.siren }),
      });

      const p = donnees(verdict(r, 'photo'));
      if (p) {
        parcellesEcrites += await ecrireParcelles(
          sql, d.id, s.siren, p, s.origine ?? 'bodacc',
        );
        if (p.tronque || p.indisponible?.length) {
          await journaliser(d.id, qui, 'photographie partielle', {
            siren: s.siren,
            tronque: Boolean(p.tronque),
            indisponible: p.indisponible ?? [],
          });
        }
      }

      const reg = donnees(verdict(r, 'registre'));
      if (reg && await ecrireRegistre(sql, d.id, s.siren, reg)) registres += 1;

      filialesTraitees += 1;
    });

    await journaliser(d.id, qui, 'collecte lancée', {
      photo: vPhoto?.statut, liens: vLiens?.statut, registre: vRegistre?.statut,
      tete_complete: rTete.complete,
      parcelles: parcellesEcrites, societes: societesEcrites, registres,
      filiales: { traitees: filialesTraitees, restantes: filialesRestantes },
    });

    const [{ tete: empreinte }] = await sql`SELECT marteau_journal_tete() AS tete`;

    return res.status(200).json({
      dossier: d.reference,
      volets: {
        photo: vPhoto?.statut, liens: vLiens?.statut, registre: vRegistre?.statut,
      },
      tete_complete: rTete.complete,
      filiales: { traitees: filialesTraitees, restantes: filialesRestantes },
      ecrit: { parcelles: parcellesEcrites, societes: societesEcrites, registres },
      ms: Date.now() - t0,
      // Empreinte de tête de la piste d'audit. À ancrer hors de la base :
      // c'est elle, et non le chaînage seul, qui rend une réécriture
      // opposable.
      journal_tete: empreinte,
    });
  } catch (e) {
    console.error('[MARTEAU] collecter', e);
    return res.status(500).json({ erreur: e.message });
  }
}
