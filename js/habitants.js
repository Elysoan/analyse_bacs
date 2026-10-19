/*
 * Habitants d'un circuit de collecte : la population des carreaux (INSEE, 200 m) est répartie
 * au prorata de la surface du carreau qui tombe dans le circuit, puis mise en forme pour l'export.
 * Calculs en Europe LAEA (EPSG:3035) : projection équivalente, les surfaces sont exactes.
 * Utilisable dans le navigateur (window.Habitants) et dans Node (tests).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../vendor/proj4.js'));
  else root.Habitants = factory(root.proj4);
})(typeof self !== 'undefined' ? self : this, function (proj4) {
  'use strict';

  const WORK = 'EPSG:3035';
  proj4.defs(WORK, '+proj=laea +lat_0=52 +lon_0=10 +x_0=4321000 +y_0=3210000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs');
  proj4.defs('EPSG:2154', '+proj=lcc +lat_0=46.5 +lon_0=3 +lat_1=49 +lat_2=44 +x_0=700000 +y_0=6600000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs');

  // --- Géométrie -----------------------------------------------------------
  function ringArea(ring) {
    let s = 0;
    for (let i = 0, n = ring.length; i < n; i++) {
      const a = ring[i], b = ring[(i + 1) % n];
      s += a[0] * b[1] - b[0] * a[1];
    }
    return s / 2;
  }

  function bboxOf(ring) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of ring) {
      if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
      if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
    }
    return [x0, y0, x1, y1];
  }

  const overlaps = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
  const inside = (a, b) => a[0] >= b[0] && a[1] >= b[1] && a[2] <= b[2] && a[3] <= b[3];

  // Sutherland-Hodgman : `subject` quelconque, `clip` convexe et orienté anti-horaire.
  function clipPolygon(subject, clip) {
    let out = subject;
    for (let i = 0; i < clip.length && out.length; i++) {
      const a = clip[i], b = clip[(i + 1) % clip.length];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const side = p => dx * (p[1] - a[1]) - dy * (p[0] - a[0]);
      const input = out;
      out = [];
      for (let j = 0; j < input.length; j++) {
        const cur = input[j], prev = input[(j + input.length - 1) % input.length];
        const sc = side(cur), sp = side(prev);
        if ((sc >= 0) !== (sp >= 0)) {
          const t = sp / (sp - sc);
          out.push([prev[0] + t * (cur[0] - prev[0]), prev[1] + t * (cur[1] - prev[1])]);
        }
        if (sc >= 0) out.push(cur);
      }
    }
    return out;
  }

  const clipArea = (subject, clip) => Math.abs(ringArea(clipPolygon(subject, clip)));

  function isConvex(ring) {
    let sign = 0;
    for (let i = 0, n = ring.length; i < n; i++) {
      const a = ring[i], b = ring[(i + 1) % n], c = ring[(i + 2) % n];
      const z = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      if (Math.abs(z) < 1e-9) continue;
      if (sign && (z > 0) !== (sign > 0)) return false;
      sign = z;
    }
    return true;
  }

  function pointInRing(p, ring) {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i], b = ring[j];
      if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) c = !c;
    }
    return c;
  }

  // --- Systèmes de coordonnées ------------------------------------------------
  function detectCRS(x, y) {
    if (Math.abs(x) <= 180 && Math.abs(y) <= 90) return 'EPSG:4326';
    if (x > 50000 && x < 1300000 && y > 6000000 && y < 7200000) return 'EPSG:2154';
    if (x > 2000000 && x < 7500000 && y > 1000000 && y < 5500000) return WORK;
    return 'EPSG:3857';
  }

  function firstCoord(g) {
    let c = g && g.coordinates;
    while (c && Array.isArray(c[0])) c = c[0];
    return c && c.length >= 2 ? c : null;
  }

  // CRS d'un GeoJSON : membre « crs » (ArcGIS Pro), sinon d'après le premier sommet.
  function geojsonCRS(gj, features) {
    const name = gj && gj.crs && gj.crs.properties && gj.crs.properties.name;
    const m = name && /(?:EPSG)(?:::|:)(\d+)/i.exec(name);
    if (m) return m[1] === '4326' || /CRS84/i.test(name) ? 'EPSG:4326' : 'EPSG:' + m[1];
    if (name && /CRS84/i.test(name)) return 'EPSG:4326';
    for (const f of features) {
      const c = firstCoord(f.geometry);
      if (c) return detectCRS(c[0], c[1]);
    }
    return 'EPSG:4326';
  }

  const transform = (from, to) => from === to ? p => [p[0], p[1]] : (t => p => t.forward([p[0], p[1]]))(proj4(from, to));

  function polygonsOf(geometry) {
    if (!geometry) return [];
    if (geometry.type === 'Polygon') return [geometry.coordinates];
    if (geometry.type === 'MultiPolygon') return geometry.coordinates;
    return [];
  }

  // Anneau fermé -> anneau ouvert, orienté anti-horaire.
  function cleanRing(ring, ccw) {
    let r = ring;
    const f = r[0], l = r[r.length - 1];
    if (r.length > 1 && f[0] === l[0] && f[1] === l[1]) r = r.slice(0, -1);
    return ccw && ringArea(r) < 0 ? r.slice().reverse() : r;
  }

  // --- Circuits ---------------------------------------------------------------
  /**
   * Circuits depuis des entités GeoJSON (polygones). Chaque circuit : { id, name, props, parts, bbox, area }
   * avec parts = [[anneau extérieur, ...trous]] en EPSG:3035.
   */
  function circuitsFromFeatures(features, crs, opts) {
    opts = opts || {};
    const tr = transform(crs, WORK);
    const circuits = [];
    let ignored = 0;
    features.forEach((f, i) => {
      const polys = polygonsOf(f.geometry);
      if (!polys.length) { ignored++; return; }
      const parts = polys.map(rings => rings.map((r, k) => cleanRing(r.map(tr), false)));
      const outer = [].concat(...parts.map(p => p[0]));
      let area = 0;
      for (const p of parts) area += Math.abs(ringArea(p[0])) - p.slice(1).reduce((s, h) => s + Math.abs(ringArea(h)), 0);
      const props = f.properties || {};
      const id = opts.idCol ? props[opts.idCol] : undefined;
      const name = opts.nameCol ? props[opts.nameCol] : undefined;
      circuits.push({
        n: i,
        id: id === undefined || id === null || id === '' ? 'Circuit ' + (circuits.length + 1) : String(id),
        name: name === undefined || name === null ? '' : String(name),
        props, parts, bbox: bboxOf(outer), area
      });
    });
    return { circuits, ignored };
  }

  // --- Population : carreaux ----------------------------------------------------
  // Idcar_200m : « CRS3035RES200mN2889000E3811400 » (coin sud-ouest, en mètres, EPSG:3035).
  const RE_CARREAU = /(\d+)m\s?N(\d+)E(\d+)/i;

  function parseCarreauId(id) {
    const m = RE_CARREAU.exec(String(id === undefined || id === null ? '' : id));
    if (!m) return null;
    return { size: +m[1], x: +m[3], y: +m[2] };
  }

  function makeUnit(ring, pop, men, extra) {
    return Object.assign({ ring, bbox: bboxOf(ring), area: ringArea(ring), pop, men, convex: isConvex(ring) }, extra);
  }

  /**
   * Unités de population depuis un tableau de lignes (colonne d'identifiant de carreau).
   * `window` (bbox EPSG:3035) : seuls les carreaux qui la touchent sont conservés (fichiers nationaux).
   * Renvoie { units, extent, read, invalid, total }.
   */
  function unitsFromRows(each, opts) {
    const toNum = opts.toNumber;
    const units = [];
    let read = 0, invalid = 0, total = 0;
    const extent = [Infinity, Infinity, -Infinity, -Infinity];
    each(row => {
      const c = parseCarreauId(row[opts.idCol]);
      if (!c) { invalid++; return; }
      read++;
      extent[0] = Math.min(extent[0], c.x); extent[1] = Math.min(extent[1], c.y);
      extent[2] = Math.max(extent[2], c.x + c.size); extent[3] = Math.max(extent[3], c.y + c.size);
      const box = [c.x, c.y, c.x + c.size, c.y + c.size];
      if (opts.window && !overlaps(box, opts.window)) return;
      const pop = toNum(row[opts.popCol]);
      const men = opts.menCol ? toNum(row[opts.menCol]) : NaN;
      const p = Number.isFinite(pop) ? pop : 0;
      total += p;
      units.push({
        ring: [[c.x, c.y], [box[2], c.y], [box[2], box[3]], [c.x, box[3]]], bbox: box, area: c.size * c.size,
        pop: p, men: Number.isFinite(men) ? men : 0, convex: true
      });
    });
    return { units, extent, read, invalid, total };
  }

  // Unités depuis des polygones GeoJSON (carreaux, IRIS, îlots… avec une colonne de population).
  function unitsFromFeatures(features, crs, opts) {
    const tr = transform(crs, WORK);
    const toNum = opts.toNumber;
    const units = [];
    let read = 0, invalid = 0, total = 0;
    const extent = [Infinity, Infinity, -Infinity, -Infinity];
    for (const f of features) {
      const polys = polygonsOf(f.geometry);
      if (!polys.length) { invalid++; continue; }
      read++;
      const props = f.properties || {};
      const pop = toNum(props[opts.popCol]);
      const men = opts.menCol ? toNum(props[opts.menCol]) : NaN;
      const polysPop = Number.isFinite(pop) ? pop : 0;
      // Plusieurs parties : la population est répartie au prorata des surfaces.
      const rings = polys.map(p => cleanRing(p[0].map(tr), true));
      const areas = rings.map(r => Math.abs(ringArea(r)));
      const sum = areas.reduce((s, a) => s + a, 0) || 1;
      rings.forEach((ring, k) => {
        const b = bboxOf(ring);
        extent[0] = Math.min(extent[0], b[0]); extent[1] = Math.min(extent[1], b[1]);
        extent[2] = Math.max(extent[2], b[2]); extent[3] = Math.max(extent[3], b[3]);
        if (opts.window && !overlaps(b, opts.window)) return;
        const share = areas[k] / sum;
        total += polysPop * share;
        units.push(makeUnit(ring, polysPop * share, Number.isFinite(men) ? men * share : 0));
      });
    }
    return { units, extent, read, invalid, total };
  }

  // Fenêtre de lecture : emprise de tous les circuits, élargie de 1 km.
  function windowOf(circuits, margin) {
    const m = margin === undefined ? 1000 : margin;
    const w = [Infinity, Infinity, -Infinity, -Infinity];
    for (const c of circuits) {
      w[0] = Math.min(w[0], c.bbox[0] - m); w[1] = Math.min(w[1], c.bbox[1] - m);
      w[2] = Math.max(w[2], c.bbox[2] + m); w[3] = Math.max(w[3], c.bbox[3] + m);
    }
    return w;
  }

  // --- Calcul ---------------------------------------------------------------------
  /**
   * Habitants d'un circuit. `onCell(unité, part)` est appelé pour chaque carreau touché
   * (part = fraction du carreau située dans le circuit).
   */
  function computeCircuit(circuit, units, extent, onCell) {
    let pop = 0, men = 0, covered = 0, touched = 0, partial = 0, approx = 0;
    for (const u of units) {
      if (!overlaps(u.bbox, circuit.bbox)) continue;
      let inter = 0;
      if (u.convex) {
        for (const part of circuit.parts) {
          if (!overlaps(u.bbox, bboxOf(part[0]))) continue;
          inter += clipArea(part[0], u.ring);
          for (let h = 1; h < part.length; h++) inter -= clipArea(part[h], u.ring);
        }
      } else {
        // Unité non convexe (rare) : tout ou rien selon son centre.
        const c = u.ring.reduce((s, p) => [s[0] + p[0] / u.ring.length, s[1] + p[1] / u.ring.length], [0, 0]);
        const hit = circuit.parts.some(p => pointInRing(c, p[0]) && !p.slice(1).some(h => pointInRing(c, h)));
        if (hit) { inter = u.area; approx++; }
      }
      const frac = Math.max(0, Math.min(1, inter / u.area));
      if (frac < 1e-6) continue;
      pop += u.pop * frac;
      men += u.men * frac;
      covered += frac * u.area;
      touched++;
      if (frac < 0.999) partial++;
      if (onCell) onCell(u, frac);
    }
    const km2 = circuit.area / 1e6;
    const alerts = [];
    if (extent && !inside(circuit.bbox, [extent[0] - 1000, extent[1] - 1000, extent[2] + 1000, extent[3] + 1000])) alerts.push('Dépasse la zone du fichier de population');
    if (!touched) alerts.push('Aucun carreau habité');
    if (approx) alerts.push(approx + ' unité(s) non convexe(s) : estimation grossière');
    return {
      id: circuit.id, name: circuit.name, props: circuit.props,
      habitants: Math.round(pop), menages: Math.round(men),
      surface: km2, densite: km2 > 0 ? pop / km2 : 0,
      carreaux: touched, partiels: partial,
      couverture: circuit.area > 0 ? Math.min(1, covered / circuit.area) : 0,
      alerts
    };
  }

  function computeAll(circuits, units, extent) {
    return circuits.map(c => computeCircuit(c, units, extent));
  }

  // --- Format d'export ------------------------------------------------------------
  // `re` sert à reconnaître la colonne d'un modèle ; l'ordre compte (le plus spécifique d'abord).
  const FIELDS = [
    { key: 'densite', label: 'Densité (hab/km²)', re: /densit/i },
    { key: 'habParKm', label: 'Habitants par km collecté', re: /(par|\/)\s*km\s*(collect|coll)|hab\w*\s*\/\s*km\s*coll/i },
    { key: 'kmHlp', label: 'Km haut le pied', re: /haut.*pied|hlp|km.*vide/i },
    { key: 'kmCollecte', label: 'Km collectés', re: /km.*collect|collect.*km|kilom/i },
    { key: 'adresses', label: 'Adresses desservies', re: /adresse|point.*collecte|foyers? desservis/i },
    { key: 'communes', label: 'Communes (habitants)', re: /communes?\b/i },
    { key: 'menages', label: 'Nombre de ménages', re: /m[ée]nage|foyer/i },
    { key: 'carreaux', label: 'Nombre de carreaux', re: /carreau/i },
    { key: 'couverture', label: 'Couverture (%)', re: /couverture/i },
    { key: 'source', label: 'Source des données', re: /source|origine|mill[ée]sime/i },
    { key: 'date', label: 'Date de calcul', re: /date|calcul|extraction/i },
    { key: 'surface', label: 'Surface (km²)', re: /surface|superficie|\bkm|\bha\b/i },
    { key: 'habitants', label: "Nombre d'habitants", re: /habitant|population|\bpop\b|inhab/i },
    { key: 'nom', label: 'Libellé circuit', re: /lib[ée]ll?[ée]|nom|name|d[ée]signation|intitul/i },
    { key: 'id', label: 'Code circuit', re: /code|identifiant|^id\b|n°|num|circuit|tourn[ée]e/i }
  ];
  const DISPLAY_ORDER = ['id', 'nom', 'habitants', 'menages', 'surface', 'densite', 'carreaux', 'couverture', 'source', 'date'];
  const DISPLAY_ORDER_TOURNEE = ['id', 'nom', 'habitants', 'menages', 'adresses', 'kmCollecte', 'kmHlp', 'habParKm', 'communes', 'source', 'date'];

  function guessField(header) {
    const f = FIELDS.find(x => x.re.test(String(header)));
    return f ? f.key : '';
  }

  const fieldLabel = key => (FIELDS.find(f => f.key === key) || {}).label || '';

  function standardFormat(tournees) {
    return (tournees ? DISPLAY_ORDER_TOURNEE : DISPLAY_ORDER).map(key => ({ header: fieldLabel(key), field: key, fixed: '' }));
  }

  // Un modèle = les en-têtes d'un fichier existant ; chaque colonne est rattachée à un champ si reconnue.
  function formatFromHeaders(headers) {
    const used = new Set();
    return headers.map(h => {
      let field = guessField(h);
      if (field && used.has(field)) field = '';
      if (field) used.add(field);
      return { header: h, field, fixed: '' };
    });
  }

  function fieldValue(key, r, meta) {
    switch (key) {
      case 'id': return r.id;
      case 'nom': return r.name;
      case 'habitants': return r.habitants;
      case 'menages': return r.menages;
      case 'surface': return Math.round(r.surface * 1000) / 1000;
      case 'densite': return Math.round(r.densite);
      case 'carreaux': return r.carreaux;
      case 'couverture': return Math.round(r.couverture * 100);
      case 'adresses': return r.adresses === undefined ? '' : r.adresses;
      case 'kmCollecte': return r.kmCollecte === undefined ? '' : Math.round(r.kmCollecte * 10) / 10;
      case 'kmHlp': return r.kmHlp === undefined ? '' : Math.round(r.kmHlp * 10) / 10;
      case 'habParKm': return r.habParKm === undefined ? '' : Math.round(r.habParKm * 10) / 10;
      case 'communes': return (r.communes || []).map(c => `${c.commune} (${c.habitants})`).join(' ; ');
      case 'source': return meta.source || '';
      case 'date': return meta.date || '';
      default: return '';
    }
  }

  function buildTable(results, format, meta) {
    meta = meta || {};
    return {
      header: format.map(c => c.header),
      lines: results.map(r => format.map(c => c.field ? fieldValue(c.field, r, meta) : c.fixed || ''))
    };
  }

  return {
    WORK, FIELDS, ringArea, bboxOf, clipPolygon, clipArea, isConvex, pointInRing, detectCRS, geojsonCRS, transform,
    circuitsFromFeatures, parseCarreauId, unitsFromRows, unitsFromFeatures, windowOf,
    computeCircuit, computeAll, guessField, fieldLabel, standardFormat, formatFromHeaders, buildTable
  };
});
