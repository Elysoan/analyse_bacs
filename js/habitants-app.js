/*
 * Interface « Habitants par circuit ». Deux façons de définir un circuit :
 *  - polygone (GeoJSON) : habitants des carreaux INSEE au prorata des surfaces ;
 *  - tournée en tronçons (XML / ZIP) : adresses situées dans une bande du côté collecté, pondérées par les carreaux.
 * Puis carte, tableau et export selon un format (standard ou calqué sur un fichier modèle).
 */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const esc = s => String(s === undefined || s === null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmt = n => Number(n).toLocaleString('fr-FR', { maximumFractionDigits: 0 });
  const fmt1 = n => Number(n).toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const fmt2 = n => Number(n).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const tick = () => new Promise(r => setTimeout(r, 30));
  const STORE = 'habitants.format.v1';

  const state = {
    mode: 'polygon',  // 'polygon' | 'troncons'
    circuits: null,   // polygones : { name, features, crs, columns, polygons }
    tournees: null,   // tronçons : { names, list }
    sectors: null,    // secteurs complémentaires : { name, features, crs, columns }
    addr: null,       // adresses : { name, source, sheet, columns, rows, count }
    pop: null,        // carreaux : { name, kind: 'table' | 'geo', source / features, crs, columns, sheet }
    format: Habitants.standardFormat(),
    custom: false,
    hasSaved: false,
    result: null,
    sort: { key: 'habitants', dir: -1 },
    selected: null
  };
  const isT = () => state.mode === 'troncons';

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
        state.format = s.format; state.hasSaved = true;
        $('meta-source').value = s.source || '';
        state.custom = !!s.custom;
        document.querySelector(`input[name=fmt][value=${state.custom ? 'custom' : 'standard'}]`).checked = true;
      }
    } catch (e) { /* stockage indisponible : on garde le format standard */ }
  }
  function save() {
    if (!state.custom && !state.hasSaved) return;
    state.hasSaved = true;
    try { localStorage.setItem(STORE, JSON.stringify({ custom: state.custom, format: state.format, source: $('meta-source').value })); } catch (e) { /* ignoré */ }
  }

  $('btn-help').addEventListener('click', () => $('help').showModal());
  $('help').addEventListener('click', e => { if (e.target === $('help') || e.target.hasAttribute('data-close')) $('help').close(); });

  // --- Utilitaires de formulaire ---------------------------------------------------------------------
  function fill(sel, cols, selected, optional) {
    sel.innerHTML = (optional ? '<option value="">(aucune)</option>' : '') + cols.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
    sel.value = selected && cols.includes(selected) ? selected : (optional ? '' : cols[0] || '');
  }
  const find = (cols, re) => cols.find(c => re.test(c)) || '';

  function wireDrop(key, handler) {
    const drop = $('drop-' + key);
    $('file-' + key).addEventListener('change', e => { if (e.target.files.length) handler(Array.from(e.target.files), drop); e.target.value = ''; });
    ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, () => drop.classList.remove('over')));
    drop.addEventListener('drop', e => { e.preventDefault(); if (e.dataTransfer.files.length) handler(Array.from(e.dataTransfer.files), drop); });
  }

  async function guarded(files, drop, work) {
    const size = files.reduce((s, f) => s + f.size, 0);
    drop.classList.add('loading');
    drop.querySelector('b').textContent = size > 10e6 ? `Lecture de ${files[0].name} (gros fichier, patientez)` : 'Lecture de ' + files[0].name;
    await tick();
    try { await work(); }
    catch (err) { toast(`Impossible de lire ${files[0].name} : ${err.message}`, 'error'); }
    finally { drop.classList.remove('loading'); drop.querySelector('b').textContent = 'Déposer le fichier ici'; }
  }

  function decodeBuffer(buffer) { return Tournees.decodeText(new Uint8Array(buffer)); }

  async function readGeoJSON(file) {
    const gj = JSON.parse(decodeBuffer(await file.arrayBuffer()));
    const features = gj.type === 'FeatureCollection' ? gj.features : (gj.type === 'Feature' ? [gj] : []);
    if (!features.length) throw new Error('GeoJSON sans entités (FeatureCollection attendue).');
    return { features, crs: Habitants.geojsonCRS(gj, features) };
  }
  const isGeo = file => /\.(geojson|json)$/i.test(file.name);

  async function gunzip(file) {
    if (!/\.gz$/i.test(file.name)) return file;
    const blob = await new Response(file.stream().pipeThrough(new DecompressionStream('gzip'))).blob();
    return new File([blob], file.name.replace(/\.gz$/i, ''));
  }

  // --- Étape 1 : circuits (polygones) ou tournées (tronçons) ------------------------------------------
  wireDrop('c', (files, drop) => guarded(files, drop, async () => {
    const xml = [];
    for (const f of files) {
      if (/\.xml$/i.test(f.name)) xml.push({ name: f.name, text: decodeBuffer(await f.arrayBuffer()) });
      else if (/\.zip$/i.test(f.name)) {
        for (const e of await Tournees.unzip(await f.arrayBuffer())) {
          if (/\.xml$/i.test(e.name) && !/(^|\/)(__MACOSX|\.)/.test(e.name)) xml.push({ name: e.name.split('/').pop(), text: Tournees.decodeText(e.bytes) });
        }
      }
    }
    if (xml.length) return setTournees(xml);
    const file = files.find(isGeo);
    if (!file) throw new Error('un GeoJSON de polygones, un XML ou un ZIP de tournées est attendu.');
    const { features, crs } = await readGeoJSON(file);
    const polys = features.filter(f => f.geometry && /Polygon/.test(f.geometry.type));
    if (!polys.length) throw new Error('aucun polygone : pour des tracés en ligne, utilisez le XML de tournée ou créez un tampon dans ArcGIS Pro.');
    setCircuits({ name: file.name, features, crs, columns: IO.columnsOf(features.map(f => f.properties || {})), polygons: polys.length });
    if (polys.length < features.length) toast(`${features.length - polys.length} entité(s) sans polygone ignorée(s).`);
  }));

  function setMode(mode) {
    state.mode = mode;
    $('step-a').classList.toggle('hidden', mode !== 'troncons');
    $('troncon-opts').classList.toggle('hidden', mode !== 'troncons');
    $('cols-c').classList.toggle('hidden', mode !== 'polygon' || !state.circuits);
    $('num-p').textContent = mode === 'troncons' ? '3' : '2';
    $('num-f').textContent = mode === 'troncons' ? '4' : '3';
    $('sub-p').textContent = mode === 'troncons' ? 'Carreaux INSEE 200 m (facultatif : pondère les adresses)' : 'Carreaux INSEE de 200 m';
    if (!state.custom && !state.hasSaved) state.format = Habitants.standardFormat(mode === 'troncons');
  }

  function lockSteps() {
    const have = isT() ? state.tournees : state.circuits;
    $('step-p').classList.toggle('locked', !have);
    $('step-a').classList.toggle('locked', !state.tournees);
  }

  function setCircuits(c) {
    state.circuits = c; state.tournees = null;
    setMode('polygon');
    $('drop-c').classList.add('hidden');
    $('chip-c').classList.remove('hidden');
    $('name-c').textContent = c.name;
    $('info-c').textContent = `${fmt(c.polygons)} circuit${c.polygons > 1 ? 's' : ''} · ${IO.CRS[c.crs] || c.crs}`;
    $('cols-c').classList.remove('hidden');
    fill($('id-c'), c.columns, find(c.columns, /^(code|id|n°|num)[ _a-z]*circuit|circuit.*(code|id|num)|^code|^id$|tourn/i) || c.columns[0]);
    fill($('nom-c'), c.columns, find(c.columns, /lib[ée]ll?[ée]|^nom|name|d[ée]signation/i), true);
    $('step-c').classList.add('done');
    lockSteps(); refreshRun();
  }

  function setTournees(xmlFiles) {
    const list = [], errors = [];
    for (const f of xmlFiles) {
      try { list.push(Tournees.project(Tournees.parseXML(f.text, f.name))); }
      catch (e) { errors.push(`${f.name} : ${e.message}`); }
    }
    if (!list.length) throw new Error(errors[0] || 'aucune tournée lisible.');
    if (errors.length) toast(`${errors.length} fichier(s) ignoré(s) : ${errors[0]}`, 'error');
    state.tournees = { list, name: list.length === 1 ? list[0].file : `${list.length} tournées` };
    state.circuits = null;
    setMode('troncons');
    const km = list.reduce((s, t) => s + t.troncons.filter(x => x.side).reduce((a, x) => a + x.dist, 0), 0) / 1000;
    $('drop-c').classList.add('hidden');
    $('chip-c').classList.remove('hidden');
    $('name-c').textContent = state.tournees.name;
    $('info-c').textContent = `${fmt(list.reduce((s, t) => s + t.troncons.length, 0))} tronçons · ${fmt1(km)} km collectés`;
    $('step-c').classList.add('done');
    renderModes();
    lockSteps(); refreshRun();
  }

  // Mode de collecte (sac / bac) -> taux de présentation, par tournée
  const modeOptions = sel => Object.keys(Tournees.MODES).map(k => `<option value="${k}"${k === sel ? ' selected' : ''}>${esc(Tournees.MODES[k].label)}</option>`).join('');
  function renderModes() {
    const list = state.tournees.list;
    $('modes').innerHTML = '<b>Mode de collecte et taux de présentation</b>' +
      (list.length > 1 ? `<div class="mrow"><span>Toutes</span><select id="mode-all"><option value="">— choisir —</option>${modeOptions('')}</select><span></span></div>` : '') +
      '<div class="mlist">' + list.map((t, i) => `<div class="mrow" data-i="${i}"><span title="${esc(t.name)}">${esc(t.code)}</span><select class="m">${modeOptions(t.mode)}</select><input class="t" type="number" min="1" max="100" step="1" value="${Math.round(t.taux * 100)}" title="Taux de présentation (%)"></div>`).join('') + '</div>' +
      '<p class="hint">Sac = 100 %, bac en TEOM ou REOM fixe = 85 %.</p>';
  }
  function setModeOf(t, mode) { t.mode = mode; if (mode !== 'autre') t.taux = Tournees.MODES[mode].taux; }
  $('modes').addEventListener('change', e => {
    const list = state.tournees.list;
    if (e.target.id === 'mode-all') {
      if (!e.target.value) return;
      list.forEach(t => setModeOf(t, e.target.value));
      renderModes();
    } else {
      const row = e.target.closest('.mrow'), t = list[+row.dataset.i];
      if (e.target.classList.contains('m')) { setModeOf(t, e.target.value); row.querySelector('.t').value = Math.round(t.taux * 100); }
      else { t.taux = Math.max(0.01, Math.min(1, (+e.target.value || 100) / 100)); t.mode = 'autre'; row.querySelector('.m').value = 'autre'; }
    }
    if (state.result && state.result.mode === 'troncons') refreshSummaries();
  });
  const kgPerPerson = () => +String($('kg').value).replace(',', '.') || 0;
  function refreshSummaries() {
    const r = state.result;
    r.rows = r.tournees.map((t, i) => Object.assign(Tournees.summarize(t, r.served[i], r.weights, r.communes, { kgPerPerson: kgPerPerson() }), { sectors: r.rows[i].sectors }));
    renderAll();
  }
  $('kg').addEventListener('change', () => { if (state.result && state.result.mode === 'troncons') refreshSummaries(); });

  // Secteurs complémentaires (facultatif)
  $('file-s').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const { features, crs } = await readGeoJSON(file);
      const polys = features.filter(f => f.geometry && /Polygon/.test(f.geometry.type));
      if (!polys.length) throw new Error('aucun polygone.');
      const columns = IO.columnsOf(features.map(f => f.properties || {}));
      state.sectors = { name: file.name, features: polys, crs, columns };
      $('info-s').textContent = `${file.name} : ${polys.length} secteur(s)`;
      $('cols-s').classList.remove('hidden');
      fill($('id-s'), columns, find(columns, /tourn|circuit|^code/i), true);
    } catch (err) { toast(`Secteurs illisibles : ${err.message}`, 'error'); }
  });

  // --- Étape 2 (tronçons) : adresses ------------------------------------------------------------------------
  wireDrop('a', (files, drop) => guarded(files, drop, async () => {
    const file = await gunzip(files[0]);
    const source = await IO.readFile(file);
    source.name = file.name;
    state.addrSource = source;
    showAddrSheet(source.sheetNames[0]);
  }));
  $('sheet-a').querySelector('select').addEventListener('change', e => showAddrSheet(e.target.value));

  function showAddrSheet(sheet) {
    const source = state.addrSource;
    const sel = $('sheet-a').querySelector('select');
    $('sheet-a').classList.toggle('hidden', source.sheetNames.length < 2);
    sel.innerHTML = source.sheetNames.map(s => `<option>${esc(s)}</option>`).join('');
    sel.value = sheet;
    const columns = source.headers(sheet);
    const rows = source.preview(sheet);
    // La BAN fournit lon/lat et x/y (Lambert 93) : on préfère lon/lat, valables hors métropole.
    let xy = columns.includes('lon') && columns.includes('lat') ? { x: 'lon', y: 'lat' } : IO.guessXY(columns);
    state.addr = { name: source.name, source, sheet, columns, rows, count: source.count(sheet) };
    $('drop-a').classList.add('hidden');
    $('chip-a').classList.remove('hidden');
    $('name-a').textContent = source.name;
    $('info-a').textContent = `${fmt(state.addr.count)} adresses`;
    $('cols-a').classList.remove('hidden');
    fill($('x-a'), columns, xy.x); fill($('y-a'), columns, xy.y);
    $('crs-a').innerHTML = Object.keys(IO.CRS).map(k => `<option value="${k}">${esc(IO.CRS[k])}</option>`).join('');
    $('crs-a').value = xy.x && xy.y ? IO.guessCRS(rows, xy.x, xy.y) : 'EPSG:4326';
    fill($('commune-a'), columns, find(columns, /^nom_commune$/i) || find(columns, /commune/i), true);
    if (!$('meta-source').value) $('meta-source').value = 'BAN (' + source.name + ')';
    $('step-a').classList.add('done');
    refreshRun();
  }

  // --- Étape 2 (polygones) / 3 (tronçons) : population -----------------------------------------------------
  wireDrop('p', (files, drop) => guarded(files, drop, async () => {
    const file = files[0];
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
    setPop({ name: source.name, kind: 'table', source, sheet, columns: source.headers(sheet), rows: source.preview(sheet), count: source.count(sheet) });
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
      $('hint-p').textContent = isT() ? 'Les adresses ont besoin de carreaux (CSV) : cette couche de polygones sera ignorée.' : 'Couche de polygones : la population est répartie au prorata des surfaces.';
      $('hint-p').className = 'hint' + (isT() ? ' ko' : '');
    }
    fill($('pop-p'), cols, find(cols, /^ind$/i) || find(cols, /habitant|population|^pop|^ind[_ ]?\w*$/i) || cols[0]);
    fill($('men-p'), cols, find(cols, /^men$/i) || find(cols, /m[ée]nage/i), true);
    if (!$('meta-source').value) $('meta-source').value = 'INSEE – carreaux 200 m (' + p.name + ')';
    $('step-p').classList.add('done');
    refreshRun();
  }

  document.querySelectorAll('[data-change]').forEach(b => b.addEventListener('click', () => {
    const k = b.dataset.change;
    if (k === 'c') { state.circuits = null; state.tournees = null; $('cols-c').classList.add('hidden'); setMode('polygon'); }
    if (k === 'p') { state.pop = null; $('sheet-p').classList.add('hidden'); $('cols-p').classList.add('hidden'); }
    if (k === 'a') { state.addr = null; $('sheet-a').classList.add('hidden'); $('cols-a').classList.add('hidden'); }
    $('drop-' + k).classList.remove('hidden');
    $('chip-' + k).classList.add('hidden');
    $('step-' + k).classList.remove('done');
    lockSteps(); refreshRun();
  }));

  function refreshRun() {
    const ready = isT() ? state.tournees && state.addr : state.circuits && state.pop;
    $('btn-run').disabled = !ready;
    $('run-hint').textContent = ready ? 'Tout est prêt.' :
      (isT() ? (state.addr ? '' : 'Chargez maintenant les adresses.') : (state.circuits ? 'Chargez maintenant la population.' : 'Chargez les circuits pour commencer.'));
  }

  // --- Format d'export ------------------------------------------------------------------------------------------
  const activeFormat = () => state.custom ? state.format : Habitants.standardFormat(isT(), kgPerPerson() > 0);

  document.querySelectorAll('input[name=fmt]').forEach(r => r.addEventListener('change', () => {
    if (!r.checked) return;
    state.custom = r.value === 'custom';
    if (state.custom && !state.hasSaved) state.format = Habitants.standardFormat(isT());
    renderFormat(); save(); renderPreview();
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
      row.querySelector('.f').value = c.field || (c.fixed ? '=' : '');
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
      state.hasSaved = true;
      renderFormat(); save(); renderPreview();
      const unknown = state.format.filter(c => !c.field).length;
      toast(`Modèle chargé : ${headers.length} colonnes` + (unknown ? `, dont ${unknown} à renseigner (laissées vides ou à associer à la main).` : '.'));
    } catch (err) {
      toast(`Impossible de lire le modèle : ${err.message}`, 'error');
    }
  });
  $('meta-source').addEventListener('input', () => { save(); renderPreview(); });

  // --- Calcul ----------------------------------------------------------------------------------------------------------
  $('btn-run').addEventListener('click', run);

  async function run() {
    $('empty').classList.add('hidden');
    $('results').classList.add('hidden');
    $('busy').classList.remove('hidden');
    $('busy-msg').textContent = 'Lecture des fichiers…';
    await tick();
    const t0 = Date.now();
    try {
      state.result = isT() ? await runTroncons() : await runPolygons();
      state.selected = null;
      state.sort = { key: 'habitants', dir: -1 };
      save();
      $('busy').classList.add('hidden');
      $('results').classList.remove('hidden');
      renderAll();
      toast(`Calcul terminé en ${((Date.now() - t0) / 1000).toFixed(1).replace('.', ',')} s.`);
    } catch (e) {
      console.error(e);
      $('busy').classList.add('hidden');
      $(state.result ? 'results' : 'empty').classList.remove('hidden');
      toast(e.message, 'error');
    }
  }

  function popOptions(win) {
    return { popCol: $('pop-p').value, menCol: $('men-p').value, toNumber: IO.toNumber, window: win };
  }

  async function runPolygons() {
    const { circuits, ignored } = Habitants.circuitsFromFeatures(state.circuits.features, state.circuits.crs, {
      idCol: $('id-c').value, nameCol: $('nom-c').value
    });
    if (!circuits.length) throw new Error('aucun circuit exploitable.');
    const opts = popOptions(Habitants.windowOf(circuits));
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
    return { mode: 'polygon', rows, circuits, units: loaded.units, extent: loaded.extent, read: loaded.read, invalid: loaded.invalid, ignored };
  }

  async function runTroncons() {
    const list = state.tournees.list;
    const width = Math.max(1, +$('width').value || 30), perAddr = +$('per-addr').value || 2.2;
    const win = Tournees.windowOf(list, width + 1000);
    if (!isFinite(win[0])) throw new Error('aucun tronçon avec tracé.');

    // Adresses : lues en flux, seules celles proches des tournées sont conservées.
    const a = state.addr, cx = $('x-a').value, cy = $('y-a').value, cc = $('commune-a').value;
    if (!cx || !cy) throw new Error('colonnes de coordonnées des adresses non définies.');
    const toWork = Habitants.transform($('crs-a').value, Habitants.WORK);
    const pts = [], communes = [];
    let read = 0, bad = 0;
    a.source.each(a.sheet, row => {
      const x = IO.toNumber(row[cx]), y = IO.toNumber(row[cy]);
      if (!Number.isFinite(x) || !Number.isFinite(y) || (x === 0 && y === 0)) { bad++; return; }
      let p;
      try { p = toWork([x, y]); } catch (e) { bad++; return; }
      if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) { bad++; return; }
      read++;
      if (p[0] < win[0] || p[0] > win[2] || p[1] < win[1] || p[1] > win[3]) return;
      pts.push({ x: p[0], y: p[1] });
      communes.push(cc ? String(row[cc] === undefined || row[cc] === null ? '' : row[cc]).trim() : '');
    });
    if (!pts.length) throw new Error('aucune adresse près des tournées : vérifiez le fichier (département) et le système de coordonnées.');
    $('busy-msg').textContent = `${fmt(pts.length)} adresses autour des tournées…`;
    await tick();

    // Population : carreaux INSEE (facultatif)
    let units = null, popNote = '';
    const p = state.pop;
    if (p && p.kind === 'table' && $('idcar-p').value) {
      const loaded = Habitants.unitsFromRows(f => p.source.each(p.sheet, f), Object.assign({ idCol: $('idcar-p').value }, popOptions(win)));
      units = loaded.units;
      if (!units.length) popNote = 'Aucun carreau INSEE autour des tournées : habitants calculés avec le nombre fixe par adresse.';
    } else if (p && p.kind === 'geo') popNote = 'Couche de polygones ignorée : des carreaux INSEE (CSV) sont nécessaires.';
    const weights = Tournees.weigh(pts, units && units.length ? units : null, perAddr);

    // Secteurs complémentaires, par tournée
    let sectorCircuits = [];
    if (state.sectors) sectorCircuits = Habitants.circuitsFromFeatures(state.sectors.features, state.sectors.crs, {}).circuits;
    const sectorCol = state.sectors ? $('id-s').value : '';
    const index = Tournees.indexPoints(pts);
    const served = [], rows = [];
    for (const tn of list) {
      const sec = sectorCircuits.filter(c => !sectorCol || String(c.props[sectorCol]).trim().toLowerCase() === String(tn.code).toLowerCase());
      const s = Tournees.serve(tn, pts, index, width, [].concat(...sec.map(c => c.parts)));
      served.push(s);
      rows.push(Tournees.summarize(tn, s, weights, communes, { kgPerPerson: kgPerPerson() }));
      rows[rows.length - 1].sectors = sec;
    }
    return { mode: 'troncons', rows, tournees: list, pts, communes, served, weights, width, perAddr, read, bad, kept: pts.length, popNote, sectorCircuits };
  }

  // --- Affichage ---------------------------------------------------------------------------------------------------------
  function renderAll() {
    const r = state.result;
    const T = r.mode === 'troncons';
    $('btn-communes').classList.toggle('hidden', !T);
    $('btn-addr-geojson').classList.toggle('hidden', !T);
    $('btn-geojson').textContent = T ? '⭳ Tronçons (GeoJSON)' : '⭳ GeoJSON';
    const withAlert = r.rows.filter(x => x.alerts.length);
    const notes = [];
    let kpis;
    if (T) {
      const tot = r.rows.reduce((a, x) => ({ h: a.h + x.habitants, hc: a.hc + x.habCollectes, adr: a.adr + x.adresses, kc: a.kc + x.kmCollecte, kh: a.kh + x.kmHlp, kg: a.kg + (x.production || 0) }), { h: 0, hc: 0, adr: 0, kc: 0, kh: 0, kg: 0 });
      $('context').textContent = `${state.tournees.name} × ${state.addr.name}${state.pop && !r.popNote ? ' × ' + state.pop.name : ''} · ${fmt(r.kept)} adresses retenues autour des tournées · bande de ${r.width} m`;
      kpis = [
        [fmt(tot.h), 'habitants desservis (estimation)', 'var(--accent)'],
        [fmt(tot.hc), 'habitants collectés (estim., × taux de présentation)', 'var(--c-seulB)'],
        ...(kgPerPerson() > 0 ? [[fmt(tot.kg) + ' kg', 'par passage (estimation)', 'var(--c-recent)']] : []),
        [fmt(tot.adr), 'adresses desservies', 'var(--c-seulB)'],
        [fmt1(tot.kc) + ' km', `de collecte, + ${fmt1(tot.kh)} km haut le pied`, 'var(--c-autre)'],
        [fmt(tot.kc ? tot.h / tot.kc : 0) + ' hab/km', 'par km collecté', 'var(--c-arret)'],
        [fmt(withAlert.length), 'tournée(s) à vérifier', 'var(--c-faible)']
      ];
      notes.push(r.weights.mode === 'carreaux'
        ? 'Habitants par adresse : population du carreau INSEE ÷ nombre d\'adresses du carreau.'
        : `Habitants par adresse : valeur fixe (${String(r.perAddr).replace('.', ',')}), faute de carreaux INSEE.`);
      if (r.popNote) notes.push(r.popNote);
      if (r.weights.orphanPop > 0) notes.push(`${fmt(r.weights.orphanPop)} habitants de carreaux sans aucune adresse ne sont attribués à personne.`);
      if (r.bad) notes.push(`${fmt(r.bad)} adresse(s) sans coordonnées valides ignorée(s).`);
    } else {
      const tot = r.rows.reduce((a, x) => ({ h: a.h + x.habitants, s: a.s + x.surface }), { h: 0, s: 0 });
      $('context').textContent = `${state.circuits.name} × ${state.pop.name} · ${fmt(r.units.length)} carreaux retenus sur ${fmt(r.read)}`;
      kpis = [
        [fmt(tot.h), 'habitants (somme des circuits)', 'var(--accent)'],
        [fmt(r.rows.length), 'circuits', 'var(--c-seulB)'],
        [fmt1(tot.s) + ' km²', 'surface totale', 'var(--c-autre)'],
        [fmt(tot.s ? tot.h / tot.s : 0) + ' hab/km²', 'densité moyenne', 'var(--c-arret)'],
        [fmt(withAlert.length), 'circuit(s) à vérifier', 'var(--c-faible)']
      ];
      if (r.ignored) notes.push(`${r.ignored} entité(s) sans polygone ignorée(s).`);
      if (r.invalid) notes.push(`${fmt(r.invalid)} ligne(s) de population sans identifiant de carreau valide.`);
    }
    $('kpis').innerHTML = kpis.map(k => `<div class="kpi" style="--kc:${k[2]}"><div class="v">${esc(k[0])}</div><div class="l">${esc(k[1])}</div></div>`).join('');
    withAlert.forEach(x => notes.push(`<b>${esc(x.id)}</b> : ${esc(x.alerts.join(' · '))}`));
    $('warnings').innerHTML = notes.length ? '<b>À savoir / à vérifier</b><ul>' + notes.slice(0, 12).map(n => `<li>${n}</li>`).join('') + (notes.length > 12 ? `<li>… et ${notes.length - 12} autre(s)</li>` : '') + '</ul>' : '';
    $('warnings').classList.toggle('hidden', !notes.length);
    $('map-hint').textContent = T ? 'Cliquez une tournée pour voir les adresses retenues' : 'Cliquez un circuit pour voir les carreaux utilisés';
    $('table-title').textContent = T ? 'Tournées' : 'Circuits';
    renderTable();
    renderPreview();
    drawMap();
  }

  const COLS_P = [
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
  const COLS_T = [
    ['id', 'Code', false, x => esc(x.id)],
    ['name', 'Libellé', false, x => esc(x.name)],
    ['habitants', 'Habitants', true, x => fmt(x.habitants)],
    ['menages', 'Ménages', true, x => x.menages === '' ? '–' : fmt(x.menages)],
    ['mode', 'Mode', false, x => esc(x.modeLabel) + ' · ' + Math.round(x.taux * 100) + ' %'],
    ['habCollectes', 'Hab. collectés', true, x => `<b>${fmt(x.habCollectes)}</b>`],
    ['production', 'Production (kg/passage)', true, x => x.production === '' ? '–' : fmt(x.production)],
    ['adresses', 'Adresses', true, x => fmt(x.adresses) + (x.adressesSecteur ? ` <small class="muted">(dont ${fmt(x.adressesSecteur)} secteur)</small>` : '')],
    ['kmCollecte', 'Km collectés', true, x => fmt1(x.kmCollecte)],
    ['kmHlp', 'Km haut le pied', true, x => fmt1(x.kmHlp)],
    ['habParKm', 'Hab./km collecté', true, x => fmt1(x.habParKm)],
    ['communes', 'Communes', false, x => esc(x.communes.slice(0, 3).map(c => `${c.commune} (${fmt(c.habitants)})`).join(' · ') + (x.communes.length > 3 ? ' …' : ''))],
    ['alerts', 'Alerte', false, x => x.alerts.length ? `<span class="warn">⚠ ${esc(x.alerts[0])}</span>` : '']
  ];
  const cols = () => isT() ? COLS_T : COLS_P;

  function renderTable() {
    const q = $('search').value.trim().toLowerCase();
    const { key, dir } = state.sort;
    const rows = state.result.rows.map((x, i) => [x, i]).filter(([x]) => !q || (x.id + ' ' + x.name).toLowerCase().includes(q));
    const val = (x, k) => k === 'alerts' ? x.alerts.length : (k === 'communes' ? (x.communes[0] || {}).commune || '' : x[k]);
    rows.sort((a, b) => {
      const va = val(a[0], key), vb = val(b[0], key);
      return (typeof va === 'string' ? va.localeCompare(vb, 'fr', { numeric: true }) : va - vb) * dir;
    });
    $('table').innerHTML = '<thead><tr>' + cols().map(c => `<th data-k="${c[0]}" class="${c[2] ? 'n ' : ''}${c[0] === key ? 'sorted' + (dir > 0 ? ' asc' : '') : ''}">${c[1]}</th>`).join('') + '</tr></thead><tbody>' +
      rows.map(([x, i]) => `<tr data-i="${i}" class="${state.selected === i ? 'active' : ''}">` + cols().map(c => `<td class="${c[2] ? 'n' : ''}">${c[3](x)}</td>`).join('') + '</tr>').join('') + '</tbody>';
  }
  $('search').addEventListener('input', () => state.result && renderTable());
  $('table').addEventListener('click', e => {
    const th = e.target.closest('th');
    if (th) {
      const k = th.dataset.k;
      state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : (k === 'id' || k === 'name' || k === 'communes' ? 1 : -1) };
      return renderTable();
    }
    const tr = e.target.closest('tbody tr');
    if (tr) select(+tr.dataset.i, true);
  });

  // Aperçu de l'export : exactement ce qui sera écrit dans le fichier.
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

  // --- Exports ------------------------------------------------------------------------------------------------------------
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
  $('btn-communes').addEventListener('click', () => {
    const lines = [];
    state.result.rows.forEach(r => r.communes.forEach(c => lines.push([r.id, r.name, c.commune, c.adresses, c.habitants])));
    IO.download(`habitants_par_commune_${stamp()}.csv`, IO.toCSV(['Code', 'Libellé', 'Commune', 'Adresses', 'Habitants'], lines), 'text/csv;charset=utf-8');
  });
  $('btn-geojson').addEventListener('click', () => {
    const r = state.result;
    let features;
    if (r.mode === 'troncons') {
      features = [];
      r.tournees.forEach((tn, i) => tn.troncons.forEach(t => {
        if (t.pts.length < 2) return;
        features.push({
          type: 'Feature',
          properties: { tournee: tn.code, tournee_libelle: tn.name, troncon: t.id, voie: t.nom, commune: t.commune, type: t.type, distance_m: t.dist, collecte: t.side ? 1 : 0 },
          geometry: { type: 'LineString', coordinates: t.pts }
        });
      }));
    } else {
      features = r.circuits.map((c, i) => ({
        type: 'Feature',
        properties: {
          code: r.rows[i].id, libelle: r.rows[i].name, habitants: r.rows[i].habitants, menages: r.rows[i].menages,
          surface_km2: Math.round(r.rows[i].surface * 1000) / 1000, densite: Math.round(r.rows[i].densite), couverture: Math.round(r.rows[i].couverture * 100)
        },
        geometry: geometryOf(c)
      }));
    }
    IO.download(`${r.mode === 'troncons' ? 'troncons' : 'habitants_circuits'}_${stamp()}.geojson`, JSON.stringify({ type: 'FeatureCollection', features }), 'application/geo+json');
  });
  $('btn-addr-geojson').addEventListener('click', () => {
    const r = state.result, features = [];
    r.served.forEach((s, i) => s.taken.forEach((origin, k) => {
      const p = toLL([r.pts[k].x, r.pts[k].y]);
      features.push({
        type: 'Feature',
        properties: { tournee: r.rows[i].id, origine: origin, habitants: Math.round(r.weights.pop[k] * 100) / 100, commune: r.communes[k] },
        geometry: { type: 'Point', coordinates: [p[0], p[1]] }
      });
    }));
    IO.download(`adresses_retenues_${stamp()}.geojson`, JSON.stringify({ type: 'FeatureCollection', features }), 'application/geo+json');
  });

  // --- Carte ----------------------------------------------------------------------------------------------------------------------
  let map, layer, cellLayer, legend;
  const polys = new Map();
  const toLL = Habitants.transform(Habitants.WORK, 'EPSG:4326');
  const RAMP = ['#d7efe9', '#9bd6c9', '#56b8a6', '#1f8f7e', '#0b5f53'];
  const SIDE_STYLE = {
    D: { color: '#0f7b6c', weight: 4, label: 'Collecte à droite' },
    G: { color: '#4a3aa7', weight: 4, label: 'Collecte à gauche' },
    B: { color: '#2a78d6', weight: 4, label: 'Collecte bilatérale' },
    '': { color: '#8a919c', weight: 2, dashArray: '5 5', label: 'Haut le pied' }
  };

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
    if (r.mode === 'troncons') drawTournees(r); else drawCircuits(r);
    setTimeout(() => { map.invalidateSize(); if (layer.getBounds().isValid()) map.fitBounds(layer.getBounds(), { padding: [20, 20] }); }, 50);
  }

  function drawCircuits(r) {
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
  }

  function drawTournees(r) {
    r.tournees.forEach((tn, i) => {
      const g = L.featureGroup().addTo(layer);
      tn.troncons.forEach(t => {
        if (t.pts.length < 2) return;
        const st = SIDE_STYLE[t.side];
        L.polyline(t.pts.map(p => [p[1], p[0]]), { color: st.color, weight: st.weight, dashArray: st.dashArray || null, opacity: .9 })
          .bindTooltip(`<b>${esc(t.nom || '(sans nom)')}</b> · ${esc(t.type)}<br>${esc(t.commune)} · ${fmt(t.dist)} m`, { sticky: true })
          .on('click', () => select(i, false)).addTo(g);
      });
      polys.set(i, g);
    });
    (r.sectorCircuits || []).forEach(c => L.geoJSON(geometryOf(c), { style: { color: '#d55181', weight: 2, dashArray: '6 4', fillOpacity: .08 } }).bindTooltip('Secteur complémentaire').addTo(layer));
    legend.getContainer().innerHTML = '<b>Tronçons</b><br>' + ['D', 'G', 'B', ''].map(k => `<i style="background:${SIDE_STYLE[k].color}"></i>${SIDE_STYLE[k].label}<br>`).join('') +
      '<i style="background:#eda100"></i>Adresse retenue<br><i style="background:#d55181"></i>Adresse du secteur<br><i class="ctx" style="background:#c3c8cf"></i>Autre adresse';
  }

  // Sélection : met en évidence le circuit / la tournée et montre ce qui a servi au calcul.
  function select(i, zoom) {
    state.selected = i;
    cellLayer.clearLayers();
    const r = state.result, x = r.rows[i];
    if (r.mode === 'troncons') {
      polys.forEach((g, k) => g.setStyle({ opacity: k === i ? 1 : .35 }));
      const tn = r.tournees[i], s = r.served[i];
      const box = tn.troncons.reduce((b, t) => t.work.length ? [Math.min(b[0], t.bbox[0]), Math.min(b[1], t.bbox[1]), Math.max(b[2], t.bbox[2]), Math.max(b[3], t.bbox[3])] : b, [Infinity, Infinity, -Infinity, -Infinity]);
      const m = r.width + 150;
      let others = 0;
      r.pts.forEach((p, k) => {
        if (p.x < box[0] - m || p.x > box[2] + m || p.y < box[1] - m || p.y > box[3] + m) return;
        const origin = s.taken.get(k);
        if (!origin && ++others > 4000) return;
        const ll = toLL([p.x, p.y]);
        L.circleMarker([ll[1], ll[0]], origin
          ? { radius: 4, weight: 1, color: '#16191d', fillColor: origin === 'secteur' ? '#d55181' : '#eda100', fillOpacity: .95 }
          : { radius: 2, weight: 0, fillColor: '#8a919c', fillOpacity: .6 })
          .bindTooltip(origin ? `${fmt1(r.weights.pop[k])} hab.${r.communes[k] ? ' · ' + esc(r.communes[k]) : ''}` : 'Non retenue').addTo(cellLayer);
      });
      if (zoom && polys.get(i).getBounds().isValid()) map.fitBounds(polys.get(i).getBounds(), { padding: [30, 30] });
      $('map-hint').textContent = `${x.id} : ${fmt(x.habitants)} habitants · ${fmt(x.adresses)} adresses retenues (jaune)`;
    } else {
      polys.forEach((p, k) => p.setStyle({ weight: k === i ? 3.5 : 1.5, color: k === i ? '#e34948' : '#16191d' }));
      const c = r.circuits[i];
      const max = Math.max(1, ...r.units.filter(u => u.bbox[0] < c.bbox[2] && u.bbox[2] > c.bbox[0] && u.bbox[1] < c.bbox[3] && u.bbox[3] > c.bbox[1]).map(u => u.pop));
      Habitants.computeCircuit(c, r.units, r.extent, (u, frac) => {
        const ring = u.ring.map(toLL).map(q => [q[1], q[0]]);
        L.polygon(ring, { color: '#0b5f53', weight: 1, fillColor: '#eda100', fillOpacity: .15 + .55 * Math.min(1, u.pop / max), dashArray: frac < .999 ? '4 3' : null })
          .bindTooltip(`${fmt(u.pop)} hab. × ${Math.round(frac * 100)} % = ${fmt1(u.pop * frac)}`).addTo(cellLayer);
      });
      polys.get(i).bringToFront();
      if (zoom) map.fitBounds(polys.get(i).getBounds(), { padding: [30, 30] });
      $('map-hint').textContent = `${x.id} : ${fmt(x.habitants)} habitants · carreaux en jaune (pointillés = partiellement dans le circuit)`;
    }
    renderTable();
    $('map-card').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  $('btn-map-size').addEventListener('click', () => {
    const big = $('map-card').classList.toggle('big');
    $('btn-map-size').textContent = big ? '⤡ Réduire' : '⤢ Agrandir';
    setTimeout(() => map.invalidateSize(), 50);
  });

  // --- Exemples -------------------------------------------------------------------------------------------------------------------
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

  function demoTournee() {
    const d = HabitantsDemo.buildTournee();
    setTournees([{ name: 'tournee_exemple.xml', text: d.xml }]);
    const addr = IO.arraySource({ adresses: d.addresses });
    addr.name = 'adresses_exemple.csv';
    state.addrSource = addr;
    showAddrSheet('adresses');
    const pop = IO.arraySource({ carreaux: d.rows });
    pop.name = 'carreaux_exemple.csv';
    state.popSource = pop;
    showPopSheet('carreaux');
    state.sectors = { name: 'secteurs_exemple.geojson', features: d.sectors.features, crs: 'EPSG:4326', columns: ['tournee', 'libelle'] };
    $('info-s').textContent = 'secteurs_exemple.geojson : 1 secteur';
    $('cols-s').classList.remove('hidden');
    fill($('id-s'), ['tournee', 'libelle'], 'tournee', true);
    $('sectors-box').open = true;
    $('meta-source').value = 'Données fictives (exemple)';
    run();
  }
  $('btn-demo').addEventListener('click', demo);
  $('btn-demo-t').addEventListener('click', demoTournee);
  document.querySelectorAll('[data-demo]').forEach(b => b.addEventListener('click', () => (b.dataset.demo === 'troncons' ? demoTournee : demo)()));

  loadSaved();
  renderFormat();
})();
