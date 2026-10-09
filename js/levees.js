/*
 * Analyse d'un historique de levées : agrégation par bac puis indicateurs
 * (taux de présentation, arrêt de collecte...) après rapprochement avec la base client.
 * Aucune dépendance : utilisable dans le navigateur (window.Levees) et dans Node (tests).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./compare.js'));
  else root.Levees = factory(root.Compare);
})(typeof self !== 'undefined' ? self : this, function (Compare) {
  'use strict';

  const JOUR_MS = 86400000;
  const PRIORITE = ['recent', 'seulA', 'seulB', 'arret', 'faible', 'autre_flux', 'deplace', 'identique'];

  // --- Dates : renvoie un numéro de jour (jours depuis 1970-01-01), ou null ---
  function parseDate(v) {
    if (v === null || v === undefined || v === '') return null;
    if (v instanceof Date) return isNaN(v) ? null : Math.floor(Date.UTC(v.getFullYear(), v.getMonth(), v.getDate()) / JOUR_MS);
    const s = String(v).trim();
    // Numéro de série Excel (ex. 45678 ou 45678,5)
    if (/^\d{5}([.,]\d+)?$/.test(s)) {
      const n = Math.floor(Number(s.replace(',', '.')));
      return n > 20000 && n < 80000 ? n - 25569 : null;
    }
    let y, m, d, r;
    if ((r = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s))) { y = +r[1]; m = +r[2]; d = +r[3]; }
    else if ((r = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/.exec(s))) {
      d = +r[1]; m = +r[2]; y = +r[3];
      if (m > 12 && d <= 12) { const t = d; d = m; m = t; } // format US m/d
      if (y < 100) y += 2000;
    }
    else if ((r = /^(\d{4})(\d{2})(\d{2})/.exec(s))) { y = +r[1]; m = +r[2]; d = +r[3]; }
    else return null;
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    return Math.floor(Date.UTC(y, m - 1, d) / JOUR_MS);
  }

  // Lundi de la semaine du jour donné (le 01/01/1970 était un jeudi).
  const lundi = day => day - ((day + 3) % 7);

  function formatDay(day) {
    if (day === null || day === undefined || !Number.isFinite(day)) return '';
    const dt = new Date(day * JOUR_MS);
    const p = n => String(n).padStart(2, '0');
    return p(dt.getUTCDate()) + '/' + p(dt.getUTCMonth() + 1) + '/' + dt.getUTCFullYear();
  }

  function moisDe(day) {
    const dt = new Date(day * JOUR_MS);
    return dt.getUTCFullYear() + '-' + String(dt.getUTCMonth() + 1).padStart(2, '0');
  }

  function toNumber(v) {
    if (v === null || v === undefined || v === '') return NaN;
    if (typeof v === 'number') return v;
    return Number(String(v).trim().replace(/[\s ]/g, '').replace(',', '.'));
  }

  function median(arr) {
    if (!arr.length) return null;
    const s = arr.slice().sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  }

  /**
   * Agrège les levées ligne à ligne (adapté aux fichiers d'un million de lignes).
   * @param {Object} o keyCol, dateCol, weightCol?, xCol?, yCol?,
   *                   project?(x, y) -> [lon, lat] | null, ignoreLeadingZeros?,
   *                   fluxCol?, fluxKeep? (Set des flux analysés, ex. FFOM),
   *                   statutCol?, statutKeep? (Set des statuts retenus, ex. « collecté »)
   * Les indicateurs (taux, dates, position...) ne portent que sur les levées retenues ;
   * le nombre de levées par flux et par statut est conservé pour toutes les puces.
   * @returns {{ add(row), result() }}
   */
  function createAggregator(o) {
    const bacs = new Map();
    const parMois = new Map();
    const dims = [];
    if (o.fluxCol) dims.push({ id: 'flux', col: o.fluxCol, keep: o.fluxKeep, exclues: 0, total: new Map() });
    if (o.statutCol) dims.push({ id: 'statut', col: o.statutCol, keep: o.statutKeep, exclues: 0, total: new Map() });
    const st = { lignes: 0, sansCle: 0, dateInvalide: 0, minDay: Infinity, maxDay: -Infinity, levees: 0 };
    const keyOpts = { ignoreLeadingZeros: o.ignoreLeadingZeros };
    const valeur = v => v === undefined || v === null || String(v).trim() === '' ? '(vide)' : String(v).trim();

    function add(row) {
      st.lignes++;
      const day = parseDate(row[o.dateCol]);
      if (day === null) { st.dateInvalide++; return; }
      const key = Compare.normalizeKey(row[o.keyCol], keyOpts);
      // Répartition par flux / statut : toutes les levées, y compris sans puce lue.
      const vals = dims.map(d => {
        const v = valeur(row[d.col]);
        let g = d.total.get(v);
        if (!g) d.total.set(v, (g = { levees: 0, puces: new Set() }));
        g.levees++;
        if (key) g.puces.add(key);
        return v;
      });
      if (!key) { st.sansCle++; return; }

      let b = bacs.get(key);
      if (!b) {
        b = { brut: Compare.keyText(row[o.keyCol]).trim(), n: 0, dims: {}, jours: new Set(), semaines: new Set(), first: Infinity, last: -Infinity, poids: 0, nPoids: 0, lats: [], lons: [] };
        bacs.set(key, b);
      }
      let retenue = true;
      dims.forEach((d, i) => {
        const c = b.dims[d.id] || (b.dims[d.id] = {});
        c[vals[i]] = (c[vals[i]] || 0) + 1;
        if (retenue && d.keep && !d.keep.has(vals[i])) { d.exclues++; retenue = false; }
      });
      if (!retenue) return;

      st.levees++;
      if (day < st.minDay) st.minDay = day;
      if (day > st.maxDay) st.maxDay = day;
      const mois = moisDe(day);
      parMois.set(mois, (parMois.get(mois) || 0) + 1);

      b.n++;
      b.jours.add(day);
      b.semaines.add(lundi(day));
      if (day < b.first) b.first = day;
      if (day > b.last) b.last = day;
      if (o.weightCol) {
        const w = toNumber(row[o.weightCol]);
        if (Number.isFinite(w)) { b.poids += w; b.nPoids++; }
      }
      if (o.xCol && o.yCol && o.project && b.lats.length < 500) {
        const x = toNumber(row[o.xCol]), y = toNumber(row[o.yCol]);
        if (Number.isFinite(x) && Number.isFinite(y) && !(x === 0 && y === 0)) {
          const p = o.project(x, y);
          if (p) { b.lons.push(p[0]); b.lats.push(p[1]); }
        }
      }
    }

    function result() {
      const vide = st.levees === 0;
      const records = [];
      const dimsParCle = new Map();
      let idx = 0;
      for (const [key, b] of bacs) {
        if (dims.length) dimsParCle.set(key, b.dims);
        if (!b.n) continue; // aucune levée retenue (autre flux, non collectée...) : pas une puce analysée
        records.push({
          idx: idx++,
          props: { identifiant: b.brut },
          agg: {
            n: b.n, jours: b.jours.size, semaines: b.semaines.size, first: b.first, last: b.last,
            poidsTotal: b.nPoids ? b.poids : null, poidsMoyen: b.nPoids ? b.poids / b.nPoids : null
          },
          lat: median(b.lats), lon: median(b.lons)
        });
      }
      const resume = d => Array.from(d.total.entries())
        .map(([v, g]) => ({ flux: v, valeur: v, levees: g.levees, puces: g.puces.size, retenu: !d.keep || d.keep.has(v) }))
        .sort((a, b) => b.levees - a.levees);
      const parDim = {};
      dims.forEach(d => { parDim[d.id] = resume(d); });
      const exclues = id => { const d = dims.find(x => x.id === id); return d ? d.exclues : 0; };
      return {
        records,
        dimsParCle,
        stats: {
          lignes: st.lignes, levees: st.levees, sansCle: st.sansCle, dateInvalide: st.dateInvalide,
          autresFlux: exclues('flux'), statutsExclus: exclues('statut'),
          debut: vide ? null : st.minDay, fin: vide ? null : st.maxDay,
          semainesPeriode: vide ? 0 : (lundi(st.maxDay) - lundi(st.minDay)) / 7 + 1,
          parMois: Array.from(parMois.entries()).sort((a, b) => a[0] < b[0] ? -1 : 1),
          flux: parDim.flux || [],
          statuts: parDim.statut || []
        }
      };
    }

    return { add, result };
  }

  /**
   * Excel convertit en nombre les puces hexadécimales de la forme « chiffres E chiffres » :
   * « 01167726E4 » devient 11677260000, indiscernable d'une puce purement numérique.
   * Pour chaque puce levée purement numérique, on teste sa forme « 1167726E4 » dans la base client
   * (uniquement parmi les puces client de type « chiffres E chiffres », sans écraser une correspondance directe). Renvoie le nombre de puces reconstituées.
   */
  function reconcilierExcel(bacs, agg, o) {
    if (!o.ignoreLeadingZeros) return 0;
    const keyOpts = { ignoreLeadingZeros: true };
    const clefsA = new Map(), toutesA = new Set();
    for (const a of bacs) {
      const k = Compare.normalizeKey(a.props[o.keyA], keyOpts);
      if (k) toutesA.add(k);
      if (k && /E/.test(k)) clefsA.set(k, a.props[o.keyA]);
    }
    if (!clefsA.size) return 0;
    let n = 0;
    for (const rec of agg.records) {
      const k = Compare.normalizeKey(rec.props.identifiant, keyOpts);
      if (!/^\d+$/.test(k) || toutesA.has(k)) continue;
      const cand = Compare.normalizeKey(k + 'E0', keyOpts); // forme canonique : 11677260000E0 -> 1167726E4
      if (!clefsA.has(cand)) continue;
      rec.props.identifiant = String(clefsA.get(cand));
      rec.reconstituee = true;
      if (agg.dimsParCle && agg.dimsParCle.has(k)) agg.dimsParCle.set(cand, agg.dimsParCle.get(k));
      n++;
    }
    return n;
  }

  /**
   * Rapproche la base client (A) des levées agrégées puis ajoute les indicateurs.
   * Chaque ligne reçoit r.lv = { taux, semainesPossibles, livraison, declare, ecart }.
   * @param {Array} bacs enregistrements de la base client
   * @param {Object} agg résultat de createAggregator().result()
   * @param {Object} o keyA, moveThreshold (m), seuilTaux (%), seuilArret (semaines),
   *                   dateA? (colonne date de livraison), countA? (colonne nb de levées déclaré),
   *                   fluxKeep? (Set des flux analysés), ignoreLeadingZeros?
   * Chaque ligne reçoit aussi r.flux / r.statuts = { valeur: nb de levées } (toutes levées confondues).
   */
  function analyser(bacs, agg, o) {
    const pucesCorrigees = reconcilierExcel(bacs, agg, o);
    const res = Compare.compare(bacs, agg.records, {
      mode: 'key', keyA: o.keyA, keyB: 'identifiant', fieldPairs: [],
      moveThreshold: o.moveThreshold, ignoreLeadingZeros: o.ignoreLeadingZeros
    });
    const { debut, fin, semainesPeriode } = agg.stats;

    for (const r of res.rows) {
      const lv = { taux: null, semainesPossibles: semainesPeriode, livraison: null, declare: null, ecart: null };
      const levees = r.b ? r.b.agg : null;
      if (r.a && fin !== null) {
        let start = debut;
        if (o.dateA) {
          lv.livraison = parseDate(r.a.props[o.dateA]);
          if (lv.livraison !== null && lv.livraison > debut) start = lv.livraison;
        }
        lv.semainesPossibles = start > fin ? 0 : (lundi(fin) - lundi(start)) / 7 + 1;
        if (o.countA) {
          const d = toNumber(r.a.props[o.countA]);
          if (Number.isFinite(d)) { lv.declare = d; lv.ecart = (levees ? levees.n : 0) - d; }
        }
      }
      if (levees) lv.taux = lv.semainesPossibles ? Math.min(100, 100 * levees.semaines / lv.semainesPossibles) : null;
      else if (r.a) lv.taux = 0;
      r.lv = lv;

      const keyOpts = { ignoreLeadingZeros: o.ignoreLeadingZeros };
      const cle = r.a ? Compare.normalizeKey(r.a.props[o.keyA], keyOpts) : Compare.normalizeKey(r.b.props.identifiant, keyOpts);
      r.dims = agg.dimsParCle ? agg.dimsParCle.get(cle) || null : null;
      r.flux = r.dims && r.dims.flux ? r.dims.flux : null;
      r.statuts = r.dims && r.dims.statut ? r.dims.statut : null;
      // Bac du client levé (aussi) sur un flux non analysé, ex. bac biodéchets vidé par la tournée OMR.
      const autreFlux = r.a && r.flux && o.fluxKeep && Object.keys(r.flux).some(f => !o.fluxKeep.has(f));

      const tags = r.tags.filter(t => t !== 'identique');
      if (autreFlux) tags.push('autre_flux');
      if (r.a && levees) {
        if (fin - levees.last >= o.seuilArret * 7) tags.push('arret');
        if (lv.taux !== null && lv.taux < o.seuilTaux) tags.push('faible');
        if (!tags.some(t => t === 'arret' || t === 'faible' || t === 'deplace' || t === 'autre_flux')) tags.push('identique');
      } else if (r.a && lv.semainesPossibles < o.seuilArret) {
        // Livré trop récemment pour juger : ne compte pas comme « jamais levé ».
        tags.splice(tags.indexOf('seulA'), 1, 'recent');
      }
      r.tags = tags;
      r.category = PRIORITE.find(c => tags.includes(c)) || 'identique';
    }

    const byTag = {};
    const tranches = [0, 0, 0, 0, 0]; // 0 %, ]0-25[, [25-50[, [50-75[, [75-100]
    let leveesNonRef = 0, bacsClient = 0;
    for (const r of res.rows) {
      for (const t of r.tags) byTag[t] = (byTag[t] || 0) + 1;
      if (r.b && !r.a) leveesNonRef += r.b.agg.n;
      if (r.a) bacsClient++;
      if (r.a && r.category !== 'recent' && r.lv.taux !== null) {
        const t = r.lv.taux;
        tranches[t === 0 ? 0 : t < 25 ? 1 : t < 50 ? 2 : t < 75 ? 3 : 4]++;
      }
    }
    const tauxLeves = res.rows.filter(r => r.a && r.b && r.lv.taux !== null).map(r => r.lv.taux);
    res.stats = Object.assign({}, res.stats, {
      byTag, leveesNonRef, tranches, bacsClient, pucesCorrigees,
      tauxMedian: median(tauxLeves),
      levees: agg.stats
    });
    return res;
  }

  return { parseDate, formatDay, createAggregator, analyser, PRIORITE, median };
});
