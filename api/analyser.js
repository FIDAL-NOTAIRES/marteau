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
//
// ---------------------------------------------------------------------
// VENTILATION PAR SOCIÉTÉ — correction du 11/09/2026
//
// Depuis la descente sur les filiales (mémo § 4.4, codée le 09/09), le
// périmètre contient les parcelles des sociétés LIÉES en plus de celles
// de la société auditée : sur 2026-0001, 1 636 au nom de LOGIS MÉTROPOLE
// et 2 192 au nom de HABITAT DU NORD, sa société absorbante.
//
// Les agrégats de ce fichier comptaient TOUTES les parcelles du
// périmètre sans distinguer `siren_proprietaire`. Deux phrases s'en
// trouvaient fausses, et de la pire façon — plausibles :
//
//   • la DÉSIGNATION annonçait 3 828 parcelles et la contenance cumulée
//     comme étant le bien de la société auditée ;
//   • la NATURE DU DROIT comptait les parcelles démembrées des autres
//     sociétés dans une phrase qui dit « la société auditée n'est
//     titulaire que d'un droit… ».
//
// Les deux ne portent désormais QUE sur les parcelles publiées au nom de
// la société auditée. Le reste du périmètre fait l'objet d'un voyant
// distinct, `designation_perimetre_elargi`, qui le nomme société par
// société. NE PAS refusionner ces compteurs : l'information est en base
// (`siren_proprietaire`), c'est la restitution qui doit la porter.
// ---------------------------------------------------------------------

import { db, journaliser } from '../lib/db.js';
import { PHRASES } from '../lib/phrases.js';
import { sousFamille, voyantsAlimentesPar, cheminDrive } from '../lib/nomenclature.js';

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
      SELECT denominations_anterieures, etat_administratif FROM marteau_societe
       WHERE dossier_id = ${d.id} AND siren = ${d.siren_tete}
    `;
    const [absorbante] = await sql`
      SELECT siren, denomination FROM marteau_societe
       WHERE dossier_id = ${d.id} AND role_fusion = 'absorbante' ORDER BY id LIMIT 1
    `;
    // Tous les compteurs sont FILTRÉS sur la société auditée, sauf
    // `autres` qui compte le reste du périmètre. Voir l'en-tête : ne pas
    // retirer les FILTER, ils sont la correction.
    const [parc] = await sql`
      SELECT count(*) FILTER (WHERE siren_proprietaire = ${d.siren_tete})::int AS total,
             count(DISTINCT commune_insee) FILTER (WHERE siren_proprietaire = ${d.siren_tete})::int AS communes,
             coalesce(sum(contenance) FILTER (WHERE siren_proprietaire = ${d.siren_tete}), 0)::bigint AS contenance,
             -- REDPAR rend le droit sous la forme « P - Propriétaire », « E - Emphytéote » :
             -- un LIBELLÉ, pas un code nu. On teste la première lettre, comme la façade.
             count(*) FILTER (WHERE siren_proprietaire = ${d.siren_tete}
                                AND droit IS NOT NULL AND left(trim(droit), 1) <> 'P')::int AS demembre,
             array_remove(array_agg(DISTINCT droit) FILTER (WHERE siren_proprietaire = ${d.siren_tete}
                                AND droit IS NOT NULL AND left(trim(droit), 1) <> 'P'), NULL) AS codes,
             count(*) FILTER (WHERE siren_proprietaire IS DISTINCT FROM ${d.siren_tete})::int AS autres
        FROM marteau_parcelle WHERE dossier_id = ${d.id} AND en_perimetre
    `;

    // Le détail du périmètre élargi, société par société. La dénomination
    // vient de marteau_societe quand elle y est ; à défaut le SIREN seul,
    // jamais un trou.
    const autresSocietes = parc.autres > 0 ? await sql`
      SELECT p.siren_proprietaire AS siren, s.denomination,
             count(*)::int AS parcelles,
             coalesce(sum(p.contenance), 0)::bigint AS contenance
        FROM marteau_parcelle p
        LEFT JOIN marteau_societe s
               ON s.dossier_id = p.dossier_id AND s.siren = p.siren_proprietaire
       WHERE p.dossier_id = ${d.id} AND p.en_perimetre
         AND p.siren_proprietaire IS DISTINCT FROM ${d.siren_tete}
       GROUP BY p.siren_proprietaire, s.denomination
       ORDER BY count(*) DESC
    ` : [];

    // Chaque entrée : [code de phrase, précisions]. Le niveau est le
    // dossier (ni société ni parcelle) sauf indication.
    const voyants = [];
    const poser = (code, precisions = {}) => voyants.push({ code, precisions });

    // 1. identité — le K-bis est demandé par l'étude, jamais au client.
    poser('identite_attente', { date: aujourdhui() });
    // Société auditée CESSÉE au registre : au moins orange. Si le BODACC a
    // désigné une absorbante, c'est la discordance du mémo — le vendeur au
    // titre n'est plus la société immatriculée — donc carmin.
    if (tete?.etat_administratif === 'cessee') {
      if (absorbante) poser('identite_absorbee', { absorbante: absorbante.denomination ?? '', siren: absorbante.siren });
      else poser('identite_cessee');
    }
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

    // 2. désignation — cadastre seul, titre attendu. Les chiffres sont
    // ceux de la SOCIÉTÉ AUDITÉE et d'elle seule.
    poser('designation_attente_titre', {
      parcelles: parc.total, communes: parc.communes,
      contenance: Number(parc.contenance).toLocaleString('fr-FR') + ' m²',
    });
    // Le reste du périmètre, nommé. Voyant distinct, pas une nuance
    // glissée dans la phrase précédente : ce sont deux constats de nature
    // différente, l'un désigne un bien, l'autre signale ce qui n'en est
    // pas encore un.
    if (parc.autres > 0) {
      const detail = autresSocietes.map((s) => {
        const nom = s.denomination || `SIREN ${s.siren}`;
        return `${nom} (SIREN ${s.siren}) : ${s.parcelles} parcelle(s), `
          + `${Number(s.contenance).toLocaleString('fr-FR')} m²`;
      }).join(' ; ');
      poser('designation_perimetre_elargi', { autres: parc.autres, detail });
    }

    // 3. propriété
    poser('propriete_attente');

    // 4. organisation de l'ensemble — ouvre en jaune par construction.
    poser('organisation_attente');

    // 5. hypothécaire — inscriptions en attente ; nature du droit CALCULÉE
    // sur les seules parcelles de la société auditée : la phrase parle
    // d'elle, elle ne peut pas compter celles des autres.
    poser('hypo_attente', { date: aujourdhui() });
    if (parc.demembre > 0) {
      poser('nature_droit_orange', { parcelles: parc.demembre, codes: (parc.codes ?? []).join(', ') });
    } else if (parc.total > 0) {
      poser('nature_droit_canard');
    }

    // 6. urbanisme — trois volets en attente ; assurance sans travaux connus.
    poser('urba_attente', { date: aujourdhui() });
    poser('zone_attente');
    // Pas `assurance_attente` : elle affirmerait des travaux relevés,
    // alors qu'aucune source d'autorisations n'est encore lue.
    poser('assurance_non_verifie', {
      raison: "le recensement des autorisations d'urbanisme n'est pas encore raccordé à MARTEAU",
    });

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
      // Un code de phrase inconnu ne doit pas faire tomber toute
      // l'analyse : on le compte à part et on continue.
      if (!p) { console.error('[MARTEAU] bloc de phrase inconnu :', v.code); continue; }
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
    //
    // Chaque pièce porte MAINTENANT son code documentaire : c'est lui qui
    // donne le sous-dossier Drive et le nom de fichier attendu. Les deux
    // colonnes sont indépendantes — `famille` est l'axe d'ANALYSE (quel
    // voyant bouge), `code_doc` l'axe DOCUMENTAIRE (où le fichier vit).
    // Ne JAMAIS déduire l'un de l'autre : les familles 2 et 3 sont
    // inversées entre les deux axes (mémo v5 § 21).
    const PIECES = [
      // famille, nature, libellé, destinataire, code documentaire
      [2,  'piece', 'Titre de propriété',                                        'client',              '021'],
      [4,  'piece', 'Règlement de copropriété et état descriptif de division',   'client',              '042'],
      [4,  'piece', 'Procès-verbaux d\'assemblée générale (3 derniers exercices)', 'client',              '042'],
      [5,  'etat_hypothecaire', 'État hypothécaire',                             'publicite_fonciere',  '051'],
      [5,  'piece', 'Copie des actes de prêt en cours et de leurs garanties',    'client',              '053'],
      [6,  'piece', 'Liste des autorisations d\'urbanisme délivrées',             'mairie',              '062'],
      [6,  'piece', 'Attestations dommages-ouvrage et décennale (travaux < 10 ans)', 'client',          '095'],
      [7,  'piece', 'Dossier de diagnostics techniques',                         'client',              '071'],
      [8,  'piece', 'État des risques et pollutions',                            'client',              '081'],
      // Le libellé couvre commerciaux ET habitation (091 et 092). Rangé en
      // 091 par défaut : le portefeuille audité est commercial dans la
      // quasi-totalité des cas. À scinder en deux pièces si un dossier
      // porte de l'habitation — signalé par verifierRangement().
      [9,  'piece', 'Baux en cours et état locatif',                             'client',              '091'],
      [9,  'piece', 'Contrats attachés à l\'immeuble (gestion, entretien, énergie)', 'client',          '094'],
      // ÉCART CONNU, en attente d'arbitrage JFD : la 023 (titres
      // d'occupation dont la société est bénéficiaire) alimente
      // `nature_droit`, qui est en famille d'analyse 5 — pas 9. Une AOT du
      // domaine public est consentie À la société, elle relève donc du
      // droit détenu. La famille reste à 9 tant que ce n'est pas tranché,
      // et verifierRangement() le signale au lieu de le taire.
      [9,  'piece', 'Autorisations d\'occupation du domaine public',              'client',              '023'],
      [10, 'piece', 'Acte d\'acquisition, tableau des immobilisations, factures de travaux, détail du compte 2013', 'expert_comptable', '101'],
    ];

    // Contrôle de rangement : la famille d'analyse déclarée doit figurer
    // parmi celles des voyants que le code documentaire alimente. Un
    // écart n'est pas bloquant — il est RENDU, comme le recoupement de
    // /api/sante, parce qu'un mauvais rangement est un défaut silencieux :
    // la pièce arrive, elle est simplement classée là où personne ne la
    // cherchera.
    const verifierRangement = () => {
      const ecarts = [];
      for (const [fam, , libelle, , code] of PIECES) {
        const sf = sousFamille(code);
        if (!sf) {
          ecarts.push(`« ${libelle} » : code documentaire ${code} inconnu`);
          continue;
        }
        const familles = voyantsAlimentesPar(code).map((v) => v.famille);
        if (!familles.includes(fam)) {
          ecarts.push(
            `« ${libelle} » : rangée en ${code} (${sf.libelle}), qui alimente `
            + `la famille ${familles.join(' et ') || 'aucune'}, mais déclarée en famille ${fam}`,
          );
        }
      }
      return ecarts;
    };
    const ecartsRangement = verifierRangement();
    await sql`DELETE FROM marteau_piece WHERE dossier_id = ${d.id} AND statut IN ('demandable', 'a_saisir')`;
    const dejaLibelles = (await sql`SELECT libelle FROM marteau_piece WHERE dossier_id = ${d.id}`).map((r) => r.libelle);
    let demandables = 0;
    for (const [fam, nature, libelle, dest, code] of PIECES) {
      if (dejaLibelles.includes(libelle)) continue;
      await sql`
        INSERT INTO marteau_piece (dossier_id, famille, libelle, nature, destinataire_type, statut, code_doc)
        VALUES (${d.id}, ${fam}, ${libelle}, ${nature}, ${dest},
                ${nature === 'etat_hypothecaire' ? 'a_saisir' : 'demandable'}, ${code})
      `;
      demandables += 1;
    }

    await journaliser(d.id, String(qui).trim().toUpperCase(), 'analyse calculée', {
      pieces_demandables: demandables,
      voyants: voyants.length, ...parCouleur,
      // La ventilation part au journal : un audit doit pouvoir dire, après
      // coup, sur quel périmètre il a été établi.
      parcelles: { auditee: parc.total, autres: parc.autres },
    });
    const [{ tete: empreinte }] = await sql`SELECT marteau_journal_tete() AS tete`;

    // Le rangement attendu, DÉDUIT du code — jamais stocké, sinon il y
    // aurait deux vérités à maintenir. C'est ce que l'écran affiche à côté
    // de chaque pièce et ce que le mail de demande rappellera.
    const rangement = PIECES.map(([, , libelle, , code]) => ({
      libelle, code, sous_famille: sousFamille(code)?.libelle ?? null,
      chemin: cheminDrive(code),
    }));

    return res.status(200).json({
      dossier: d.reference,
      voyants: voyants.length,
      ...parCouleur,
      parcelles: {
        auditee: parc.total,
        autres: parc.autres,
        detail: autresSocietes.map((s) => ({
          siren: s.siren, denomination: s.denomination ?? null,
          parcelles: s.parcelles, contenance: Number(s.contenance),
        })),
      },
      rangement,
      ...(ecartsRangement.length ? { anomalies_rangement: ecartsRangement } : {}),
      journal_tete: empreinte,
    });
  } catch (e) {
    console.error('[MARTEAU] analyser', e);
    return res.status(500).json({ erreur: e.message });
  }
}
