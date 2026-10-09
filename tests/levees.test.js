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
  const fluxKeep = new Set(['FFOM']);
  const statutKeep = new Set(['Identifié, autorisé, collecté', 'Identifié, non autorisé, collecté', 'Non identifié, non autorisé, collecté']);
  const agg = createAggregator({ keyCol: 'Numero puce', dateCol: 'Jour', fluxCol: 'Flux', fluxKeep, statutCol: 'Libelle Code Levee', statutKeep, ignoreLeadingZeros: true });
  d.levees.forEach(agg.add);
  const bacs = d.clients.map((p, i) => rec(i, p, p.Latitude, p.Longitude));
  const res = analyser(bacs, agg.result(), { keyA: 'Code puce', moveThreshold: 50, seuilTaux: 25, seuilArret: 8, dateA: 'Date livraison', fluxKeep, ignoreLeadingZeros: true });
  const t = res.stats.byTag;
  for (const k of ['identique', 'faible', 'arret', 'seulA', 'recent', 'seulB', 'autre_flux']) assert.ok(t[k] > 0, k + ' attendu > 0');
  // Les 250 puces OMR / CS hors base client ne sont pas des « FFOM non référencées ».
  assert.deepStrictEqual(res.stats.levees.flux.map(f => f.flux).sort(), ['CS', 'FFOM', 'OMR']);
  assert.ok(res.stats.levees.statutsExclus > 0, 'levées non collectées écartées');
  assert.strictEqual(res.stats.levees.statuts.length, 4);
  assert.strictEqual(t.seulB, 50);
  assert.ok(res.stats.tauxMedian > 30 && res.stats.tauxMedian < 90, 'taux médian ' + res.stats.tauxMedian);
});

test('flux : seules les levées du flux retenu comptent, la répartition reste visible', () => {
  const L = [
    { d: '06/01/2025', p: 'A1', f: 'FFOM' }, { d: '13/01/2025', p: 'A1', f: 'FFOM' }, { d: '14/01/2025', p: 'A1', f: 'OMR' },
    { d: '07/01/2025', p: 'A2', f: 'OMR' },                                       // bac client jamais levé en FFOM
    { d: '08/01/2025', p: 'X9', f: 'FFOM' }, { d: '15/01/2025', p: 'X9', f: 'FFOM' }, // FFOM non référencée
    { d: '09/01/2025', p: 'OM1', f: 'OMR' }                                         // autre bac OMR : ignoré
  ];
  const fluxKeep = new Set(['FFOM']);
  const agg = createAggregator({ keyCol: 'p', dateCol: 'd', fluxCol: 'f', fluxKeep });
  L.forEach(agg.add);
  const ag = agg.result();
  assert.strictEqual(ag.stats.levees, 4);
  assert.strictEqual(ag.stats.autresFlux, 3);
  const res = analyser([rec(0, { p: 'A1' }), rec(1, { p: 'A2' })], ag, { keyA: 'p', moveThreshold: 50, seuilTaux: 0, seuilArret: 1, fluxKeep });
  const a1 = res.rows.find(r => r.a && r.a.props.p === 'A1');
  const a2 = res.rows.find(r => r.a && r.a.props.p === 'A2');
  assert.deepStrictEqual(a1.flux, { FFOM: 2, OMR: 1 });
  assert.strictEqual(a1.b.agg.n, 2);
  assert.ok(a1.tags.includes('autre_flux') && !a1.tags.includes('identique'));
  assert.deepStrictEqual(a2.tags.sort(), ['autre_flux', 'seulA']);
  const seulB = res.rows.filter(r => r.category === 'seulB');
  assert.deepStrictEqual(seulB.map(r => r.b.props.identifiant), ['X9']);
  assert.strictEqual(seulB[0].b.agg.n, 2);
});

test('statut de levée : seules les levées collectées comptent', () => {
  const L = [
    { d: 45931, p: '011678954D', s: 'Identifié, autorisé, collecté' },
    { d: 45938, p: '011678954D', s: 'Identifié, autorisé, non collecté' },
    { d: 45932, p: 117068081, s: 'Identifié, non autorisé, collecté' },   // zéro perdu par Excel
    { d: 45933, p: '', s: 'Non identifié, non autorisé, collecté' }
  ];
  const statutKeep = new Set(['Identifié, autorisé, collecté', 'Identifié, non autorisé, collecté', 'Non identifié, non autorisé, collecté']);
  const agg = createAggregator({ keyCol: 'p', dateCol: 'd', statutCol: 's', statutKeep, ignoreLeadingZeros: true });
  L.forEach(agg.add);
  const ag = agg.result();
  assert.strictEqual(ag.stats.levees, 2);
  assert.strictEqual(ag.stats.statutsExclus, 1);
  assert.strictEqual(ag.stats.sansCle, 1);
  assert.strictEqual(formatDay(ag.stats.debut), '01/10/2025');
  const res = analyser([rec(0, { puce: '0117068081' }), rec(1, { puce: '011678954D' })], ag, { keyA: 'puce', moveThreshold: 50, seuilTaux: 0, seuilArret: 1, ignoreLeadingZeros: true });
  const r = res.rows.find(x => x.a && x.a.props.puce === '011678954D');
  assert.strictEqual(r.b.agg.n, 1);
  assert.deepStrictEqual(r.statuts, { 'Identifié, autorisé, collecté': 1, 'Identifié, autorisé, non collecté': 1 });
  assert.ok(res.rows.find(x => x.a && x.a.props.puce === '0117068081').b, 'puce sans zéro rapprochée');
});

test('puces converties en nombre par Excel : reconstitution sans écraser une correspondance directe', () => {
  const agg = createAggregator({ keyCol: 'p', dateCol: 'd', ignoreLeadingZeros: true });
  [11677260000, 116772, 116772000].forEach(p => agg.add({ d: 45931, p }));
  const bacs = [rec(0, { p: '01167726E4' }), rec(1, { p: '0116772E00' }), rec(2, { p: '0116772000' }), rec(3, { p: '0116772E03' })];
  const res = analyser(bacs, agg.result(), { keyA: 'p', moveThreshold: 50, seuilTaux: 0, seuilArret: 1, ignoreLeadingZeros: true });
  const leve = p => !!res.rows.find(r => r.a && r.a.props.p === p).b;
  assert.ok(leve('01167726E4') && leve('0116772E00') && leve('0116772000'));
  assert.ok(!leve('0116772E03'), 'la correspondance directe 0116772000 est prioritaire');
  assert.strictEqual(res.stats.pucesCorrigees, 2);
});
