# Analyse bacs — comparateur de bases

Outil web pour comparer deux inventaires de bacs (ex. **base SIG** vs **base métier / facturation**) avec une **carte** et des **tableaux**.

- 100 % navigateur : les fichiers ne quittent jamais le poste, aucun serveur ni installation.
- Fonctionne hors-ligne (seuls les fonds de carte IGN/OSM nécessitent Internet).

## Démarrer

1. Ouvrir `index.html` dans Chrome, Edge ou Firefox (double-clic suffit).
2. Cliquer sur **Charger l'exemple** pour voir le résultat sur un jeu fictif de 1 500 bacs,
   ou charger ses propres fichiers dans *Base A* et *Base B*.

Fichiers d'exemple réalistes dans `exemples/` : un CSV en Lambert 93 (`;`, encodage Windows-1252) et un Excel à deux onglets.

## Formats acceptés

| Format | Détails |
|---|---|
| CSV / TXT | séparateur `,` `;` ou tabulation détecté ; UTF-8 ou Windows-1252 |
| Excel (.xlsx, .xls, .ods) | choix de l'onglet (le plus rempli par défaut) |
| GeoJSON | géométrie utilisée directement (point, ou 1er sommet sinon) |

Coordonnées : **WGS84**, **Lambert 93** ou **Web Mercator**, détectées automatiquement (modifiables). Décimales à virgule acceptées.

## Comparaison

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
js/io.js        lecture CSV/Excel/GeoJSON, projections, exports
js/app.js       interface (carte Leaflet, tableaux, filtres)
js/demo.js      générateur du jeu d'exemple
vendor/         Leaflet 1.9.4, PapaParse 5.4.1, SheetJS 0.18.5, proj4 2.11.0
```

- Tests : `npm test` (Node ≥ 18).
- Serveur local optionnel : `npm start` puis http://localhost:8080.

Limites connues :
- Fluide jusqu'à quelques dizaines de milliers de bacs ; au-delà, prévoir un regroupement des points sur la carte.
- SheetJS 0.18.5 (dernière version publiée sur npm) a des vulnérabilités connues sur des fichiers Excel piégés : sans risque pour vos propres exports, mais remplacer `vendor/xlsx.full.min.js` par la version 0.20.x de https://cdn.sheetjs.com si l'outil doit lire des fichiers d'origine inconnue.
