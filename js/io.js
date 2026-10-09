/*
 * Lecture des fichiers (CSV, Excel, GeoJSON) et gestion des coordonnées.
 * Dépend de PapaParse, SheetJS (XLSX) et proj4 chargés par index.html.
 */
(function (root) {
  'use strict';

  proj4.defs('EPSG:2154', '+proj=lcc +lat_0=46.5 +lon_0=3 +lat_1=49 +lat_2=44 +x_0=700000 +y_0=6600000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs');

  const CRS = {
    'EPSG:4326': 'WGS84 (lat/lon degrés)',
    'EPSG:2154': 'Lambert 93',
    'EPSG:3857': 'Web Mercator'
  };

  // Décodage UTF-8, avec repli Windows-1252 (CSV exportés par Excel FR).
  function decodeText(buffer) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^﻿/, ''); }
    catch (e) { return new TextDecoder('windows-1252').decode(buffer); }
  }

  /**
   * Lit un fichier et renvoie { kind, sheets: { nom: lignes[] }, geo }.
   * Pour le GeoJSON, chaque ligne contient en plus __x/__y (géométrie).
   */
  async function readFile(file) {
    const name = file.name.toLowerCase();
    const buffer = await file.arrayBuffer();

    if (name.endsWith('.xlsx') || name.endsWith('.xls') || name.endsWith('.ods')) {
      const wb = XLSX.read(buffer, { type: 'array' });
      const sheets = {};
      for (const sn of wb.SheetNames) {
        sheets[sn] = XLSX.utils.sheet_to_json(wb.Sheets[sn], { defval: '', raw: false });
      }
      return { kind: 'excel', sheets };
    }

    const text = decodeText(buffer);
    if (name.endsWith('.geojson') || name.endsWith('.json')) {
      return { kind: 'geojson', sheets: { features: parseGeoJSON(JSON.parse(text)) }, geo: true };
    }
    const res = Papa.parse(text, { header: true, skipEmptyLines: 'greedy', transformHeader: h => h.trim() });
    if (!res.meta.fields || !res.meta.fields.length) throw new Error('Aucune colonne détectée dans ' + file.name);
    return { kind: 'csv', sheets: { csv: res.data } };
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

  /** Convertit les lignes brutes en enregistrements { idx, props, lat, lon }. */
  function toRecords(rows, xCol, yCol, crs) {
    const tr = crs && crs !== 'EPSG:4326' ? proj4(crs, 'EPSG:4326') : null;
    return rows.map((row, idx) => {
      const props = {};
      for (const k in row) if (k !== '__x' && k !== '__y') props[k] = row[k];
      let lat = null, lon = null;
      if (xCol && yCol) {
        const x = toNumber(row[xCol]), y = toNumber(row[yCol]);
        if (Number.isFinite(x) && Number.isFinite(y) && !(x === 0 && y === 0)) {
          const p = tr ? tr.forward([x, y]) : [x, y];
          if (Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90) { lon = p[0]; lat = p[1]; }
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

  root.IO = { CRS, readFile, columnsOf, guessXY, guessKey, guessCRS, toRecords, toNumber, download, toCSV };
})(window);
