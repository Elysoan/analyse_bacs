/*
 * Habitants desservis par une tournée décrite en tronçons (export XML « ci / tr » : un tronçon par ligne,
 * type de collecte, tracé dans le sens de la tournée).
 *
 * Méthode :
 *  1. zone de collecte = bande de largeur L autour de chaque tronçon collecté, du bon côté (droite, gauche ou
 *     les deux selon le type, le côté étant relatif au sens de circulation) ; « haut le pied » = aucune collecte ;
 *     des polygones de secteur (bacs de regroupement, hameaux) peuvent s'y ajouter ;
 *  2. les adresses (BAN...) situées dans la zone sont retenues, chacune une seule fois ;
 *  3. chaque adresse porte une part des habitants : population du carreau INSEE ÷ nombre d'adresses du carreau
 *     (ou un nombre fixe d'habitants par adresse, faute de carreaux).
 * Utilisable dans le navigateur (window.Tournees) et dans Node (tests).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./habitants.js'));
  else root.Tournees = factory(root.Habitants);
})(typeof self !== 'undefined' ? self : this, function (Habitants) {
  'use strict';

  // --- Lecture ------------------------------------------------------------------------------------
  const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
  const decode = s => s.replace(/&(amp|lt|gt|quot|apos);|&#(\d+);/g, (m, n, d) => d ? String.fromCharCode(+d) : ENT[m]);

  function attrsOf(s) {
    const a = {};
    s.replace(/([\w:-]+)="([^"]*)"/g, (m, k, v) => { a[k] = decode(v); return m; });
    return a;
  }

  // « Collecte à droite » / « à gauche » / « bilatérale » ; le reste (haut le pied...) ne collecte pas.
  function sideOf(type) {
    const t = String(type || '').toLowerCase();
    if (/bilat|deux c[ôo]t|double/.test(t)) return 'B';
    if (/droite/.test(t)) return 'D';
    if (/gauche/.test(t)) return 'G';
    return '';
  }

  /** Une tournée depuis le texte XML. Les coordonnées du tracé sont en WGS84 (lon, lat). */
  function parseXML(text, fileName) {
    const ci = /<ci\s([^>]*)>/.exec(text);
    if (!ci) throw new Error('format non reconnu (balise <ci> absente)');
    const head = attrsOf(ci[1]);
    const troncons = [];
    const unknown = new Set();
    text.replace(/<tr\s([^>]*?)\/?>/g, (m, body) => {
      const a = attrsOf(body);
      const pts = [];
      (a.gy || '').replace(/\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)/g, (mm, x, y) => { pts.push([+x, +y]); return mm; });
      if (!pts.length && a.lo && a.la) pts.push([+a.lo, +a.la]);
      const side = sideOf(a.tr);
      if (!side && !/haut.*pied|hlp|transfert|d[ée]placement|vide/i.test(a.tr || '')) unknown.add(a.tr || '(vide)');
      troncons.push({ id: a.id, nom: a.nr || '', commune: a.ce || '', type: a.tr || '', side, dist: +a.dt || 0, pts });
      return m;
    });
    if (!troncons.length) throw new Error('aucun tronçon <tr> dans le fichier');
    return {
      file: fileName || '', code: head.nc || fileName || '', name: head.nl || head.nc || '', entreprise: head.ct || '',
      date: head.dtu || '', distance: +head.dtt || 0, troncons, unknownTypes: Array.from(unknown)
    };
  }

  // --- Lecture d'un zip (plusieurs tournées) ------------------------------------------------------------
  async function inflateRaw(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /** Fichiers d'une archive zip : [{ name, bytes }] (méthodes « stocké » et « deflate »). */
  async function unzip(buffer) {
    const dv = new DataView(buffer), bytes = new Uint8Array(buffer);
    let e = bytes.length - 22;
    while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
    if (e < 0) throw new Error('archive zip invalide');
    const n = dv.getUint16(e + 10, true);
    let p = dv.getUint32(e + 16, true);
    const out = [];
    for (let i = 0; i < n; i++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('archive zip corrompue');
      const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
      const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
      const off = dv.getUint32(p + 42, true);
      const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nl));
      p += 46 + nl + xl + cl;
      if (name.endsWith('/')) continue;
      const start = off + 30 + dv.getUint16(off + 26, true) + dv.getUint16(off + 28, true);
      const raw = bytes.subarray(start, start + csize);
      if (method !== 0 && method !== 8) throw new Error('compression zip non prise en charge dans ' + name);
      out.push({ name, bytes: method === 0 ? raw : await inflateRaw(raw) });
    }
    return out;
  }

  function decodeText(bytes) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, ''); }
    catch (e) { return new TextDecoder('windows-1252').decode(bytes); }
  }

  // --- Géométrie des tronçons -----------------------------------------------------------------------------
  const toWork = Habitants.transform('EPSG:4326', Habitants.WORK);

  /** Ajoute `work` (tracé projeté, mètres) et `bbox` à chaque tronçon. */
  function project(tournee) {
    for (const t of tournee.troncons) {
      t.work = t.pts.map(toWork);
      t.bbox = Habitants.bboxOf(t.work);
    }
    return tournee;
  }

  function windowOf(tournees, margin) {
    const w = [Infinity, Infinity, -Infinity, -Infinity];
    for (const tn of tournees) for (const t of tn.troncons) {
      if (!t.work.length) continue;
      w[0] = Math.min(w[0], t.bbox[0] - margin); w[1] = Math.min(w[1], t.bbox[1] - margin);
      w[2] = Math.max(w[2], t.bbox[2] + margin); w[3] = Math.max(w[3], t.bbox[3] + margin);
    }
    return w;
  }

  /** Distance d'un point à la polyligne, et côté (> 0 : à gauche du sens de la tournée, < 0 : à droite). */
  function locate(px, py, line) {
    let best = Infinity, side = 0;
    for (let i = 0; i + 1 < line.length; i++) {
      const ax = line[i][0], ay = line[i][1], dx = line[i + 1][0] - ax, dy = line[i + 1][1] - ay;
      const len2 = dx * dx + dy * dy;
      const vx = px - ax, vy = py - ay;
      const t = len2 ? Math.max(0, Math.min(1, (vx * dx + vy * dy) / len2)) : 0;
      const d2 = (vx - t * dx) * (vx - t * dx) + (vy - t * dy) * (vy - t * dy);
      if (d2 < best) { best = d2; side = dx * vy - dy * vx; }
    }
    return { dist: Math.sqrt(best), side };
  }

  // --- Adresses -----------------------------------------------------------------------------------------------
  const CELL = 100;

  /** Index spatial en grille de 100 m. `pts` : tableau de { x, y } en EPSG:3035. */
  function indexPoints(pts) {
    const m = new Map();
    pts.forEach((p, i) => {
      const k = Math.floor(p.x / CELL) + ',' + Math.floor(p.y / CELL);
      const l = m.get(k);
      if (l) l.push(i); else m.set(k, [i]);
    });
    return m;
  }

  function candidates(index, bbox) {
    const out = [];
    for (let ix = Math.floor(bbox[0] / CELL); ix <= Math.floor(bbox[2] / CELL); ix++)
      for (let iy = Math.floor(bbox[1] / CELL); iy <= Math.floor(bbox[3] / CELL); iy++) {
        const l = index.get(ix + ',' + iy);
        if (l) for (const i of l) out.push(i);
      }
    return out;
  }

  /**
   * Adresses desservies par une tournée : { taken: Map(adresse -> 'troncon' | 'secteur'), perTroncon }.
   * `sectors` : polygones facultatifs [[anneau, ...trous]] (EPSG:3035) — l'union avec la bande de collecte ;
   * `exclusions` : polygones dont les adresses sont retirées.
   */
  function serve(tournee, pts, index, width, sectors, exclusions) {
    const taken = new Map();
    const perTroncon = [];
    for (const t of tournee.troncons) {
      let n = 0;
      if (t.side && t.work.length > 1) {
        const box = [t.bbox[0] - width, t.bbox[1] - width, t.bbox[2] + width, t.bbox[3] + width];
        for (const i of candidates(index, box)) {
          if (taken.has(i)) continue;
          const loc = locate(pts[i].x, pts[i].y, t.work);
          if (loc.dist > width) continue;
          if (t.side === 'D' && loc.side > 0) continue;
          if (t.side === 'G' && loc.side < 0) continue;
          taken.set(i, 'troncon');
          n++;
        }
      }
      perTroncon.push(n);
    }
    for (const poly of sectors || []) {
      const box = Habitants.bboxOf(poly[0]);
      for (const i of candidates(index, box)) {
        if (taken.has(i)) continue;
        const p = [pts[i].x, pts[i].y];
        if (Habitants.pointInRing(p, poly[0]) && !poly.slice(1).some(h => Habitants.pointInRing(p, h))) taken.set(i, 'secteur');
      }
    }
    // Zones d'exclusion : leurs adresses sont retirées, quelle que soit leur origine.
    for (const poly of exclusions || []) {
      const box = Habitants.bboxOf(poly[0]);
      for (const i of candidates(index, box)) {
        if (!taken.has(i)) continue;
        const p = [pts[i].x, pts[i].y];
        if (Habitants.pointInRing(p, poly[0]) && !poly.slice(1).some(h => Habitants.pointInRing(p, h))) taken.delete(i);
      }
    }
    return { taken, perTroncon };
  }

  /**
   * Habitants portés par chaque adresse. Avec des carreaux : population du carreau ÷ nombre d'adresses du
   * carreau (la population de chaque carreau est conservée). Sinon : `perAddress` habitants par adresse.
   * Renvoie { pop, men, orphanPop } (orphanPop : population de carreaux sans aucune adresse).
   */
  function weigh(pts, units, perAddress) {
    const pop = new Float64Array(pts.length), men = new Float64Array(pts.length);
    if (!units || !units.length) {
      pop.fill(perAddress);
      return { pop, men, orphanPop: 0, mode: 'fixe' };
    }
    const cells = new Map();
    for (const u of units) cells.set(u.bbox[0] + ',' + u.bbox[1], { u, n: 0 });
    const keys = pts.map(p => {
      const c = cells.get(Math.floor(p.x / 200) * 200 + ',' + Math.floor(p.y / 200) * 200);
      if (c) c.n++;
      return c;
    });
    keys.forEach((c, i) => { if (c) { pop[i] = c.u.pop / c.n; men[i] = c.u.men / c.n; } });
    let orphanPop = 0;
    for (const c of cells.values()) if (!c.n) orphanPop += c.u.pop;
    return { pop, men, orphanPop, mode: 'carreaux' };
  }

  /** Résultat d'une tournée (mêmes champs que les circuits en polygone, plus les indicateurs de tournée). */
  function summarize(tournee, served, weights, communes) {
    let hab = 0, men = 0;
    const byCommune = new Map();
    for (const i of served.taken.keys()) {
      hab += weights.pop[i]; men += weights.men[i];
      const c = communes[i] || '(commune inconnue)';
      const e = byCommune.get(c) || { commune: c, adresses: 0, habitants: 0 };
      e.adresses++; e.habitants += weights.pop[i];
      byCommune.set(c, e);
    }
    let km = { D: 0, G: 0, B: 0, none: 0 };
    for (const t of tournee.troncons) km[t.side || 'none'] += t.dist;
    const kmCollecte = (km.D + km.G + km.B) / 1000;
    const alerts = [];
    if (!served.taken.size) alerts.push('Aucune adresse dans la zone de collecte');
    const noGeo = tournee.troncons.filter(t => t.side && t.work.length < 2).length;
    if (noGeo) alerts.push(noGeo + ' tronçon(s) collecté(s) sans tracé');
    if (tournee.unknownTypes.length) alerts.push('Types de tronçon inconnus : ' + tournee.unknownTypes.join(', '));
    const list = Array.from(byCommune.values()).sort((a, b) => b.habitants - a.habitants);
    return {
      id: tournee.code, name: tournee.name, props: { entreprise: tournee.entreprise, date: tournee.date },
      habitants: Math.round(hab), menages: weights.mode === 'fixe' ? '' : Math.round(men),
      adresses: served.taken.size, adressesSecteur: Array.from(served.taken.values()).filter(v => v === 'secteur').length,
      troncons: tournee.troncons.length, kmCollecte, kmHlp: km.none / 1000, kmTotal: (km.D + km.G + km.B + km.none) / 1000,
      habParKm: kmCollecte ? hab / kmCollecte : 0,
      communes: list.map(c => ({ commune: c.commune, adresses: c.adresses, habitants: Math.round(c.habitants) })),
      surface: 0, densite: 0, carreaux: 0, couverture: 0, partiels: 0,
      alerts
    };
  }

  /**
   * Calcul complet. o : { tournees (projetées), eachAddress(cb(x, y, commune)), crs, units (carreaux ou null),
   * width, perAddress, sectors (polygones facultatifs, [[anneau, ...trous]] en EPSG:3035) }.
   */
  function compute(o) {
    const win = windowOf(o.tournees, o.margin === undefined ? o.width + 1000 : o.margin);
    if (!isFinite(win[0])) throw new Error('aucun tronçon avec tracé');
    const tr = Habitants.transform(o.crs, Habitants.WORK);
    const pts = [], communes = [];
    let read = 0, bad = 0;
    o.eachAddress((x, y, commune) => {
      if (!Number.isFinite(x) || !Number.isFinite(y) || (x === 0 && y === 0)) { bad++; return; }
      let p;
      try { p = tr([x, y]); } catch (e) { bad++; return; }
      if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) { bad++; return; }
      read++;
      if (p[0] < win[0] || p[0] > win[2] || p[1] < win[1] || p[1] > win[3]) return;
      pts.push({ x: p[0], y: p[1] });
      communes.push(commune || '');
    });
    if (!pts.length) throw new Error('aucune adresse près des tournées : vérifiez le fichier (département) et le système de coordonnées');
    const weights = weigh(pts, o.units && o.units.length ? o.units : null, o.perAddress);
    const index = indexPoints(pts);
    const served = o.tournees.map(tn => serve(tn, pts, index, o.width, o.sectors, o.exclusions));
    const rows = o.tournees.map((tn, i) => summarize(tn, served[i], weights, communes));
    return { rows, served, pts, communes, weights, index, read, bad, kept: pts.length };
  }

  return { compute, parseXML, sideOf, unzip, decodeText, project, windowOf, locate, indexPoints, candidates, serve, weigh, summarize };
});
