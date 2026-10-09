/*
 * Moteur de comparaison de deux bases de points (ex. inventaires de bacs).
 * Aucune dépendance : utilisable dans le navigateur (window.Compare) et dans Node (tests).
 *
 * Un enregistrement est de la forme { idx, props, lat, lon } :
 *   - idx   : position dans le fichier source
 *   - props : objet { colonne: valeur }
 *   - lat/lon : coordonnées WGS84 (null si absentes)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Compare = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Ordre de priorité pour la catégorie principale (couleur sur la carte).
  const CATEGORIES = ['seulA', 'seulB', 'deplace', 'attributs', 'identique'];

  const R_TERRE = 6371008.8;

  function haversine(lat1, lon1, lat2, lon2) {
    const toRad = Math.PI / 180;
    const dLat = (lat2 - lat1) * toRad;
    const dLon = (lon2 - lon1) * toRad;
    const s = Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
    return 2 * R_TERRE * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  function hasCoords(r) {
    return r && Number.isFinite(r.lat) && Number.isFinite(r.lon);
  }

  function stripAccents(s) {
    return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
  }

  // Normalisation d'un identifiant : pas de conversion numérique (les puces RFID
  // dépassent la précision des nombres JS), uniquement casse / espaces / zéros en tête.
  function normalizeKey(v, opts) {
    if (v === null || v === undefined) return '';
    let s = String(v).trim().replace(/\s+/g, '').toUpperCase();
    if (opts && opts.ignoreLeadingZeros) s = s.replace(/^0+(?=.)/, '');
    return s;
  }

  // Normalisation d'une valeur attributaire avant comparaison.
  function normalizeValue(v, opts) {
    if (v === null || v === undefined) return '';
    let s = String(v).trim().replace(/\s+/g, ' ');
    if (opts.ignoreCase) s = s.toLowerCase();
    if (opts.ignoreAccents) s = stripAccents(s);
    // "1,50" == "1.5" == "1.50" ; limité à 15 chiffres pour rester exact.
    const num = s.replace(/[\s ]/g, '').replace(',', '.');
    if (num !== '' && num.replace(/\D/g, '').length <= 15 &&
        /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(num)) {
      return String(Number(num));
    }
    return s;
  }

  function diffAttributes(a, b, fieldPairs, opts) {
    const diffs = [];
    for (const p of fieldPairs) {
      const va = a.props[p.a];
      const vb = b.props[p.b];
      if (normalizeValue(va, opts) !== normalizeValue(vb, opts)) {
        diffs.push({ a: p.a, b: p.b, va: va == null ? '' : va, vb: vb == null ? '' : vb });
      }
    }
    return diffs;
  }

  function primaryCategory(tags) {
    for (const c of CATEGORIES) if (tags.includes(c)) return c;
    return 'identique';
  }

  function makePair(a, b, opts, extraTags) {
    const tags = extraTags ? extraTags.slice() : [];
    const distance = hasCoords(a) && hasCoords(b) ? haversine(a.lat, a.lon, b.lat, b.lon) : null;
    const diffs = diffAttributes(a, b, opts.fieldPairs || [], opts);
    if (diffs.length) tags.push('attributs');
    if (opts.mode === 'key' && distance !== null && distance > opts.moveThreshold) tags.push('deplace');
    if (!diffs.length && !tags.includes('deplace')) tags.push('identique');
    return { a, b, distance, diffs, tags, category: primaryCategory(tags) };
  }

  function makeSingle(rec, side, extraTags) {
    const tags = [side === 'A' ? 'seulA' : 'seulB'].concat(extraTags || []);
    return {
      a: side === 'A' ? rec : null,
      b: side === 'B' ? rec : null,
      distance: null, diffs: [], tags, category: primaryCategory(tags)
    };
  }

  // --- Rapprochement par identifiant -------------------------------------
  function groupByKey(records, col, opts) {
    const groups = new Map();
    const noKey = [];
    for (const r of records) {
      const k = normalizeKey(r.props[col], opts);
      if (!k) { noKey.push(r); continue; }
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    return { groups, noKey };
  }

  function matchByKey(A, B, opts) {
    const ga = groupByKey(A, opts.keyA, opts);
    const gb = groupByKey(B, opts.keyB, opts);
    const rows = [];

    for (const [k, listA] of ga.groups) {
      const listB = gb.groups.get(k) || [];
      const dup = listA.length > 1 || listB.length > 1 ? ['doublon'] : [];
      const usedB = new Set();
      // Doublons : on associe chaque A au B le plus proche encore libre.
      for (const a of listA) {
        let best = -1, bestD = Infinity;
        listB.forEach((b, i) => {
          if (usedB.has(i)) return;
          const d = hasCoords(a) && hasCoords(b) ? haversine(a.lat, a.lon, b.lat, b.lon) : 0;
          if (best === -1 || d < bestD) { best = i; bestD = d; }
        });
        if (best === -1) rows.push(withKey(makeSingle(a, 'A', dup), k));
        else { usedB.add(best); rows.push(withKey(makePair(a, listB[best], opts, dup), k)); }
      }
      listB.forEach((b, i) => { if (!usedB.has(i)) rows.push(withKey(makeSingle(b, 'B', dup), k)); });
    }
    for (const [k, listB] of gb.groups) {
      if (ga.groups.has(k)) continue;
      const dup = listB.length > 1 ? ['doublon'] : [];
      for (const b of listB) rows.push(withKey(makeSingle(b, 'B', dup), k));
    }
    for (const a of ga.noKey) rows.push(withKey(makeSingle(a, 'A', ['sans_cle']), ''));
    for (const b of gb.noKey) rows.push(withKey(makeSingle(b, 'B', ['sans_cle']), ''));
    return rows;
  }

  function withKey(row, key) { row.key = key; return row; }

  // --- Rapprochement par proximité ---------------------------------------
  // Appariement glouton des paires les plus proches (rayon max), via une grille.
  function matchBySpatial(A, B, opts) {
    const radius = opts.matchRadius;
    const withA = A.filter(hasCoords), withB = B.filter(hasCoords);
    const all = withA.concat(withB);
    const lat0 = all.length ? all.reduce((s, r) => s + r.lat, 0) / all.length : 0;
    const kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110574;
    const cell = Math.max(radius, 1);
    const cellOf = r => [Math.floor(r.lon * kx / cell), Math.floor(r.lat * ky / cell)];

    const grid = new Map();
    withB.forEach((b, i) => {
      const [cx, cy] = cellOf(b);
      const key = cx + ':' + cy;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(i);
    });

    const candidates = [];
    withA.forEach((a, ia) => {
      const [cx, cy] = cellOf(a);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const list = grid.get((cx + dx) + ':' + (cy + dy));
          if (!list) continue;
          for (const ib of list) {
            const d = haversine(a.lat, a.lon, withB[ib].lat, withB[ib].lon);
            if (d <= radius) candidates.push([d, ia, ib]);
          }
        }
      }
    });
    candidates.sort((x, y) => x[0] - y[0]);

    const usedA = new Set(), usedB = new Set(), rows = [];
    for (const [, ia, ib] of candidates) {
      if (usedA.has(ia) || usedB.has(ib)) continue;
      usedA.add(ia); usedB.add(ib);
      const row = makePair(withA[ia], withB[ib], opts);
      row.key = keyLabel(row, opts);
      rows.push(row);
    }
    withA.forEach((a, i) => { if (!usedA.has(i)) rows.push(labelled(makeSingle(a, 'A'), opts)); });
    withB.forEach((b, i) => { if (!usedB.has(i)) rows.push(labelled(makeSingle(b, 'B'), opts)); });
    A.filter(r => !hasCoords(r)).forEach(a => rows.push(labelled(makeSingle(a, 'A', ['sans_coord']), opts)));
    B.filter(r => !hasCoords(r)).forEach(b => rows.push(labelled(makeSingle(b, 'B', ['sans_coord']), opts)));
    return rows;
  }

  function keyLabel(row, opts) {
    const ka = row.a && opts.keyA ? row.a.props[opts.keyA] : '';
    const kb = row.b && opts.keyB ? row.b.props[opts.keyB] : '';
    if (ka && kb && normalizeKey(ka, opts) !== normalizeKey(kb, opts)) return ka + ' / ' + kb;
    return String(ka || kb || '');
  }

  function labelled(row, opts) { row.key = keyLabel(row, opts); return row; }

  // --- Point d'entrée ----------------------------------------------------
  /**
   * @param {Array} A enregistrements base A
   * @param {Array} B enregistrements base B
   * @param {Object} options
   *   mode: 'key' | 'spatial'
   *   keyA, keyB: colonnes identifiant
   *   fieldPairs: [{a, b}] colonnes à comparer
   *   moveThreshold: distance (m) au-delà de laquelle un bac apparié est "déplacé" (mode clé)
   *   matchRadius: rayon (m) de recherche (mode proximité)
   *   ignoreCase, ignoreAccents, ignoreLeadingZeros: options de normalisation
   */
  function compare(A, B, options) {
    const opts = Object.assign({
      mode: 'key', fieldPairs: [], moveThreshold: 20, matchRadius: 15,
      ignoreCase: true, ignoreAccents: false, ignoreLeadingZeros: false
    }, options);
    if (opts.mode === 'key' && (!opts.keyA || !opts.keyB)) {
      throw new Error('Choisissez une colonne identifiant pour chaque base.');
    }
    const rows = opts.mode === 'spatial' ? matchBySpatial(A, B, opts) : matchByKey(A, B, opts);
    return { rows, stats: computeStats(rows, opts) };
  }

  function computeStats(rows, opts) {
    const byTag = { identique: 0, attributs: 0, deplace: 0, seulA: 0, seulB: 0, doublon: 0, sans_cle: 0, sans_coord: 0 };
    const byField = new Map();
    for (const p of opts.fieldPairs || []) byField.set(p.a, { a: p.a, b: p.b, count: 0 });
    let pairs = 0;
    const distances = [];
    for (const r of rows) {
      for (const t of r.tags) byTag[t] = (byTag[t] || 0) + 1;
      if (r.a && r.b) {
        pairs++;
        if (r.distance !== null) distances.push(r.distance);
      }
      for (const d of r.diffs) byField.get(d.a).count++;
    }
    distances.sort((x, y) => x - y);
    const median = distances.length ? distances[Math.floor(distances.length / 2)] : null;
    return { total: rows.length, pairs, byTag, byField: Array.from(byField.values()), medianDistance: median };
  }

  return { compare, normalizeKey, normalizeValue, haversine, CATEGORIES };
});
