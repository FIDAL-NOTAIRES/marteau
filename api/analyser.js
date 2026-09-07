// MARTEAU — POST /api/analyser
//
// Calcule les voyants des dix familles à partir de ce que la base SAIT
// du dossier — rien d'autre. Aucun appel externe ici : la collecte
// alimente, l'analyse lit. Si une source manque, le voyant le dit, avec
// la raison (règle du 04/09/2026 : jamais un simple « rien relevé »).
//
// Les voyants sont RECALCULABLES : on efface ceux du dossier et on les
// repose. Ce n'est pas la piste d'audit — elle, elle ne s'efface pas, et
// elle reçoit une ligne « analyse calculée » avec le compte par couleur.
//
// Ce qui est calculable aujourd'hui, avec la collecte actuelle :
//   • famille 2 : désignation sur données cadastrales, titre attendu ;
//   • famille 1 : dénominations successives au BODACC (orange si > 1) ;
//   • famille 5 : NATURE DU DROIT — orange dès qu'une parcelle porte un
//     code de droit autre que P (les pastilles orange de la façade) ;
//   • tout le reste ouvre en jaune, chacun avec son motif d'attente.
// Le reste s'allumera source par source, au fur et à mesure des
// branchements (RISQUES, ADEME, Sitadel, TRENTE…).

import { db, journaliser } from '../lib/db.js';
import { PHRASES } from '../lib/phrases.js';

const aujourdhui = () => new Date().toLocaleDateString('fr-FR');

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ erreur: 'POST attendu' });
  const { dossier, qui } = req.body ?? {};
  if (!dossier || !qui) return res.status(400).json({ erreur: 'dossier et qui sont requis' });

  try {
    const sql = db();
    const [d] = await sql`SELECT id, reference, siren_tete FROM marteau_dossier WHERE reference = ${dossier}`;
    if (!d) return res.status(404).json({ erreur: `dossier ${dossier} inconnu` });

    const refs = await sql`SELECT id, famille, code FROM marteau_voyant_ref`;
    const refId = (fam, code) => refs.find((r) => r.famille === fam && r.code === code)?.id;

    const [tete] = await sql`
      SELECT denominations_anterieures FROM marteau_societe
       WHERE dossier_id = ${d.id} AND siren = ${d.siren_tete}
    `;
    const [parc] = await sql`
      SELECT count(*)::int AS total, count(DISTINCT commune_insee)::int AS communes,
             coalesce(sum(contenance),0)::bigint AS contenance,
             -- REDPAR rend le droit sous la forme « P - Propriétaire », « E - Emphytéote » :
             -- un LIBELLÉ, pas un code nu. On teste la première lettre, comme la façade.
             count(*) FILTER (WHERE droit IS NOT NULL AND left(trim(droit), 1) <> 'P')::int AS demembre,
             array_remove(array_agg(DISTINCT droit) FILTER (WHERE droit IS NOT NULL AND left(trim(droit), 1) <> 'P'), NULL) AS codes
        FROM marteau_parcelle WHERE dossier_id = ${d.id} AND en_perimetre
    `;

    // Chaque entrée : [code de phrase, précisions]. Le niveau est le
    // dossier (ni société ni parcelle) sauf indication.
    const voyants = [];
    const poser = (code, precisions = {}) => voyants.push({ code, precisions });

    // 1. identité — le K-bis est demandé par l'étude, jamais au client.
    poser('identite_attente', { date: aujourdhui() });
    // Dénominations distinctes — comparées SANS AUCUNE ESPACE : le BODACC
    // porte des coquilles (« A LO YER MODERE ») qui feraient compter deux
    // fois le même nom. On garde la graphie la plus fréquente pour l'affichage.
    const vues = new Map();
    for (const x of tete?.denominations_anterieures ?? []) {
      const cle = String(x.denomination).toUpperCase().replace(/\s+/g, '');
      const prev = vues.get(cle);
      if (!prev || (x.annonces ?? 0) > (prev.annonces ?? 0)) vues.set(cle, x);
    }
    const denoms = [...vues.values()].map((x) => x.denomination);
    if (denoms.length > 1) {
      poser('identite_denominations', { nombre: denoms.length, denominations: denoms.join(' ; ') });
    }

    // 2. désignation — cadastre seul, titre attendu.
    poser('designation_attente_titre', {
      parcelles: parc.total, communes: parc.communes,
      contenance: Number(parc.contenance).toLocaleString('fr-FR') + ' m²',
    });

    // 3. propriété
    poser('propriete_attente');

    // 4. organisation de l'ensemble — ouvre en jaune par construction.
    poser('organisation_attente');

    // 5. hypothécaire — inscriptions en attente ; nature du droit CALCULÉE.
    poser('hypo_attente', { date: aujourdhui() });
    if (parc.demembre > 0) {
      poser('nature_droit_orange', { parcelles: parc.demembre, codes: (parc.codes ?? []).join(', ') });
    } else if (parc.total > 0) {
      poser('nature_droit_canard');
    }

    // 6. urbanisme — trois volets en attente ; assurance sans travaux connus.
    poser('urba_attente', { date: aujourdhui() });
    poser('zone_attente');
    poser('assurance_attente');

    // 7. diagnostics — ADEME non encore branchée : on le dit.
    poser('diag_liste', { liste: 'liste calculée à venir — usage et arrêtés préfectoraux à déterminer' });

    // 8. environnement — RISQUES non encore appelé : la raison est dite.
    poser('env_non_verifie', { raison: 'le module RISQUES n\'est pas encore raccordé à MARTEAU' });

    // 9. exploitation et contrats
    poser('exploit_attente');
    poser('contrats_attente');

    // 10. fiscalité
    poser('fisc_actif_attente');
    poser('fisc_cession_attente');

    // Écriture. On repose tout : les voyants sont un CALCUL, pas une trace.
    await sql`DELETE FROM marteau_voyant WHERE dossier_id = ${d.id}`;
    const parCouleur = { canard: 0, jaune: 0, orange: 0, carmin: 0 };
    for (const v of voyants) {
      const p = PHRASES[v.code];
      const rid = refId(p.famille, p.voyant);
      if (!rid) continue;
      await sql`
        INSERT INTO marteau_voyant (dossier_id, voyant_ref_id, couleur, phrase_code, precisions)
        VALUES (${d.id}, ${rid}, ${p.couleur}, ${v.code}, ${JSON.stringify(v.precisions)}::jsonb)
      `;
      parCouleur[p.couleur] += 1;
    }

    // ---------------------------------------------------- registre des pièces
    // Chaque jaune attend une pièce précise : le registre les liste comme
    // DEMANDABLES (mémo § 9 — « toutes les pièces demandées ET toutes celles
    // qui sont demandables »). On ne touche pas aux lignes déjà demandées ou
    // reçues ; on repose seulement les demandables, qui sont un calcul.
    //
    // Le K-bis n'y est pas : il est demandé par l'étude elle-même, jamais
    // au client (arbitrage 07/09). L'état hypothécaire a son cycle propre
    // (à saisir → saisie → reçu → analysé), il est saisi au logiciel métier.
    const PIECES = [
      [2,  'piece', 'Titre de propriété',                                        'client'],
      [4,  'piece', 'Règlement de copropriété et état descriptif de division',   'client'],
      [4,  'piece', 'Procès-verbaux d\'assemblée générale (3 derniers exercices)', 'client'],
      [5,  'etat_hypothecaire', 'État hypothécaire',                             'publicite_fonciere'],
      [5,  'piece', 'Copie des actes de prêt en cours et de leurs garanties',    'client'],
      [6,  'piece', 'Liste des autorisations d\'urbanisme délivrées',             'mairie'],
      [6,  'piece', 'Attestations dommages-ouvrage et décennale (travaux < 10 ans)', 'client'],
      [7,  'piece', 'Dossier de diagnostics techniques',                         'client'],
      [8,  'piece', 'État des risques et pollutions',                            'client'],
      [9,  'piece', 'Baux en cours et état locatif',                             'client'],
      [9,  'piece', 'Contrats attachés à l\'immeuble (gestion, entretien, énergie)', 'client'],
      [9,  'piece', 'Autorisations d\'occupation du domaine public',              'client'],
      [10, 'piece', 'Acte d\'acquisition, tableau des immobilisations, factures de travaux, détail du compte 2013', 'expert_comptable'],
    ];
    await sql`DELETE FROM marteau_piece WHERE dossier_id = ${d.id} AND statut IN ('demandable', 'a_saisir')`;
    const dejaLibelles = (await sql`SELECT libelle FROM marteau_piece WHERE dossier_id = ${d.id}`).map((r) => r.libelle);
    let demandables = 0;
    for (const [fam, nature, libelle, dest] of PIECES) {
      if (dejaLibelles.includes(libelle)) continue;
      await sql`
        INSERT INTO marteau_piece (dossier_id, famille, libelle, nature, destinataire_type, statut)
        VALUES (${d.id}, ${fam}, ${libelle}, ${nature}, ${dest},
                ${nature === 'etat_hypothecaire' ? 'a_saisir' : 'demandable'})
      `;
      demandables += 1;
    }

    await journaliser(d.id, String(qui).trim().toUpperCase(), 'analyse calculée', {
      pieces_demandables: demandables,
      voyants: voyants.length, ...parCouleur,
    });
    const [{ tete: empreinte }] = await sql`SELECT marteau_journal_tete() AS tete`;

    return res.status(200).json({ dossier: d.reference, voyants: voyants.length, ...parCouleur, journal_tete: empreinte });
  } catch (e) {
    console.error('[MARTEAU] analyser', e);
    return res.status(500).json({ erreur: e.message });
  }
}
