// MARTEAU — GET /api/liens
// =========================
// La chaine des SIREN. Repond a une seule question, celle du § 7.2 du memo :
// sous quels AUTRES noms et quels AUTRES numeros des biens de cette societe
// peuvent-ils encore etre publies ?
//
// POURQUOI LE BODACC ET PAS UNE API ENTREPRISE (arbitrage du 02/09/2026)
//
// L'API Sirene rendrait l'historique des denominations proprement, mais exige
// une cle INSEE (401 sans cle, verifie). L'API RNE de l'INPI exige un compte
// (401 egalement). La seule source qui porte un vrai `pourcentage_detention`
// est l'API Entreprise de la DGFiP — reservee aux acteurs investis d'une
// mission de service public, donc fermee a l'office, et muette sur les SCI
// puisque les liasses 2059-F/G n'existent qu'au regime reel normal.
//
// Le BODACC, lui, est ouvert, sans cle, sans quota publie — et il porte mieux
// que l'historique des noms : sur une fusion, l'avis nomme la societe
// absorbante ET l'absorbee, avec leurs numeros d'identification, et le champ
// `listeprecedentproprietaire` les rend en JSON STRUCTURE. On ne depend donc
// pas d'une lecture de texte libre pour les numeros eux-memes.
//
// DEUX NIVEAUX DE CONFIANCE, JAMAIS MELANGES
//
//   `structuree` — le SIREN vient d'un champ JSON du BODACC. C'est un fait.
//   `texte`      — le role (absorbante / absorbee) vient de la lecture du
//                  descriptif de l'acte. C'est une lecture, presentee comme
//                  a confirmer.
//
// Un audit notarial ne peut pas reposer sur une extraction automatique de texte
// libre. La machine ratisse et propose, l'humain decide — memo § 13.

const BODACC = 'https://bodacc-datadila.opendatasoft.com/api/explore/v2.1'
  + '/catalog/datasets/annonces-commerciales/records';
const REDPAR = process.env.REDPAR_BASE || 'https://redpar-backend.vercel.app';

const CHAMPS = ['id', 'dateparution', 'familleavis', 'commercant', 'registre',
  'listepersonnes', 'listeprecedentproprietaire', 'listeprecedentexploitant',
  'acte', 'modificationsgenerales', 'url_complete'].join(',');

const propreSiren = (v) => String(v == null ? '' : v).replace(/\D/g, '');
const estSiren = (v) => /^\d{9}$/.test(v);

/** Le BODACC sert ses sous-objets comme des CHAINES de JSON. */
function lire(v) {
  if (!v) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return null; }
}

/** `personne` vaut tantot un objet, tantot un tableau. On rend un tableau. */
function personnes(bloc) {
  const o = lire(bloc);
  if (!o || !o.personne) return [];
  return Array.isArray(o.personne) ? o.personne : [o.personne];
}

function identite(p) {
  const num = p && p.numeroImmatriculation && p.numeroImmatriculation.numeroIdentification;
  return {
    siren: propreSiren(num),
    denomination: ((p && p.denomination) || '').trim() || null,
  };
}

/**
 * Roles d'une fusion, lus dans le descriptif de l'acte. Lecture de texte libre,
 * donc de niveau `texte` : elle QUALIFIE un lien dont le SIREN est deja connu
 * par les champs structures.
 */
function rolesFusion(descriptif) {
  const out = [];
  if (!descriptif) return out;
  const re = /soci[eé]t[eé]s?\s+absorb(ante|[eé]e)s?\s*:\s*([\s\S]*?)(?=soci[eé]t[eé]s?\s+absorb|$)/gi;
  let m;
  while ((m = re.exec(descriptif)) !== null) {
    const role = /ante/i.test(m[1]) ? 'absorbante' : 'absorbée';
    const bloc = m[2] || '';
    const nom = (bloc.split(/\s*[:,]\s*forme/i)[0] || '').trim().replace(/[:,\s]+$/, '');
    const num = (bloc.match(/identification\s*:?\s*([\d\s]{9,15})/i) || [])[1];
    const siren = propreSiren(num);
    if (nom || estSiren(siren)) {
      out.push({ role, denomination: nom || null, siren: estSiren(siren) ? siren : null });
    }
  }
  return out;
}

/** Anciennes denominations annoncees dans une modification. Niveau `texte`. */
function anciensNoms(descriptif) {
  const out = [];
  if (!descriptif) return out;
  const motifs = [
    /\(\s*ancienne\s*:\s*([^)]{2,120})\)/gi,
    /ancienne\s+d[eé]nomination\s*:\s*([^;.]{2,120}?)(?=\s*(?:;|ancienne\b|ancien\b|nouvelle\b|nouveau\b|date\b|à\s+compter|$))/gi,
  ];
  for (const re of motifs) {
    let m;
    while ((m = re.exec(descriptif)) !== null) {
      const n = m[1].trim().replace(/[,;.\s]+$/, '');
      if (n.length > 1) out.push(n);
    }
  }
  return out;
}

/**
 * Le motif dit ce que le lien IMPLIQUE pour l'audit, pas seulement qu'il existe.
 * Les deux roles n'appellent pas le meme travail : sur une absorbee, on cherche
 * ce qui est reste publie a son nom ; sur une absorbante, on verifie que le
 * transfert a bien ete publie sur chaque parcelle de la societe auditee.
 */
function motifAlerte(roles) {
  if (roles.includes('absorbée')) {
    return 'Société absorbée d’après l’avis de fusion — des biens restent inscrits à son nom, '
      + 'la publicité foncière n’a pas suivi sur ces parcelles';
  }
  if (roles.includes('absorbante')) {
    return 'Société absorbante d’après l’avis de fusion — le patrimoine de la société auditée '
      + 'lui revient ; vérifier que le transfert est publié parcelle par parcelle';
  }
  return 'Société liée au registre de l’annonce, à qualifier — des biens sont inscrits à son nom';
}

/** Combien de biens REDPAR trouve-t-il au nom de ce SIREN ? */
async function pese(siren) {
  const un = async (chemin) => {
    try {
      const r = await fetch(`${REDPAR}${chemin}?siren=${siren}&limite=1`, {
        headers: { Accept: 'application/json' },
      });
      if (!r.ok) return null;
      const d = await r.json();
      return typeof d.total === 'number' ? d.total : null;
    } catch { return null; }
  };
  const [p, l] = await Promise.all([un('/api/parcelles'), un('/api/locaux')]);
  return { parcelles: p, locaux: l, interroge: p !== null || l !== null };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const siren = propreSiren((req.query || {}).siren);
  if (!estSiren(siren)) {
    return res.status(400).json({ erreur: 'Paramètre siren requis (9 chiffres)' });
  }

  // ------------------------------------------------------------ 1. le BODACC
  let annonces = [];
  let totalAnnonces = 0;
  try {
    const url = `${BODACC}?where=search(registre%2C%22${siren}%22)`
      + `&select=${encodeURIComponent(CHAMPS)}&order_by=dateparution&limit=100`;
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`BODACC HTTP ${r.status}`);
    const d = await r.json();
    annonces = d.results || [];
    totalAnnonces = d.total_count == null ? annonces.length : d.total_count;
  } catch (e) {
    // Echec explicite : sans le BODACC on ne sait RIEN de la chaine. On ne rend
    // pas une liste vide, qui se lirait comme « aucun lien ».
    return res.status(502).json({
      erreur: 'BODACC indisponible — chaine des SIREN a retraiter',
      motif: String((e && e.message) || e), siren,
    });
  }

  // --------------------------------------------------- 2. noms et SIREN lies
  const noms = new Map();
  const liens = new Map();

  const ajouterNom = (nom, source, niveau) => {
    if (!nom) return;
    const cle = String(nom).toUpperCase().replace(/\s+/g, ' ').trim();
    if (!cle || cle.length < 2) return;
    if (!noms.has(cle)) noms.set(cle, { denomination: String(nom).trim(), sources: [], niveau });
    const e = noms.get(cle);
    if (!e.sources.includes(source)) e.sources.push(source);
    if (niveau === 'structuree') e.niveau = 'structuree';
  };

  const ajouterLien = (id, source, niveau) => {
    if (!estSiren(id.siren) || id.siren === siren) return null;
    if (!liens.has(id.siren)) {
      liens.set(id.siren, { siren: id.siren, denominations: [], roles: [], sources: [], niveau });
    }
    const e = liens.get(id.siren);
    if (id.denomination && !e.denominations.includes(id.denomination)) {
      e.denominations.push(id.denomination);
    }
    if (!e.sources.includes(source)) e.sources.push(source);
    if (niveau === 'structuree') e.niveau = 'structuree';
    return e;
  };

  for (const a of annonces) {
    const source = a.id;

    // Le nom sous lequel l'annonce a ete publiee. Une denomination ancienne
    // apparait ici telle qu'elle etait : c'est de la donnee, pas une lecture.
    // Sur les avis qui nomment deux societes, `commercant` les concatene — on
    // ne le decoupe pas, les noms exacts viennent des champs structures.
    if (a.familleavis !== 'vente') ajouterNom(a.commercant, source, 'structuree');

    for (const p of personnes(a.listepersonnes)) {
      const id = identite(p);
      if (id.siren === siren) ajouterNom(id.denomination, source, 'structuree');
      else ajouterLien(id, source, 'structuree');
    }

    for (const bloc of [a.listeprecedentproprietaire, a.listeprecedentexploitant]) {
      for (const p of personnes(bloc)) {
        const id = identite(p);
        if (id.siren === siren) ajouterNom(id.denomination, source, 'structuree');
        else ajouterLien(id, source, 'structuree');
      }
    }

    // Tout SIREN cite au registre de l'annonce est un lien, meme si aucun champ
    // structure ne le porte : c'est ainsi qu'apparait la contrepartie d'une vente.
    for (const rg of (a.registre || [])) {
      const s = propreSiren(rg);
      if (estSiren(s) && s !== siren) ajouterLien({ siren: s, denomination: null }, source, 'structuree');
    }

    // Lectures de texte libre : elles QUALIFIENT, elles n'etablissent pas.
    const acte = lire(a.acte);
    for (const r of rolesFusion(acte && acte.descriptif)) {
      if (r.siren && r.siren !== siren) {
        const e = ajouterLien({ siren: r.siren, denomination: r.denomination }, source, 'structuree');
        if (e && !e.roles.includes(r.role)) e.roles.push(r.role);
      } else if (r.siren === siren && r.denomination) {
        ajouterNom(r.denomination, source, 'texte');
      }
    }

    const modif = lire(a.modificationsgenerales);
    for (const n of anciensNoms(modif && modif.descriptif)) ajouterNom(n, source, 'texte');
  }

  // ------------------------------------- 3. que trouve REDPAR sous ces SIREN
  // Debit limite, comme l'exige l'addendum § 2 : on n'inonde pas nos propres API.
  const listeLiens = [...liens.values()];
  for (let i = 0; i < listeLiens.length; i += 4) {
    const lot = listeLiens.slice(i, i + 4);
    await Promise.all(lot.map(async (l) => { l.biens = await pese(l.siren); }));
  }

  // Une alerte n'est levee que si des biens EXISTENT sous ce SIREN. Un lien
  // societaire sans aucun bien n'a pas a encombrer l'ecran de l'audit.
  const alertes = listeLiens
    .filter((l) => l.biens && ((l.biens.parcelles || 0) + (l.biens.locaux || 0)) > 0)
    .sort((a, b) => ((b.biens.parcelles || 0) + (b.biens.locaux || 0))
      - ((a.biens.parcelles || 0) + (a.biens.locaux || 0)));

  const url = (id) => `https://www.bodacc.fr/pages/annonces-commerciales-detail/?q.id=id:${id}`;

  return res.status(200).json({
    siren,
    genere_le: new Date().toISOString(),
    source: 'BODACC (DILA), Licence Ouverte 2.0 — annonces commerciales',
    annonces_lues: annonces.length,
    annonces_total: totalAnnonces,
    tronque: totalAnnonces > annonces.length,

    // Les noms sous lesquels des biens peuvent etre publies. C'est CETTE liste
    // qu'on porte au fichier immobilier, pas seulement la denomination du jour.
    // Sources plafonnees : une denomination portee par cinquante annonces n'a
    // pas besoin de cinquante liens pour etre justifiable, il en faut un.
    denominations: [...noms.values()].map((n) => ({
      denomination: n.denomination, niveau: n.niveau,
      annonces: n.sources.length,
      sources: n.sources.slice(0, 3).map(url),
    })),

    societes_liees: listeLiens.map((l) => ({
      siren: l.siren, denominations: l.denominations, roles: l.roles,
      niveau: l.niveau, biens: l.biens, sources: l.sources.map(url),
    })),

    alertes_perimetre: alertes.map((l) => ({
      siren: l.siren,
      denomination: l.denominations[0] || null,
      roles: l.roles,
      parcelles: l.biens.parcelles, locaux: l.biens.locaux,
      motif: motifAlerte(l.roles),
      a_confirmer: l.roles.length === 0,
      sources: l.sources.map(url),
    })),

    avertissement: 'La machine détecte et propose ; aucune parcelle n’entre au périmètre '
      + 'sans validation humaine. Les rôles de fusion sont lus dans le descriptif de l’avis '
      + '(texte libre) et sont à confirmer sur l’acte.',
  });
}
