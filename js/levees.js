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
  const PRIORITE = ['recent', 'seulA', 'seulB', 'arret', 'faible', 'deplace', 'identique'];

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
   *                   project?(x, y) -> [lon, lat] | null, ignoreLeadingZeros?
   * @returns {{ add(row), result() }}
   */
  function createAggregator(o) {
    const bacs = new Map();
    const parMois = new Map();
    const st = { lignes: 0, sansCle: 0, dateInvalide: 0, minDay: Infinity, maxDay: -Infinity, levees: 0 };
    const keyOpts = { ignoreLeadingZeros: o.ignoreLeadingZeros };

    function add(row) {
      st.lignes++;
      const day = parseDate(row[o.dateCol]);
      if (day === null) { st.dateInvalide++; return; }
      const key = Compare.normalizeKey(row[o.keyCol], keyOpts);
      if (!key) { st.sansCle++; return; }
      st.levees++;
      if (day < st.minDay) st.minDay = day;
      if (day > st.maxDay) st.maxDay = day;
      const mois = moisDe(day);
      parMois.set(mois, (parMois.get(mois) || 0) + 1);

      let b = bacs.get(key);
      if (!b) {
        b = { brut: String(row[o.keyCol]).trim(), n: 0, jours: new Set(), semaines: new Set(), first: day, last: day, poids: 0, nPoids: 0, lats: [], lons: [] };
        bacs.set(key, b);
      }
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
      let idx = 0;
      for (const b of bacs.values()) {
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
      return {
        records,
        stats: {
          lignes: st.lignes, levees: st.levees, sansCle: st.sansCle, dateInvalide: st.dateInvalide,
          debut: vide ? null : st.minDay, fin: vide ? null : st.maxDay,
          semainesPeriode: vide ? 0 : (lundi(st.maxDay) - lundi(st.minDay)) / 7 + 1,
          parMois: Array.from(parMois.entries()).sort((a, b) => a[0] < b[0] ? -1 : 1)
        }
      };
    }

    return { add, result };
  }

  /**
   * Rapproche la base client (A) des levées agrégées puis ajoute les indicateurs.
   * Chaque ligne reçoit r.lv = { taux, semainesPossibles, livraison, declare, ecart }.
   * @param {Array} bacs enregistrements de la base client
   * @param {Object} agg résultat de createAggregator().result()
   * @param {Object} o keyA, moveThreshold (m), seuilTaux (%), seuilArret (semaines),
   *                   dateA? (colonne date de livraison), countA? (colonne nb de levées déclaré),
   *                   ignoreLeadingZeros?
   */
  function analyser(bacs, agg, o) {
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

      const tags = r.tags.filter(t => t !== 'identique');
      if (r.a && levees) {
        if (fin - levees.last >= o.seuilArret * 7) tags.push('arret');
        if (lv.taux !== null && lv.taux < o.seuilTaux) tags.push('faible');
        if (!tags.some(t => t === 'arret' || t === 'faible' || t === 'deplace')) tags.push('identique');
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
      byTag, leveesNonRef, tranches, bacsClient,
      tauxMedian: median(tauxLeves),
      levees: agg.stats
    });
    return res;
  }

  return { parseDate, formatDay, createAggregator, analyser, PRIORITE, median };
});
