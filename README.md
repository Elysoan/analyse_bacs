# Analyse bacs — comparateur de bases

Outil web pour analyser une base de bacs avec une **carte** et des **tableaux**, selon deux usages :

1. **Base de bacs + historique de levées** : quels bacs ne sont jamais levés, plus levés, peu présentés, quelles puces sont levées sans être référencées (bacs à facturer).
2. **Deux inventaires de bacs** (ex. base SIG vs base facturation) : bacs manquants, attributs différents, bacs déplacés.

- 100 % navigateur : les fichiers ne quittent jamais le poste, aucun serveur ni installation.
- Fonctionne hors-ligne (sauf fonds de carte et géocodage).

## Démarrer

1. Ouvrir `index.html` dans Chrome ou Edge (double-clic suffit).
2. Suivre les 3 étapes du panneau de gauche :
   1. **Base client** : déposer le fichier des bacs (glisser-déposer ou clic) ;
   2. **Levées** : déposer l'export des levées ;
   3. **Vérifier** : les colonnes, les flux (FFOM coché par défaut) et les statuts de levée retenus sont proposés automatiquement ; corriger si besoin, puis **Lancer l'analyse**.
3. Explorer : cliquer un indicateur, un flux, un statut, une tranche de taux ou une ligne de synthèse filtre la carte et le tableau ; cliquer une ligne localise le bac. Les exports CSV / GeoJSON reprennent la sélection.

Menu **Exemples** : données fictives au format réel (base biodéchets + levées, ou deux inventaires). Bouton **Aide** : mode d'emploi et définition de chaque indicateur.

### Formats réels pris en charge

- **Base client** (export agglo) : `Code puce` en texte, `Date livraison` (date Excel, y compris au format américain), `Nombre d'apparitions…`, `Activité`, adresse découpée (`Type de voie` / `Nom de la voie` avec code secteur `LSO n`).
- **Levées** (export Paprec) : `Jour` (numéro de série Excel), `Flux`, `Libelle Code Levee` (« Identifié, autorisé, collecté »…), `Numero puce`, `Latitude*` / `Longitude*`.
- Puces abîmées par Excel rapprochées automatiquement : 0 en tête perdu (`0117068081` → `117068081`) et notation scientifique (`0116794E12` → `1,16794E+17`, `01167726E4` → `11677260000`).

## Analyse des levées

Les levées sont agrégées par bac (identifiant puce ou n° de bac), puis rapprochées de la base client.

| Indicateur | Définition |
|---|---|
| Levés régulièrement | taux de présentation ≥ seuil (25 % par défaut) |
| Taux de présentation faible | semaines avec au moins une levée / semaines où le bac était en service (date de livraison prise en compte) |
| Sans levée depuis ≥ N semaines | bac levé dans l'année mais plus depuis 8 semaines (retiré ? vacant ?) |
| Jamais levés | présent dans la base client, aucune levée sur la période |
| Livrés récemment | jamais levé mais livré moins de N semaines avant la fin de la période (non compté comme anomalie) |
| Puces levées non référencées | levées (sur le flux analysé) d'un identifiant absent de la base client, avec le nombre de levées et la position |
| Levés aussi sur un autre flux | bac de la base client levé au moins une fois sur un flux non analysé (ex. OMR) |
| Écart de position | distance bac (base client) ↔ position médiane de ses levées > seuil (50 m), si les deux ont des coordonnées |

**Flux et statuts** : on choisit le ou les flux analysés (FFOM coché par défaut) et les statuts de levée retenus (tout sauf « non collecté » par défaut). Les indicateurs ne portent que sur ces levées, et :
- *Puces FFOM levées, absentes de la base client* : liste géolocalisée (position médiane des levées) avec le nombre de levées, exportable en GeoJSON pour ArcGIS Pro ;
- *Bacs du client levés aussi hors FFOM* : bacs vidés au moins une fois sur un autre flux (erreur de tournée, puce mal affectée) ;
- tableau des levées par flux, et une colonne « Levées <flux> » par flux pour chaque puce ;
- les puces levées uniquement sur un autre flux et absentes de la base client (bacs OMR, CS…) sont ignorées ;
- tableau des statuts de levée : un clic liste par exemple les puces « Identifié, non autorisé, collecté ».

**Carte** : en vue d'ensemble, seules les 3 catégories prioritaires sont en couleur (puces non référencées, jamais levés, levés sur un autre flux), le reste en gris ; un indicateur sélectionné colore tous ses points. Palette vérifiée pour le daltonisme.

Également : levées par mois (repère les mois manquants dans l'export), répartition des taux, contrôle du « nombre d'apparitions » déclaré dans la base client, **synthèse par activité / secteur / commune**.

Colonnes détectées automatiquement (modifiables) : identifiants communs (y compris si les zéros en tête diffèrent, ex. `0116772441` vs `116772441`), date de levée, poids, date de livraison, nombre de levées déclaré.

**Volumes testés** : 800 000 levées en Excel → lecture ≈ 20 s, analyse ≈ 3 s, ≈ 600 Mo de mémoire (Chrome). Un export CSV est 3 à 4 fois plus rapide à lire.

## Géocodage (base sans coordonnées)

Si la base de bacs n'a que des adresses, le panneau **Géocoder les adresses** (Base A) les envoie au service public de l'IGN (Géoplateforme, ex-API Adresse / BAN) :
- seules l'adresse et la commune sont transmises (pas les noms) ;
- un code parasite en fin de nom de voie (ex. `LSO 8`) est retiré et conservé dans une colonne `secteur` ;
- les résultats sont mémorisés dans le navigateur, et la base géocodée peut être téléchargée en CSV pour les fois suivantes ;
- `geo_score` < 0,5 = position approximative à vérifier.

## Formats acceptés

| Format | Détails |
|---|---|
| CSV / TXT | séparateur `,` `;` ou tabulation détecté ; UTF-8 ou Windows-1252 |
| Excel (.xlsx, .xls, .ods) | choix de l'onglet (le plus rempli par défaut) |
| GeoJSON | géométrie utilisée directement (point, ou 1er sommet sinon) |

Coordonnées : **WGS84**, **Lambert 93** ou **Web Mercator**, détectées automatiquement (modifiables). Décimales à virgule acceptées.

## Comparaison de deux inventaires

**Par identifiant** (n° de bac, puce RFID…) — recommandé quand une clé commune existe :

| Statut | Signification |
|---|---|
| Identique | même identifiant, mêmes valeurs, position à moins du seuil |
| Écart attributaire | au moins un champ comparé diffère (volume, flux…) |
| Déplacé | distance entre les deux positions > seuil (20 m par défaut) |
| Uniquement A / B | bac présent dans une seule base |
| Doublon | identifiant présent plusieurs fois dans une base (apparié au plus proche) |

**Par proximité** — sans clé commune : chaque bac est apparié au bac le plus proche de l'autre base dans un rayon donné (15 m par défaut), en traitant d'abord les paires les plus proches.

Normalisation avant comparaison : espaces, casse (option), accents (option), nombres (`240` = `240,0`), zéros en tête des identifiants (option).

## Exploiter les résultats

- **Indicateurs** cliquables pour filtrer carte + tableau.
- **Écarts par champ** : cliquer un champ pour ne voir que les bacs concernés.
- **Carte** : couleur par statut, trait pointillé entre les deux positions d'un bac déplacé, fiche A/B au clic. Fonds Plan IGN, photos aériennes IGN, OSM.
- **Tableau** : recherche, tri par colonne, clic sur une ligne = zoom sur le bac.
- **Exports** (respectent les filtres) : CSV (`;`, ouverture directe dans Excel) et GeoJSON.

### Aller-retour avec ArcGIS Pro

- Export depuis ArcGIS Pro : *Exporter la table* (CSV) ou *Table vers Excel* ; pour garder la géométrie, *Entités vers JSON* en cochant « GeoJSON » et « Projeter en WGS 1984 ».
- Réimport : l'export GeoJSON se charge avec *JSON vers entités*.

## Développement

```
js/compare.js   moteur de comparaison (sans dépendance, testé sous Node)
js/levees.js    agrégation des levées et indicateurs (sans dépendance, testé sous Node)
js/io.js        lecture CSV/Excel/GeoJSON (gros fichiers par paquets), projections, exports
js/geocode.js   géocodage IGN (envoi groupé, repli adresse par adresse, cache)
js/app.js       interface (carte Leaflet, tableaux, filtres)
js/demo.js      générateur du jeu d'exemple
vendor/         Leaflet 1.9.4, PapaParse 5.4.1, SheetJS 0.18.5, proj4 2.11.0
```

- Tests : `npm test` (Node ≥ 18).
- Serveur local optionnel : `npm start` puis http://localhost:8080.

Limites connues :
- Carte fluide jusqu'à quelques dizaines de milliers de bacs ; au-delà, prévoir un regroupement des points.
- Au-delà d'environ 1 million de levées en Excel, préférer un export CSV (mémoire du navigateur).
- Le taux de présentation suppose une collecte hebdomadaire ; la première et la dernière semaine de la période peuvent être incomplètes.
- SheetJS 0.18.5 (dernière version publiée sur npm) a des vulnérabilités connues sur des fichiers Excel piégés : sans risque pour vos propres exports, mais remplacer `vendor/xlsx.full.min.js` par la version 0.20.x de https://cdn.sheetjs.com si l'outil doit lire des fichiers d'origine inconnue.
