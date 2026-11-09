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
const TRAVAUX = process.env.TRAVAUX_BASE || 'https://travaux-two.vercel.app';
const TRAVAUX_MAX = 20; // même plafond que la porte de TRAVAUX

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

    // 6. urbanisme. TRAVAUX est lancé AVANT URBA et attendu après : les
    // deux interrogations courent en même temps, l'analyse tient en 60 s.
    const parcTravaux = await sql`
      SELECT code_parcelle, commune_nom FROM marteau_parcelle
       WHERE dossier_id = ${d.id} AND en_perimetre AND siren_proprietaire = ${d.siren_tete}
       ORDER BY commune_nom, code_parcelle LIMIT ${TRAVAUX_MAX}::int
    `;
    const promesseTravaux = !parcTravaux.length ? Promise.resolve(null) : (async () => {
      try {
        const ctl = new AbortController();
        const minuterie = setTimeout(() => ctl.abort(), 40000);
        const r = await fetch(TRAVAUX + '/api/autorisations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ parcelles: parcTravaux.map((x) => x.code_parcelle) }),
          signal: ctl.signal,
        });
        clearTimeout(minuterie);
        return r.ok ? await r.json() : null;
      } catch (e) { console.error('[MARTEAU] TRAVAUX injoignable :', e.message); return null; }
    })();
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
        poser('zone_non_verifie', { raison: "le Géoportail de l'urbanisme n'a pas répondu, actualiser le dossier" });
      } else {
        const libP = (code, nom) => {
          const lib = String(code).replace(/^[0-9AB]\d{4}\d{3}/, '')
            .replace(/^([A-Z0-9]{2})0*(\d+)$/, (x, sec, num) => `${sec.replace(/^0(?=[A-Z])/, '')} ${num}`).trim();
          return (nom ? nom + ' ' : '') + lib;
        };
        const LIB_SUP = {
          AC1: 'monument historique', AC2: 'site inscrit ou classé', AC4: 'site patrimonial remarquable',
          AS1: "protection d'un captage d'eau", EL3: 'halage et marchepied', EL7: 'alignement',
          EL9: 'passage sur le littoral', I1: 'hydrocarbures', I3: 'canalisation de gaz',
          I4: 'ligne électrique', INT1: 'voisinage d\'un cimetière', PM1: 'plan de prévention des risques naturels',
          PM3: 'plan de prévention des risques technologiques', PT1: 'télécommunications (perturbations)',
          PT2: 'télécommunications (obstacles)', T1: 'voie ferrée', T4: 'balisage aéronautique',
          T5: 'dégagement aéronautique', T7: 'hors dégagement aéronautique', A4: "cours d'eau non domaniaux",
          A5: "canalisations d'eau et d'assainissement",
        };
        const supTexte = (s) => (LIB_SUP[s.categorie] ? `${s.categorie} (${LIB_SUP[s.categorie]})` : (s.categorie || s.libelle || 'servitude'));
        const morceaux = [], zacs = [], echecs = [];
        for (const x of lesParcelles) {
          const u = ur.parcelles[x.code_parcelle];
          const nom = libP(x.code_parcelle, x.commune_nom);
          if (!u || u.statut !== 'ok') {
            echecs.push(nom + (u && u.statut === 'introuvable' ? ' (parcelle absente du cadastre en ligne)' : ''));
            continue;
          }
          let t = nom + ' : ';
          const zones = [...new Set((u.zones || []).map((z) => z.libelle + (z.libelong ? ' — ' + z.libelong.replace(/\.$/, '') : '')))];
          const TYPE_DOC = { PLU: "plan local d'urbanisme", PLUI: "plan local d'urbanisme intercommunal", POS: "plan d'occupation des sols", CC: 'carte communale', PSMV: 'plan de sauvegarde et de mise en valeur' };
          const docs = (u.documents || []).map((dd) => (TYPE_DOC[String(dd.type || '').toUpperCase()] || dd.type || "document d'urbanisme") + (dd.approuve_le ? ' approuvé le ' + dd.approuve_le : ' (date d\'approbation non publiée sur le Géoportail, à vérifier auprès de la commune)'));
          if (zones.length) t += 'zone ' + zones.join(', ') + (docs.length ? ' du ' + docs.join(', ') : '');
          else if (u.rnu) t += 'commune soumise au règlement national d\'urbanisme, sans document local';
          else if (docs.length) t += docs.join(', ') + ', zonage non publié pour cette parcelle';
          else t += "aucun document publié au Géoportail alors que la commune n'est pas au règlement national d'urbanisme, document à obtenir de la commune";
          const sup = [...new Set((u.servitudes || []).map(supTexte))];
          t += sup.length ? ' ; servitudes d\'utilité publique : ' + sup.join(', ') : ' ; aucune servitude d\'utilité publique publiée';
          if ((u.zac || []).length) { t += ' ; périmètre de zone d\'aménagement concerté : ' + u.zac.join(', '); zacs.push(nom); }
          if (u.partiel) t += ' (certaines couches n\'ont pas répondu, relevé partiel)';
          morceaux.push(t);
        }
        if (!morceaux.length) {
          poser('zone_non_verifie', { raison: "aucune parcelle n'a pu être interrogée sur le Géoportail de l'urbanisme (" + echecs.slice(0, 5).join(' ; ') + ')' });
        } else {
          let detail = morceaux.slice(0, 8).join(' ; ') + (morceaux.length > 8 ? ` ; et ${morceaux.length - 8} autre(s) parcelle(s)` : '');
          if (echecs.length) detail += ' ; non relevé : ' + echecs.slice(0, 5).join(', ') + (echecs.length > 5 ? ` et ${echecs.length - 5} autre(s)` : '');
          const reste = parc.total - lesParcelles.length;
          if (reste > 0) detail += ` ; relevé limité aux ${lesParcelles.length} premières parcelles, ${reste} restant à examiner`;
          poser('zone_urbanisme', { date: aujourdhui(), detail });
          if (zacs.length) poser('zone_cahier');
        }
      }
    }
    // Autorisations et bâti — lus dans TRAVAUX (règles validées par JFD le
    // 09/11/2026). Parcelle par parcelle :
    //   - autorisations trouvées dans Sitadel : jaune, listées ; achèvement
    //     et conformité demandés au client et à la commune ;
    //   - bâti sans autorisation relevée : jaune, autorisations antérieures
    //     demandées à la commune ; si le bâtiment est « apparu » à la BD TOPO
    //     après 2013, on le dit, antériorité à vérifier — JAMAIS d'orange sur
    //     cette date, qui n'est pas une date de construction (arbitrage B) ;
    //   - emprise IGN au-delà de 5 % de l'emprise cadastrale : orange ;
    //   - base injoignable : dit, l'analyse continue.
    // L'assurance n'est plus « non recherchée » dès que Sitadel a répondu.
    {
      const tr = await promesseTravaux;
      const libP = (code, nom) => {
        const lib = String(code).replace(/^[0-9AB]\d{4}\d{3}/, '')
          .replace(/^([A-Z0-9]{2})0*(\d+)$/, (x, sec, num) => `${sec.replace(/^0(?=[A-Z])/, '')} ${num}`).trim();
        return (nom ? nom + ' ' : '') + lib;
      };
      const dFr = (iso) => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : null);
      const TYPE = { PC: 'permis de construire', DP: 'déclaration préalable', PA: "permis d'aménager", PD: 'permis de démolir' };
      const ilYaDixAns = new Date(); ilYaDixAns.setFullYear(ilYaDixAns.getFullYear() - 10);
      const dixAns = ilYaDixAns.toISOString().slice(0, 10);
      if (!parcTravaux.length) {
        poser('assurance_non_verifie', { raison: "aucune parcelle au nom de la société n'est encore connue" });
      } else if (!tr || !tr.parcelles) {
        poser('urba_releve_impossible', { raison: "la base Sitadel n'a pas répondu, actualiser le dossier" });
        poser('assurance_non_verifie', { raison: "la base des autorisations d'urbanisme n'a pas répondu" });
      } else {
        const listes = [], sansAutor = [], ecarts = [], echecs = [], partiels = [], vides = [];
        let recente = false, sitadelOk = 0;
        for (const x of parcTravaux) {
          const t = tr.parcelles[x.code_parcelle];
          const nom = libP(x.code_parcelle, x.commune_nom);
          if (!t || t.statut !== 'ok') { echecs.push(nom); continue; }
          sitadelOk++;
          if ((t.sitadel_partiel || []).length) partiels.push(nom);
          const autor = (t.autorisations || []).filter((a) => a.etat !== 'annulé');
          if (!autor.length) vides.push(nom);
          if (autor.length) {
            listes.push(nom + ' : ' + autor.slice(0, 6).map((a) => {
              let s2 = (TYPE[a.type] || 'autorisation') + (a.numero ? ' n° ' + a.numero : '');
              const quoi = [a.nature, a.famille && a.famille !== 'logements' && a.famille !== 'locaux' ? null : a.famille].filter(Boolean);
              if (quoi.length) s2 += ' (' + quoi.join(', ') + ')';
              if (a.autorise_le) s2 += ', délivré le ' + dFr(a.autorise_le);
              s2 += a.achevement_declare ? ', achèvement déclaré le ' + dFr(a.achevement_declare) : ', achèvement non déclaré à la base';
              return s2;
            }).join(' ; ') + (autor.length > 6 ? ` ; et ${autor.length - 6} autre(s)` : ''));
            if (autor.some((a) => a.autorise_le && a.autorise_le >= dixAns)) recente = true;
          }
          const e = t.emprises;
          if (e && !e.erreur) {
            if (e.ecart_significatif) {
              ecarts.push(nom + ' : ' + e.ign_m2 + ' m² relevés par l\'IGN contre ' + e.cadastre_m2 + ' m² au plan cadastral');
            }
            if (e.bati) {
              const tardifs = (e.batiments || []).filter((b) => b.apparition_ign && b.apparition_ign.slice(0, 4) > '2013'
                && !autor.some((a) => a.autorise_le && a.autorise_le.slice(0, 4) <= b.apparition_ign.slice(0, 4)));
              if (!autor.length || tardifs.length) {
                let t2 = nom;
                if (tardifs.length) t2 += ' : ' + tardifs.slice(0, 3).map((b) => `bâtiment de ${b.aire_m2} m² apparu dans la base de l'IGN en ${b.apparition_ign.slice(0, 4)}, sans permis correspondant, antériorité à vérifier`).join(' ; ');
                else t2 += ' : construction existante sans autorisation relevée depuis 2013';
                sansAutor.push(t2);
              }
            }
          }
        }
        const court = (arr) => arr.slice(0, 8).join(' ; ') + (arr.length > 8 ? ` ; et ${arr.length - 8} autre(s) parcelle(s)` : '');
        const reste = parc.total - parcTravaux.length;
        const suffixe = (echecs.length ? ' ; non relevé : ' + echecs.slice(0, 5).join(', ') : '')
          + (partiels.length ? ' ; relevé partiel (une partie de la base n\'a pas répondu) : ' + partiels.slice(0, 5).join(', ') : '')
          + (reste > 0 ? ` ; relevé limité aux ${parcTravaux.length} premières parcelles, ${reste} restant à examiner` : '');
        if (!sitadelOk) {
          poser('urba_releve_impossible', { raison: "aucune parcelle n'a pu être interrogée sur la base Sitadel (" + echecs.slice(0, 5).join(' ; ') + ')' });
          poser('assurance_non_verifie', { raison: "la base des autorisations d'urbanisme n'a pas répondu" });
        } else {
          if (listes.length) poser('urba_releve', { date: aujourdhui(), detail: court(listes) + suffixe });
          // Pas de doublon : une parcelle bâtie sans autorisation est déjà
          // dite par `urba_sans_autorisation` (constaté sur 2026-0002, 09/11).
          else if (!sansAutor.length) poser('urba_aucune', { date: aujourdhui(), perimetre: court(vides) + suffixe });
          if (sansAutor.length) poser('urba_sans_autorisation', { detail: court(sansAutor) + (listes.length ? '' : suffixe) });
          if (ecarts.length) poser('urba_emprise_ecart', { detail: court(ecarts) });
          if (recente) poser('assurance_attente');
          else poser('assurance_aucun_releve', { date: aujourdhui() });
        }
      }
    }

    // 7. diagnostics — arrêtés termites et mérule lus dans XYLO (règle
    // validée par JFD le 09/11/2026). XYLO est interrogé EN DIRECT à chaque
    // analyse (arbitrage d'août : actualiser = tout recollecter). Le statut
    // est communal : un appel pour toutes les communes de la société
    // auditée. Un arrêté crée une OBLIGATION DE DIAGNOSTIC, pas une
    // difficulté : il alimente la liste des diagnostics attendus, le voyant
    // reste jaune et passe au canard à réception du dossier de diagnostics.
    // Zonage partiel ou XYLO injoignable : la phrase le dit. ADEME (DPE)
    // n'est pas encore branchée.
    {
      const communes = await sql`
        SELECT commune_insee AS insee, max(commune_nom) AS nom
          FROM marteau_parcelle
         WHERE dossier_id = ${d.id} AND en_perimetre AND siren_proprietaire = ${d.siren_tete}
         GROUP BY commune_insee ORDER BY commune_insee
      `;
      const nomC = (c) => (c.nom ? c.nom + ' (' + c.insee + ')' : c.insee);
      const liste = [];
      if (communes.length) {
        let xy = null;
        try {
          const ctl = new AbortController();
          const minuterie = setTimeout(() => ctl.abort(), 8000);
          const r = await fetch(XYLO + '/api/situation', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ insee: communes.map((c) => c.insee) }),
            signal: ctl.signal,
          });
          clearTimeout(minuterie);
          if (r.ok) xy = await r.json();
        } catch (e) { console.error('[MARTEAU] XYLO injoignable :', e.message); }

        if (!xy || !xy.communes) {
          liste.push("situation au regard des arrêtés termites et mérule NON VÉRIFIÉE (la base des arrêtés préfectoraux n'a pas répondu, relancer l'analyse)");
        } else {
          const termites = [], merule = [], partiel = [], aucun = [];
          for (const c of communes) {
            const s = xy.communes[c.insee] || {};
            const date = (b) => (b && (b.date_arrete || b.date_effet))
              ? ' — arrêté du ' + new Date(b.date_arrete || b.date_effet).toLocaleDateString('fr-FR') : '';
            let vise = false;
            for (const [cle, tab] of [['termite', termites], ['merule', merule]]) {
              const b = s[cle];
              if (!b) continue;
              if (b.statut === 'zonage' || b.statut === 'partiel' || b.statut === 'verifier') {
                partiel.push(nomC(c) + ' (' + (cle === 'termite' ? 'termites' : 'mérule') + ')'); vise = true;
              } else if (b.classe) { tab.push(nomC(c) + date(b)); vise = true; }
            }
            if (!vise) aucun.push(nomC(c));
          }
          const court = (t) => t.slice(0, 6).join(' ; ') + (t.length > 6 ? ` ; et ${t.length - 6} autre(s) commune(s)` : '');
          if (termites.length) liste.push('état relatif à la présence de termites (' + court(termites) + ')');
          if (merule.length) liste.push("information de l'acquéreur sur le risque de mérule (" + court(merule) + ')');
          if (partiel.length) liste.push('situation à vérifier sur l\'annexe de l\'arrêté, zonage partiel de la commune (' + court(partiel) + ')');
          if (aucun.length) liste.push('aucun arrêté termites ni mérule, vérifié sur la base des arrêtés préfectoraux le ' + aujourdhui() + ' (' + court(aucun) + ')');
        }
      }
      liste.push("autres diagnostics : liste calculée à venir selon l'usage du bien");
      poser('diag_liste', { liste: liste.join(' ; ') });
    }

    // 8. environnement — lecture du rapport de RISQUES (grille validée par
    // JFD le 08/11/2026). MARTEAU commande le rapport depuis la page du
    // dossier ; il en garde la réponse finale dans `marteau_dossier.risques`,
    // dont `biens[].rubriques[]` (statut de chacune des quinze rubriques).
    //   - pas de rapport, en cours, en échec, ou rapport antérieur au
    //     08/11 (sans rubriques) : jaune, la raison est dite ;
    //   - PPR approuvé (rubriques 1 à 3) au niveau maximal : carmin ;
    //   - PPR approuvé, autre zone : orange ;
    //   - sites et sols pollués « concerné » : orange ;
    //   - une base muette : jaune « partielles » ;
    //   - le reste (sismicité, radon, argiles, bruit…) relève de
    //     l'information de l'acquéreur : jaune, état du client attendu.
    {
      const rq = d.risques || null;
      const biensRq = rq && Array.isArray(rq.biens) ? rq.biens : [];
      if (!rq || !rq.statut) {
        poser('env_non_verifie', { raison: "l'état des risques établi par l'étude n'a pas encore été produit" });
      } else if (rq.statut === 'en_cours') {
        poser('env_non_verifie', { raison: "l'état des risques établi par l'étude est en cours de production" });
      } else if (rq.statut !== 'termine') {
        poser('env_non_verifie', { raison: "l'état des risques établi par l'étude n'a pas abouti et doit être produit de nouveau" });
      } else if (!biensRq.length) {
        poser('env_non_verifie', { raison: 'le rapport de risques du portefeuille est à actualiser pour que ses résultats soient repris ici' });
      } else {
        const nomBien = (b) => 'groupe ' + b.numero + (b.refs && b.refs.length ? ' (' + b.refs.slice(0, 3).join(', ') + (b.refs.length > 3 ? '…' : '') + ')' : '');
        const lister = (items) => items.slice(0, 5).join(' ; ') + (items.length > 5 ? ` ; et ${items.length - 5} autre(s) bien(s)` : '');
        const PPR = ['pprt', 'pprn', 'pprm'];
        const rouge = [], ppr = [], sols = [], muettes = new Set(), introuvables = [];
        for (const b of biensRq) {
          if (b.introuvable) introuvables.push(nomBien(b));
          for (const r of b.rubriques || []) {
            if (r.statut === 'non_obtenu') muettes.add(r.intitule);
            if (r.statut !== 'concerne') continue;
            const texte = nomBien(b) + ' : ' + String(r.phrase || r.intitule || '').replace(/\.$/, '');
            if (PPR.includes(r.cle)) (r.maximal ? rouge : ppr).push(texte);
            else if (r.cle === 'sis') sols.push(texte);
          }
        }
        if (rouge.length) poser('env_zone_rouge', { precision: lister(rouge) });
        if (ppr.length) poser('env_ppr', { precision: lister(ppr) });
        if (sols.length) poser('env_sols_concerne', { precision: lister(sols) });
        if (muettes.size || introuvables.length) {
          const manque = [];
          if (muettes.size) manque.push('rubriques non renseignées : ' + [...muettes].join(', '));
          if (introuvables.length) manque.push('biens non traités : ' + lister(introuvables));
          poser('env_partiel', { precision: manque.join(' ; ') });
        } else {
          poser('env_attente_client');
        }
      }
    }

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
