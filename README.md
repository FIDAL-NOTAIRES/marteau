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
| Couche de collecte | squelette — BODACC et REDPAR branchés |
| Reste des sources | à brancher |
| Rendu du rapport | non commencé |

## Variables d'environnement

| Variable | Rôle |
|---|---|
| `DATABASE_URL` | Neon, chaîne *pooled*. Base **partagée** avec MATRICE et PARTAGE AMIABLE |
| `REDPAR_URL` | Base de l'API REDPAR (défaut : production) |
| `CRON_SECRET` | Protège `/api/reprise` |
| `MARTEAU_CODE_LEVEE` | Code unique des levées de réserve. **Jamais dans le code** |

## Pièges connus

* **Toute fonction absente de `vercel.json` rend 404.** Vérifié sur
  REDPAR, retenu ici.
* La base est **partagée**. Les tables sans préfixe appartiennent à
  PARTAGE AMIABLE, les `matrice_*` à MATRICE. Ne rien y toucher.
* `marteau_journal` refuse `UPDATE`, `DELETE` et `TRUNCATE`. Un dossier
  se **clôt** (`clos_le`), il ne se supprime pas.
* Un trigger est désactivable par le propriétaire de la table :
  `/api/sante` vérifie qu'ils sont actifs, c'est le seul filet.

## Contrôle

`GET /api/sante` — rend 200 si tables, référentiel et journal sont en
ordre, 503 sinon, avec le détail de ce qui manque.
