const test = require('node:test');
const assert = require('node:assert');
const zlib = require('node:zlib');
const T = require('../js/tournees.js');

const XML = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<ci nc="EC226" nl="Tournée &amp; test" ct="COVED" dtt="300" dtu="31/08/2026"><tr id="0" nr="D97" ce="La Bosse" la="48.1" lo="0.5" tr="Collecte à droite" dt="100" gy="(0.5,48.1):(0.501,48.1)"/><tr id="1" nr="Chemin" ce="La Bosse" la="48.1" lo="0.501" tr="Haut le pied" dt="100" gy="(0.501,48.1):(0.502,48.1)"/><tr id="2" nr="Rue" ce="Autre" la="48.1" lo="0.502" tr="Collecte bilatérale" dt="100"/><tr id="3" nr="X" ce="" la="48.1" lo="0.502" tr="Bizarre" dt="10" gy="(0.5,48.1):(0.5,48.2)"/></ci>`;

test('XML : tournée, tronçons, côté de collecte', () => {
  const t = T.parseXML(XML, 'EC226.xml');
  assert.strictEqual(t.code, 'EC226');
  assert.strictEqual(t.name, 'Tournée & test');
  assert.strictEqual(t.troncons.length, 4);
  assert.deepStrictEqual(t.troncons.map(x => x.side), ['D', '', 'B', '']);
  assert.deepStrictEqual(t.troncons[0].pts, [[0.5, 48.1], [0.501, 48.1]]);
  assert.strictEqual(t.troncons[2].pts.length, 1); // sans tracé : point de départ seul
  assert.deepStrictEqual(t.unknownTypes, ['Bizarre']);
  assert.throws(() => T.parseXML('<foo/>'), /format/);
  assert.strictEqual(T.sideOf('Collecte à gauche'), 'G');
});

// Tournée droite vers l'est : à droite = au sud (y < 0).
const line = (side, pts) => ({ code: 'T', name: '', unknownTypes: [], troncons: [{ side, work: pts, bbox: [Math.min(...pts.map(p => p[0])), Math.min(...pts.map(p => p[1])), Math.max(...pts.map(p => p[0])), Math.max(...pts.map(p => p[1]))], dist: 1000 }] });
const PTS = [{ x: 500, y: -10 }, { x: 500, y: 10 }, { x: 500, y: -50 }, { x: 1200, y: -5 }, { x: 500, y: -29 }];
const run = (tn, w = 30) => Array.from(T.serve(tn, PTS, T.indexPoints(PTS), w).taken.keys()).sort();

test('côté de la bande : droite, gauche, bilatérale, et sens de circulation', () => {
  const east = [[0, 0], [1000, 0]], west = [[1000, 0], [0, 0]];
  assert.deepStrictEqual(run(line('D', east)), [0, 4]);   // sud, à moins de 30 m
  assert.deepStrictEqual(run(line('G', east)), [1]);      // nord
  assert.deepStrictEqual(run(line('B', east)), [0, 1, 4]);
  assert.deepStrictEqual(run(line('D', west)), [1]);      // sens inverse : la droite devient le nord
  assert.deepStrictEqual(run(line('', east)), []);        // haut le pied
  assert.deepStrictEqual(run(line('D', east), 60), [0, 2, 4]);
});

test('aller-retour à droite = les deux côtés, chaque adresse comptée une fois', () => {
  const tn = line('D', [[0, 0], [1000, 0]]);
  tn.troncons.push(line('D', [[1000, 0], [0, 0]]).troncons[0]);
  const s = T.serve(tn, PTS, T.indexPoints(PTS), 30);
  assert.deepStrictEqual(Array.from(s.taken.keys()).sort(), [0, 1, 4]);
  assert.deepStrictEqual(s.perTroncon, [2, 1]);
});

test('secteur en polygone : ajouté à la bande, sans doublon', () => {
  const tn = line('D', [[0, 0], [1000, 0]]);
  const sector = [[[[400, -100], [600, -100], [600, 100], [400, 100]]]];
  const s = T.serve(tn, PTS, T.indexPoints(PTS), 30, sector);
  assert.deepStrictEqual(Array.from(s.taken.keys()).sort(), [0, 1, 2, 4]);
  assert.strictEqual(s.taken.get(0), 'troncon');
  assert.strictEqual(s.taken.get(1), 'secteur');
});

test('habitants par adresse : population du carreau répartie, orphelins signalés', () => {
  const units = [
    { bbox: [0, 0, 200, 200], pop: 10, men: 4 },
    { bbox: [200, 0, 400, 200], pop: 7, men: 3 }   // aucune adresse
  ];
  const pts = [{ x: 10, y: 10 }, { x: 150, y: 150 }, { x: 5000, y: 5000 }];
  const w = T.weigh(pts, units, 2.2);
  assert.deepStrictEqual(Array.from(w.pop), [5, 5, 0]);
  assert.deepStrictEqual(Array.from(w.men), [2, 2, 0]);
  assert.strictEqual(w.orphanPop, 7);
  assert.deepStrictEqual(Array.from(T.weigh(pts, null, 2.2).pop), [2.2, 2.2, 2.2]);
});

test('synthèse : habitants, adresses, kilomètres et communes', () => {
  const tn = T.parseXML(XML, 'x.xml');
  T.project(tn);
  const taken = new Map([[0, 'troncon'], [1, 'troncon'], [2, 'secteur']]);
  const r = T.summarize(tn, { taken }, { pop: Float64Array.from([2, 3, 4]), men: Float64Array.from([1, 1, 2]) }, ['A', 'A', 'B']);
  assert.strictEqual(r.habitants, 9);
  assert.strictEqual(T.summarize(tn, { taken }, { pop: Float64Array.from([2, 3, 4]), men: new Float64Array(3), mode: 'fixe' }, ['A', 'A', 'B']).menages, '');
  assert.strictEqual(r.adresses, 3);
  assert.strictEqual(r.adressesSecteur, 1);
  assert.strictEqual(r.kmCollecte, 0.2);
  assert.strictEqual(r.kmHlp, 0.11);
  assert.deepStrictEqual(r.communes, [{ commune: 'A', adresses: 2, habitants: 5 }, { commune: 'B', adresses: 1, habitants: 4 }]);
  assert.ok(r.alerts.some(a => /sans tracé/.test(a)));
  assert.ok(r.alerts.some(a => /Bizarre/.test(a)));
});

// Archive zip minimale (un fichier « stocké », un fichier compressé)
function zip(files) {
  const parts = [], central = [];
  let off = 0;
  for (const [name, data, method] of files) {
    const raw = Buffer.from(data), comp = method === 8 ? zlib.deflateRawSync(raw) : raw, nm = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(method, 8); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nm.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(method, 10); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(off, 42);
    parts.push(lh, nm, comp); central.push(ch, nm);
    off += 30 + nm.length + comp.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  const all = Buffer.concat(parts.concat([cd, end]));
  return all.buffer.slice(all.byteOffset, all.byteOffset + all.length);
}

test('zip : plusieurs tournées, compressées ou non', async () => {
  const files = await T.unzip(zip([['EC1.xml', XML, 8], ['dossier/', '', 0], ['EC2.xml', XML.replace('EC226', 'EC227'), 0]]));
  assert.deepStrictEqual(files.map(f => f.name), ['EC1.xml', 'EC2.xml']);
  assert.strictEqual(T.parseXML(T.decodeText(files[0].bytes)).code, 'EC226');
  assert.strictEqual(T.parseXML(T.decodeText(files[1].bytes)).code, 'EC227');
  await assert.rejects(() => T.unzip(new ArrayBuffer(40)), /zip/);
});
