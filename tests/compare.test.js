const test = require('node:test');
const assert = require('node:assert');
const { compare, normalizeKey, normalizeValue } = require('../js/compare.js');
const Demo = require('../js/demo.js');

const rec = (idx, props, lat = null, lon = null) => ({ idx, props, lat, lon });
const tagsOf = (res, key) => res.rows.filter(r => r.key === key).map(r => r.tags.sort().join('+'));

test('normalisation des identifiants : casse, espaces, zéros en tête optionnels', () => {
  assert.strictEqual(normalizeKey(' bac 001 '), 'BAC001');
  assert.strictEqual(normalizeKey('000123'), '000123');
  assert.strictEqual(normalizeKey('000123', { ignoreLeadingZeros: true }), '123');
  // Les grands identifiants RFID ne doivent pas être arrondis.
  assert.notStrictEqual(normalizeKey('250012345678901234'), normalizeKey('250012345678901235'));
});

test('normalisation des valeurs : nombres FR, casse, accents', () => {
  const o = { ignoreCase: true, ignoreAccents: true };
  assert.strictEqual(normalizeValue('1,50', o), normalizeValue('1.5', o));
  assert.strictEqual(normalizeValue(240, o), normalizeValue('240', o));
  assert.strictEqual(normalizeValue('Rue Émile', o), normalizeValue('rue emile', o));
  assert.notStrictEqual(normalizeValue('Rue Émile', { ignoreCase: false }), normalizeValue('rue Émile', { ignoreCase: false }));
});

test('mode identifiant : identiques, écarts, déplacés, seuls, doublons, sans clé', () => {
  const A = [
    rec(0, { id: 'B1', vol: '240' }, 47, -1.5),
    rec(1, { id: 'B2', vol: '240' }, 47, -1.5),
    rec(2, { id: 'B3', vol: '120' }, 47, -1.5),
    rec(3, { id: 'B4', vol: '120' }, 47, -1.5),
    rec(4, { id: '', vol: '120' }, 47, -1.5)
  ];
  const B = [
    rec(0, { num: 'b1', volume: '240,0' }, 47.00001, -1.5),  // ~1 m
    rec(1, { num: 'B2', volume: '340' }, 47, -1.5),
    rec(2, { num: 'B3', volume: '120' }, 47.001, -1.5),       // ~111 m
    rec(3, { num: 'B5', volume: '120' }, 47, -1.5),
    rec(4, { num: 'B5', volume: '120' }, 47, -1.5)
  ];
  const res = compare(A, B, { mode: 'key', keyA: 'id', keyB: 'num', fieldPairs: [{ a: 'vol', b: 'volume' }], moveThreshold: 20 });
  assert.deepStrictEqual(tagsOf(res, 'B1'), ['identique']);
  assert.deepStrictEqual(tagsOf(res, 'B2'), ['attributs']);
  assert.deepStrictEqual(tagsOf(res, 'B3'), ['deplace']);
  assert.deepStrictEqual(tagsOf(res, 'B4'), ['seulA']);
  assert.deepStrictEqual(tagsOf(res, 'B5'), ['doublon+seulB', 'doublon+seulB']);
  assert.deepStrictEqual(tagsOf(res, ''), ['sans_cle+seulA']);
  assert.strictEqual(res.stats.byField[0].count, 1);
  assert.strictEqual(res.stats.pairs, 3);
});

test('mode identifiant : un doublon est apparié au plus proche', () => {
  const A = [rec(0, { id: 'X' }, 47, -1.5)];
  const B = [rec(0, { id: 'X' }, 47.01, -1.5), rec(1, { id: 'X' }, 47.00001, -1.5)];
  const res = compare(A, B, { mode: 'key', keyA: 'id', keyB: 'id' });
  const pair = res.rows.find(r => r.a && r.b);
  assert.strictEqual(pair.b.idx, 1);
  assert.ok(pair.tags.includes('doublon'));
  assert.strictEqual(res.rows.filter(r => r.tags.includes('seulB')).length, 1);
});

test('mode proximité : appariement au plus proche dans le rayon', () => {
  const A = [rec(0, { id: 'a1' }, 47, -1.5), rec(1, { id: 'a2' }, 47.0001, -1.5), rec(2, { id: 'a3' }, 48, -1)];
  const B = [rec(0, { id: 'b1' }, 47.00002, -1.5), rec(1, { id: 'b2' }, 47.00012, -1.5), rec(2, { id: 'b3' })];
  const res = compare(A, B, { mode: 'spatial', matchRadius: 10, keyA: 'id', keyB: 'id' });
  const pairs = res.rows.filter(r => r.a && r.b).map(r => r.a.props.id + '-' + r.b.props.id).sort();
  assert.deepStrictEqual(pairs, ['a1-b1', 'a2-b2']);
  assert.ok(res.rows.some(r => r.a && r.a.props.id === 'a3' && r.tags.includes('seulA')));
  assert.ok(res.rows.some(r => r.b && r.b.props.id === 'b3' && r.tags.includes('sans_coord')));
});

test('jeu de démonstration : écarts cohérents', () => {
  const d = Demo.generate(1500, 42);
  const toRec = (rows, x, y) => rows.map((p, i) => rec(i, p, Number(String(p[y]).replace(',', '.')), Number(String(p[x]).replace(',', '.'))));
  const res = compare(toRec(d.sig, 'longitude', 'latitude'), toRec(d.metier, 'LON', 'LAT'), {
    mode: 'key', keyA: 'id_bac', keyB: 'N° bac', moveThreshold: 20,
    fieldPairs: [{ a: 'flux', b: 'Flux' }, { a: 'volume_l', b: 'Volume (L)' }, { a: 'adresse', b: 'Adresse' }]
  });
  const t = res.stats.byTag;
  for (const k of ['identique', 'attributs', 'deplace', 'seulA', 'seulB']) assert.ok(t[k] > 0, k + ' attendu > 0');
  assert.ok(t.identique > 1000);
  assert.strictEqual(res.stats.byField.find(f => f.a === 'adresse').count, 0, 'la casse est ignorée par défaut');
});

test('puce hexadécimale convertie par Excel en notation scientifique', () => {
  const { keyText } = require('../js/compare.js');
  assert.strictEqual(keyText(116794e12), '116794E12');          // « 0116794E12 » lu par Excel
  assert.strictEqual(normalizeKey(116794e12, { ignoreLeadingZeros: true }), normalizeKey('0116794E12', { ignoreLeadingZeros: true }));
  assert.strictEqual(normalizeKey(116790e12, { ignoreLeadingZeros: true }), normalizeKey('0116790E12', { ignoreLeadingZeros: true }));
  assert.strictEqual(keyText(117068081), '117068081');          // nombre ordinaire inchangé
  assert.strictEqual(keyText('011678954D'), '011678954D');
});
