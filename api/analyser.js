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
//   • famille 2 encore : MOUVEMENT CADASTRAL lu dans HISTO (11/10/2026),
//     jaune et jamais plus ;
//   • tout le reste ouvre en jaune, chacun avec son motif d'attente.
// Le reste s'allumera source par source, au fur et à mesure des
// branchements (RISQUES, XYLO, URBA, ADEME, Sitadel, TRENTE…).
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
const XYLO = process.env.XYLO_BASE || 'https://xylo-phi.vercel.app';
const URBA = process.env.URBA_BASE || 'https://urba-lemon.vercel.app';
const URBA_MAX = 40;   // même plafond que la porte d'URBA

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ erreur: 'POST attendu' });
  const { dossier, qui } = req.body ?? {};
  if (!dossier || !qui) return res.status(400).json({ erreur: 'dossier et qui sont requis' });

  try {
    const sql = db();
    const [d] = await sql`SELECT id, reference, siren_tete, risques FROM marteau_dossier WHERE reference = ${dossier}`;
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

    // Dates de demande RÉELLES (règle du 08/11/2026). Une phrase ne porte
    // une date que si la pièce a été marquée demandée (ou l'état
    // hypothécaire saisi) dans MARTEAU : c'est `premier_envoi_le`, posé une
    // seule fois. Avant, la date était celle du jour de l'analyse — le
    // rapport affirmait une diligence non faite, et la date changeait à
    // chaque relance.
    const envois = await sql`
      SELECT libelle, premier_envoi_le FROM marteau_piece
       WHERE dossier_id = ${d.id} AND premier_envoi_le IS NOT NULL
    `;
    const envoyeLe = (libelle) => {
      const r = envois.find((x) => x.libelle === libelle);
      return r ? new Date(r.premier_envoi_le).toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' }) : null;
    };

    // Chaque entrée : [code de phrase, précisions]. Le niveau est le
    // dossier (ni société ni parcelle) sauf indication.
    const voyants = [];
    const poser = (code, precisions = {}) => voyants.push({ code, precisions });

    // 1. identité — le K-bis est demandé par l'étude, jamais au client.
    // Le K-bis n'a pas de ligne au registre des pièces : aucune date de
    // demande connue, donc la variante sans date.
    poser('identite_a_solliciter');
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

    // Filiation cadastrale (HISTO, 11/10/2026) : parcelles de la société
    // auditée issues d'un mouvement cadastral. Lu en base (colonne `histo`,
    // migration 010) : l'analyse n'appelle jamais HISTO elle-même.
    const mouv = await sql`
      SELECT code_parcelle, commune_nom, histo FROM marteau_parcelle
       WHERE dossier_id = ${d.id} AND en_perimetre AND siren_proprietaire = ${d.siren_tete}
         AND histo IS NOT NULL AND jsonb_array_length(histo) > 0
       ORDER BY commune_nom, code_parcelle`.catch(() => []);   // colonne absente tant que 010 n'est pas passée
    if (mouv.length) {
      const exemples = mouv.slice(0, 8).map((m) => {
        const x = (m.histo ?? [])[0] ?? {};
        // section d'une lettre complétée d'un zéro par le cadastre (« 0Z ») : on retire ce zéro (13/10/2026)
        const lib = String(m.code_parcelle).replace(/^\d{5}0{3}/, '').replace(/^([A-Z0-9]{2})0*(\d+)$/, (x, sec, num) => `${sec.replace(/^0(?=[A-Z])/, '')} ${num}`).trim();
        return `${m.commune_nom ? m.commune_nom + ' ' : ''}${lib}, issue de ${x.nature || 'un mouvement'}${(x.origines ?? []).length ? ' de ' + x.origines.join(', ') : ''}${x.annee ? ' (' + x.annee + ')' : ''}`;
      });
      poser('designation_mouvement_cadastral', {
        nombre: mouv.length,
        detail: exemples.join(' ; ') + (mouv.length > 8 ? ` ; et ${mouv.length - 8} autre(s)` : ''),
      });
    }

    // 3. propriété
    poser('propriete_attente');

    // 4. organisation de l'ensemble — ouvre en jaune par construction.
    poser('organisation_attente');

    // 5. hypothécaire — inscriptions en attente ; nature du droit CALCULÉE
    // sur les seules parcelles de la société auditée : la phrase parle
    // d'elle, elle ne peut pas compter celles des autres.
    { const le = envoyeLe('État hypothécaire');
      if (le) poser('hypo_attente', { date: le }); else poser('hypo_a_solliciter'); }
    if (parc.demembre > 0) {
      poser('nature_droit_orange', { parcelles: parc.demembre, codes: (parc.codes ?? []).join(', ') });
    } else if (parc.total > 0) {
      poser('nature_droit_canard');
    }

    // 6. urbanisme — trois volets en attente ; assurance sans travaux connus.
    { const le = envoyeLe("Liste des autorisations d'urbanisme délivrées");
      if (le) poser('urba_attente', { date: le }); else poser('urba_a_solliciter'); }
    // Organisation de la zone — lue dans URBA (règle validée par JFD le
    // 09/11/2026), interrogé EN DIRECT comme XYLO. Parcelle par parcelle :
    //   - zonage relevé : jaune, zone + document + date d'approbation,
    //     conformité à vérifier au titre ;
    //   - périmètre de zone d'aménagement concerté : orange (zone_cahier)
    //     jusqu'à réception du cahier des charges ;
    //   - servitudes d'utilité publique : listées, jaune, jamais d'orange
    //     automatique ;
    //   - règlement national d'urbanisme ou base injoignable : dit ;
    //   - lotissement : inconnu du Géoportail, demande à la commune maintenue.
    // URBA ne lit pas Sitadel : `autorisations` et `assurance` restent en
    // attente. Le nom de l'outil n'apparaît dans aucune phrase.
    {
      const lesParcelles = await sql`
        SELECT code_parcelle, commune_nom FROM marteau_parcelle
         WHERE dossier_id = ${d.id} AND en_perimetre AND siren_proprietaire = ${d.siren_tete}
         ORDER BY commune_nom, code_parcelle LIMIT ${URBA_MAX}::int
      `;
      let ur = null;
      if (lesParcelles.length) {
        try {
          const ctl = new AbortController();
          const minuterie = setTimeout(() => ctl.abort(), 45000);
          const r = await fetch(URBA + '/api/urbanisme', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ parcelles: lesParcelles.map((x) => x.code_parcelle) }),
            signal: ctl.signal,
          });
          clearTimeout(minuterie);
          if (r.ok) ur = await r.json();
        } catch (e) { console.error('[MARTEAU] URBA injoignable :', e.message); }
      }
      if (!lesParcelles.length) {
        poser('zone_attente');
      } else if (!ur || !ur.parcelles) {
        poser('zone_non_verifie', { raison: "le Géoportail de l'urbanisme n'a pas
