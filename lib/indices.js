// MARTEAU — lib/indices.js — INDICES INSEE ET LOYER INDEXÉ (10/11/2026)
//
// Règle validée par JFD le 09/11/2026 : la dernière quittance est comparée
// au loyer du bail actualisé par son indice ; AUCUNE MARGE, sauf l'arrondi
// au centime ; tout écart → orange, chiffré.
//
// Source : séries de l'INSEE (Banque de données macro-économiques), en
// accès libre et sans clé, au format SDMX. Une série est lue une fois par
// exécution de l'analyse.
//   ILC  001532540 (base 100 au 1er trimestre 2008)
//   ILAT 001617112 (base 100 au 1er trimestre 2010)
//   ICC  000008630
//   IRL  001515333
//
// Calcul (indexation annuelle à la date anniversaire, clause d'échelle
// mobile usuelle) : loyer de l'année n = loyer de base × indice du même
// trimestre n années après le trimestre de référence ÷ indice de
// référence. Le calcul ne connaît ni les avenants, ni les révisions
// triennales judiciaires, ni le plafonnement de 3,5 % de la loi du
// 16 août 2022 : la phrase le rappelle quand l'écart est en faveur du
// preneur.

const SERIES = { ILC: '001532540', ILAT: '001617112', ICC: '000008630', IRL: '001515333' };
const cache = new Map();

export async function serie(indice) {
  const id = SERIES[indice];
  if (!id) throw new Error('indice inconnu : ' + indice);
  if (cache.has(id)) return cache.get(id);
  const ctl = new AbortController();
  const minuteur = setTimeout(() => ctl.abort(), 15000);
  try {
    let r = await fetch('https://www.bdm.insee.fr/series/sdmx/data/SERIES_BDM/' + id, { signal: ctl.signal, headers: { Accept: 'application/xml' } }).catch(() => null);
    if (!r || !r.ok) r = await fetch('https://bdm.insee.fr/series/sdmx/data/SERIES_BDM/' + id, { signal: ctl.signal, headers: { Accept: 'application/xml' } });
    if (!r.ok) throw new Error('INSEE ' + r.status);
    const xml = await r.text();
    const valeurs = {};
    const motif = /<Obs\b[^>]*?TIME_PERIOD="(\d{4})-Q([1-4])"[^>]*?OBS_VALUE="([\d.]+)"/g;
    let m;
    while ((m = motif.exec(xml))) valeurs[m[1] + '-' + m[2]] = Number(m[3]);
    // Certaines réponses placent OBS_VALUE avant TIME_PERIOD.
    const inverse = /<Obs\b[^>]*?OBS_VALUE="([\d.]+)"[^>]*?TIME_PERIOD="(\d{4})-Q([1-4])"/g;
    while ((m = inverse.exec(xml))) valeurs[m[2] + '-' + m[3]] = Number(m[1]);
    if (!Object.keys(valeurs).length) throw new Error('série INSEE illisible');
    cache.set(id, valeurs);
    return valeurs;
  } finally {
    clearTimeout(minuteur);
  }
}

const cle = (annee, trimestre) => annee + '-' + trimestre;

// trimestre_reference : « 4T2018 » (format de lib/lecture.js)
export async function loyerIndexe({ indice, trimestre_reference, loyer, date_effet }, dateQuittance) {
  if (!indice || !trimestre_reference || !loyer || !date_effet || !dateQuittance) return { calculable: false, motif: 'données du bail incomplètes' };
  const [t, a] = trimestre_reference.split('T').map(Number);
  const valeurs = await serie(indice);
  const i0 = valeurs[cle(a, t)];
  if (!i0) return { calculable: false, motif: `indice ${indice} du ${t}e trimestre ${a} introuvable à l'INSEE` };
  // Nombre d'anniversaires échus à la date de la quittance.
  const [ae, me, je] = date_effet.split('-').map(Number);
  const [aq, mq, jq] = dateQuittance.split('-').map(Number);
  let n = aq - ae;
  if (mq < me || (mq === me && jq < je)) n -= 1;
  if (n < 1) return { calculable: true, n: 0, i0, iN: i0, annuel: loyer, texte_indice: `${indice} ${t}e trimestre ${a}` };
  const iN = valeurs[cle(a + n, t)];
  if (!iN) return { calculable: false, motif: `indice ${indice} du ${t}e trimestre ${a + n} non encore publié ou introuvable` };
  const annuel = Math.round(loyer * iN / i0 * 100) / 100;
  const v = (x) => String(x).replace('.', ',');
  return { calculable: true, n, i0, iN, annuel, texte_indice: `${indice} du ${t}e trimestre ${a} (${v(i0)}) porté au ${t}e trimestre ${a + n} (${v(iN)})` };
}

// Nombre de mois couverts par une quittance.
export function moisCouverts(debut, fin) {
  if (!debut) return null;
  if (!fin) return 1;
  const d = new Date(debut + 'T00:00:00Z'), f = new Date(fin + 'T00:00:00Z');
  f.setUTCDate(f.getUTCDate() + 1);
  const mois = (f.getUTCFullYear() - d.getUTCFullYear()) * 12 + (f.getUTCMonth() - d.getUTCMonth());
  return mois > 0 && mois <= 12 ? mois : null;
}
