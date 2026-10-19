/*
 * Interface « Habitants par circuit » : chargement des circuits et des carreaux, calcul, carte,
 * tableau et export selon un format (standard ou calqué sur un fichier modèle).
 */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const esc = s => String(s === undefined || s === null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmt = n => Number(n).toLocaleString('fr-FR', { maximumFractionDigits: 0 });
  const fmt2 = n => Number(n).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmt1 = n => Number(n).toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const tick = () => new Promise(r => setTimeout(r, 30));
  const STORE = 'habitants.format.v1';

  const state = {
    circuits: null,   // { name, features, crs, columns }
    pop: null,        // { name, kind: 'table' | 'geo', source / features, crs, columns, sheet }
    format: Habitants.standardFormat(),
    custom: false,
    result: null,     // { rows, circuits, units, extent, meta }
    sort: { key: 'habitants', dir: -1 },
    selected: null
  };

  function toast(msg, type) {
    const t = document.createElement('div');
    t.className = 'toast' + (type === 'error' ? ' error' : '');
    t.textContent = msg;
    $('toasts').appendChild(t);
    setTimeout(() => t.remove(), type === 'error' ? 9000 : 4500);
  }

  // --- Mémoire du format (localStorage, facultatif) ----------------------------------------------
  function loadSaved() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE) || 'null');
      if (s && Array.isArray(s.format) && s.format.length) {
        state.format = s.format;
        $('meta-source').value = s.source || '';
        state.custom = !!s.custom;
        document.querySelector(`input[name=fmt][value=${state.custom ? 'custom' : 'standard'}]`).checked = true;
      }
    } catch (e) { /* stockage indisponible : on garde le format standard */ }
  }
  function save() {
    try { localStorage.setItem(STORE, JSON.stringify({ custom: state.custom, format: state.format, source: $('meta-source').value })); } catch (e) { /* ignoré */ }
  }

  // --- Aide, démonstration ---------------------------------------------------------------------------
  $('btn-help').addEventListener('click', () => $('help').showModal());
  $('help').addEventListener('click', e => { if (e.target === $('help') || e.target.hasAttribute('data-close')) $('help').close(); });

  // --- Remplissage des listes de colonnes ------------------------------------------------------------
  function fill(sel, cols, selected, optional) {
    sel.innerHTML = (optional ? '<option value="">(aucune)</option>' : '') + cols.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
    sel.value = selected && cols.includes(selected) ? selected : (optional ? '' : cols[0] || '');
  }
  const find = (cols, re) => cols.find(c => re.test(c)) || '';

  // --- Dépôt de fichiers -------------------------------------------------------------------------------
  function wireDrop(key, handler) {
    const drop = $('drop-' + key);
    $('file-' + key).addEventListener('change', e => { if (e.target.files[0]) handler(e.target.files[0], drop); e.target.value = ''; });
    ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, () => drop.classList.remove('over')));
    drop.addEventListener('drop', e => { e.preventDefault(); if (e.dataTransfer.files[0]) handler(e.dataTransfer.files[0], drop); });
  }

  async function guarded(file, drop, work) {
    drop.classList.add('loading');
    drop.querySelector('b').textContent = file.size > 10e6 ? `Lecture de ${file.name} (gros fichier, patientez)` : 'Lecture de ' + file.name;
    await tick();
    try { await work(); }
    catch (err) { toast(`Impossible de lire ${file.name} : ${err.message}`, 'error'); }
    finally { drop.classList.remove('loading'); drop.querySelector('b').textContent = 'Déposer le fichier ici'; }
  }

  async function readGeoJSON(file) {
    const gj = JSON.parse(IO_decode(await file.arrayBuffer()));
    const features = gj.type === 'FeatureCollection' ? gj.features : (gj.type === 'Feature' ? [gj] : []);
    if (!features.length) throw new Error('GeoJSON sans entités (FeatureCollection attendue).');
    return { features, crs: Habitants.geojsonCRS(gj, features) };
  }
  function IO_decode(buffer) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^﻿/, ''); }
    catch (e) { return new TextDecoder('windows-1252').decode(buffer); }
  }
  const isGeo = file => /\.(geojson|json)$/i.test(file.name);

  // Étape 1 : circuits
  wireDrop('c', (file, drop) => guarded(file, drop, async () => {
    if (!isGeo(file)) throw new Error('un GeoJSON de polygones est attendu (ArcGIS Pro : « Convertir entités en JSON »).');
    const { features, crs } = await readGeoJSON(file);
    const polys = features.filter(f => f.geometry && /Polygon/.test(f.geometry.type));
    if (!polys.length) throw new Error('aucun polygone : pour des tracés en ligne, créez d\'abord un tampon dans ArcGIS Pro.');
    const columns = IO.columnsOf(features.map(f => f.properties || {}));
    setCircuits({ name: file.name, features, crs, columns, polygons: polys.length });
    if (polys.length < features.length) toast(`${features.length - polys.length} entité(s) sans polygone ignorée(s).`);
  }));

  function setCircuits(c) {
    state.circuits = c;
    $('drop-c').classList.add('hidden');
    $('chip-c').classList.remove('hidden');
    $('name-c').textContent = c.name;
    $('info-c').textContent = `${fmt(c.polygons)} circuit${c.polygons > 1 ? 's' : ''} · ${IO.CRS[c.crs] || c.crs}`;
    $('cols-c').classList.remove('hidden');
    fill($('id-c'), c.columns, find(c.columns, /^(code|id|n°|num)[ _a-z]*circuit|circuit.*(code|id|num)|^code|^id$|tourn/i) || c.columns[0]);
    fill($('nom-c'), c.columns, find(c.columns, /lib[ée]ll?[ée]|^nom|name|d[ée]signation/i), true);
    $('step-p').classList.remove('locked');
    $('step-c').classList.add('done');
    refreshRun();
  }

  // Étape 2 : population
  wireDrop('p', (file, drop) => guarded(file, drop, async () => {
    if (isGeo(file)) {
      const { features, crs } = await readGeoJSON(file);
      setPop({ name: file.name, kind: 'geo', features, crs, columns: IO.columnsOf(features.map(f => f.properties || {})), count: features.length });
    } else {
      const source = await IO.readFile(file);
      source.name = file.name;
      state.popSource = source;
      showPopSheet(source.sheetNames[0]);
    }
  }));

  function showPopSheet(sheet) {
    const source = state.popSource;
    const sel = $('sheet-p').querySelector('select');
    $('sheet-p').classList.toggle('hidden', source.sheetNames.length < 2);
    sel.innerHTML = source.sheetNames.map(s => `<option>${esc(s)}</option>`).join('');
    sel.value = sheet;
    setPop({ name: source.name, kind: 'table', source, sheet, columns: IO.columnsOf(source.preview(sheet)), rows: source.preview(sheet), count: source.count(sheet) });
  }
  $('sheet-p').querySelector('select').addEventListener('change', e => showPopSheet(e.target.value));

  function setPop(p) {
    state.pop = p;
    $('drop-p').classList.add('hidden');
    $('chip-p').classList.remove('hidden');
    $('name-p').textContent = p.name;
    $('info-p').textContent = `${fmt(p.count)} ${p.kind === 'geo' ? 'polygones' : 'lignes'}`;
    $('cols-p').classList.remove('hidden');
    $('field-idcar').classList.toggle('hidden', p.kind === 'geo');
    const cols = p.columns;
    if (p.kind === 'table') {
      const idCol = cols.find(c => p.rows.slice(0, 50).some(r => Habitants.parseCarreauId(r[c]))) || '';
      fill($('idcar-p'), cols, idCol);
      $('hint-p').textContent = idCol ? '' : 'Aucune colonne d\'identifiant de carreau reconnue (ex. CRS3035RES200mN2889000E3811400).';
      $('hint-p').className = 'hint' + (idCol ? '' : ' ko');
    } else {
      $('hint-p').textContent = 'Couche de polygones : la population est répartie au prorata des surfaces.';
      $('hint-p').className = 'hint';
    }
    fill($('pop-p'), cols, find(cols, /^ind$/i) || find(cols, /habitant|population|^pop|^ind[_ ]?\w*$/i) || cols[0]);
    fill($('men-p'), cols, find(cols, /^men$/i) || find(cols, /m[ée]nage/i), true);
    if (!$('meta-source').value) $('meta-source').value = 'INSEE – carreaux 200 m (' + p.name + ')';
    $('step-p').classList.add('done');
    refreshRun();
  }

  document.querySelectorAll('[data-change]').forEach(b => b.addEventListener('click', () => {
    const k = b.dataset.change;
    state[k === 'c' ? 'circuits' : 'pop'] = null;
    $('drop-' + k).classList.remove('hidden');
    $('chip-' + k).classList.add('hidden');
    $('cols-' + k).classList.add('hidden');
    if (k === 'p') $('sheet-p').classList.add('hidden');
    if (k === 'c') $('step-p').classList.add('locked');
    $('step-' + (k === 'c' ? 'c' : 'p')).classList.remove('done');
    refreshRun();
  }));

  function refreshRun() {
    const ready = state.circuits && state.pop;
    $('btn-run').disabled = !ready;
    $('run-hint').textContent = ready ? 'Tout est prêt.' : (state.circuits ? 'Chargez maintenant la population.' : 'Chargez les circuits et la population pour commencer.');
  }

  // --- Étape 3 : format d'export ------------------------------------------------------------------------
  document.querySelectorAll('input[name=fmt]').forEach(r => r.addEventListener('change', () => {
    if (!r.checked) return;
    state.custom = r.value === 'custom';
    renderFormat();
    save();
    renderPreview();
  }));

  const FIELD_OPTIONS = () => Habitants.FIELDS.slice().reverse().map(f => `<option value="${f.key}">${esc(f.label)}</option>`).join('') +
    '<option value="">(colonne vide)</option><option value="=">= valeur fixe…</option>';

  function renderFormat() {
    $('fmt-custom').classList.toggle('hidden', !state.custom);
    if (!state.custom) return;
    $('fmt-rows').innerHTML = state.format.map((c, i) => `
      <div class="fmt-row" data-i="${i}">
        <input class="h" value="${esc(c.header)}" aria-label="En-tête">
        <select class="f" aria-label="Contenu">${FIELD_OPTIONS()}</select>
        <button class="btn ghost small x" title="Retirer la colonne" aria-label="Retirer">✕</button>
        <input class="v ${c.field === '' && c.fixed ? '' : 'hidden'}" value="${esc(c.fixed)}" placeholder="valeur fixe">
      </div>`).join('');
    $('fmt-rows').querySelectorAll('.fmt-row').forEach(row => {
      const c = state.format[+row.dataset.i];
      const sel = row.querySelector('.f');
      sel.value = c.field || (c.fixed ? '=' : '');
    });
  }

  $('fmt-rows').addEventListener('input', e => {
    const row = e.target.closest('.fmt-row');
    if (!row) return;
    const c = state.format[+row.dataset.i];
    if (e.target.classList.contains('h')) c.header = e.target.value;
    if (e.target.classList.contains('v')) c.fixed = e.target.value;
    save(); renderPreview();
  });
  $('fmt-rows').addEventListener('change', e => {
    const row = e.target.closest('.fmt-row');
    if (!row || !e.target.classList.contains('f')) return;
    const c = state.format[+row.dataset.i];
    const v = e.target.value;
    c.field = v === '=' ? '' : v;
    if (v !== '=') c.fixed = '';
    row.querySelector('.v').classList.toggle('hidden', v !== '=');
    save(); renderPreview();
  });
  $('fmt-rows').addEventListener('click', e => {
    const row = e.target.closest('.fmt-row');
    if (!row || !e.target.classList.contains('x')) return;
    state.format.splice(+row.dataset.i, 1);
    renderFormat(); save(); renderPreview();
  });
  $('btn-fmt-add').addEventListener('click', () => {
    state.format.push({ header: 'Nouvelle colonne', field: '', fixed: '' });
    renderFormat(); save(); renderPreview();
  });

  $('file-f').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const src = await IO.readFile(file);
      const headers = src.headers(src.sheetNames[0]).filter(h => !h.startsWith('__'));
      if (!headers.length) throw new Error('aucun en-tête trouvé sur la première ligne.');
      state.format = Habitants.formatFromHeaders(headers);
      renderFormat(); save(); renderPreview();
      const unknown = state.format.filter(c => !c.field).length;
      toast(`Modèle chargé : ${headers.length} colonnes` + (unknown ? `, dont ${unknown} à renseigner (laissées vides ou à associer à la main).` : '.'));
    } catch (err) {
      toast(`Impossible de lire le modèle : ${err.message}`, 'error');
    }
  });
  $('meta-source').addEventListener('input', () => { save(); renderPreview(); });

  // --- Calcul ---------------------------------------------------------------------------------------------
  $('btn-run').addEventListener('click', run);

  async function run() {
    $('empty').classList.add('hidden');
    $('results').classList.add('hidden');
    $('busy').classList.remove('hidden');
    $('busy-msg').textContent = 'Lecture des carreaux…';
    await tick();
    const t0 = Date.now();
    try {
      const { circuits, ignored } = Habitants.circuitsFromFeatures(state.circuits.features, state.circuits.crs, {
        idCol: $('id-c').value, nameCol: $('nom-c').value
      });
      if (!circuits.length) throw new Error('aucun circuit exploitable.');
      const opts = { popCol: $('pop-p').value, menCol: $('men-p').value, toNumber: IO.toNumber, window: Habitants.windowOf(circuits) };
      let loaded;
      if (state.pop.kind === 'geo') {
        loaded = Habitants.unitsFromFeatures(state.pop.features, state.pop.crs, opts);
      } else {
        if (!$('idcar-p').value) throw new Error('aucune colonne d\'identifiant de carreau.');
        const p = state.pop;
        loaded = Habitants.unitsFromRows(f => p.source.each(p.sheet, f), Object.assign({ idCol: $('idcar-p').value }, opts));
      }
      if (!loaded.read) throw new Error('aucun carreau lu : vérifiez la colonne d\'identifiant.');
      $('busy-msg').textContent = `${fmt(loaded.units.length)} carreaux autour des circuits…`;
      await tick();
      const rows = Habitants.computeAll(circuits, loaded.units, loaded.extent);
      state.result = { rows, circuits, units: loaded.units, extent: loaded.extent, read: loaded.read, invalid: loaded.invalid, ignored };
      state.selected = null;
      save();
      $('busy').classList.add('hidden');
      $('results').classList.remove('hidden');
      renderAll();
      toast(`Calcul terminé en ${((Date.now() - t0) / 1000).toFixed(1).replace('.', ',')} s.`);
    } catch (e) {
      console.error(e);
      $('busy').classList.add('hidden');
      $((state.result ? 'results' : 'empty')).classList.remove('hidden');
      toast(e.message, 'error');
    }
  }

  // --- Affichage ------------------------------------------------------------------------------------------------
  function renderAll() {
    const r = state.result;
    const tot = r.rows.reduce((a, x) => ({ h: a.h + x.habitants, m: a.m + x.menages, s: a.s + x.surface }), { h: 0, m: 0, s: 0 });
    const withAlert = r.rows.filter(x => x.alerts.length);
    $('context').textContent = `${state.circuits.name} × ${state.pop.name} · ${fmt(r.units.length)} carreaux retenus sur ${fmt(r.read)}`;
    $('kpis').innerHTML = [
      [fmt(tot.h), 'habitants (somme des circuits)', 'var(--accent)'],
      [fmt(r.rows.length), 'circuits', 'var(--c-seulB)'],
      [fmt1(tot.s) + ' km²', 'surface totale', 'var(--c-autre)'],
      [fmt(tot.s ? tot.h / tot.s : 0) + ' hab/km²', 'densité moyenne', 'var(--c-arret)'],
      [fmt(withAlert.length), 'circuit(s) à vérifier', 'var(--c-faible)']
    ].map(k => `<div class="kpi" style="--kc:${k[2]}"><div class="v">${esc(k[0])}</div><div class="l">${esc(k[1])}</div></div>`).join('');
    const notes = [];
    if (r.ignored) notes.push(`${r.ignored} entité(s) sans polygone ignorée(s).`);
    if (r.invalid) notes.push(`${fmt(r.invalid)} ligne(s) de population sans identifiant de carreau valide.`);
    withAlert.forEach(x => notes.push(`<b>${esc(x.id)}</b> : ${esc(x.alerts.join(' · '))}`));
    $('warnings').innerHTML = notes.length ? '<b>À vérifier</b><ul>' + notes.slice(0, 12).map(n => `<li>${n}</li>`).join('') + (notes.length > 12 ? `<li>… et ${notes.length - 12} autre(s)</li>` : '') + '</ul>' : '';
    $('warnings').classList.toggle('hidden', !notes.length);
    renderTable();
    renderPreview();
    drawMap();
  }

  const COLS = [
    ['id', 'Code', false, x => esc(x.id)],
    ['name', 'Libellé', false, x => esc(x.name)],
    ['habitants', 'Habitants', true, x => fmt(x.habitants)],
    ['menages', 'Ménages', true, x => fmt(x.menages)],
    ['surface', 'Surface (km²)', true, x => fmt2(x.surface)],
    ['densite', 'Densité (hab/km²)', true, x => fmt(x.densite)],
    ['carreaux', 'Carreaux', true, x => fmt(x.carreaux)],
    ['couverture', 'Couverture', true, x => Math.round(x.couverture * 100) + ' %'],
    ['alerts', 'Alerte', false, x => x.alerts.length ? `<span class="warn">⚠ ${esc(x.alerts[0])}</span>` : '']
  ];

  function renderTable() {
    const q = $('search').value.trim().toLowerCase();
    const { key, dir } = state.sort;
    const rows = state.result.rows.map((x, i) => [x, i]).filter(([x]) => !q || (x.id + ' ' + x.name).toLowerCase().includes(q));
    rows.sort((a, b) => {
      const va = key === 'alerts' ? a[0].alerts.length : a[0][key], vb = key === 'alerts' ? b[0].alerts.length : b[0][key];
      return (typeof va === 'string' ? va.localeCompare(vb, 'fr', { numeric: true }) : va - vb) * dir;
    });
    $('table').innerHTML = '<thead><tr>' + COLS.map(c => `<th data-k="${c[0]}" class="${c[2] ? 'n ' : ''}${c[0] === key ? 'sorted' + (dir > 0 ? ' asc' : '') : ''}">${c[1]}</th>`).join('') + '</tr></thead><tbody>' +
      rows.map(([x, i]) => `<tr data-i="${i}" class="${state.selected === i ? 'active' : ''}">` + COLS.map(c => `<td class="${c[2] ? 'n' : ''}">${c[3](x)}</td>`).join('') + '</tr>').join('') + '</tbody>';
  }
  $('search').addEventListener('input', () => state.result && renderTable());
  $('table').addEventListener('click', e => {
    const th = e.target.closest('th');
    if (th) {
      const k = th.dataset.k;
      state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : (k === 'id' || k === 'name' ? 1 : -1) };
      return renderTable();
    }
    const tr = e.target.closest('tbody tr');
    if (tr) select(+tr.dataset.i, true);
  });

  // Aperçu de l'export : exactement ce qui sera écrit dans le fichier.
  const activeFormat = () => state.custom ? state.format : Habitants.standardFormat();
  function exportTable() {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    return Habitants.buildTable(state.result.rows, activeFormat(), { source: $('meta-source').value, date: `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}` });
  }
  function renderPreview() {
    if (!state.result) return;
    const t = exportTable();
    $('preview').innerHTML = `<div class="table-scroll"><table class="mini"><thead><tr>${t.header.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>` +
      t.lines.slice(0, 6).map(l => `<tr>${l.map(v => `<td>${esc(v)}</td>`).join('')}</tr>`).join('') + '</tbody></table></div>' +
      `<p class="note">${t.lines.length > 6 ? `6 premières lignes sur ${t.lines.length}. ` : ''}${state.custom ? 'Format : mon modèle.' : 'Format standard.'}</p>`;
  }

  // --- Exports -----------------------------------------------------------------------------------------------------
  const stamp = () => new Date().toISOString().slice(0, 10);
  const csvValue = v => typeof v === 'number' && !Number.isInteger(v) ? String(v).replace('.', ',') : v;

  $('btn-csv').addEventListener('click', () => {
    const t = exportTable();
    IO.download(`habitants_circuits_${stamp()}.csv`, IO.toCSV(t.header, t.lines.map(l => l.map(csvValue))), 'text/csv;charset=utf-8');
    save();
  });
  $('btn-xlsx').addEventListener('click', () => {
    const t = exportTable();
    const ws = XLSX.utils.aoa_to_sheet([t.header].concat(t.lines));
    ws['!cols'] = t.header.map((h, i) => ({ wch: Math.min(40, Math.max(String(h).length, ...t.lines.slice(0, 50).map(l => String(l[i]).length)) + 2) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Habitants');
    XLSX.writeFile(wb, `habitants_circuits_${stamp()}.xlsx`);
    save();
  });
  $('btn-geojson').addEventListener('click', () => {
    const r = state.result;
    const gj = {
      type: 'FeatureCollection',
      features: r.circuits.map((c, i) => ({
        type: 'Feature',
        properties: {
          code: r.rows[i].id, libelle: r.rows[i].name, habitants: r.rows[i].habitants, menages: r.rows[i].menages,
          surface_km2: Math.round(r.rows[i].surface * 1000) / 1000, densite: Math.round(r.rows[i].densite), couverture: Math.round(r.rows[i].couverture * 100)
        },
        geometry: geometryOf(c)
      }))
    };
    IO.download(`habitants_circuits_${stamp()}.geojson`, JSON.stringify(gj), 'application/geo+json');
  });

  // --- Carte -------------------------------------------------------------------------------------------------------------
  let map, layer, cellLayer, legend;
  const polys = new Map();
  const toLL = Habitants.transform(Habitants.WORK, 'EPSG:4326');
  const RAMP = ['#d7efe9', '#9bd6c9', '#56b8a6', '#1f8f7e', '#0b5f53'];

  function geometryOf(c) {
    const parts = c.parts.map(p => p.map(ring => { const r = ring.map(toLL); r.push(r[0]); return r; }));
    return parts.length === 1 ? { type: 'Polygon', coordinates: parts[0] } : { type: 'MultiPolygon', coordinates: parts };
  }

  function initMap() {
    if (map) return;
    map = L.map('map', { preferCanvas: false });
    const ign = (id, f) => L.tileLayer(
      'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&STYLE=normal&TILEMATRIXSET=PM' +
      `&LAYER=${id}&FORMAT=${f}&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}`, { maxZoom: 19, attribution: '© IGN-F/Géoplateforme' });
    const bases = {
      'Plan IGN (gris)': ign('GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2', 'image/png'),
      'Photos aériennes IGN': ign('ORTHOIMAGERY.ORTHOPHOTOS', 'image/jpeg'),
      'OpenStreetMap': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© contributeurs OpenStreetMap' })
    };
    bases['Plan IGN (gris)'].addTo(map);
    L.control.layers(bases, null, { position: 'topright' }).addTo(map);
    L.control.scale({ imperial: false }).addTo(map);
    layer = L.featureGroup().addTo(map);
    cellLayer = L.featureGroup().addTo(map);
    legend = L.control({ position: 'bottomleft' });
    legend.onAdd = () => L.DomUtil.create('div', 'legend');
    legend.addTo(map);
    map.setView([46.6, 2.4], 6);
  }

  function colorOf(x, breaks) {
    let k = 0;
    while (k < breaks.length && x.densite > breaks[k]) k++;
    return RAMP[k];
  }

  function drawMap() {
    initMap();
    layer.clearLayers(); cellLayer.clearLayers(); polys.clear();
    const r = state.result;
    const d = r.rows.map(x => x.densite).sort((a, b) => a - b);
    const breaks = [0.2, 0.4, 0.6, 0.8].map(q => d[Math.min(d.length - 1, Math.floor(q * d.length))]);
    r.circuits.forEach((c, i) => {
      const x = r.rows[i];
      const p = L.geoJSON(geometryOf(c), { style: { color: '#16191d', weight: 1.5, fillColor: colorOf(x, breaks), fillOpacity: .55 } }).addTo(layer);
      p.bindTooltip(`<b>${esc(x.id)}</b>${x.name ? ' · ' + esc(x.name) : ''}<br>${fmt(x.habitants)} habitants · ${fmt(x.densite)} hab/km²`, { sticky: true });
      p.on('click', () => select(i, false));
      polys.set(i, p);
    });
    const lo = [Math.min(...d), ...breaks, Math.max(...d)];
    legend.getContainer().innerHTML = '<b>Densité (hab/km²)</b><br>' + RAMP.map((c, k) => `<i style="background:${c}"></i>${fmt(lo[k])} – ${fmt(lo[k + 1])}<br>`).join('');
    setTimeout(() => { map.invalidateSize(); if (layer.getBounds().isValid()) map.fitBounds(layer.getBounds(), { padding: [20, 20] }); }, 50);
  }

  // Sélection : met en évidence le circuit et affiche les carreaux qui ont servi au calcul.
  function select(i, zoom) {
    state.selected = i;
    cellLayer.clearLayers();
    polys.forEach((p, k) => p.setStyle({ weight: k === i ? 3.5 : 1.5, color: k === i ? '#e34948' : '#16191d' }));
    const c = state.result.circuits[i];
    const x = state.result.rows[i];
    const max = Math.max(1, ...state.result.units.filter(u => u.bbox[0] < c.bbox[2] && u.bbox[2] > c.bbox[0] && u.bbox[1] < c.bbox[3] && u.bbox[3] > c.bbox[1]).map(u => u.pop));
    Habitants.computeCircuit(c, state.result.units, state.result.extent, (u, frac) => {
      const ring = u.ring.map(toLL).map(q => [q[1], q[0]]);
      L.polygon(ring, { color: '#0b5f53', weight: 1, fillColor: '#eda100', fillOpacity: .15 + .55 * Math.min(1, u.pop / max), dashArray: frac < .999 ? '4 3' : null })
        .bindTooltip(`${fmt(u.pop)} hab. × ${Math.round(frac * 100)} % = ${fmt1(u.pop * frac)}`).addTo(cellLayer);
    });
    polys.get(i).bringToFront();
    if (zoom) map.fitBounds(polys.get(i).getBounds(), { padding: [30, 30] });
    $('map-hint').textContent = `${x.id} : ${fmt(x.habitants)} habitants · carreaux en jaune (pointillés = partiellement dans le circuit)`;
    renderTable();
    $('map-card').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  $('btn-map-size').addEventListener('click', () => {
    const big = $('map-card').classList.toggle('big');
    $('btn-map-size').textContent = big ? '⤡ Réduire' : '⤢ Agrandir';
    setTimeout(() => map.invalidateSize(), 50);
  });

  // --- Exemple -----------------------------------------------------------------------------------------------------------------
  function demo() {
    const d = HabitantsDemo.build();
    const features = d.circuits.features;
    setCircuits({ name: 'circuits_exemple.geojson', features, crs: 'EPSG:4326', columns: ['code_circuit', 'libelle'], polygons: features.length });
    $('id-c').value = 'code_circuit'; $('nom-c').value = 'libelle';
    const source = IO.arraySource({ carreaux: d.rows });
    source.name = 'carreaux_exemple.csv';
    state.popSource = source;
    showPopSheet('carreaux');
    $('meta-source').value = 'Données fictives (exemple)';
    run();
  }
  $('btn-demo').addEventListener('click', demo);
  document.querySelector('[data-demo]').addEventListener('click', demo);

  loadSaved();
  renderFormat();
})();
