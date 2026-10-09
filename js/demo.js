/*
 * Jeu de données de démonstration : deux inventaires de bacs fictifs
 * (base SIG vs base métier) avec des écarts volontaires.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Demo = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function rng(seed) {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6D2B79F5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const RUES = ['rue de la Paix', 'avenue Jean Jaurès', 'boulevard Victor Hugo', 'rue des Lilas',
    'rue du Moulin', 'impasse des Tilleuls', 'rue Pasteur', 'allée des Chênes', 'rue de la Gare',
    'chemin des Vignes', 'rue Émile Zola', 'place de la Mairie'];
  const COMMUNES = ['Saint-Herblain', 'Rezé', 'Orvault', 'Nantes'];
  const FLUX = ['OM', 'OM', 'OM', 'CS', 'CS', 'VERRE', 'BIODECHETS'];
  const VOLUMES = { OM: [120, 180, 240, 340, 660], CS: [120, 240, 340, 660], VERRE: [120, 240], BIODECHETS: [120, 240] };

  // Déplacement d'un point de d mètres dans une direction aléatoire.
  function offset(lat, lon, d, r) {
    const a = r() * 2 * Math.PI;
    return [lat + (d * Math.cos(a)) / 110574, lon + (d * Math.sin(a)) / (111320 * Math.cos(lat * Math.PI / 180))];
  }

  function generate(n, seed) {
    n = n || 1500;
    const r = rng(seed || 42);
    const pick = arr => arr[Math.floor(r() * arr.length)];
    const centre = [47.2184, -1.5536];
    const sig = [], metier = [];

    for (let i = 1; i <= n; i++) {
      // Points le long de "rues" pour un rendu réaliste.
      const rue = Math.floor(r() * 40);
      const t = r();
      const angle = (rue * 137.5) * Math.PI / 180;
      const base = offset(centre[0], centre[1], 300 + (rue % 10) * 350, () => (rue * 0.618) % 1);
      const lat = base[0] + Math.cos(angle) * t * 0.012;
      const lon = base[1] + Math.sin(angle) * t * 0.018;
      const flux = pick(FLUX);
      const id = 'BAC' + String(i).padStart(6, '0');
      const a = {
        id_bac: id,
        flux,
        volume_l: pick(VOLUMES[flux]),
        adresse: (1 + Math.floor(r() * 120)) + ' ' + pick(RUES),
        commune: pick(COMMUNES),
        date_pose: '20' + (15 + Math.floor(r() * 10)) + '-0' + (1 + Math.floor(r() * 9)) + '-1' + Math.floor(r() * 9),
        longitude: +lon.toFixed(7),
        latitude: +lat.toFixed(7)
      };

      const u = r();
      if (u < 0.05) { sig.push(a); continue; } // absent de la base métier

      // Base métier : noms de colonnes différents, décimales à virgule, bruit GPS.
      const [mlat, mlon] = u < 0.09 ? offset(lat, lon, 30 + r() * 170, r) : offset(lat, lon, r() * 6, r);
      let volume = a.volume_l, fluxB = flux, adresse = a.adresse;
      if (r() < 0.08) volume = pick(VOLUMES[flux].filter(v => v !== a.volume_l)) || volume;
      if (r() < 0.03) fluxB = pick(FLUX.filter(f => f !== flux));
      if (r() < 0.05) adresse = adresse.toUpperCase();
      const b = {
        'N° bac': r() < 0.1 ? id.toLowerCase() : id,
        'Flux': fluxB,
        'Volume (L)': volume,
        'Adresse': adresse,
        'Commune': a.commune,
        'Statut facturation': r() < 0.9 ? 'Actif' : 'Suspendu',
        'LAT': mlat.toFixed(7).replace('.', ','),
        'LON': mlon.toFixed(7).replace('.', ',')
      };
      sig.push(a);
      metier.push(b);
      if (r() < 0.005) metier.push(Object.assign({}, b, { 'Statut facturation': 'Doublon ?' }));
    }

    // Bacs facturés mais absents du SIG.
    const extra = Math.round(n * 0.04);
    for (let j = 0; j < extra; j++) {
      const [lat, lon] = offset(centre[0], centre[1], r() * 3500, r);
      const flux = pick(FLUX);
      metier.push({
        'N° bac': 'BAC' + String(n + 1 + j).padStart(6, '0'),
        'Flux': flux,
        'Volume (L)': pick(VOLUMES[flux]),
        'Adresse': (1 + Math.floor(r() * 120)) + ' ' + pick(RUES),
        'Commune': pick(COMMUNES),
        'Statut facturation': 'Actif',
        'LAT': lat.toFixed(7).replace('.', ','),
        'LON': lon.toFixed(7).replace('.', ',')
      });
    }
    return { sig, metier };
  }

  return { generate };
});
