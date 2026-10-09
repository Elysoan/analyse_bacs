/*
 * Lecture des fichiers (CSV, Excel, GeoJSON) et gestion des coordonnées.
 * Dépend de PapaParse, SheetJS (XLSX) et proj4 chargés par index.html.
 *
 * readFile() renvoie une "source" qui expose, pour chaque onglet :
 *   preview(onglet) -> 2 000 premières lignes (paramétrage)
 *   count(onglet)   -> nombre de lignes (approximatif pour les CSV)
 *   all(onglet)     -> toutes les lignes (mises en cache)
 *   each(onglet, f) -> parcours ligne à ligne, sans tout garder en mémoire (gros fichiers de levées)
 */
(function (root) {
  'use strict';

  proj4.defs('EPSG:2154', '+proj=lcc +lat_0=46.5 +lon_0=3 +lat_1=49 +lat_2=44 +x_0=700000 +y_0=6600000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs');

  const CRS = {
    'EPSG:4326': 'WGS84 (lat/lon degrés)',
    'EPSG:2154': 'Lambert 93',
    'EPSG:3857': 'Web Mercator'
  };
  const PREVIEW = 2000;
  const CHUNK = 20000;

  // Décodage UTF-8, avec repli Windows-1252 (CSV exportés par Excel FR).
  function decodeText(buffer) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^﻿/, ''); }
    catch (e) { return new TextDecoder('windows-1252').decode(buffer); }
  }

  async function readFile(file) {
    const name = file.name.toLowerCase();
    const buffer = await file.arrayBuffer();
    if (/\.(xlsx|xlsm|xls|ods)$/.test(name)) {
      // Réglages mémoire : 800 000 lignes ≈ 20 s et 730 Mo (contre 40 s et 1,8 Go par défaut).
      return excelSource(XLSX.read(buffer, { type: 'array', dense: true, cellHTML: false, cellText: false, cellNF: true }));
    }
    const text = decodeText(buffer);
    if (name.endsWith('.geojson') || name.endsWith('.json')) {
      const src = arraySource({ entites: parseGeoJSON(JSON.parse(text)) });
      src.geo = true;
      return src;
    }
    return csvSource(text, file.name);
  }

  // --- Sources ------------------------------------------------------------
  function arraySource(sheets) {
    return {
      kind: 'table',
      sheetNames: Object.keys(sheets),
      preview: s => sheets[s].slice(0, PREVIEW),
      count: s => sheets[s].length,
      all: s => sheets[s],
      each: (s, f) => sheets[s].forEach(f),
      distinct: (s, col) => countValues(f => sheets[s].forEach(f), col)
    };
  }

  function csvSource(text, fileName) {
    const opts = { header: true, skipEmptyLines: 'greedy', transformHeader: h => h.trim() };
    const head = Papa.parse(text, Object.assign({ preview: PREVIEW }, opts));
    if (!head.meta.fields || !head.meta.fields.length) throw new Error('Aucune colonne détectée dans ' + fileName);
    let lines = 0;
    for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) lines++;
    let full = null;
    return {
      kind: 'csv',
      sheetNames: ['csv'],
      preview: () => head.data,
      count: () => full ? full.length : Math.max(head.data.length, lines - (text.endsWith('\n') ? 1 : 0)),
      all: () => full || (full = Papa.parse(text, opts).data),
      each: (s, f) => {
        if (full) return full.forEach(f);
        Papa.parse(text, Object.assign({ step: r => f(r.data) }, opts));
      },
      distinct(s, col) { return countValues(f => this.each(s, f), col); }
    };
  }

  function excelSource(wb) {
    const cache = {};
    function sheet(name) {
      if (cache[name]) return cache[name];
      const ws = wb.Sheets[name];
      fixDates(ws);
      const ref = ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']) : null;
      let headers = [];
      if (ref) {
        const first = XLSX.utils.sheet_to_json(ws, { header: 1, range: { s: ref.s, e: { r: ref.s.r, c: ref.e.c } }, defval: '', raw: true })[0] || [];
        const seen = {};
        headers = first.map((h, i) => {
          let n = String(h).trim() || 'Colonne ' + (i + 1);
          if (seen[n]) n = n + '_' + seen[n]++; else seen[n] = 1;
          return n;
        });
      }
      // raw: true -> nombres exacts (pas de « 1.16772E+14 » pour un n° de puce), dates déjà converties en texte.
      const rows = (r0, r1) => r1 < r0 ? [] : XLSX.utils.sheet_to_json(ws, {
        header: headers, range: { s: { r: r0, c: ref.s.c }, e: { r: r1, c: ref.e.c } },
        defval: '', raw: true, blankrows: false
      });
      return (cache[name] = { ref, headers, rows, full: null });
    }
    return {
      kind: 'excel',
      sheetNames: wb.SheetNames,
      preview: s => { const x = sheet(s); return x.ref ? x.rows(x.ref.s.r + 1, Math.min(x.ref.e.r, x.ref.s.r + PREVIEW)) : []; },
      count: s => { const x = sheet(s); return x.full ? x.full.length : (x.ref ? x.ref.e.r - x.ref.s.r : 0); },
      all: s => { const x = sheet(s); return x.full || (x.full = x.ref ? x.rows(x.ref.s.r + 1, x.ref.e.r) : []); },
      each: (s, f) => {
        const x = sheet(s);
        if (!x.ref) return;
        if (x.full) return x.full.forEach(f);
        for (let r = x.ref.s.r + 1; r <= x.ref.e.r; r += CHUNK) x.rows(r, Math.min(x.ref.e.r, r + CHUNK - 1)).forEach(f);
      },
      distinct: (s, col) => {
        const x = sheet(s);
        const ci = x.headers.indexOf(col);
        if (!x.ref || ci < 0) return [];
        const ws = wb.Sheets[s], c = x.ref.s.c + ci;
        return countValues(f => {
          for (let r = x.ref.s.r + 1; r <= x.ref.e.r; r++) {
            const cell = Array.isArray(ws) ? (ws[r] || [])[c] : ws[XLSX.utils.encode_cell({ r, c })];
            f({ [col]: cell ? cell.v : '' });
          }
        }, col);
      }
    };
  }

  // Valeurs distinctes d'une colonne avec leur nombre d'occurrences (au plus 200 valeurs).
  function countValues(iterate, col) {
    const m = new Map();
    iterate(row => {
      const v = row[col];
      const k = v === undefined || v === null || String(v).trim() === '' ? '(vide)' : String(v).trim();
      if (m.has(k) || m.size < 200) m.set(k, (m.get(k) || 0) + 1);
    });
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1]);
  }

  function guessFlux(rows, cols) {
    return cols.find(c => /flux|fili[eè]re|nature.*d[ée]chet|type.*d[ée]chet|produit/i.test(c) &&
      new Set(rows.map(r => r[c])).size <= 30) || '';
  }

  // Les dates Excel sont des nombres de jours : on les écrit nous-mêmes en jj/mm/aaaa [hh:mm]
  // plutôt que via le format d'affichage (souvent américain, ex. « 3/4/25 »).
  function serialToText(v) {
    let day = Math.floor(v);
    let min = Math.round((v - day) * 1440);
    if (min === 1440) { day++; min = 0; }
    const dt = new Date((day - 25569) * 86400000);
    const p = n => String(n).padStart(2, '0');
    const d = p(dt.getUTCDate()) + '/' + p(dt.getUTCMonth() + 1) + '/' + dt.getUTCFullYear();
    return min ? d + ' ' + p(Math.floor(min / 60)) + ':' + p(min % 60) : d;
  }

  function fixDates(ws) {
    const fix = c => {
      if (c && c.t === 'n' && c.z && XLSX.SSF.is_date(c.z)) {
        c.t = 's';
        // Heure seule (fraction de jour) : hh:mm
        if (c.v < 1) { const m = Math.round(c.v * 1440); c.v = String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); }
        else c.v = serialToText(c.v);
      }
    };
    if (Array.isArray(ws)) ws.forEach(row => row && row.forEach(fix));
    else for (const k in ws) if (k[0] !== '!') fix(ws[k]);
  }

  function parseGeoJSON(gj) {
    const features = gj.type === 'FeatureCollection' ? gj.features : (gj.type === 'Feature' ? [gj] : []);
    if (!features.length) throw new Error('GeoJSON sans entités (FeatureCollection attendue).');
    return features.map(f => {
      const row = Object.assign({}, f.properties || {});
      const c = pointOf(f.geometry);
      row.__x = c ? c[0] : '';
      row.__y = c ? c[1] : '';
      return row;
    });
  }

  // Point représentatif : le point lui-même, ou le premier sommet pour les autres géométries.
  function pointOf(g) {
    if (!g || !g.coordinates) return null;
    let c = g.coordinates;
    while (Array.isArray(c[0])) c = c[0];
    return c.length >= 2 ? c : null;
  }

  // --- Colonnes -----------------------------------------------------------
  function columnsOf(rows) {
    const cols = new Set();
    rows.slice(0, 200).forEach(r => Object.keys(r).forEach(k => cols.add(k)));
    return Array.from(cols);
  }

  function toNumber(v) {
    if (v === null || v === undefined || v === '') return NaN;
    if (typeof v === 'number') return v;
    return Number(String(v).trim().replace(/[\s ]/g, '').replace(',', '.'));
  }

  // Devine les colonnes X / Y d'après leur nom.
  function guessXY(cols) {
    if (cols.includes('__x') && cols.includes('__y')) return { x: '__x', y: '__y' };
    const find = re => cols.find(c => re.test(c.trim()));
    const x = find(/^(lon|lng|long|longitude|x|x_?l93|coord_?x|x_?wgs84|point_?x|xcoord)$/i) ||
              find(/(longitude|^lon|^x[_ ]|[_ ]x$)/i);
    const y = find(/^(lat|latitude|y|y_?l93|coord_?y|y_?wgs84|point_?y|ycoord)$/i) ||
              find(/(latitude|^lat|^y[_ ]|[_ ]y$)/i);
    return { x: x || '', y: y || '' };
  }

  function guessKey(cols) {
    return cols.find(c => /^(id|identifiant|num|numero|n°|no)?[ _-]?(bac|puce|rfid|tag|conteneur|cuve)/i.test(c)) ||
           cols.find(c => /(^id$|^id_|_id$|identifiant|numero|n°|rfid|puce)/i.test(c)) || cols[0] || '';
  }

  // Part des valeurs d'une colonne reconnues comme dates.
  function dateRatio(rows, col) {
    let n = 0, ok = 0;
    for (const r of rows) {
      const v = r[col];
      if (v === '' || v === null || v === undefined) continue;
      n++;
      if (/[/.-]/.test(String(v)) && Levees.parseDate(v) !== null) ok++;
      if (n >= 200) break;
    }
    return n ? ok / n : 0;
  }

  function guessDate(rows, cols) {
    return cols.find(c => /date|jour|horodat/i.test(c) && dateRatio(rows, c) >= 0.5) ||
           cols.find(c => dateRatio(rows, c) >= 0.8) || '';
  }

  function guessWeight(cols) {
    return cols.find(c => /poids|pes[ée]e|\bkg\b|masse|weight|tonnage/i.test(c)) || '';
  }

  /**
   * Choisit le couple de colonnes identifiant qui partage le plus de valeurs entre les deux bases
   * (zéros en tête ignorés pour la détection). Renvoie aussi le score sans cette tolérance,
   * pour savoir s'il faut cocher l'option « ignorer les zéros en tête ».
   * Les colonnes de dates, de coordonnées et à faible diversité (commune, volume, n° de rue) sont écartées.
   */
  function guessKeyPair(rowsA, colsA, rowsB, colsB) {
    const usable = (rows, cols) => cols.filter(c => !c.startsWith('__') && dateRatio(rows, c) < 0.5);
    const distinct = (rows, col, zeros) => {
      const s = new Set();
      let filled = 0;
      for (const r of rows) {
        const k = Compare.normalizeKey(r[col], { ignoreLeadingZeros: zeros });
        if (k) { s.add(k); filled++; }
      }
      s.filled = filled;
      return s;
    };
    const overlap = (sa, sb) => { let n = 0; for (const v of sa) if (sb.has(v)) n++; return n; };
    const setsB = usable(rowsB, colsB).map(c => [c, distinct(rowsB, c, true)]);
    let best = { a: '', b: '', score: 0 };
    for (const ca of usable(rowsA, colsA)) {
      const sa = distinct(rowsA, ca, true);
      if (sa.size < 10 || sa.size < 0.5 * sa.filled) continue; // un identifiant est (presque) unique dans A
      for (const [cb, sb] of setsB) {
        const score = overlap(sa, sb);
        if (score > best.score && score >= 5) best = { a: ca, b: cb, score };
      }
    }
    if (!best.score) {
      return { a: guessKey(colsA.filter(c => !c.startsWith('__'))), b: guessKey(colsB.filter(c => !c.startsWith('__'))), score: 0, scoreExact: 0 };
    }
    best.scoreExact = overlap(distinct(rowsA, best.a, false), distinct(rowsB, best.b, false));
    return best;
  }

  // Devine le système de coordonnées d'après l'ordre de grandeur des valeurs.
  function guessCRS(rows, xCol, yCol) {
    const sample = [];
    for (const r of rows) {
      const x = toNumber(r[xCol]), y = toNumber(r[yCol]);
      if (Number.isFinite(x) && Number.isFinite(y)) sample.push([x, y]);
      if (sample.length >= 50) break;
    }
    if (!sample.length) return 'EPSG:4326';
    const [x, y] = sample[Math.floor(sample.length / 2)];
    if (Math.abs(x) <= 180 && Math.abs(y) <= 90) return 'EPSG:4326';
    if (x > 50000 && x < 1300000 && y > 6000000 && y < 7200000) return 'EPSG:2154';
    return 'EPSG:3857';
  }

  /** Fonction (x, y) -> [lon, lat] WGS84, ou null si hors limites. */
  function projector(crs) {
    const tr = crs && crs !== 'EPSG:4326' ? proj4(crs, 'EPSG:4326') : null;
    return (x, y) => {
      const p = tr ? tr.forward([x, y]) : [x, y];
      return Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90 ? p : null;
    };
  }

  /** Convertit les lignes brutes en enregistrements { idx, props, lat, lon }. */
  function toRecords(rows, xCol, yCol, crs) {
    const project = projector(crs);
    return rows.map((row, idx) => {
      const props = {};
      for (const k in row) if (k !== '__x' && k !== '__y') props[k] = row[k];
      let lat = null, lon = null;
      if (xCol && yCol) {
        const x = toNumber(row[xCol]), y = toNumber(row[yCol]);
        if (Number.isFinite(x) && Number.isFinite(y) && !(x === 0 && y === 0)) {
          const p = project(x, y);
          if (p) { lon = p[0]; lat = p[1]; }
        }
      }
      return { idx, props, lat, lon };
    });
  }

  // --- Exports -----------------------------------------------------------
  function download(filename, content, mime) {
    const blob = new Blob([content], { type: mime });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }

  function toCSV(header, lines) {
    const esc = v => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    // BOM + point-virgule : ouverture directe dans Excel FR.
    return '﻿' + [header].concat(lines).map(l => l.map(esc).join(';')).join('\r\n');
  }

  root.IO = {
    CRS, readFile, arraySource, columnsOf, guessXY, guessKey, guessKeyPair, guessDate, guessWeight, guessFlux, dateRatio,
    guessCRS, projector, toRecords, toNumber, download, toCSV
  };
})(window);
