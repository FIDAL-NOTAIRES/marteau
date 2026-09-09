// Contrôle de santé. Même parti que celui de MATRICE, et pour la même
// raison : sans lui, on diagnostique une base mal branchée en créant des
// dossiers de test.
//
// Présence des variables, JAMAIS leur valeur.

import { db } from '../lib/db.js';
import { verifier as verifierNomenclature, VOYANTS } from '../lib/nomenclature.js';

const TABLES = [
  'marteau_famille', 'marteau_voyant_ref', 'marteau_dossier',
  'marteau_societe', 'marteau_unite_fonciere', 'marteau_groupe',
  'marteau_parcelle', 'marteau_voyant', 'marteau_piece',
  'marteau_reserve', 'marteau_photo', 'marteau_rapport',
  'marteau_journal', 'marteau_appel',
];

export default async function handler(req, res) {
  const t0 = Date.now();

  const config = {
    DATABASE_URL: Boolean(process.env.DATABASE_URL),
    REDPAR_BASE: Boolean(process.env.REDPAR_BASE),
    CRON_SECRET: Boolean(process.env.CRON_SECRET),
    MARTEAU_CODE_LEVEE: Boolean(process.env.MARTEAU_CODE_LEVEE),
  };

  const rapport = {
    service: 'MARTEAU',
    le: new Date().toISOString(),
    node: process.version,
    // La région se LIT à l'exécution, elle ne se croit pas sur un
    // réglage. La région de BUILD reste iad1 : ne pas confondre.
    execution: {
      region: process.env.VERCEL_REGION || null,
      environnement: process.env.VERCEL_ENV || null,
      commit: (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) || null,
    },
    config,
    base: null,
    tables: null,
    referentiel: null,
    nomenclature: null,
    journal: null,
  };

  // Cohérence du plan de nommage — contrôle PUREMENT CODE, donc placé
  // avant tout accès à la base : il doit répondre même DATABASE_URL
  // absente. Un voyant orphelin est une pièce que personne ne demandera
  // jamais, et le défaut est SILENCIEUX — le rapport sort, simplement il
  // ne dit rien sur ce voyant. C'est le seul endroit où l'oubli se
  // rattrape.
  const nom = verifierNomenclature();
  rapport.nomenclature = {
    familles: nom.familles,
    sous_familles: nom.sous_familles,
    voyants: nom.voyants,
    etat: nom.sain ? 'coherente' : 'INCOHÉRENTE',
    ...(nom.sain ? {} : { anomalies: nom.anomalies }),
  };

  if (!config.DATABASE_URL) {
    rapport.base = 'DATABASE_URL absente';
    rapport.etat = 'incomplet';
    rapport.ms = Date.now() - t0;
    return res.status(503).json(rapport);
  }

  try {
    const sql = db();

    const presentes = await sql`
      SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY(${TABLES})
    `;
    const trouvees = presentes.map((r) => r.table_name);
    const manquantes = TABLES.filter((t) => !trouvees.includes(t));

    rapport.base = 'joignable';
    rapport.tables = manquantes.length
      ? { etat: 'INCOMPLÈTES', manquantes }
      : { etat: 'complètes', nombre: trouvees.length };

    // Le référentiel doit être complet ET annoté : une famille sans note
    // fixe sort un rendu amputé de son en-tête, et personne ne le
    // remarquerait avant de relire un rapport.
    const [ref] = await sql`
      SELECT (SELECT count(*) FROM marteau_famille)                        AS familles,
             (SELECT count(*) FROM marteau_famille WHERE note_fixe IS NULL) AS sans_note,
             (SELECT count(*) FROM marteau_voyant_ref)                      AS voyants
    `;
    rapport.referentiel = {
      familles: Number(ref.familles),
      voyants: Number(ref.voyants),
      etat: Number(ref.familles) === 10 && Number(ref.voyants) === 21
        && Number(ref.sans_note) === 0
        ? 'complet'
        : `INCOMPLET — ${ref.sans_note} famille(s) sans note fixe`,
    };

    // Recoupement des DEUX AXES : les voyants que le plan de nommage
    // prétend alimenter contre ceux qui existent vraiment en base.
    //
    // Rappel du piège (mémo v4 § 21) : l'axe d'analyse et l'axe
    // documentaire ne coïncident pas, et les familles 2 et 3 sont
    // inversées. La table de correspondance est donc écrite en dur dans
    // lib/nomenclature.js — ce qui veut dire qu'elle peut dériver du
    // référentiel en base sans que rien ne le signale. Ce contrôle est
    // ce qui rend la dérive visible.
    const refVoyants = await sql`SELECT famille, code FROM marteau_voyant_ref`;
    const enBase = new Map(refVoyants.map((r) => [r.code, Number(r.famille)]));
    const ecarts = [];

    for (const [code, v] of Object.entries(VOYANTS)) {
      if (!enBase.has(code)) {
        ecarts.push(`« ${code} » est alimenté par le plan de nommage mais absent du référentiel en base`);
      } else if (enBase.get(code) !== v.famille) {
        ecarts.push(`« ${code} » : famille ${v.famille} dans le code, ${enBase.get(code)} en base`);
      }
    }
    for (const code of enBase.keys()) {
      if (!VOYANTS[code]) {
        ecarts.push(`« ${code} » existe en base mais aucune sous-famille documentaire ne l'alimente`);
      }
    }

    rapport.nomenclature.recoupement = ecarts.length
      ? { etat: 'DÉRIVE', ecarts }
      : { etat: 'concordant', voyants: enBase.size };

    // Deux garanties de nature différente, à ne pas confondre dans le
    // diagnostic.
    //
    //   • Les TRIGGERS protègent contre l'accident. Un trigger désactivé
    //     ne se voit nulle part dans l'interface Neon : ce contrôle est
    //     le seul endroit où l'oubli se rattrape.
    //   • Le CHAÎNAGE prouve. Sur Neon, tout rôle hérite de
    //     `neon_superuser` et peut donc baisser un trigger ; c'est
    //     l'empreinte chaînée, et elle seule, qui rend une réécriture
    //     détectable.
    const triggers = await sql`
      SELECT tgname, tgenabled FROM pg_trigger
       WHERE tgname LIKE 'marteau_journal%'
    `;
    const eteints = triggers.filter((t) => t.tgenabled !== 'O');

    const ruptures = await sql`SELECT id, le, motif FROM marteau_journal_verifier()`;
    const [{ tete }] = await sql`SELECT marteau_journal_tete() AS tete`;
    const [{ lignes }] = await sql`SELECT count(*)::int AS lignes FROM marteau_journal`;

    rapport.journal = {
      lignes,
      triggers: eteints.length
        ? { etat: 'DÉSACTIVÉS', lesquels: eteints.map((t) => t.tgname) }
        : { etat: 'actifs', nombre: triggers.length },
      chaine: ruptures.length
        ? { etat: 'ROMPUE', ruptures }
        : { etat: lignes ? 'intègre' : 'vide — aucun événement journalisé' },
      // Valeur à ANCRER HORS DE LA BASE. Elle apparaît ici pour passer
      // dans les journaux Vercel, et chaque rapport généré la portera.
      // Sans cet ancrage, le chaînage se recalcule et ne prouve rien.
      tete,
    };

    rapport.etat = rapport.tables.etat === 'complètes'
      && rapport.referentiel.etat === 'complet'
      && rapport.nomenclature.etat === 'coherente'
      && rapport.nomenclature.recoupement.etat === 'concordant'
      && !eteints.length && !ruptures.length
      ? 'operationnel' : 'incomplet';
  } catch (e) {
    rapport.base = `INJOIGNABLE — ${e.message}`;
    rapport.etat = 'incomplet';
  }

  rapport.ms = Date.now() - t0;
  return res.status(rapport.etat === 'operationnel' ? 200 : 503).json(rapport);
}
