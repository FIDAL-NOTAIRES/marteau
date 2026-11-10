// MARTEAU — lib/google.js — ACCÈS GOOGLE CÔTÉ SERVEUR (10/11/2026)
//
// Compte de service outils@fidal-apps.iam.gserviceaccount.com (projet
// Google Cloud « FIDAL - Apps »), clé JSON dans la variable Vercel
// GOOGLE_COMPTE_SERVICE. Arbitrage de JFD du 10/11/2026 : le compte n'a pas
// de stockage propre ; il n'écrit QUE dans des fichiers créés par JFD sur
// son Drive et partagés avec lui en écriture.
//
// Aucune dépendance : le jeton est signé ici (RS256, module crypto de Node)
// et échangé auprès de Google contre un jeton d'accès d'une heure, gardé
// en mémoire le temps de vie de la fonction.

import crypto from 'node:crypto';

const PORTEE = 'https://www.googleapis.com/auth/spreadsheets';
let cache = null; // { jeton, expire }

function compte() {
  const brut = process.env.GOOGLE_COMPTE_SERVICE;
  if (!brut) throw new Error('GOOGLE_COMPTE_SERVICE absent des variables Vercel');
  const c = JSON.parse(brut);
  if (!c.client_email || !c.private_key) throw new Error('GOOGLE_COMPTE_SERVICE incomplet');
  return c;
}

const b64url = (b) => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

async function jeton() {
  if (cache && cache.expire > Date.now() + 60000) return cache.jeton;
  const c = compte();
  const maintenant = Math.floor(Date.now() / 1000);
  const tete = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const corps = b64url(JSON.stringify({
    iss: c.client_email, scope: PORTEE, aud: 'https://oauth2.googleapis.com/token',
    iat: maintenant, exp: maintenant + 3600,
  }));
  const signature = crypto.createSign('RSA-SHA256').update(tete + '.' + corps).sign(c.private_key);
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: tete + '.' + corps + '.' + b64url(signature),
    }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error('jeton Google refusé : ' + (d.error_description || d.error || r.status));
  cache = { jeton: d.access_token, expire: Date.now() + (d.expires_in || 3600) * 1000 };
  return cache.jeton;
}

// Ajoute des lignes à la suite du premier onglet d'un tableur.
export async function ajouterLignes(tableurId, lignes) {
  const t = await jeton();
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${tableurId}/values/A1:append`
    + '?valueInputOption=RAW&insertDataOption=INSERT_ROWS';
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: lignes }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('écriture du tableur refusée : ' + ((d.error && d.error.message) || r.status));
  return d.updates || null;
}

// Journal de l'anonymisation (arbitrages des 28/09, 01/10 et 10/11/2026) :
// une ligne par pièce traitée — date, outil, type de pièce, nom du fichier,
// éléments retirés, détail, version de la bibliothèque. Tableur créé par
// JFD dans le dossier ANONYMISATION de son Drive.
export const JOURNAL_ANONYMISATION = '1uOOEQU9Kvw1C5wX1WzcuRq7eGPCSa1iTegHsPCRgC0M';

export async function journaliserAnonymisation(ligne) {
  const detail = ligne.detail ? Object.entries(ligne.detail).map(([k, v]) => v + ' ' + k.toLowerCase()).join(', ') : '';
  return ajouterLignes(JOURNAL_ANONYMISATION, [[
    ligne.date || new Date().toISOString(),
    ligne.outil || '',
    ligne.type || '',
    ligne.fichier || '',
    Number(ligne.elements_retires) || 0,
    detail,
    ligne.version || '',
  ]]);
}
