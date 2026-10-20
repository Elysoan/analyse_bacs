/*
 * Version simple : tournée(s) + adresses (+ carreaux) -> tableau d'habitants desservis, en un écran.
 * Même moteur que habitants.html (Tournees.compute) ; format d'export mémorisé par la version complète s'il existe.
 */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const esc = s => String(s === undefined || s === null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmt = n => Number(n).toLocaleString('fr-FR', { maximumFractionDigits: 0 });
  const fmt1 = n => Number(n).toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const tick = () => new Promise(r => setTimeout(r, 30));
  const state = { tournees: null, addr: null, pop: null, result: null, sectors: [], active: 0, skipPop: false, checked: false, problem: '', step: -1 };

  function toast(msg, error) {
    if (error) problem(msg);
    const t = document.createElement('div');
    t.className = 'toast' + (error ? ' error' : '');
    t.textContent = msg;
    $('toasts').appendChild(t);
    setTimeout(() => t.remove(), error ? 9000 : 4500);
  }

  function wire(key, handler) {
    const drop = $('drop-' + key);
    const go = async files => {
      if (!files.length) return;
      drop.classList.add('loading');
      await tick();
      try { await handler(files); } catch (e) { toast(`${files[0].name} : ${e.message}`, true); }
      drop.classList.remove('loading');
    };
    $('file-' + key).addEventListener('change', e => { go(Array.from(e.target.files)); e.target.value = ''; });
    ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, () => drop.classList.remove('over')));
    drop.addEventListener('drop', e => { e.preventDefault(); go(Array.from(e.dataTransfer.files)); });
  }

  function chip(key, name, info) {
    $('drop-' + key).classList.add('hidden');
    $('chip-' + key).classList.remove('hidden');
    $('name-' + key).textContent = name;
    $('info-' + key).textContent = info;
    refresh();
  }

  function refresh() {
    const ready = state.tournees && state.addr;
    $('btn-run').disabled = !ready;
    guide();
    $('hint').textContent = ready ? (state.pop ? '' : 'Sans carreaux, un nombre fixe d\'habitants par adresse est utilisé (réglable).') :
      'Chargez les fichiers 1 et 2 pour commencer.';
  }

  // 1. Tournées
  async function loadTournees(files) {
    const xml = [];
    for (const f of files) {
      const buf = await f.arrayBuffer();
      if (/\.zip$/i.test(f.name)) {
        for (const e of await Tournees.unzip(buf)) if (/\.xml$/i.test(e.name) && !/(^|\/)(__MACOSX|\.)/.test(e.name)) xml.push({ name: e.name.split('/').pop(), text: Tournees.decodeText(e.bytes) });
      } else xml.push({ name: f.name, text: Tournees.decodeText(new Uint8Array(buf)) });
    }
    setTournees(xml);
  }
  function setTournees(xml) {
    const list = [], errors = [];
    xml.forEach(f => { try { list.push(Tournees.project(Tournees.parseXML(f.text, f.name))); } catch (e) { errors.push(f.name + ' : ' + e.message); } });
    if (!list.length) throw new Error(errors[0] || 'aucune tournée lisible');
    if (errors.length) toast(`${errors.length} fichier(s) ignoré(s) : ${errors[0]}`, true);
    state.tournees = list;
    const km = list.reduce((s, t) => s + t.troncons.filter(x => x.side).reduce((a, x) => a + x.dist, 0), 0) / 1000;
    chip('t', list.length === 1 ? list[0].file : `${list.length} tournées`, `${fmt1(km)} km collectés`);
    renderModes();
  }

  // Mode de collecte (sac / bac) -> taux de présentation, par tournée.
  function modeOptions(sel) { return Object.keys(Tournees.MODES).map(k => `<option value="${k}"${k === sel ? ' selected' : ''}>${esc(Tournees.MODES[k].label)}</option>`).join(''); }
  function renderModes() {
    const list = state.tournees;
    $('modes').classList.remove('hidden');
    $('modes').innerHTML = `<b>Mode de collecte et taux de présentation</b>` +
      (list.length > 1 ? `<div class="mrow"><span>Toutes</span><select id="mode-all"><option value="">— choisir —</option>${modeOptions('')}</select><span></span></div>` : '') +
      `<div class="mlist">` + list.map((t, i) => `<div class="mrow" data-i="${i}"><span title="${esc(t.name)}">${esc(t.code)}</span><select class="m">${modeOptions(t.mode)}</select><input class="t" type="number" min="1" max="100" step="1" value="${Math.round(t.taux * 100)}" title="Taux de présentation (%)"></div>`).join('') + `</div>` +
      `<p class="muted" style="margin:6px 0 0">Sac = 100 %, bac en TEOM ou REOM fixe = 85 % : part des adresses qui sortent leur déchet à chaque passage.</p>`;
  }
  function setMode(i, mode) {
    const t = state.tournees[i];
    t.mode = mode;
    if (mode !== 'autre') t.taux = Tournees.MODES[mode].taux;
  }
  $('modes').addEventListener('change', e => {
    if (e.target.id === 'mode-all') {
      if (!e.target.value) return;
      state.tournees.forEach((t, i) => setMode(i, e.target.value));
      renderModes();
    } else {
      const row = e.target.closest('.mrow'), t = state.tournees[+row.dataset.i];
      if (e.target.classList.contains('m')) { setMode(+row.dataset.i, e.target.value); row.querySelector('.t').value = Math.round(t.taux * 100); }
      else { t.taux = Math.max(0.01, Math.min(1, (+e.target.value || 100) / 100)); t.mode = 'autre'; row.querySelector('.m').value = 'autre'; }
    }
    if (state.result) recalc();
  });
  wire('t', loadTournees);

  // 2. Adresses
  async function sourceOf(file) {
    if (/\.gz$/i.test(file.name)) {
      const blob = await new Response(file.stream().pipeThrough(new DecompressionStream('gzip'))).blob();
      file = new File([blob], file.name.replace(/\.gz$/i, ''));
    }
    const src = await IO.readFile(file);
    src.name = file.name;
    return src;
  }
  function setAddr(src) {
    const sheet = src.sheetNames[0], cols = src.headers(sheet);
    const lonlat = cols.includes('lon') && cols.includes('lat');
    const xy = lonlat ? { x: 'lon', y: 'lat' } : IO.guessXY(cols);
    if (!xy.x || !xy.y) throw new Error('colonnes de coordonnées introuvables (lon / lat attendues)');
    state.addr = {
      src, sheet, x: xy.x, y: xy.y, crs: lonlat ? 'EPSG:4326' : IO.guessCRS(src.preview(sheet), xy.x, xy.y),
      commune: cols.find(c => /^nom_commune$/i.test(c)) || cols.find(c => /commune/i.test(c)) || ''
    };
    chip('a', src.name, `${fmt(src.count(sheet))} adresses`);
  }
  wire('a', async files => setAddr(await sourceOf(files[0])));

  // Lien de téléchargement de la BAN selon le département saisi
  $('dep').addEventListener('input', () => {
    const d = $('dep').value.trim().toUpperCase().replace(/[^0-9AB]/g, '');
    const a = $('dl-ban');
    a.href = `https://adresse.data.gouv.fr/data/ban/adresses/latest/csv/adresses-${d || 'XX'}.csv.gz`;
    a.textContent = `adresses-${d || 'XX'}.csv.gz`;
  });

  // 3. Population (carreaux)
  function setPop(src) {
    const sheet = src.sheetNames[0], cols = src.headers(sheet), rows = src.preview(sheet);
    const idCol = cols.find(c => rows.slice(0, 50).some(r => Habitants.parseCarreauId(r[c])));
    if (!idCol) throw new Error('identifiant de carreau introuvable (ex. CRS3035RES200mN2889000E3811400)');
    const find = re => cols.find(c => re.test(c)) || '';
    state.pop = { src, sheet, id: idCol, pop: find(/^ind$/i) || find(/habitant|population|^pop/i), men: find(/^men$/i) || find(/m[ée]nage/i) };
    if (!state.pop.pop) throw new Error('colonne d\'habitants introuvable (ind attendue)');
    chip('p', src.name, `${fmt(src.count(sheet))} carreaux`);
  }
  wire('p', async files => setPop(await sourceOf(files[0])));

  // Calcul
  $('btn-run').addEventListener('click', async () => {
    $('btn-run').disabled = true;
    $('hint').textContent = 'Calcul en cours…';
    await tick();
    try {
      const width = Math.max(1, +$('width').value || 30), perAddress = +$('per-addr').value || 2.2;
      const a = state.addr, p = state.pop;
      let units = null;
      if (p) {
        const win = Tournees.windowOf(state.tournees, width + 1000);
        units = Habitants.unitsFromRows(f => p.src.each(p.sheet, f), { idCol: p.id, popCol: p.pop, menCol: p.men, toNumber: IO.toNumber, window: win }).units;
      }
      const res = Tournees.compute({
        tournees: state.tournees, crs: a.crs, units, width, perAddress, margin: 1500, sectors: [], exclusions: [], kgPerPerson: kgPerPerson(),
        eachAddress: cb => a.src.each(a.sheet, r => cb(IO.toNumber(r[a.x]), IO.toNumber(r[a.y]), a.commune ? String(r[a.commune] || '').trim() : ''))
      });
      res.width = width; res.perAddress = perAddress; res.hasUnits = !!(units && units.length);
      state.result = res;
      state.checked = false; state.problem = '';
      state.sectors = [];
      Object.keys(manual).forEach(k => delete manual[k]);
      $('width-r').value = width; $('width-v').textContent = width + ' m';
      mapShow();
      recalc();
      guide();
    } catch (e) { toast(e.message, true); }
    $('btn-run').disabled = false;
    $('hint').textContent = '';
  });

  const kgPerPerson = () => +String($('kg').value).replace(',', '.') || 0;
  $('kg').addEventListener('change', () => { if (state.result) recalc(); });

  function render() {
    const r = state.result, rows = r.rows;
    r.width = r.width || 30;
    const tot = rows.reduce((s, x) => ({ h: s.h + x.habitants, c: s.c + x.habCollectes, a: s.a + x.adresses, p: s.p + x.presentees, k: s.k + x.kmCollecte, kg: s.kg + (x.production || 0) }), { h: 0, c: 0, a: 0, p: 0, k: 0, kg: 0 });
    const kgOn = kgPerPerson() > 0;
    $('results').classList.remove('hidden');
    $('summary').textContent = `${fmt(tot.h)} habitants desservis · ${fmt(tot.c)} collectés (estim.) · ${fmt(tot.a)} adresses · ${fmt1(tot.k)} km collectés` + (kgOn ? ` · ${fmt(tot.kg)} kg par passage` : '');
    $('table').innerHTML = '<thead><tr><th>Code</th><th>Libellé</th><th>Mode</th><th class="n">Habitants desservis</th><th class="n">Habitants collectés</th><th class="n">Adresses</th><th class="n">Adresses présentées</th>' + (kgOn ? '<th class="n">Production (kg/passage)</th>' : '') + '<th class="n">Km collectés</th><th>Communes</th><th>Alerte</th></tr></thead><tbody>' +
      rows.map(x => `<tr><td>${esc(x.id)}</td><td>${esc(x.name)}</td><td>${esc(x.modeLabel)} · ${Math.round(x.taux * 100)} %</td><td class="n">${fmt(x.habitants)}</td><td class="n"><b>${fmt(x.habCollectes)}</b></td><td class="n">${fmt(x.adresses)}</td><td class="n">${fmt(x.presentees)}</td>` + (kgOn ? `<td class="n"><b>${fmt(x.production || 0)}</b></td>` : '') + `<td class="n">${fmt1(x.kmCollecte)}</td>` +
        `<td>${esc(x.communes.slice(0, 3).map(c => `${c.commune || '?'} (${fmt(c.habitants)})`).join(' · '))}</td><td>${x.alerts.length ? `<span class="warn">⚠ ${esc(x.alerts[0])}</span>` : ''}</td></tr>`).join('') + '</tbody>';
    const notes = [r.hasUnits ? 'Habitants par adresse : population du carreau INSEE ÷ nombre d\'adresses du carreau.' : `Habitants par adresse : valeur fixe (${String(r.perAddress).replace('.', ',')}).`,
      `Bande de ${r.width} m du côté collecté. Habitants collectés = habitants desservis × taux de présentation du mode de collecte (sac 100 %, bac 85 %). Estimation : à vérifier sur quelques secteurs connus.`];
    if (r.weights.orphanPop > 0) notes.push(`${fmt(r.weights.orphanPop)} habitants de carreaux sans adresse non attribués.`);
    $('notes').textContent = notes.join(' ');
  }

  // Exports : format mémorisé par la version complète, sinon format standard « tournée ».
  function format() {
    try {
      const s = JSON.parse(localStorage.getItem('habitants.format.v1') || 'null');
      if (s && s.custom && Array.isArray(s.format) && s.format.length) return { format: s.format, source: s.source };
    } catch (e) { /* ignoré */ }
    return { format: Habitants.standardFormat(true, kgPerPerson() > 0), source: '' };
  }
  const stamp = () => new Date().toISOString().slice(0, 10);
  function table() {
    const f = format(), d = new Date(), p = n => String(n).padStart(2, '0');
    return Habitants.buildTable(state.result.rows, f.format, { source: f.source || 'BAN × INSEE carreaux 200 m', date: `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}` });
  }
  const num = v => typeof v === 'number' && !Number.isInteger(v) ? String(v).replace('.', ',') : v;
  $('btn-csv').addEventListener('click', () => { const t = table(); IO.download(`habitants_tournees_${stamp()}.csv`, IO.toCSV(t.header, t.lines.map(l => l.map(num))), 'text/csv;charset=utf-8'); });
  $('btn-xlsx').addEventListener('click', () => {
    const t = table(), wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([t.header].concat(t.lines)), 'Habitants');
    XLSX.writeFile(wb, `habitants_tournees_${stamp()}.xlsx`);
  });
  $('btn-communes').addEventListener('click', () => {
    const lines = [];
    state.result.rows.forEach(r => r.communes.forEach(c => lines.push([r.id, r.name, c.commune, c.adresses, c.habitants])));
    IO.download(`habitants_par_commune_${stamp()}.csv`, IO.toCSV(['Code', 'Libellé', 'Commune', 'Adresses', 'Habitants'], lines), 'text/csv;charset=utf-8');
  });

  // --- Carte et sectorisation ------------------------------------------------------------------------------
  const toLL = Habitants.transform(Habitants.WORK, 'EPSG:4326'), toWork = Habitants.transform('EPSG:4326', Habitants.WORK);
  const SIDE = { D: ['#4f7a0a', 4], G: ['#4a3aa7', 4], B: ['#2a78d6', 4], '': ['#8a919c', 2] };
  const KIND = { add: { color: '#d55181', label: 'Secteur ajouté' }, excl: { color: '#e34948', label: 'Zone exclue' } };
  let map, tLayer, aLayer, sLayer, vLayer, drawing = null, tmp = null, selected = null, seq = 0;

  function initMap() {
    if (map) return;
    map = L.map('map', { preferCanvas: true });
    L.tileLayer('https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&STYLE=normal&TILEMATRIXSET=PM&LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2&FORMAT=image/png&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}',
      { maxZoom: 19, attribution: '© IGN-F/Géoplateforme' }).addTo(map);
    L.control.scale({ imperial: false }).addTo(map);
    tLayer = L.featureGroup().addTo(map); aLayer = L.featureGroup().addTo(map);
    sLayer = L.featureGroup().addTo(map); vLayer = L.featureGroup().addTo(map);
    map.on('click', e => { if (drawing) { drawing.pts.push([e.latlng.lng, e.latlng.lat]); drawTmp(); } else if (selected) { selected = null; drawSectors(); } });
    map.on('moveend', () => { if (state.result) drawAddresses(); });
    map.setView([46.6, 2.4], 6);
  }

  function mapShow() {
    $('map-card').classList.remove('hidden');
    initMap();
    $('active').innerHTML = state.tournees.map((t, i) => `<option value="${i}">${esc(t.code)}${t.name && t.name !== t.code ? ' · ' + esc(t.name) : ''}</option>`).join('');
    $('active').classList.toggle('hidden', state.tournees.length < 2);
    state.active = 0; $('active').value = '0';
    drawTournees();
    setTimeout(() => { map.invalidateSize(); if (tLayer.getBounds().isValid()) map.fitBounds(tLayer.getBounds(), { padding: [20, 20] }); }, 60);
  }

  function drawTournees() {
    tLayer.clearLayers();
    state.tournees.forEach((tn, i) => tn.troncons.forEach(t => {
      if (t.pts.length < 2) return;
      const st = SIDE[t.side];
      L.polyline(t.pts.map(q => [q[1], q[0]]), { color: st[0], weight: st[1], dashArray: t.side ? null : '5 5', opacity: i === state.active ? .95 : .3 })
        .bindTooltip(`<b>${esc(t.nom || '(sans nom)')}</b> · ${esc(t.type)}<br>${esc(t.commune)} · ${fmt(t.dist)} m`, { sticky: true })
        .on('click', () => { if (!drawing && state.tournees.length > 1) { state.active = i; $('active').value = String(i); drawTournees(); drawAddresses(); } }).addTo(tLayer);
    }));
  }

  // Ajustements manuels, par tournée : adresses ajoutées « + » ou retirées d'un clic.
  const manual = {};
  const man = code => manual[code] || (manual[code] = { add: new Set(), rem: new Set() });
  const PLUS_MIN_ZOOM = 15, PLUS_MAX = 1500;

  function toggleAddress(k) {
    const code = state.tournees[state.active].code, m = man(code);
    if (state.result.served[state.active].taken.has(k)) { if (!m.add.delete(k)) m.rem.add(k); }
    else if (!m.rem.delete(k)) m.add.add(k);
    recalc();
  }

  function drawAddresses() {
    aLayer.clearLayers();
    const r = state.result, tn = state.tournees[state.active], s = r.served[state.active], m = man(tn.code);
    const box = tn.troncons.reduce((b, t) => t.work.length ? [Math.min(b[0], t.bbox[0]), Math.min(b[1], t.bbox[1]), Math.max(b[2], t.bbox[2]), Math.max(b[3], t.bbox[3])] : b, [Infinity, Infinity, -Infinity, -Infinity]);
    const mg = r.width + 150;
    const zoomed = map.getZoom() >= PLUS_MIN_ZOOM, view = map.getBounds().pad(0.05);
    let plus = 0, dots = 0;
    r.pts.forEach((p, k) => {
      if (p.x < box[0] - mg || p.x > box[2] + mg || p.y < box[1] - mg || p.y > box[3] + mg) return;
      const origin = s.taken.get(k);
      const ll = toLL([p.x, p.y]), at = [ll[1], ll[0]];
      const tip = `${fmt1(r.weights.pop[k])} hab.${r.communes[k] ? ' · ' + esc(r.communes[k]) : ''}`;
      if (origin) {
        const manuel = origin === 'manuel';
        L.circleMarker(at, { radius: manuel ? 5 : 4, weight: manuel ? 2 : 1, color: manuel ? '#2a78d6' : '#16191d', fillColor: origin === 'secteur' ? '#d55181' : '#eda100', fillOpacity: .95, interactive: !drawing && zoomed })
          .bindTooltip(`${tip}<br><i>${zoomed ? 'Cliquer pour retirer' : ''}</i>`).on('click', () => toggleAddress(k)).addTo(aLayer);
      } else if (zoomed && view.contains(at) && plus < PLUS_MAX) {
        plus++;
        L.marker(at, { icon: L.divIcon({ className: 'plus' + (m.rem.has(k) ? ' rem' : ''), html: '+', iconSize: [16, 16] }), interactive: !drawing, keyboard: false })
          .bindTooltip(`${tip}<br><i>${m.rem.has(k) ? 'Retirée : cliquer pour la remettre' : 'Cliquer pour ajouter'}</i>`).on('click', () => toggleAddress(k)).addTo(aLayer);
      } else if (!zoomed && ++dots <= 5000) {
        L.circleMarker(at, { radius: 2, weight: 0, fillColor: '#8a919c', fillOpacity: .6, interactive: false }).addTo(aLayer);
      }
    });
    $('map-help').textContent = drawing ? 'Cliquez sur la carte pour placer les sommets du polygone (3 au minimum), puis « Terminer ».' : HELP + (zoomed ? '' : ' Zoomez pour afficher les « + » et ajouter une adresse d\'un clic.');
  }
  const HELP = 'Traits : tournée (vert = droite, violet = gauche, bleu = bilatérale, gris = haut le pied). Points jaunes : adresses retenues (clic pour retirer). « + » : adresses non retenues (clic pour ajouter). Cliquez un secteur pour déplacer ses sommets (clic droit sur un sommet pour le retirer).';

  const latlngs = ring => ring.map(q => [q[1], q[0]]);

  function drawSectors() {
    sLayer.clearLayers(); vLayer.clearLayers();
    state.sectors.forEach(sec => {
      const k = KIND[sec.kind];
      const poly = L.polygon(latlngs(sec.ring), { color: k.color, weight: sec.id === selected ? 3 : 2, dashArray: '6 4', fillOpacity: sec.id === selected ? .18 : .08, opacity: sec.code === state.tournees[state.active].code ? 1 : .5 })
        .bindTooltip(`${k.label} · ${esc(sec.code)}`, { sticky: true })
        .on('click', e => { if (drawing) return; L.DomEvent.stopPropagation(e); selected = sec.id; drawSectors(); }).addTo(sLayer);
      if (sec.id !== selected) return;
      sec.ring.forEach((q, i) => {
        const mk = L.marker([q[1], q[0]], { draggable: true, icon: L.divIcon({ className: '', html: '<div class="vtx"></div>', iconSize: [12, 12] }) }).addTo(vLayer);
        mk.on('drag', () => { const ll = mk.getLatLng(); sec.ring[i] = [ll.lng, ll.lat]; poly.setLatLngs(latlngs(sec.ring)); });
        mk.on('dragend', recalc);
        mk.on('contextmenu', () => { if (sec.ring.length > 3) { sec.ring.splice(i, 1); drawSectors(); recalc(); } });
      });
    });
    $('secs').innerHTML = state.sectors.length ? state.sectors.map(sec => `<div class="row"><span class="tag" style="--tc:${KIND[sec.kind].color}">${KIND[sec.kind].label}</span><span>${esc(sec.code)} · ${sec.ring.length} sommets</span><button class="link" data-edit="${sec.id}">Modifier</button><button class="link" data-del="${sec.id}">Supprimer</button></div>`).join('')
      : '<span class="muted">Aucun secteur. « Ajouter un secteur » pour un hameau ou un bac de regroupement hors de la bande ; « Exclure une zone » pour retirer des adresses.</span>';
  }
  $('secs').addEventListener('click', e => {
    const d = e.target.closest('[data-del]'), ed = e.target.closest('[data-edit]');
    if (d) { state.sectors = state.sectors.filter(s => s.id !== +d.dataset.del); selected = null; drawSectors(); recalc(); }
    if (ed) { selected = +ed.dataset.edit; drawSectors(); const sec = state.sectors.find(s => s.id === selected); map.fitBounds(L.polygon(latlngs(sec.ring)).getBounds(), { padding: [40, 40] }); }
  });

  // Nouveau polygone : un clic par sommet, puis « Terminer ».
  function startDraw(kind) {
    drawing = { kind, pts: [] }; selected = null; drawSectors();
    document.body.classList.add('drawing');
    ['btn-add', 'btn-excl'].forEach(id => $(id).classList.add('hidden'));
    ['btn-finish', 'btn-cancel'].forEach(id => $(id).classList.remove('hidden'));
    map.doubleClickZoom.disable();
    drawAddresses();
  }
  function drawTmp() {
    if (tmp) map.removeLayer(tmp);
    tmp = L.polyline(latlngs(drawing.pts.concat(drawing.pts.length > 2 ? [drawing.pts[0]] : [])), { color: KIND[drawing.kind].color, weight: 2, dashArray: '4 4' }).addTo(map);
  }
  function endDraw(ok) {
    if (ok && drawing.pts.length >= 3) {
      const sec = { id: ++seq, kind: drawing.kind, code: state.tournees[state.active].code, ring: drawing.pts };
      state.sectors.push(sec); selected = sec.id;
    } else if (ok) toast('Un polygone demande au moins 3 sommets.', true);
    if (tmp) map.removeLayer(tmp);
    tmp = null; drawing = null;
    document.body.classList.remove('drawing');
    ['btn-add', 'btn-excl'].forEach(id => $(id).classList.remove('hidden'));
    ['btn-finish', 'btn-cancel'].forEach(id => $(id).classList.add('hidden'));
    map.doubleClickZoom.enable();
    drawSectors(); recalc();
  }
  $('btn-add').addEventListener('click', () => startDraw('add'));
  $('btn-excl').addEventListener('click', () => startDraw('excl'));
  $('btn-finish').addEventListener('click', () => endDraw(true));
  $('btn-cancel').addEventListener('click', () => endDraw(false));
  $('active').addEventListener('change', () => { state.active = +$('active').value; drawTournees(); drawSectors(); drawAddresses(); });

  // Recalcul après un changement de secteur ou de largeur (les adresses sont déjà en mémoire).
  function polysFor(code, kind) {
    return state.sectors.filter(s => s.kind === kind && s.code === code).map(s => [s.ring.map(toWork)]);
  }
  function recalc() {
    const r = state.result;
    if (!r) return;
    r.served = state.tournees.map(t => {
      const sv = Tournees.serve(t, r.pts, r.index, r.width, polysFor(t.code, 'add'), polysFor(t.code, 'excl')), m = man(t.code);
      m.rem.forEach(k => sv.taken.delete(k));
      m.add.forEach(k => { if (!sv.taken.has(k)) sv.taken.set(k, 'manuel'); });
      return sv;
    });
    r.rows = state.tournees.map((t, i) => Tournees.summarize(t, r.served[i], r.weights, r.communes, { kgPerPerson: kgPerPerson() }));
    render(); drawSectors(); drawAddresses();
  }
  function setWidth(v) {
    v = Math.max(5, Math.min(150, +v || 30));
    $('width').value = v; $('width-r').value = v; $('width-v').textContent = v + ' m';
    if (state.result) { state.result.width = v; recalc(); }
  }
  $('width-r').addEventListener('change', e => setWidth(e.target.value));
  $('width-r').addEventListener('input', e => { $('width-v').textContent = e.target.value + ' m'; });
  $('width').addEventListener('change', e => setWidth(e.target.value));

  // Enregistrement / chargement des secteurs (GeoJSON, lisible dans ArcGIS Pro)
  $('btn-save-sec').addEventListener('click', () => {
    const pointsOf = (set, type) => Array.from(set).map(k => ({ code: null, k, type }));
    const pts = [];
    state.tournees.forEach(t => { const m = man(t.code); m.add.forEach(k => pts.push([t.code, k, 'ajout_adresse'])); m.rem.forEach(k => pts.push([t.code, k, 'retrait_adresse'])); });
    if (!state.sectors.length && !pts.length) return toast('Aucun secteur ni ajustement à enregistrer.', true);
    const features = pts.map(([code, k, type]) => { const ll = toLL([state.result.pts[k].x, state.result.pts[k].y]); return { type: 'Feature', properties: { type, tournee: code }, geometry: { type: 'Point', coordinates: ll } }; }).concat(state.sectors.map(s => ({ type: 'Feature', properties: { type: s.kind === 'add' ? 'ajout' : 'exclusion', tournee: s.code }, geometry: { type: 'Polygon', coordinates: [s.ring.concat([s.ring[0]])] } })));
    IO.download(`secteurs_${stamp()}.geojson`, JSON.stringify({ type: 'FeatureCollection', features }), 'application/geo+json');
  });
  $('file-sec').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file || !state.result) return toast('Calculez d\'abord la tournée, puis chargez les secteurs.', true);
    try {
      const gj = JSON.parse(Tournees.decodeText(new Uint8Array(await file.arrayBuffer())));
      const feats = gj.type === 'FeatureCollection' ? gj.features : [gj];
      const codes = state.tournees.map(t => t.code);
      let n = 0;
      feats.forEach(f => {
        if (f.geometry && f.geometry.type === 'Point') {
          // Ajustement d'adresse : retrouvée par sa position (à 2 m près)
          const p = f.properties || {}, w = toWork(f.geometry.coordinates), r0 = state.result;
          let best = -1, bd = 4;
          Tournees.candidates(r0.index, [w[0] - 2, w[1] - 2, w[0] + 2, w[1] + 2]).forEach(k => { const d = Math.hypot(r0.pts[k].x - w[0], r0.pts[k].y - w[1]); if (d < bd) { bd = d; best = k; } });
          const code = codes.includes(String(p.tournee)) ? String(p.tournee) : codes[state.active];
          if (best >= 0 && /ajout_adresse|retrait_adresse/.test(p.type || '')) { man(code)[/ajout/.test(p.type) ? 'add' : 'rem'].add(best); n++; }
          return;
        }
        if (!f.geometry || f.geometry.type !== 'Polygon') return;
        const p = f.properties || {};
        const ring = f.geometry.coordinates[0].slice(0, -1);
        state.sectors.push({ id: ++seq, kind: /excl/i.test(p.type || p.kind || '') ? 'excl' : 'add', code: codes.includes(String(p.tournee)) ? String(p.tournee) : codes[state.active], ring });
        n++;
      });
      if (!n) throw new Error('aucun polygone ni adresse reconnue');
      toast(`${n} élément(s) chargé(s).`);
      drawSectors(); recalc();
    } catch (err) { toast(`Secteurs illisibles : ${err.message}`, true); }
  });

  // --- Guide pas à pas -----------------------------------------------------------------------------------
  const STEPS = ['Tournée', 'Adresses', 'Population', 'Calcul', 'Contrôle', 'Export'];
  const FOCUS = [['slot-t'], ['slot-a'], ['slot-p'], ['modes', 'btn-run'], ['map-card'], ['results']];
  const HINTS = [
    [/aucune adresse près/i, 'Le fichier d\'adresses ne correspond sans doute pas au département de la tournée : vérifiez le numéro de département de la BAN.'],
    [/format non reconnu|aucun tronçon|aucune tournée|zip|xml/i, 'La tournée doit être un fichier .xml (ou un .zip contenant des .xml).'],
    [/coordonn/i, 'Le fichier d\'adresses doit contenir des colonnes de coordonnées (lon et lat pour la BAN).'],
    [/carreau|habitants introuvable/i, 'Prenez le fichier des carreaux de 200 m de l\'INSEE (colonnes idcar_200m et ind), au format CSV.']
  ];
  let guideOn = true;
  try { guideOn = localStorage.getItem('tournee.guide') !== 'off'; } catch (e) { /* ignoré */ }

  function problem(msg) {
    const hint = (HINTS.find(h => h[0].test(msg)) || [])[1];
    state.problem = msg + (hint ? ' → ' + hint : '');
    guide();
  }

  function currentStep() {
    if (!state.tournees) return 0;
    if (!state.addr) return 1;
    if (!state.pop && !state.skipPop) return 2;
    if (!state.result) return 3;
    return state.checked ? 5 : 4;
  }

  const btn = (label, onclick, primary, href) => {
    const el = document.createElement(href ? 'a' : 'button');
    el.className = 'btn small' + (primary ? ' primary' : '');
    el.textContent = label;
    if (href) { el.href = href; el.target = '_blank'; el.rel = 'noopener'; } else el.addEventListener('click', onclick);
    return el;
  };

  function guide() {
    if (!$('guide')) return;
    const step = currentStep(), r = state.result;
    $('guide').classList.toggle('hidden', !guideOn);
    $('coach-show').classList.toggle('hidden', guideOn);
    $('stepper').innerHTML = STEPS.map((s, i) => `<li class="${i < step ? 'done' : i === step ? 'cur' : ''}"><b>${i + 1}</b>${s}</li>`).join('');
    const sum = r ? r.rows.reduce((t, x) => ({ h: t.h + x.habitants, c: t.c + x.habCollectes }), { h: 0, c: 0 }) : null;
    const km = state.tournees ? state.tournees.reduce((t, tn) => t + tn.troncons.filter(x => x.side).reduce((a, x) => a + x.dist, 0), 0) / 1000 : 0;
    const A = [];
    let title, text;
    if (step === 0) {
      title = 'Déposez votre tournée';
      text = 'Glissez le fichier XML de la tournée dans la case 1, ou un ZIP qui en contient plusieurs : vous obtiendrez une ligne de résultat par tournée.';
      A.push(btn('Essayer avec un exemple', () => $('btn-demo').click(), true));
    } else if (step === 1) {
      title = 'Ajoutez les adresses';
      text = `Tournée lue : ${fmt1(km)} km de collecte. Déposez maintenant la BAN de votre département (adresses-XX.csv.gz, inutile de la décompresser) dans la case 2.`;
      A.push(btn('⭳ Télécharger la BAN ' + ($('dep').value.trim() || ''), null, true, $('dl-ban').href));
    } else if (step === 2) {
      title = 'Ajoutez la population (conseillé)';
      text = 'Les carreaux INSEE répartissent les habitants adresse par adresse, ce qui donne un résultat bien plus juste. Sans eux, un nombre fixe d\'habitants par adresse est utilisé.';
      A.push(btn('⭳ Télécharger les carreaux INSEE', null, true, 'https://www.insee.fr/fr/statistiques/8735162'));
      A.push(btn('Continuer sans', () => { state.skipPop = true; guide(); }));
    } else if (step === 3) {
      title = 'Réglez et calculez';
      text = 'Vérifiez le mode de collecte de chaque tournée (sac : 100 %, bac TEOM ou REOM fixe : 85 %), puis cliquez sur Calculer. La largeur de collecte (30 m) se règle dans « Réglages » ou plus tard sur la carte.';
      A.push(btn('Calculer', () => $('btn-run').click(), true));
    } else if (step === 4) {
      title = 'Contrôlez sur la carte';
      text = `${fmt(sum.h)} habitants desservis, ${fmt(sum.c)} collectés (estim.). Zoomez : un « + » est une adresse non retenue, cliquez pour l'ajouter ; cliquez un point jaune pour le retirer. « Ajouter un secteur » couvre un hameau ou un bac de regroupement.`;
      A.push(btn('Aller à la carte', () => scrollTo('map-card')));
      A.push(btn('Tout est bon : exporter', () => { state.checked = true; guide(); }, true));
    } else {
      title = 'Téléchargez le résultat';
      text = 'Tableau en CSV ou Excel, détail par commune. Sous la carte, vous pouvez enregistrer vos secteurs et ajustements pour les réutiliser. Pour une autre tournée : « Changer » sur la case 1.';
      A.push(btn('⭳ CSV', () => $('btn-csv').click(), true));
      A.push(btn('⭳ Excel', () => $('btn-xlsx').click(), true));
      A.push(btn('Revenir au contrôle', () => { state.checked = false; guide(); }));
    }
    $('coach-n').textContent = step + 1;
    $('coach-title').textContent = title;
    $('coach-text').textContent = text;
    $('coach-problem').textContent = '⚠ ' + state.problem;
    $('coach-problem').classList.toggle('hidden', !state.problem);
    const box = $('coach-actions');
    box.innerHTML = '';
    A.forEach(a => box.appendChild(a));
    document.querySelectorAll('.focus').forEach(e => e.classList.remove('focus'));
    if (guideOn) FOCUS[step].forEach(id => { const e = $(id); if (e && !e.classList.contains('hidden')) e.classList.add('focus'); });
    if (step !== state.step) {
      if (state.step !== -1 && guideOn) scrollTo(FOCUS[step][0]);
      state.problem = step > state.step ? '' : state.problem;
      $('coach-problem').classList.toggle('hidden', !state.problem);
      state.step = step;
    }
  }
  function scrollTo(id) { const e = $(id); if (e) setTimeout(() => e.scrollIntoView({ behavior: 'smooth', block: 'center' }), 80); }
  $('coach-hide').addEventListener('click', () => { guideOn = false; try { localStorage.setItem('tournee.guide', 'off'); } catch (e) { /* ignoré */ } guide(); });
  $('coach-show').addEventListener('click', () => { guideOn = true; try { localStorage.removeItem('tournee.guide'); } catch (e) { /* ignoré */ } guide(); });

  // « Changer » : remet une case à zéro (le résultat doit alors être recalculé)
  document.querySelectorAll('[data-reset]').forEach(b => b.addEventListener('click', () => {
    const k = b.dataset.reset;
    state[{ t: 'tournees', a: 'addr', p: 'pop' }[k]] = null;
    if (k === 'p') state.skipPop = false;
    $('drop-' + k).classList.remove('hidden');
    $('chip-' + k).classList.add('hidden');
    if (k === 't') $('modes').classList.add('hidden');
    state.result = null; state.problem = ''; state.checked = false; state.step = -1;
    $('results').classList.add('hidden'); $('map-card').classList.add('hidden');
    refresh();
  }));

  // Exemple
  $('btn-demo').addEventListener('click', () => {
    const d = HabitantsDemo.buildTournee();
    setTournees([{ name: 'tournee_exemple.xml', text: d.xml }]);
    const a = IO.arraySource({ adresses: d.addresses }); a.name = 'adresses_exemple.csv'; setAddr(a);
    const p = IO.arraySource({ carreaux: d.rows }); p.name = 'carreaux_exemple.csv'; setPop(p);
    $('btn-run').click();
  });
  refresh();
})();
