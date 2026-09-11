# MARTEAU — audit de portefeuille immobilier

Outil interne de FIDAL Notaires Paris. Audite le patrimoine immobilier
d'une société à partir de son seul SIREN.

**Document de référence : `20260907 MARTEAU-memo-de-reference (v3).md`**
(Drive, dossier MARTEAU). À lire avant toute modification — il porte les
arbitrages, et ce dépôt n'en est que l'exécution.

## Règle fondatrice

MARTEAU **appelle**, il ne duplique jamais. REDPAR, URBA, XYLO, TRENTE,
MATRICE, CERTIF et RISQUES sont interrogés par API. Toute logique
recopiée ici devient une divergence à maintenir.

Corollaire : les plans annexés au rapport sont demandés à **REDPAR**, qui
appelle PAINT en interne. Un seul constructeur de polygone.

## État

| Brique | État |
|---|---|
| Modèle de données (`sql/001` à `008`) | **001–008 appliquées** (008 vérifiée en base le 10/09 : six colonnes de registre présentes sur `marteau_societe`) |
| Façade (`index.html`) | écrite le 01/09 — accroche large, carte Leaflet/IGN, validation du périmètre ; **familles et couleurs en retard sur le mémo** ; **écran d'accueil non codé** |
| Vérification SIREN (`api/entreprises.js`) | reprise de REDPAR : annuaire officiel des entreprises (gouv.fr), une carte par société — siège, création, APE, dirigeants — à choisir avant toute photographie. La machine propose, l'humain décide |
| Sources (`api/photo.js`, `api/liens.js`, `api/matrice.js`) | écrites le 01/09, sans état — REDPAR, BODACC, raccord MATRICE |
| **Cycle de vie du dossier (`api/dossier.js`)** | **route unique depuis le 10/09** — actions `ouvrir`, `lister`, `lire`, `lever`, `preparer`, `marquer`, `saisir`. Fusion de `dossier` + `etat` + `lever` + `demander` pour tenir sous le plafond de douze fonctions |
| Persistance (`api/collecter.js`) | écrit ce que les deux volets rendent ; porte aussi `action: 'reprise'` (ex `api/reprise.js`) et la lecture du registre société par société |
| Bibliothèque (`lib/phrases.js`) | les blocs de phrases des dix familles, codifiés — LA source, la base ne garde que le code |
| Nomenclature (`lib/nomenclature.js`) | plan de nommage documentaire : dix familles, 29 sous-familles, table de correspondance vers les 21 voyants. Contrôlée par `/api/sante` |
| Analyse (`api/analyser.js`) | calcule les voyants des dix familles depuis la base seule ; recalculable ; pose aussi le registre des pièces demandables |
| Note de réunion (`api/reunion.js`, `reunion.html`) | page de garde datée, une liste par dossier, blocs < 15 j / > 15 j depuis le premier envoi, alertes « à saisir », réserves levées avec qui et pourquoi. Lecture seule, imprimable |
| Module Documents / Drive | **non commencé** — dépôt des titres, inventaire, rangement et renommage par la nomenclature. Colonne `code_doc` déjà posée sur `marteau_piece` |
| Unités foncières, organigramme | spécifiés, non codés |
| Reste des sources | à brancher |
| Rendu du rapport | non commencé |

## Surface d'appel de `/api/dossier`

```
GET  /api/dossier?dossier=2026-0001    lecture d'un dossier
GET  /api/dossier?liste=1              dossiers en cours
GET  /api/dossier?liste=1&clos=1       dossiers clos

POST /api/dossier { action, ... }
  ouvrir    { siren, denomination?, associe, collaborateur?, qui }
  lister    { clos? }
  lire      { dossier }
  lever     { dossier, reserve, motif, qui, code? }
  preparer  { dossier, pieces[], qui }
  marquer   { dossier, pieces[], qui }
  saisir    { dossier, pieces[], qui }
```

Un POST sans `action` mais avec `siren` vaut `ouvrir` : la façade
existante n'a pas eu à changer pour l'ouverture.

## Variables d'environnement

| Variable | Rôle |
|---|---|
| `DATABASE_URL` | Neon, chaîne *pooled*. Base **partagée** avec MATRICE et PARTAGE AMIABLE |
| `REDPAR_BASE` | Base de l'API REDPAR (défaut : production). **`REDPAR_BASE`, pas `REDPAR_URL`** — nom déjà en place dans `api/photo.js` et `api/liens.js`. **Non posée en production au 10/09** : les deux fonctions retombent sur leur défaut codé en dur |
| `CRON_SECRET` | Protège l'action `reprise` de `api/collecter.js` |
| `MARTEAU_CODE_LEVEE` | Code unique des levées de réserve. **Jamais dans le code** |
| `MATRICE_BASE` | Base de l'API MATRICE (défaut : production) |
| `MATRICE_PASSE`, `MATRICE_AUTEUR` | Raccord machine vers MATRICE — **non posées** tant que la question du jeton machine n'est pas tranchée (voir pièges) |

## Pièges connus

* **PLAN HOBBY : DOUZE fonctions par déploiement, pas une de plus.** La
  treizième fait échouer le build à « Deploying outputs », sans message
  utile. Deux fusions ont déjà servi à tenir : `api/reprise.js` dans
  `collecter.js` (`action: 'reprise'`) le 07/09, puis `etat` + `lever` +
  `demander` dans `dossier.js` le 10/09. Le projet est à **neuf**
  fonctions. Toute brique suivante consomme ce reste, ou passe le projet
  en Pro.

* **Toute fonction absente de `vercel.json` rend 404.** Vérifié sur
  REDPAR, retenu ici. Corollaire du retrait d'une route : supprimer le
  fichier ET sa ligne, mais **repointer la façade d'abord** — sinon elle
  appelle une adresse morte.

* **Pas de cron sur ce plan pour la reprise.** L'entrée `crons` qui
  visait `/api/collecter` a été retirée le 10/09 : elle appelait la
  fonction en **GET sans corps**, or `collecter.js` refuse tout ce qui
  n'est pas un POST (405) et la reprise exige `{ action: 'reprise' }`.
  Elle ne faisait donc rien, chaque nuit, silencieusement. La reprise
  est appelée à la main ou à l'ouverture du dossier.

* **`/api/sante` ne contrôle pas les COLONNES**, seulement la présence
  des tables. Une migration oubliée passe donc « operationnel » et casse
  la collecte en 500. Vérifier les migrations en base, pas au santé.

* La base est **partagée**. Les tables sans préfixe appartiennent à
  PARTAGE AMIABLE, les `matrice_*` à MATRICE. Ne rien y toucher.
* `marteau_journal` refuse `UPDATE`, `DELETE` et `TRUNCATE`. Un dossier
  se **clôt** (`clos_le`), il ne se supprime pas.
* Un trigger est désactivable par le propriétaire de la table — et sur
  Neon **tout** rôle hérite de `neon_superuser`, appartenance qui ne se
  révoque pas. Un rôle applicatif restreint est donc impossible ici :
  c'est le **chaînage par empreinte** (`sql/005`) qui prouve, pas le
  trigger. La garantie suppose que `marteau_journal_tete()` soit ancrée
  hors de la base.
* Dans `ouvrir`, la référence AAAA-NNNN est tirée sous
  `pg_advisory_xact_lock` : le `WITH v AS (…)` et le `FROM n, v` doivent
  rester dans la même requête, sans quoi deux ouvertures simultanées
  peuvent porter la même référence.
* `api/collecter.js` ne doit JAMAIS appeler REDPAR ni le BODACC
  directement. Il passe par `/api/photo` et `/api/liens`, sans quoi la
  logique existerait en deux endroits et divergerait.
* **Raccord MARTEAU → MATRICE.** `api/matrice.js` exige
  `MATRICE_MOT_DE_PASSE` côté MATRICE, alors que MATRICE est verrouillée
  par Entra et que l'absence de ce mot de passe est saine. Poser le mot
  de passe rouvrirait une porte de recette en production. Il faut un
  jeton dédié aux appels de machine à machine, distinct du verrou humain
  — à concevoir. En attendant, l'appel rend 503 avec la charge prête, et
  le parcours « Copier / Ouvrir MATRICE » fonctionne.
* Deux colonnes proches sur `marteau_societe` : `niveau` est la
  profondeur dans l'arborescence, `niveau_confiance` dit si le lien est
  un fait (champ structuré) ou une lecture de texte libre.
* **Les familles 2 et 3 sont inversées** entre l'axe d'analyse et l'axe
  documentaire (analyse 2 = désignation ↔ documentaire 030 = cadastre).
  Ne jamais déduire un code documentaire d'un `famille.numero × 10` :
  voir l'avertissement en tête de `lib/nomenclature.js`.

## Contrôle

`GET /api/sante` — rend 200 si tables, référentiel, nomenclature et
journal sont en ordre, 503 sinon, avec le détail de ce qui manque.
