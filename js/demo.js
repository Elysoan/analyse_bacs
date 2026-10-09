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

  /*
   * Base client biodéchets (même structure que l'export agglo) + une année de levées.
   * Noms et adresses fictifs. Coordonnées ajoutées à la base client pour que la démo
   * fonctionne hors-ligne (la vraie base, sans coordonnées, passe par le géocodage).
   */
  const NOMS = ['MARTIN', 'BERNARD', 'THOMAS', 'PETIT', 'ROBERT', 'RICHARD', 'DURAND', 'LEROY', 'MOREAU', 'SIMON',
    'LAURENT', 'LEFEBVRE', 'MICHEL', 'GARCIA', 'DAVID', 'BERTRAND', 'ROUX', 'VINCENT', 'FOURNIER', 'MOREL'];
  const PRENOMS = ['MARIE', 'JEAN', 'ANNE', 'PIERRE', 'SOPHIE', 'LUC', 'CLAIRE', 'PAUL', 'JULIE', 'ALAIN'];
  const VOIES = [['RUE', 'DES', 'MOUETTES'], ['AVENUE', 'DE LA', 'PLAGE'], ['RUE', 'DU', 'PORT'], ['IMPASSE', 'DES', 'PINS'],
    ['RUE', 'DES', 'SALINES'], ['ROUTE', 'DE LA', 'FORET'], ['RUE', 'DES', 'DUNES'], ['ALLEE', 'DES', 'GOELANDS'],
    ['RUE', 'DU', 'MARAIS'], ['CHEMIN', 'DES', 'VIGNES'], ['RUE', 'DE LA', 'JETEE'], ['AVENUE', 'DES', 'SABLES']];
  const COMMUNES_LSO = ["LES SABLES D'OLONNE", 'OLONNE SUR MER', "LE CHATEAU D'OLONNE"];
  const ACTIVITES = [['Habitation individuelle', 0.85], ['Immeuble collectif/Appart', 0.10], ['Bâtiment public', 0.05]];

  const MOIS = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];
  const LIBELLES = {
    111: 'Identifié, autorisé, collecté',
    110: 'Identifié, autorisé, non collecté',
    101: 'Identifié, non autorisé, collecté',
    1: 'Non identifié, non autorisé, collecté'
  };
  // Ce que fait Excel d'une puce : « 0117068081 » devient le nombre 117068081,
  // « 0116794E12 » devient 1,16794E+17 ; les puces avec d'autres lettres restent du texte.
  function commeExcel(puce) {
    if (/^\d+$/.test(puce)) return Number(puce);
    // (au-delà de 9,99E+307, Excel ne peut pas convertir et garde le texte)
    if (/^\d+E\d+$/.test(puce) && Number(puce.replace('E', 'e')) < 9.99e307) return Number(puce.replace('E', 'e'));
    return puce;
  }

  function generateLevees(n, seed) {
    n = n || 1500;
    const r = rng(seed || 7);
    const pick = arr => arr[Math.floor(r() * arr.length)];
    const p2 = x => String(x).padStart(2, '0');
    const JOUR = 86400000;
    const debut = Date.UTC(2025, 0, 1) / JOUR, fin = Date.UTC(2025, 11, 31) / JOUR;
    const trouDebut = Date.UTC(2025, 7, 11) / JOUR, trouFin = Date.UTC(2025, 7, 24) / JOUR; // export incomplet
    const fmtDate = d => { const t = new Date(d * JOUR); return p2(t.getUTCDate()) + '/' + p2(t.getUTCMonth() + 1) + '/' + t.getUTCFullYear(); };
    const centre = [46.4967, -1.7831];

    const clients = [], levees = [];
    const ajouterLevees = (puce, secteur, lat, lon, p, du, au, decalage, flux, nonAutorise) => {
      let nb = 0;
      const jourCollecte = secteur % 5; // 0 = lundi
      for (let lundi = debut - ((debut + 3) % 7); lundi <= fin; lundi += 7) {
        const d = lundi + jourCollecte;
        if (d < du || d > au || d < debut || d > fin || (d >= trouDebut && d <= trouFin)) continue;
        if (r() > p) continue;
        nb++;
        const [la, lo] = offset(lat, lon, decalage + r() * 15, r);
        // Même structure que l'export des levées Paprec.
        const u = r();
        const code = nonAutorise ? 101 : u < 0.004 ? 1 : u < 0.014 ? 110 : 111;
        const lue = code !== 1;
        const dt = new Date(d * JOUR);
        levees.push({
          'Annee': 'Année ' + dt.getUTCFullYear(),
          'Mois': MOIS[dt.getUTCMonth()],
          'Jour': d + 25569, // numéro de série Excel, comme dans l'export
          'Contrat': 'LSOA',
          'Code Tournee': r() < 0.5 ? 'SANS TOURNEE' : 'LSO' + p2(secteur),
          'Statut Tournee': 'Mise à disposition',
          'Flux': flux || 'FFOM',
          'Code Levee': code,
          'Libelle Code Levee': LIBELLES[code],
          'Code BOM': ['HA364NH', 'GT512KL', 'FX908PB', 'DR227MS'][secteur % 4],
          'Code Chaise': 0,
          'Numero puce': lue ? commeExcel(puce) : '',
          'Latitude*': String(+la.toFixed(6)),
          'Longitude*': String(+lo.toFixed(6)),
          'Repere levee': lue ? commeExcel(puce) : 225000000 + Math.floor(r() * 99999)
        });
      }
      return nb;
    };

    for (let i = 0; i < n; i++) {
      const secteur = 1 + Math.floor(r() * 14);
      const [lat, lon] = offset(centre[0], centre[1], 300 + r() * 3500, r);
      const v = pick(VOIES);
      const u = r();
      const activite = u < ACTIVITES[0][1] ? ACTIVITES[0][0] : u < ACTIVITES[0][1] + ACTIVITES[1][1] ? ACTIVITES[1][0] : ACTIVITES[2][0];
      const puce = '0116' + (0x772000 + i * 7).toString(16).toUpperCase().padStart(6, '0');
      // Livraison : majorité avant la période, 10 % en cours d'année, 3 % en décembre.
      const w = r();
      const livraison = w < 0.03 ? fin - 3 - Math.floor(r() * 20) : w < 0.13 ? debut + 30 + Math.floor(r() * 280) : debut - 30 - Math.floor(r() * 300);
      const lt = new Date(livraison * JOUR);
      // Probabilité de présentation hebdomadaire (plus forte en collectif).
      const pr = r();
      let p = activite === 'Habitation individuelle' ? (pr < 0.15 ? 0.05 + r() * 0.15 : 0.3 + r() * 0.65) : 0.75 + r() * 0.25;
      const profil = r();
      let au = fin, decalage = 0;
      if (profil < 0.04) p = 0;                                   // jamais levé
      else if (profil < 0.08) au = debut + 120 + Math.floor(r() * 150); // plus levé (bac retiré ?)
      else if (profil < 0.10) decalage = 150 + r() * 250;         // adresse fausse
      const nb = ajouterLevees(puce, secteur, lat, lon, p, livraison, au, decalage);
      // 3 % des bacs biodéchets vidés quelques fois par la tournée OMR (erreur de tournée ou de puce).
      if (r() < 0.03) ajouterLevees(puce, secteur, lat, lon, 0.06, debut, fin, 0, 'OMR');

      clients.push({
        'Nom commune': pick(COMMUNES_LSO),
        'Numéro': 1 + Math.floor(r() * 150),
        'Bis/ter': r() < 0.05 ? pick(['BIS', 'B', 'TER']) : '',
        'Type de voie': v[0] + ' ' + v[1],
        'Nom de la voie': v[2] + ' LSO ' + secteur,
        'Nom': activite === 'Bâtiment public' ? 'MAIRIE ANNEXE ' + (1 + i % 9) : pick(NOMS),
        'Prénom': activite === 'Habitation individuelle' ? pick(PRENOMS) : '',
        'Activité': activite,
        'Type de récipient': 'Bio dechet marron ' + (activite === 'Habitation individuelle' ? 120 : pick([120, 240, 400])) + ' L',
        'Code cuve': 120000000 + Math.floor(r() * 900000),
        'Code puce': puce,
        'Date livraison': p2(lt.getUTCDate()) + '/' + p2(lt.getUTCMonth() + 1) + '/' + lt.getUTCFullYear(),
        'Nombre d’apparitions sur une année glissante': r() < 0.05 ? Math.floor(r() * 40) : nb,
        'Latitude': +lat.toFixed(6),
        'Longitude': +lon.toFixed(6)
      });
    }

    // Puces levées mais absentes de la base client.
    for (let j = 0; j < 50; j++) {
      const [lat, lon] = offset(centre[0], centre[1], 300 + r() * 3500, r);
      ajouterLevees('0116' + (0x990000 + j * 13).toString(16).toUpperCase(), 1 + (j % 14), lat, lon, 0.6, debut, fin, 0, 'FFOM', j % 2 === 0);
    }
    // Autres flux collectés sur le territoire (bacs hors base biodéchets).
    for (let j = 0; j < 250; j++) {
      const [lat, lon] = offset(centre[0], centre[1], 300 + r() * 3500, r);
      ajouterLevees('0117' + (0x500000 + j * 11).toString(16).toUpperCase(), 1 + (j % 14), lat, lon, 0.8, debut, fin, 0, j < 180 ? 'OMR' : 'CS');
    }
    levees.sort((a, b) => a.Jour - b.Jour);
    return { clients, levees };
  }

  return { generate, generateLevees };
});
