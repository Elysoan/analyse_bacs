const test = require('node:test');
const assert = require('node:assert');
const H = require('../js/habitants.js');

const toNumber = v => Number(String(v).replace(',', '.'));
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≠ ${b}`);
const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const id = (x, y) => `CRS3035RES200mN${y}E${x}`;

// Grille 3 × 1 de carreaux de 200 m : populations 100, 200, 400.
const X0 = 3800000, Y0 = 2800000;
const ROWS = [
  { idcar_200m: id(X0, Y0), ind: '100', men: '40' },
  { idcar_200m: id(X0 + 200, Y0), ind: '200', men: '80' },
  { idcar_200m: id(X0 + 400, Y0), ind: '400', men: '160' }
];
const load = rows => H.unitsFromRows(f => rows.forEach(f), { idCol: 'idcar_200m', popCol: 'ind', menCol: 'men', toNumber });
const circuit = (parts, extra) => Object.assign({ id: 'C1', name: 'Test', props: {}, parts, bbox: H.bboxOf([].concat(...parts.map(p => p[0]))), area: 0 }, extra, {
  area: parts.reduce((s, p) => s + Math.abs(H.ringArea(p[0])) - p.slice(1).reduce((t, h) => t + Math.abs(H.ringArea(h)), 0), 0)
});

test('identifiant de carreau INSEE', () => {
  assert.deepStrictEqual(H.parseCarreauId('CRS3035RES200mN2889000E3811400'), { size: 200, x: 3811400, y: 2889000 });
  assert.deepStrictEqual(H.parseCarreauId('200mN2889000E3811400'), { size: 200, x: 3811400, y: 2889000 });
  assert.strictEqual(H.parseCarreauId('44109'), null);
  assert.strictEqual(H.parseCarreauId(''), null);
});

test('découpage : surface commune d\'un polygone quelconque et d\'un carré', () => {
  near(H.clipArea(rect(0, 0, 100, 100), rect(50, 50, 150, 150)), 2500);
  near(H.clipArea(rect(0, 0, 100, 100), rect(200, 200, 300, 300)), 0);
  // Orientation indifférente pour le sujet.
  near(H.clipArea(rect(0, 0, 100, 100).reverse(), rect(0, 0, 50, 50)), 2500);
  // Sujet concave en L : 3 × 100 × 100 ; le carré (0,0)-(100,200) en contient 100 × 100 + 100 × 100 = 20 000 → ici 2 branches.
  const L = [[0, 0], [200, 0], [200, 100], [100, 100], [100, 200], [0, 200]];
  near(H.clipArea(L, rect(0, 0, 100, 200)), 20000);
  near(H.clipArea(L, rect(100, 100, 200, 200)), 0);
});

test('prorata exact', () => {
  const { units, extent } = load(ROWS);
  const c = circuit([[rect(X0, Y0, X0 + 300, Y0 + 200)]]); // carreau 1 + moitié du 2
  const r = H.computeCircuit(c, units, extent);
  assert.strictEqual(r.habitants, 200);   // 100 + 200 × 0,5
  assert.strictEqual(r.menages, 80);      // 40 + 80 × 0,5
  assert.strictEqual(r.carreaux, 2);
  assert.strictEqual(r.partiels, 1);
  near(r.surface, 0.06);
  near(r.couverture, 1);
  near(r.densite, 200 / 0.06, 1e-6);
});

test('trou et multi-parties', () => {
  const { units, extent } = load(ROWS);
  // Polygone couvrant les 3 carreaux, avec un trou sur le carreau 3 entier.
  const withHole = circuit([[rect(X0, Y0, X0 + 600, Y0 + 200), rect(X0 + 400, Y0, X0 + 600, Y0 + 200)]]);
  assert.strictEqual(H.computeCircuit(withHole, units, extent).habitants, 300);
  // Deux parties disjointes : carreau 1 et carreau 3.
  const multi = circuit([[rect(X0, Y0, X0 + 200, Y0 + 200)], [rect(X0 + 400, Y0, X0 + 600, Y0 + 200)]]);
  const r = H.computeCircuit(multi, units, extent);
  assert.strictEqual(r.habitants, 500);
  assert.strictEqual(r.carreaux, 2);
});

test('circuit hors des carreaux et hors de la zone du fichier : alertes', () => {
  const { units, extent } = load(ROWS);
  const vide = circuit([[rect(X0, Y0 + 1000, X0 + 200, Y0 + 1200)]]);
  const r = H.computeCircuit(vide, units, extent);
  assert.strictEqual(r.habitants, 0);
  assert.ok(r.alerts.some(a => /Aucun carreau/.test(a)));
  const loin = circuit([[rect(X0 + 50000, Y0, X0 + 50200, Y0 + 200)]]);
  assert.ok(H.computeCircuit(loin, units, extent).alerts.some(a => /Dépasse/.test(a)));
  assert.strictEqual(H.computeCircuit(circuit([[rect(X0, Y0, X0 + 600, Y0 + 200)]]), units, extent).alerts.length, 0);
});

test('lecture : fenêtre, lignes invalides, valeurs vides', () => {
  const rows = ROWS.concat([{ idcar_200m: 'x', ind: '5' }, { idcar_200m: id(X0 + 600, Y0), ind: '' }, { idcar_200m: id(X0 + 90000, Y0), ind: '9' }]);
  const all = load(rows);
  assert.strictEqual(all.invalid, 1);
  assert.strictEqual(all.units.length, 5);
  assert.strictEqual(all.total, 100 + 200 + 400 + 9);
  const win = H.unitsFromRows(f => rows.forEach(f), { idCol: 'idcar_200m', popCol: 'ind', toNumber, window: [X0, Y0, X0 + 700, Y0 + 200] });
  assert.strictEqual(win.units.length, 4);
  assert.ok(win.extent[2] >= X0 + 90200); // l'emprise du fichier reste calculée sur l'ensemble
});

test('circuits GeoJSON : projection, trous, entités sans polygone ignorées', () => {
  const lonlat = H.transform(H.WORK, 'EPSG:4326');
  const ring = rect(X0, Y0, X0 + 1000, Y0 + 1000).map(lonlat);
  const features = [
    { type: 'Feature', properties: { code: 'A1', lib: 'Nord' }, geometry: { type: 'Polygon', coordinates: [ring.concat([ring[0]])] } },
    { type: 'Feature', properties: { code: 'B2' }, geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } }
  ];
  assert.strictEqual(H.geojsonCRS({}, features), 'EPSG:4326');
  const { circuits, ignored } = H.circuitsFromFeatures(features, 'EPSG:4326', { idCol: 'code', nameCol: 'lib' });
  assert.strictEqual(ignored, 1);
  assert.strictEqual(circuits.length, 1);
  assert.strictEqual(circuits[0].id, 'A1');
  assert.strictEqual(circuits[0].name, 'Nord');
  near(circuits[0].area, 1e6, 1); // 1 km² (projection équivalente)
});

test('CRS déclaré dans le GeoJSON et détection', () => {
  const f = [{ geometry: { type: 'Point', coordinates: [350000, 6700000] } }];
  assert.strictEqual(H.geojsonCRS({}, f), 'EPSG:2154');
  assert.strictEqual(H.geojsonCRS({ crs: { properties: { name: 'urn:ogc:def:crs:EPSG::3035' } } }, f), 'EPSG:3035');
  assert.strictEqual(H.geojsonCRS({ crs: { properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' } } }, f), 'EPSG:4326');
  assert.strictEqual(H.detectCRS(3811400, 2889000), 'EPSG:3035');
});

test('population GeoJSON (polygones) : prorata et unités non convexes', () => {
  const lonlat = H.transform(H.WORK, 'EPSG:4326');
  const poly = (x0, y0, x1, y1) => ({ type: 'Polygon', coordinates: [rect(x0, y0, x1, y1).map(lonlat)] });
  const feats = [{ properties: { p: '1000' }, geometry: poly(X0, Y0, X0 + 1000, Y0 + 1000) }];
  const { units, extent } = H.unitsFromFeatures(feats, 'EPSG:4326', { popCol: 'p', toNumber });
  const c = circuit([[rect(X0, Y0, X0 + 500, Y0 + 1000)]]);
  near(H.computeCircuit(c, units, extent).habitants, 500, 1);
  assert.strictEqual(H.isConvex([[0, 0], [10, 0], [10, 10], [5, 3], [0, 10]]), false);
});

test('format d\'export : reconnaissance des colonnes d\'un modèle', () => {
  const g = H.guessField;
  assert.strictEqual(g('Densité (hab/km²)'), 'densite');
  assert.strictEqual(g('Nom du circuit'), 'nom');
  assert.strictEqual(g('Libellé circuit'), 'nom');
  assert.strictEqual(g('Code circuit'), 'id');
  assert.strictEqual(g('N° tournée'), 'id');
  assert.strictEqual(g('Population'), 'habitants');
  assert.strictEqual(g('Nb habitants'), 'habitants');
  assert.strictEqual(g('Surface km2'), 'surface');
  assert.strictEqual(g('Date de calcul'), 'date');
  assert.strictEqual(g('Km collectés'), 'kmCollecte');
  assert.strictEqual(g('Adresses desservies'), 'adresses');
  assert.strictEqual(g('Habitants par km collecté'), 'habParKm');
  assert.strictEqual(g('Communes'), 'communes');
  assert.strictEqual(g('Commentaire'), '');
  const fmt = H.formatFromHeaders(['Code', 'Population', 'Population INSEE', 'Commentaire']);
  assert.deepStrictEqual(fmt.map(c => c.field), ['id', 'habitants', '', '']); // un champ n'est utilisé qu'une fois
});

test('table d\'export : ordre du modèle, valeurs fixes, arrondis', () => {
  const { units, extent } = load(ROWS);
  const r = H.computeCircuit(circuit([[rect(X0, Y0, X0 + 300, Y0 + 200)]], { id: 'T7', name: 'Centre' }), units, extent);
  const fmt = [
    { header: 'Pop', field: 'habitants', fixed: '' },
    { header: 'Circuit', field: 'id', fixed: '' },
    { header: 'Agglo', field: '', fixed: 'Nantes' },
    { header: 'Source', field: 'source', fixed: '' },
    { header: 'Libre', field: '', fixed: '' }
  ];
  const t = H.buildTable([r], fmt, { source: 'Filosofi 2021' });
  assert.deepStrictEqual(t.header, ['Pop', 'Circuit', 'Agglo', 'Source', 'Libre']);
  assert.deepStrictEqual(t.lines[0], [200, 'T7', 'Nantes', 'Filosofi 2021', '']);
  assert.strictEqual(H.buildTable([r], H.standardFormat()).header.length, 10);
});
