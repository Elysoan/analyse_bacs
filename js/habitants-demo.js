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

  return { build };
});
