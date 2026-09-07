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
| Modèle de données (`sql/001` à `003`) | appliqué en production |
| Façade (`index.html`) | écrite le 01/09 — accroche large, carte Leaflet/IGN, validation du périmètre ; **familles et couleurs en retard sur le mémo** |
| Sources (`api/photo.js`, `api/liens.js`, `api/matrice.js`) | écrites le 01/09, sans état — REDPAR, BODACC, raccord MATRICE |
| Persistance (`api/collecter.js`) | écrit ce que les deux volets rendent |
| Reste des sources | à brancher |
| Rendu du rapport | non commencé |

## Variables d'environnement

| Variable | Rôle |
|---|---|
| `DATABASE_URL` | Neon, chaîne *pooled*. Base **partagée** avec MATRICE et PARTAGE AMIABLE |
| `REDPAR_BASE` | Base de l'API REDPAR (défaut : production). **`REDPAR_BASE`, pas `REDPAR_URL`** — nom déjà en place dans `api/photo.js` et `api/liens.js` |
| `CRON_SECRET` | Protège `/api/reprise` |
| `MARTEAU_CODE_LEVEE` | Code unique des levées de réserve. **Jamais dans le code** |
| `MATRICE_BASE` | Base de l'API MATRICE (défaut : production) |
| `MATRICE_PASSE`, `MATRICE_AUTEUR` | Raccord machine vers MATRICE — **non posées** tant que la question du jeton machine n'est pas tranchée (voir pièges) |

## Pièges connus

* **Toute fonction absente de `vercel.json` rend 404.** Vérifié sur
  REDPAR, retenu ici.
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
* `api/collecter.js` ne doit JAMAIS appeler REDPAR ni le BODACC
  directement. Il passe par `/api/photo` et `/api/liens`, sans quoi la
  logique existerait en deux endroits et divergerait.
* **Façade en retard sur le mémo.** `index.html` (01/09) affiche « les six
  familles de risque » et l'ancienne échelle à trois couleurs. Le mémo v3
  en compte dix, et quatre couleurs. À mettre à jour — pas en priorité,
  la façade n'engage rien, mais ne pas s'y fier comme référence.
* **Raccord MARTEAU → MATRICE.** `api/matrice.js` exige
  `MATRICE_MOT_DE_PASSE` côté MATRICE, alors que MATRICE est verrouillée
  par Entra et que l'absence de ce mot de passe est saine. Poser le mot
  de passe rouvrirait une porte de recette en production. Il faut un jeton
  dédié aux appels de machine à machine, distinct du verrou humain — à
  concevoir. En attendant, l'appel rend 503 avec la charge prête, et le
  parcours « Copier / Ouvrir MATRICE » fonctionne.
* Deux colonnes proches sur `marteau_societe` : `niveau` est la
  profondeur dans l'arborescence, `niveau_confiance` dit si le lien est
  un fait (champ structuré) ou une lecture de texte libre.

## Contrôle

`GET /api/sante` — rend 200 si tables, référentiel et journal sont en
ordre, 503 sinon, avec le détail de ce qui manque.
