// MARTEAU — GET /api/entreprises?q=logis
//
// L'étape « Vérification SIREN », reprise de REDPAR : avant toute
// photographie, on identifie la société dans l'annuaire officiel des
// entreprises (API Recherche d'entreprises, gouv.fr — gratuite, sans clé)
// et on fait CHOISIR. Une société s'identifie à son siège et à ses
// dirigeants, pas à son nombre de parcelles.
//
// La machine propose, l'humain décide : rien n'est photographié tant
// qu'une carte n'a pas été choisie. Même écran que REDPAR, même geste —
// un seul réflexe pour les collaborateurs.
//
// Côté serveur plutôt que dans le navigateur : pour ne dépendre ni de la
// politique CORS de l'API, ni de son format s'il change — un seul endroit
// à corriger.

const API = 'https://recherche-entreprises.api.gouv.fr/search';

export default async function handler(req, res) {
  const q = String(req.query?.q ?? '').trim();
  if (q.length < 2) return res.status(400).json({ erreur: 'q requis (2 caractères minimum)' });

  try {
    const url = new URL(API);
    url.searchParams.set('q', q);
    url.searchParams.set('per_page', '10');
    // Personnes morales seulement : le cadastre (MAJIC) ne connaît pas
    // les personnes physiques, inutile de les proposer.
    url.searchParams.set('est_entrepreneur_individuel', 'false');
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`annuaire des entreprises — HTTP ${r.status}`);
    const d = await r.json();

    const entreprises = (d.results ?? []).map((x) => ({
      siren: x.siren,
      denomination: x.nom_raison_sociale || x.nom_complet || '',
      sigle: x.sigle || null,
      active: x.etat_administratif === 'A',
      categorie: x.categorie_entreprise || null,
      creee_le: x.date_creation || null,
      nature_juridique: x.nature_juridique || null,
      ape: x.activite_principale || null,
      // `adresse` contient déjà code postal et commune : ne pas les rajouter,
      // sinon « 75016 PARIS 75016 PARIS ». On ne complète que si elle manque.
      siege: x.siege
        ? (x.siege.adresse || [x.siege.code_postal, x.siege.libelle_commune].filter(Boolean).join(' ') || null)
        : null,
      dirigeants: (x.dirigeants ?? []).slice(0, 4).map((p) => ({
        nom: [p.prenoms, p.nom].filter(Boolean).join(' ') || p.denomination || '',
        qualite: p.qualite || null,
      })),
    }));

    return res.status(200).json({
      recherche: q, total: d.total_results ?? entreprises.length, entreprises,
      source: 'API Recherche d\'entreprises — gouv.fr',
    });
  } catch (e) {
    // Échec explicite : sans l'annuaire on ne sait pas identifier, on ne
    // devine pas à la place du collaborateur.
    return res.status(502).json({ erreur: 'annuaire des entreprises indisponible — saisir le SIREN directement', motif: e.message });
  }
}
