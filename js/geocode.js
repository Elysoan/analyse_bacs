/*
 * Géocodage des adresses via le service public de l'IGN (Géoplateforme, ex-API Adresse / BAN).
 * Seules l'adresse et la commune sont envoyées. Les résultats sont mémorisés dans le navigateur
 * pour ne pas regéocoder à chaque analyse.
 */
(function (root) {
  'use strict';

  const URL_CSV = 'https://data.geopf.fr/geocodage/search/csv';
  const URL_UNIT = 'https://data.geopf.fr/geocodage/search';
  const CACHE_KEY = 'analyse_bacs_geocache_v1';
  const LOT = 5000;          // lignes par envoi groupé (limite du service : 200 000 / 50 Mo)
  const INTERVALLE_MS = 30;  // repli unitaire : ~33 requêtes/s (limite : 50/s)

  function loadCache() {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); } catch (e) { return {}; }
  }
  function saveCache(c) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)); } catch (e) { /* quota ou stockage bloqué */ }
  }

  // --- Préparation des adresses ------------------------------------------
  const RE = {
    numero: /^(num(e|é)ro|n°|no|num|n° ?voie|numero_?voie)$/i,
    indice: /bis|ter|indice|suffixe|compl[ée]ment.*num/i,
    typeVoie: /type.*voie/i,
    voie: /(nom|libell[ée]).*voie|^voie$|^rue$|^adresse/i,
    commune: /commune|ville|localit/i,
    cp: /code.?postal|^cp$/i
  };

  function guessColumns(cols) {
    const f = re => cols.find(c => re.test(c.trim())) || '';
    return { numero: f(RE.numero), indice: f(RE.indice), typeVoie: f(RE.typeVoie), voie: f(RE.voie), commune: f(RE.commune), cp: f(RE.cp) };
  }

  /**
   * Repère un code parasite fréquent en fin de nom de voie (ex. « LSO 8 », code secteur de collecte).
   * Renvoie le préfixe (« LSO ») s'il apparaît dans au moins 20 % des lignes.
   */
  const MOTS_VOIE = new Set(['RUE', 'AV', 'AVE', 'BD', 'BLD', 'CHE', 'IMP', 'ALL', 'PL', 'RTE', 'DU', 'DE', 'DES', 'LA', 'LE', 'LES', 'ST', 'STE', 'RES', 'BAT']);
  function detectNoise(rows, col) {
    if (!col) return '';
    const count = new Map();
    let n = 0;
    for (const r of rows) {
      const v = String(r[col] || '').toUpperCase();
      if (!v) continue;
      n++;
      const m = /\s([A-Z]{2,5})\s*\d+[A-Z]*\b.*$/.exec(v);
      if (m && !MOTS_VOIE.has(m[1])) count.set(m[1], (count.get(m[1]) || 0) + 1);
    }
    let best = '', max = 0;
    for (const [k, c] of count) if (c > max) { best = k; max = c; }
    return n && max / n >= 0.2 ? best : '';
  }

  function noiseRegex(token) {
    return token ? new RegExp('\\s+' + token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b.*$', 'i') : null;
  }

  /** Construit { adresse, commune, secteur } pour une ligne. */
  function buildAddress(row, c, noise) {
    const re = noiseRegex(noise);
    let voie = String(row[c.voie] || '').trim();
    let secteur = '';
    if (re) {
      const m = re.exec(voie);
      if (m) { secteur = m[0].trim(); voie = voie.slice(0, m.index).trim(); }
    }
    const parts = [row[c.numero], row[c.indice], row[c.typeVoie], voie].map(v => String(v === undefined || v === null ? '' : v).trim()).filter(Boolean);
    const commune = [row[c.cp], row[c.commune]].map(v => String(v || '').trim()).filter(Boolean).join(' ');
    return { adresse: parts.join(' ').replace(/\s+/g, ' '), commune, secteur };
  }

  const cacheKey = a => (a.adresse + '|' + a.commune).toUpperCase();

  // --- Appels au service -------------------------------------------------
  async function geocodeBatch(list) {
    const csv = Papa.unparse({ fields: ['id', 'adresse', 'commune'], data: list.map((a, i) => [i, a.adresse, a.commune]) });
    const fd = new FormData();
    fd.append('data', new Blob([csv], { type: 'text/csv' }), 'adresses.csv');
    fd.append('columns', 'adresse');
    fd.append('columns', 'commune');
    const resp = await fetch(URL_CSV, { method: 'POST', body: fd });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const out = Papa.parse(await resp.text(), { header: true, skipEmptyLines: true }).data;
    const res = new Array(list.length).fill(null);
    for (const r of out) {
      const i = Number(r.id);
      const lat = parseFloat(r.latitude || r.result_latitude), lon = parseFloat(r.longitude || r.result_longitude);
      if (Number.isInteger(i) && Number.isFinite(lat) && Number.isFinite(lon)) {
        res[i] = { lat, lon, score: parseFloat(r.result_score) || 0, label: r.result_label || '', type: r.result_type || '' };
      }
    }
    return res;
  }

  async function geocodeOne(a) {
    const q = encodeURIComponent((a.adresse + ' ' + a.commune).trim());
    const resp = await fetch(`${URL_UNIT}?q=${q}&limit=1&index=address`);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const f = (await resp.json()).features;
    if (!f || !f.length) return null;
    const p = f[0].properties || {};
    return { lat: f[0].geometry.coordinates[1], lon: f[0].geometry.coordinates[0], score: p.score || 0, label: p.label || '', type: p.type || '' };
  }

  /**
   * Géocode une liste d'adresses (doublons et cache gérés).
   * @param {Array<{adresse, commune}>} addresses
   * @param {Function} onProgress (faits, total, message)
   * @returns {Promise<Array<{lat, lon, score, label, type}|null>>} dans le même ordre
   */
  async function geocodeAll(addresses, onProgress) {
    const cache = loadCache();
    const uniques = new Map();
    for (const a of addresses) if (a.adresse || a.commune) uniques.set(cacheKey(a), a);
    const todo = Array.from(uniques.entries()).filter(([k]) => !(k in cache));
    let done = uniques.size - todo.length;
    const total = uniques.size;
    onProgress(done, total, done ? `${done} adresses déjà connues (mémorisées)` : '');

    let batchOk = true;
    for (let i = 0; i < todo.length && batchOk; i += LOT) {
      const lot = todo.slice(i, i + LOT);
      try {
        const res = await geocodeBatch(lot.map(([, a]) => a));
        lot.forEach(([k], j) => { cache[k] = res[j]; });
        done += lot.length;
        saveCache(cache);
        onProgress(done, total, 'Envoi groupé');
      } catch (e) {
        batchOk = false;
        onProgress(done, total, 'Envoi groupé indisponible (' + e.message + '), passage adresse par adresse…');
      }
    }

    if (!batchOk) {
      const reste = todo.filter(([k]) => !(k in cache));
      let next = 0, erreurs = 0;
      const worker = async () => {
        while (next < reste.length) {
          const [k, a] = reste[next++];
          const t0 = Date.now();
          try { cache[k] = await geocodeOne(a); } catch (e) { erreurs++; if (erreurs > 50 && erreurs > done / 2) throw new Error('Service de géocodage injoignable (' + e.message + ')'); }
          done++;
          if (done % 50 === 0) { saveCache(cache); onProgress(done, total, 'Adresse par adresse'); }
          const wait = INTERVALLE_MS * 6 - (Date.now() - t0);
          if (wait > 0) await new Promise(r => setTimeout(r, wait));
        }
      };
      await Promise.all(Array.from({ length: 6 }, worker));
      saveCache(cache);
      onProgress(done, total, erreurs ? erreurs + ' adresses en erreur' : '');
    }
    return addresses.map(a => cache[cacheKey(a)] || null);
  }

  root.Geocode = { guessColumns, detectNoise, buildAddress, geocodeAll };
})(window);
