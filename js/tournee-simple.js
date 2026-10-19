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
  const state = { tournees: null, addr: null, pop: null, result: null };

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
        tournees: state.tournees, crs: a.crs, units, width, perAddress, sectors: [],
        eachAddress: cb => a.src.each(a.sheet, r => cb(IO.toNumber(r[a.x]), IO.toNumber(r[a.y]), a.commune ? String(r[a.commune] || '').trim() : ''))
      });
      res.width = width; res.perAddress = perAddress; res.hasUnits = !!(units && units.length);
      state.result = res;
      render();
    } catch (e) { toast(e.message, true); }
    $('btn-run').disabled = false;
    $('hint').textContent = '';
  });

  function render() {
    const r = state.result, rows = r.rows;
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

  // Exemple
  $('btn-demo').addEventListener('click', () => {
    const d = HabitantsDemo.buildTournee();
    setTournees([{ name: 'tournee_exemple.xml', text: d.xml }]);
    const a = IO.arraySource({ adresses: d.addresses }); a.name = 'adresses_exemple.csv'; setAddr(a);
    const p = IO.arraySource({ carreaux: d.rows }); p.name = 'carreaux_exemple.csv'; setPop(p);
    $('btn-run').click();
  });
})();
