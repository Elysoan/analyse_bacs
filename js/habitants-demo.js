/*
 * Données fictives pour l'outil « Habitants par circuit » : une grille de carreaux de 200 m
 * (même format que le fichier INSEE) et quatre circuits de collecte.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./habitants.js'));
  else root.HabitantsDemo = factory(root.Habitants);
})(typeof self !== 'undefined' ? self : this, function (Habitants) {
  'use strict';

  function build() {
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const toWork = Habitants.transform('EPSG:4326', Habitants.WORK);
    const toLonLat = Habitants.transform(Habitants.WORK, 'EPSG:4326');
    const o = toWork([-1.5536, 47.2184]); // Nantes
    const X0 = Math.round(o[0] / 200) * 200 - 4000, Y0 = Math.round(o[1] / 200) * 200 - 3000;
    const NX = 40, NY = 30;

    const rows = [];
    for (let i = 0; i < NX; i++) for (let j = 0; j < NY; j++) {
      const d = Math.hypot((i - 20) / 14, (j - 15) / 11);
      const pop = Math.round(Math.max(0, 260 * Math.exp(-d * d * 2.2) * (0.5 + rnd()) - 8));
      if (pop < 4 || rnd() < 0.12) continue; // carreaux sans habitants : absents du fichier
      rows.push({
        idcar_200m: `CRS3035RES200mN${Y0 + j * 200}E${X0 + i * 200}`,
        ind: pop,
        men: Math.round(pop / 2.1)
      });
    }

    const at = (x, y) => [X0 + x, Y0 + y];
    const poly = coords => ({ type: 'Polygon', coordinates: [coords.map(p => toLonLat(at(p[0], p[1])))] });
    const closed = r => r.concat([r[0]]);
    const feature = (code, lib, geometry) => ({ type: 'Feature', properties: { code_circuit: code, libelle: lib }, geometry });
    const lonlat = (r) => closed(r).map(p => toLonLat(at(p[0], p[1])));

    const circuits = [
      feature('T01', 'Tournée 01 - Centre', { type: 'Polygon', coordinates: [lonlat([[3000, 2300], [5300, 2100], [5900, 3600], [5100, 4600], [3300, 4400]])] }),
      feature('T02', 'Tournée 02 - Nord (avec parc)', { type: 'Polygon', coordinates: [
        lonlat([[3000, 4800], [5600, 4800], [5600, 5800], [3000, 5800]]),
        lonlat([[3800, 5100], [4600, 5100], [4600, 5600], [3800, 5600]])
      ] }),
      feature('T03', 'Tournée 03 - Est (deux secteurs)', { type: 'MultiPolygon', coordinates: [
        [lonlat([[6200, 2200], [7400, 2200], [7400, 3800], [6200, 3800]])],
        [lonlat([[6200, 4200], [7000, 4200], [7000, 5000], [6200, 5000]])]
      ] }),
      feature('T04', 'Tournée 04 - Sud', poly([[2200, 200], [5200, 200], [3800, 1900]]))
    ];

    return { rows, circuits: { type: 'FeatureCollection', features: circuits } };
  }

  // Tournée en tronçons (XML au format réel), adresses et un secteur de regroupement, sur la même grille.
  function buildTournee() {
    const base = build();
    let seed = 11;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const toLonLat = Habitants.transform(Habitants.WORK, 'EPSG:4326');
    // Origine de la grille : retrouvée à partir des identifiants (multiples de 200 m).
    const xs = base.rows.map(r => +/E(\d+)/.exec(r.idcar_200m)[1]), ys = base.rows.map(r => +/N(\d+)E/.exec(r.idcar_200m)[1]);
    const X0 = Math.min(...xs), Y0 = Math.min(...ys);
    const ll = (x, y) => toLonLat([X0 + x, Y0 + y]);

    // Adresses : environ 1 pour 2,3 habitants, réparties dans chaque carreau.
    const addresses = [];
    base.rows.forEach(r => {
      const cx = +/E(\d+)/.exec(r.idcar_200m)[1], cy = +/N(\d+)E/.exec(r.idcar_200m)[1];
      const n = Math.max(1, Math.round(r.ind / 2.3));
      for (let k = 0; k < n; k++) {
        const p = toLonLat([cx + rnd() * 200, cy + rnd() * 200]);
        addresses.push({ numero: k + 1, nom_commune: cy - Y0 > 3500 ? 'Nantes-Nord' : 'Nantes-Sud', lon: +p[0].toFixed(6), lat: +p[1].toFixed(6) });
      }
    });

    const route = [
      ['Collecte à droite', 'Rue du Centre', [[2500, 3000], [4200, 3000], [6000, 3000]]],
      ['Haut le pied', 'Boulevard Est', [[6000, 3000], [6000, 4200]]],
      ['Collecte bilatérale', 'Avenue du Nord', [[6000, 4200], [4500, 4200], [3000, 4200]]],
      ['Haut le pied', 'Rue de Liaison', [[3000, 4200], [2500, 3000]]],
      ['Collecte à gauche', 'Rue du Sud', [[3600, 3000], [3600, 1800]]]
    ];
    const len = pts => pts.slice(1).reduce((t, p, i) => t + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0);
    const esc = v => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    const trs = route.map((r, i) => {
      const g = r[2].map(p => ll(p[0], p[1]));
      return `<tr id="${i}" nr="${esc(r[1])}" ce="Nantes" la="${g[0][1]}" lo="${g[0][0]}" tr="${esc(r[0])}" cm="3" dt="${Math.round(len(r[2]))}" er="0" gy="${g.map(q => `(${q[0].toFixed(5)},${q[1].toFixed(5)})`).join(':')}" mt="6" hc="non"/>`;
    }).join('');
    const total = Math.round(route.reduce((t, r) => t + len(r[2]), 0));
    const xml = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n<ci nc="DEMO1" nl="Tournée exemple" mt="6" ct="Démo" dtt="${total}" dtu="01/01/2026" vth="0">${trs}</ci>`;

    // Secteur de regroupement : un carré de 500 m sans tronçon collecté.
    const ring = [[6400, 1500], [6900, 1500], [6900, 2000], [6400, 2000], [6400, 1500]].map(p => ll(p[0], p[1]));
    const sectors = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { tournee: 'DEMO1', libelle: 'Bac de regroupement' }, geometry: { type: 'Polygon', coordinates: [ring] } }] };
    return { xml, addresses, rows: base.rows, sectors };
  }

  return { build, buildTournee };
});
