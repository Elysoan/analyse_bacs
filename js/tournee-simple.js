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
  const state = { tournees: null, addr: null, pop: null, result: null, sectors: [], active: 0 };

  function toast(msg, error) {
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
  }
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
        tournees: state.tournees, crs: a.crs, units, width, perAddress, margin: 1500, sectors: [], exclusions: [],
        eachAddress: cb => a.src.each(a.sheet, r => cb(IO.toNumber(r[a.x]), IO.toNumber(r[a.y]), a.commune ? String(r[a.commune] || '').trim() : ''))
      });
      res.width = width; res.perAddress = perAddress; res.hasUnits = !!(units && units.length);
      state.result = res;
      state.sectors = [];
      $('width-r').value = width; $('width-v').textContent = width + ' m';
      mapShow();
      recalc();
    } catch (e) { toast(e.message, true); }
    $('btn-run').disabled = false;
    $('hint').textContent = '';
  });

  function render() {
    const r = state.result, rows = r.rows;
    r.width = r.width || 30;
    const tot = rows.reduce((s, x) => ({ h: s.h + x.habitants, a: s.a + x.adresses, k: s.k + x.kmCollecte }), { h: 0, a: 0, k: 0 });
    $('results').classList.remove('hidden');
    $('summary').textContent = `${fmt(tot.h)} habitants · ${fmt(tot.a)} adresses · ${fmt1(tot.k)} km collectés`;
    $('table').innerHTML = '<thead><tr><th>Code</th><th>Libellé</th><th class="n">Habitants</th><th class="n">Adresses</th><th class="n">Km collectés</th><th class="n">Hab./km</th><th>Communes</th><th>Alerte</th></tr></thead><tbody>' +
      rows.map(x => `<tr><td>${esc(x.id)}</td><td>${esc(x.name)}</td><td class="n"><b>${fmt(x.habitants)}</b></td><td class="n">${fmt(x.adresses)}</td><td class="n">${fmt1(x.kmCollecte)}</td><td class="n">${fmt1(x.habParKm)}</td>` +
        `<td>${esc(x.communes.slice(0, 3).map(c => `${c.commune || '?'} (${fmt(c.habitants)})`).join(' · '))}</td><td>${x.alerts.length ? `<span class="warn">⚠ ${esc(x.alerts[0])}</span>` : ''}</td></tr>`).join('') + '</tbody>';
    const notes = [r.hasUnits ? 'Habitants par adresse : population du carreau INSEE ÷ nombre d\'adresses du carreau.' : `Habitants par adresse : valeur fixe (${String(r.perAddress).replace('.', ',')}).`,
      `Bande de ${r.width} m du côté collecté. Estimation : à vérifier sur quelques secteurs connus.`];
    if (r.weights.orphanPop > 0) notes.push(`${fmt(r.weights.orphanPop)} habitants de carreaux sans adresse non attribués.`);
    $('notes').textContent = notes.join(' ');
  }

  // Exports : format mémorisé par la version complète, sinon format standard « tournée ».
  function format() {
    try {
      const s = JSON.parse(localStorage.getItem('habitants.format.v1') || 'null');
      if (s && s.custom && Array.isArray(s.format) && s.format.length) return { format: s.format, source: s.source };
    } catch (e) { /* ignoré */ }
    return { format: Habitants.standardFormat(true), source: '' };
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
  const SIDE = { D: ['#0f7b6c', 4], G: ['#4a3aa7', 4], B: ['#2a78d6', 4], '': ['#8a919c', 2] };
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

  function drawAddresses() {
    aLayer.clearLayers();
    const r = state.result, tn = state.tournees[state.active], s = r.served[state.active];
    const box = tn.troncons.reduce((b, t) => t.work.length ? [Math.min(b[0], t.bbox[0]), Math.min(b[1], t.bbox[1]), Math.max(b[2], t.bbox[2]), Math.max(b[3], t.bbox[3])] : b, [Infinity, Infinity, -Infinity, -Infinity]);
    const m = r.width + 150;
    let others = 0;
    r.pts.forEach((p, k) => {
      if (p.x < box[0] - m || p.x > box[2] + m || p.y < box[1] - m || p.y > box[3] + m) return;
      const origin = s.taken.get(k);
      if (!origin && ++others > 5000) return;
      const ll = toLL([p.x, p.y]);
      L.circleMarker([ll[1], ll[0]], origin
        ? { radius: 4, weight: 1, color: '#16191d', fillColor: origin === 'secteur' ? '#d55181' : '#eda100', fillOpacity: .95, interactive: false }
        : { radius: 2, weight: 0, fillColor: '#8a919c', fillOpacity: .6, interactive: false }).addTo(aLayer);
    });
  }

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
    $('map-help').textContent = 'Cliquez sur la carte pour placer les sommets du polygone (3 au minimum), puis « Terminer ».';
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
    $('map-help').textContent = 'Traits : tournée (vert = droite, violet = gauche, bleu = bilatérale, gris = haut le pied). Points jaunes : adresses retenues. Cliquez un secteur pour déplacer ses sommets (clic droit sur un sommet pour le retirer).';
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
    r.served = state.tournees.map(t => Tournees.serve(t, r.pts, r.index, r.width, polysFor(t.code, 'add'), polysFor(t.code, 'excl')));
    r.rows = state.tournees.map((t, i) => Tournees.summarize(t, r.served[i], r.weights, r.communes));
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
    if (!state.sectors.length) return toast('Aucun secteur à enregistrer.', true);
    const features = state.sectors.map(s => ({ type: 'Feature', properties: { type: s.kind === 'add' ? 'ajout' : 'exclusion', tournee: s.code }, geometry: { type: 'Polygon', coordinates: [s.ring.concat([s.ring[0]])] } }));
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
        if (!f.geometry || f.geometry.type !== 'Polygon') return;
        const p = f.properties || {};
        const ring = f.geometry.coordinates[0].slice(0, -1);
        state.sectors.push({ id: ++seq, kind: /excl/i.test(p.type || p.kind || '') ? 'excl' : 'add', code: codes.includes(String(p.tournee)) ? String(p.tournee) : codes[state.active], ring });
        n++;
      });
      if (!n) throw new Error('aucun polygone');
      toast(`${n} secteur(s) chargé(s).`);
      drawSectors(); recalc();
    } catch (err) { toast(`Secteurs illisibles : ${err.message}`, true); }
  });

  // Exemple
  $('btn-demo').addEventListener('click', () => {
    const d = HabitantsDemo.buildTournee();
    setTournees([{ name: 'tournee_exemple.xml', text: d.xml }]);
    const a = IO.arraySource({ adresses: d.addresses }); a.name = 'adresses_exemple.csv'; setAddr(a);
    const p = IO.arraySource({ carreaux: d.rows }); p.name = 'carreaux_exemple.csv'; setPop(p);
    $('btn-run').click();
  });
})();
