const test = require('node:test');
const assert = require('node:assert');
const Levees = require('../js/levees.js');
const Demo = require('../js/demo.js');
const { parseDate, formatDay, createAggregator, analyser } = Levees;

const rec = (idx, props, lat = null, lon = null) => ({ idx, props, lat, lon });

test('dates : formats FR, ISO, Excel, US détecté', () => {
  const ref = parseDate('15/01/2025');
  assert.strictEqual(formatDay(ref), '15/01/2025');
  assert.strictEqual(parseDate('2025-01-15T07:12:00'), ref);
  assert.strictEqual(parseDate('15/01/2025 07:12'), ref);
  assert.strictEqual(parseDate('15-01-25'), ref);
  assert.strictEqual(parseDate('1/15/25'), ref);        // m/j/aa (mois > 12 impossible)
  assert.strictEqual(parseDate(45672), ref);             // n° de série Excel
  assert.strictEqual(parseDate('45672,3'), ref);
  assert.strictEqual(parseDate('20250115'), ref);
  assert.strictEqual(parseDate('pas une date'), null);
  assert.strictEqual(parseDate(''), null);
});

function scenario() {
  // Période : 4 semaines (lundi 06/01/2025 → dimanche 02/02/2025)
  const L = [];
  const add = (puce, dates, lat = 47, lon = -1.5) => dates.forEach(d => L.push({ date: d, puce, poids: '10,5', lat, lon }));
  add('0001', ['06/01/2025', '13/01/2025', '20/01/2025', '27/01/2025', '27/01/2025']); // régulier (doublon de levée le 27)
  add('0002', ['07/01/2025']);                                                         // faible (1/4) + arrêt
  add('0003', ['08/01/2025', '22/01/2025', '02/02/2025'], 47.01, -1.5);                // ~1,1 km de la position déclarée
  add('9999', ['09/01/2025', '16/01/2025']);                                           // puce non référencée
  L.push({ date: '10/01/2025', puce: '', poids: '' });                                 // levée sans identifiant
  L.push({ date: 'n/a', puce: '0001', poids: '' });                                    // date illisible
  const agg = createAggregator({ keyCol: 'puce', dateCol: 'date', weightCol: 'poids', xCol: 'lon', yCol: 'lat', project: (x, y) => [x, y], ignoreLeadingZeros: true });
  L.forEach(agg.add);
  const bacs = [
    rec(0, { puce: '0001', livraison: '01/01/2020', declare: 5 }, 47, -1.5),
    rec(1, { puce: '0002', livraison: '01/01/2020', declare: 30 }, 47, -1.5),
    rec(2, { puce: '0003', livraison: '01/01/2020' }, 47, -1.5),
    rec(3, { puce: '0004', livraison: '01/01/2020' }, 47, -1.5),   // jamais levé
    rec(4, { puce: '0005', livraison: '28/01/2025' }, 47, -1.5),   // livré la dernière semaine
    rec(5, { puce: '1', livraison: '20/01/2025' }, 47, -1.5)       // "1" = "0001" sans zéro : doublon d'identifiant
  ];
  return { agg: agg.result(), bacs };
}

test('agrégation : période, comptages, rejets', () => {
  const { agg } = scenario();
  assert.strictEqual(agg.stats.lignes, 13);
  assert.strictEqual(agg.stats.levees, 11);
  assert.strictEqual(agg.stats.sansCle, 1);
  assert.strictEqual(agg.stats.dateInvalide, 1);
  assert.strictEqual(agg.stats.semainesPeriode, 4);
  const b1 = agg.records.find(r => r.props.identifiant === '0001');
  assert.deepStrictEqual([b1.agg.n, b1.agg.jours, b1.agg.semaines], [5, 4, 4]);
  assert.strictEqual(b1.agg.poidsMoyen, 10.5);
});

test('analyse : catégories et taux de présentation', () => {
  const { agg, bacs } = scenario();
  const res = analyser(bacs, agg, { keyA: 'puce', moveThreshold: 50, seuilTaux: 50, seuilArret: 2, dateA: 'livraison', countA: 'declare', ignoreLeadingZeros: true });
  const byPuce = p => res.rows.filter(r => r.a && r.a.props.puce === p);
  const r1 = byPuce('0001')[0], r2 = byPuce('0002')[0], r3 = byPuce('0003')[0];
  assert.strictEqual(r1.lv.taux, 100);
  assert.ok(r1.tags.includes('doublon'));
  assert.strictEqual(r1.lv.ecart, 0);
  assert.deepStrictEqual(r2.tags.sort(), ['arret', 'faible']);
  assert.strictEqual(r2.lv.taux, 25);
  assert.strictEqual(r2.lv.ecart, -29);
  assert.ok(r3.tags.includes('deplace') && r3.distance > 1000);
  assert.strictEqual(byPuce('0004')[0].category, 'seulA');
  assert.deepStrictEqual(byPuce('0005')[0].tags, ['recent']);
  // Bac livré le 20/01 : 2 semaines en service, et son homonyme "1" n'a pas reçu les levées
  assert.strictEqual(byPuce('1')[0].lv.semainesPossibles, 2);
  const nonRef = res.rows.filter(r => r.category === 'seulB');
  assert.strictEqual(nonRef.length, 1);
  assert.strictEqual(res.stats.leveesNonRef, 2);
});

test('démo levées : ordres de grandeur réalistes', () => {
  const d = Demo.generateLevees(600, 7);
  const agg = createAggregator({ keyCol: 'Code puce', dateCol: 'Date levée', weightCol: 'Poids (kg)', ignoreLeadingZeros: true });
  d.levees.forEach(agg.add);
  const bacs = d.clients.map((p, i) => rec(i, p, p.Latitude, p.Longitude));
  const res = analyser(bacs, agg.result(), { keyA: 'Code puce', moveThreshold: 50, seuilTaux: 25, seuilArret: 8, dateA: 'Date livraison', ignoreLeadingZeros: true });
  const t = res.stats.byTag;
  for (const k of ['identique', 'faible', 'arret', 'seulA', 'recent', 'seulB']) assert.ok(t[k] > 0, k + ' attendu > 0');
  assert.strictEqual(t.seulB, 50);
  assert.ok(res.stats.tauxMedian > 30 && res.stats.tauxMedian < 90, 'taux médian ' + res.stats.tauxMedian);
});
