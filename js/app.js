/* Interface : chargement, paramétrage, carte, tableaux et exports. */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const PAGE_SIZE = 100;

  const CAT = {
    identique: { label: 'Identiques', color: '--c-identique' },
    attributs: { label: 'Écarts attributaires', color: '--c-attributs' },
    deplace: { label: 'Déplacés', color: '--c-deplace' },
    seulA: { label: 'Uniquement A', color: '--c-seulA' },
    seulB: { label: 'Uniquement B', color: '--c-seulB' },
    doublon: { label: 'Doublons', color: '--c-doublon' }
  };
  const TAG_LABEL = {
    identique: 'identique', attributs: 'attributs', deplace: 'déplacé', seulA: 'seul A',
    seulB: 'seul B', doublon: 'doublon', sans_cle: 'sans identifiant', sans_coord: 'sans coordonnées'
  };

  const state = {
    src: { A: null, B: null },      // { parsed, rows, cols }
    result: null, opts: null,
    filter: { tag: null, field: null, search: '' },
    sort: { col: null, asc: true },
    page: 0, filtered: []
  };

  const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const esc = v => String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const fmt = n => n.toLocaleString('fr-FR');
  const label = side => $(side === 'A' ? 'label-a' : 'label-b').value || 'Base ' + side;

  // ---------------------------------------------------------------------
  // Chargement des fichiers
  // ---------------------------------------------------------------------
  ['A', 'B'].forEach(side => {
    const s = side.toLowerCase();
    $('file-' + s).addEventListener('change', async e => {
      const file = e.target.files[0];
      if (!file) return;
      const info = $('info-' + s);
      info.textContent = 'Lecture…';
      try {
        const parsed = await IO.readFile(file);
        e.target.nextElementSibling.textContent = file.name;
        setSource(side, parsed);
      } catch (err) {
        info.textContent = 'Erreur : ' + err.message;
      }
    });
    $('sheet-' + s).querySelector('select').addEventListener('change', ev => selectSheet(side, ev.target.value));
    $('label-' + s).addEventListener('input', () => { if (state.result) renderAll(); });
  });

  function setSource(side, parsed) {
    state.src[side] = { parsed };
    const names = Object.keys(parsed.sheets);
    const box = $('sheet-' + side.toLowerCase());
    box.classList.toggle('hidden', names.length < 2);
    // Par défaut : la feuille la plus remplie (évite les onglets « Lisez-moi »).
    const best = names.reduce((x, y) => parsed.sheets[y].length > parsed.sheets[x].length ? y : x);
    const sel = box.querySelector('select');
    sel.innerHTML = names.map(n => `<option>${esc(n)}</option>`).join('');
    sel.value = best;
    selectSheet(side, best);
  }

  function selectSheet(side, name) {
    const src = state.src[side];
    src.rows = src.parsed.sheets[name] || [];
    src.cols = IO.columnsOf(src.rows);
    const geo = src.parsed.geo ? ' · géométrie GeoJSON' : '';
    $('info-' + side.toLowerCase()).textContent = `${fmt(src.rows.length)} lignes · ${src.cols.filter(c => !c.startsWith('__')).length} colonnes${geo}`;
    if (state.src.A && state.src.B) buildConfig();
  }

  // ---------------------------------------------------------------------
  // Paramétrage
  // ---------------------------------------------------------------------
  function fillSelect(sel, cols, value, allowEmpty) {
    const opts = (allowEmpty ? ['<option value="">—</option>'] : [])
      .concat(cols.map(c => `<option value="${esc(c)}">${esc(c === '__x' ? '(géométrie X)' : c === '__y' ? '(géométrie Y)' : c)}</option>`));
    sel.innerHTML = opts.join('');
    sel.value = value || '';
  }

  const normName = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

  function buildConfig() {
    const A = state.src.A, B = state.src.B;
    const plainA = A.cols.filter(c => !c.startsWith('__')), plainB = B.cols.filter(c => !c.startsWith('__'));

    const keyA = IO.guessKey(plainA), keyB = IO.guessKey(plainB);
    fillSelect($('key-a'), plainA, keyA, true);
    fillSelect($('key-b'), plainB, keyB, true);

    const crsOpts = Object.keys(IO.CRS);
    [['A', A], ['B', B]].forEach(([side, src]) => {
      const s = side.toLowerCase();
      const xy = IO.guessXY(src.cols);
      fillSelect($('x-' + s), src.cols, xy.x, true);
      fillSelect($('y-' + s), src.cols, xy.y, true);
      $('crs-' + s).innerHTML = crsOpts.map(c => `<option value="${c}">${IO.CRS[c]}</option>`).join('');
      $('crs-' + s).value = IO.guessCRS(src.rows, xy.x, xy.y);
    });

    // Appariement automatique des colonnes de même nom (hors identifiant et coordonnées).
    const xyCols = new Set([$('x-a').value, $('y-a').value, $('x-b').value, $('y-b').value]);
    const bByName = new Map(plainB.map(c => [normName(c), c]));
    $('fields').innerHTML = plainA.map((c, i) => {
      const match = bByName.get(normName(c)) || '';
      const checked = match && c !== keyA && !xyCols.has(c) && !xyCols.has(match);
      return `<div class="pair">
        <input type="checkbox" id="fp-${i}" data-a="${esc(c)}" ${checked ? 'checked' : ''}>
        <label class="name" for="fp-${i}" title="${esc(c)}">${esc(c)}</label>
        <select data-for="${i}"><option value="">—</option>${plainB.map(b => `<option value="${esc(b)}">${esc(b)}</option>`).join('')}</select>
      </div>`;
    }).join('');
    $('fields').querySelectorAll('select').forEach(sel => {
      const a = $('fp-' + sel.dataset.for).dataset.a;
      sel.value = bByName.get(normName(a)) || '';
      sel.addEventListener('change', () => { $('fp-' + sel.dataset.for).checked = !!sel.value; });
    });

    $('config').classList.remove('hidden');
  }

  document.querySelectorAll('input[name=mode]').forEach(r => r.addEventListener('change', () => {
    const spatial = document.querySelector('input[name=mode]:checked').value === 'spatial';
    document.querySelectorAll('.opt-key').forEach(e => e.classList.toggle('hidden', spatial));
    document.querySelectorAll('.opt-spatial').forEach(e => e.classList.toggle('hidden', !spatial));
  }));

  function readOptions() {
    const fieldPairs = [];
    $('fields').querySelectorAll('.pair').forEach(p => {
      const cb = p.querySelector('input'), sel = p.querySelector('select');
      if (cb.checked && sel.value) fieldPairs.push({ a: cb.dataset.a, b: sel.value });
    });
    return {
      mode: document.querySelector('input[name=mode]:checked').value,
      keyA: $('key-a').value, keyB: $('key-b').value,
      moveThreshold: Number($('move-threshold').value) || 0,
      matchRadius: Number($('match-radius').value) || 15,
      fieldPairs,
      ignoreCase: $('opt-case').checked,
      ignoreAccents: $('opt-accents').checked,
      ignoreLeadingZeros: $('opt-zeros').checked
    };
  }

  $('btn-compare').addEventListener('click', runCompare);

  function runCompare() {
    const err = $('error');
    err.classList.add('hidden');
    try {
      const opts = readOptions();
      const recA = IO.toRecords(state.src.A.rows, $('x-a').value, $('y-a').value, $('crs-a').value);
      const recB = IO.toRecords(state.src.B.rows, $('x-b').value, $('y-b').value, $('crs-b').value);
      if (opts.mode === 'spatial' && (!recA.some(r => r.lat !== null) || !recB.some(r => r.lat !== null))) {
        throw new Error('Le mode proximité nécessite des coordonnées valides dans les deux bases.');
      }
      state.result = Compare.compare(recA, recB, opts);
      state.result.rows.forEach((r, i) => { r._i = i; });
      state.opts = opts;
      state.filter = { tag: null, field: null, search: '' };
      state.sort = { col: null, asc: true };
      $('search').value = '';
      $('empty').classList.add('hidden');
      $('results').classList.remove('hidden');
      initMap();
      renderAll(true);
    } catch (e) {
      err.textContent = e.message;
      err.classList.remove('hidden');
    }
  }

  // ---------------------------------------------------------------------
  // Rendu
  // ---------------------------------------------------------------------
  function renderAll(fit) {
    renderKPIs();
    renderFieldStats();
    applyFilters(fit);
  }

  function renderKPIs() {
    const { stats } = state.result;
    const total = stats.total || 1;
    const spatial = state.opts.mode === 'spatial';
    const labels = Object.assign({}, CAT, {
      seulA: { label: 'Uniquement dans ' + label('A'), color: CAT.seulA.color },
      seulB: { label: 'Uniquement dans ' + label('B'), color: CAT.seulB.color }
    });
    $('kpis').innerHTML = Object.keys(CAT).map(tag => {
      const n = stats.byTag[tag] || 0;
      const na = spatial && (tag === 'deplace' || tag === 'doublon');
      return `<button class="kpi ${state.filter.tag === tag ? 'active' : ''}" data-tag="${tag}" style="--kc:${cssVar(labels[tag].color)}" ${na ? 'disabled' : ''}>
        <div class="v">${na ? '—' : fmt(n)}</div>
        <div class="l">${esc(labels[tag].label)}</div>
        <div class="p">${na ? 'mode identifiant uniquement' : (100 * n / total).toFixed(1).replace('.', ',') + ' %'}</div>
      </button>`;
    }).join('');
    $('kpis').querySelectorAll('.kpi').forEach(b => b.addEventListener('click', () => {
      state.filter.tag = state.filter.tag === b.dataset.tag ? null : b.dataset.tag;
      state.page = 0;
      renderKPIs();
      applyFilters();
    }));
  }

  function renderFieldStats() {
    const { stats } = state.result;
    const max = Math.max(1, ...stats.byField.map(f => f.count));
    const rows = stats.byField.slice().sort((x, y) => y.count - x.count);
    $('field-stats').innerHTML = rows.length
      ? `<tr><th>Champ</th><th class="n">Écarts</th></tr>` + rows.map(f => `
        <tr class="clickable ${state.filter.field === f.a ? 'active' : ''}" data-field="${esc(f.a)}">
          <td>${esc(f.a)}${f.a !== f.b ? ` <span class="muted">↔ ${esc(f.b)}</span>` : ''}<div class="bar" style="width:${(100 * f.count / max).toFixed(0)}%"></div></td>
          <td class="n">${fmt(f.count)}</td>
        </tr>`).join('')
      : '<tr><td class="muted">Aucun champ comparé.</td></tr>';
    $('field-stats').querySelectorAll('tr[data-field]').forEach(tr => tr.addEventListener('click', () => {
      state.filter.field = state.filter.field === tr.dataset.field ? null : tr.dataset.field;
      state.page = 0;
      renderFieldStats();
      applyFilters();
    }));
    const md = stats.medianDistance;
    $('dist-info').innerHTML = `${fmt(stats.pairs)} bacs appariés` +
      (md !== null ? ` · écart de position médian : ${md.toFixed(1).replace('.', ',')} m` : '');
  }

  function searchText(r) {
    if (r._s === undefined) {
      const parts = [r.key];
      if (r.a) parts.push(...Object.values(r.a.props));
      if (r.b) parts.push(...Object.values(r.b.props));
      r._s = parts.join(' ').toLowerCase();
    }
    return r._s;
  }

  function applyFilters(fit) {
    const f = state.filter;
    const q = f.search.trim().toLowerCase();
    let rows = state.result.rows.filter(r =>
      (!f.tag || r.tags.includes(f.tag)) &&
      (!f.field || r.diffs.some(d => d.a === f.field)) &&
      (!q || searchText(r).includes(q)));

    if (state.sort.col) {
      const col = columns().find(c => c.id === state.sort.col);
      const dir = state.sort.asc ? 1 : -1;
      rows = rows.slice().sort((x, y) => {
        const vx = col.sort(x), vy = col.sort(y);
        if (vx === vy) return 0;
        if (vx === null || vx === '') return 1;
        if (vy === null || vy === '') return -1;
        return (typeof vx === 'number' && typeof vy === 'number' ? vx - vy : String(vx).localeCompare(String(vy), 'fr', { numeric: true })) * dir;
      });
    }
    state.filtered = rows;

    const badges = [];
    if (f.tag) badges.push(CAT[f.tag].label);
    if (f.field) badges.push('écart sur « ' + f.field + ' »');
    $('filter-badge').classList.toggle('hidden', !badges.length);
    $('filter-badge').textContent = badges.join(' + ') + ' ✕';

    renderTable();
    renderMap(fit);
  }

  $('filter-badge').addEventListener('click', () => {
    state.filter.tag = null; state.filter.field = null; state.page = 0;
    renderKPIs(); renderFieldStats(); applyFilters();
  });

  let searchTimer;
  $('search').addEventListener('input', e => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.filter.search = e.target.value; state.page = 0; applyFilters(); }, 200);
  });

  // ---------------------------------------------------------------------
  // Tableau
  // ---------------------------------------------------------------------
  function tagsHtml(r) {
    return r.tags.map(t => `<span class="tag" style="--tc:${cssVar((CAT[t] || CAT.doublon).color)}">${esc(TAG_LABEL[t] || t)}</span>`).join('');
  }

  function columns() {
    const cols = [
      { id: 'statut', title: 'Statut', html: tagsHtml, sort: r => Compare.CATEGORIES.indexOf(r.category) },
      { id: 'cle', title: 'Identifiant', html: r => esc(r.key), sort: r => r.key },
      { id: 'dist', title: 'Distance (m)', cls: 'n', html: r => r.distance === null ? '' : r.distance.toFixed(1).replace('.', ','), sort: r => r.distance },
      { id: 'nb', title: 'Nb écarts', cls: 'n', html: r => r.a && r.b ? r.diffs.length : '', sort: r => r.a && r.b ? r.diffs.length : null }
    ];
    state.opts.fieldPairs.forEach(p => {
      cols.push({
        id: 'f:' + p.a, title: p.a,
        html: r => {
          const d = r.diffs.find(x => x.a === p.a);
          if (d) return `<span class="diff"><span class="old">${esc(d.va) || '∅'}</span> → <span class="new">${esc(d.vb) || '∅'}</span></span>`;
          return esc(r.a ? r.a.props[p.a] : r.b.props[p.b]);
        },
        sort: r => r.a ? r.a.props[p.a] : r.b.props[p.b]
      });
    });
    return cols;
  }

  function renderTable() {
    const cols = columns();
    const rows = state.filtered;
    const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    state.page = Math.min(state.page, pages - 1);
    const slice = rows.slice(state.page * PAGE_SIZE, (state.page + 1) * PAGE_SIZE);

    $('table').innerHTML =
      '<thead><tr>' + cols.map(c => `<th data-col="${esc(c.id)}" class="${state.sort.col === c.id ? 'sorted' + (state.sort.asc ? ' asc' : '') : ''}">${esc(c.title)}</th>`).join('') + '</tr></thead>' +
      '<tbody>' + slice.map(r => `<tr data-i="${r._i}">` + cols.map(c => `<td class="${c.cls || ''}">${c.html(r)}</td>`).join('') + '</tr>').join('') + '</tbody>';

    $('page-info').textContent = rows.length
      ? `${fmt(state.page * PAGE_SIZE + 1)}–${fmt(state.page * PAGE_SIZE + slice.length)} sur ${fmt(rows.length)}`
      : 'Aucun résultat';
    $('prev').disabled = state.page === 0;
    $('next').disabled = state.page >= pages - 1;

    $('table').querySelectorAll('th').forEach(th => th.addEventListener('click', () => {
      state.sort = { col: th.dataset.col, asc: state.sort.col === th.dataset.col ? !state.sort.asc : true };
      applyFilters();
    }));
    $('table').querySelectorAll('tbody tr').forEach(tr => tr.addEventListener('click', () => focusRow(state.result.rows[tr.dataset.i])));
  }

  $('prev').addEventListener('click', () => { state.page--; renderTable(); });
  $('next').addEventListener('click', () => { state.page++; renderTable(); });

  // ---------------------------------------------------------------------
  // Carte
  // ---------------------------------------------------------------------
  let map, dataLayer, legend;
  const markers = new Map();

  function initMap() {
    if (map) return;
    map = L.map('map', { preferCanvas: true });
    const ign = (layer, fmtImg) => L.tileLayer(
      'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&STYLE=normal&TILEMATRIXSET=PM' +
      `&LAYER=${layer}&FORMAT=${fmtImg}&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}`,
      { maxZoom: 19, attribution: '© IGN-F/Géoplateforme' });
    const bases = {
      'Plan IGN': ign('GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2', 'image/png'),
      'Photos aériennes IGN': ign('ORTHOIMAGERY.ORTHOPHOTOS', 'image/jpeg'),
      'OpenStreetMap': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© contributeurs OpenStreetMap' })
    };
    bases['Plan IGN'].addTo(map);
    L.control.layers(bases, null, { position: 'topright' }).addTo(map);
    L.control.scale({ imperial: false }).addTo(map);
    dataLayer = L.featureGroup().addTo(map);

    legend = L.control({ position: 'bottomleft' });
    legend.onAdd = () => L.DomUtil.create('div', 'legend');
    legend.addTo(map);
    map.setView([46.6, 2.4], 6);
  }

  function posOf(r) {
    const rec = r.a && r.a.lat !== null ? r.a : (r.b && r.b.lat !== null ? r.b : null);
    return rec ? [rec.lat, rec.lon] : null;
  }

  function renderMap(fit) {
    dataLayer.clearLayers();
    markers.clear();
    const counts = {};
    for (const r of state.filtered) {
      const p = posOf(r);
      if (!p) continue;
      const color = cssVar(CAT[r.category].color);
      counts[r.category] = (counts[r.category] || 0) + 1;
      if (r.tags.includes('deplace') && r.b && r.b.lat !== null) {
        L.polyline([p, [r.b.lat, r.b.lon]], { color, weight: 2, dashArray: '4 4', interactive: false }).addTo(dataLayer);
        L.circleMarker([r.b.lat, r.b.lon], { radius: 3, color, weight: 1, fillOpacity: 0, interactive: false }).addTo(dataLayer);
      }
      const m = L.circleMarker(p, { radius: 5, color: '#fff', weight: 1, fillColor: color, fillOpacity: 0.9 })
        .bindPopup(() => popupHtml(r), { maxWidth: 420 });
      m.addTo(dataLayer);
      markers.set(r._i, m);
    }
    legend.getContainer().innerHTML = Compare.CATEGORIES.filter(c => counts[c])
      .map(c => `<div><i style="background:${cssVar(CAT[c].color)}"></i>${esc(c === 'seulA' ? 'Uniquement ' + label('A') : c === 'seulB' ? 'Uniquement ' + label('B') : CAT[c].label)} (${fmt(counts[c])})</div>`).join('') ||
      '<div>Aucun point localisé</div>';
    if (fit && dataLayer.getLayers().length) map.fitBounds(dataLayer.getBounds(), { padding: [20, 20] });
    setTimeout(() => map.invalidateSize(), 0);
  }

  function popupHtml(r) {
    const o = state.opts;
    const lines = [];
    const keyRow = [o.keyA, o.keyB];
    if (keyRow[0] || keyRow[1]) lines.push({ name: 'Identifiant', va: r.a && keyRow[0] ? r.a.props[keyRow[0]] : '', vb: r.b && keyRow[1] ? r.b.props[keyRow[1]] : '', diff: false });
    o.fieldPairs.forEach(p => lines.push({
      name: p.a, va: r.a ? r.a.props[p.a] : '', vb: r.b ? r.b.props[p.b] : '',
      diff: r.diffs.some(d => d.a === p.a)
    }));
    const dist = r.distance !== null ? `<p>Distance entre les deux positions : <b>${r.distance.toFixed(1).replace('.', ',')} m</b></p>` : '';
    return `<div class="pop"><h4>${esc(r.key || '(sans identifiant)')}</h4>${tagsHtml(r)}${dist}
      <table><tr><th>Champ</th><th>${esc(label('A'))}</th><th>${esc(label('B'))}</th></tr>
      ${lines.map(l => `<tr class="${l.diff ? 'diff-row' : ''}"><td>${esc(l.name)}</td><td>${r.a ? esc(l.va) : '—'}</td><td>${r.b ? esc(l.vb) : '—'}</td></tr>`).join('')}
      </table></div>`;
  }

  function focusRow(r) {
    const m = markers.get(r._i);
    if (!m) return;
    $('map').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    map.setView(m.getLatLng(), Math.max(map.getZoom(), 18));
    m.openPopup();
  }

  // ---------------------------------------------------------------------
  // Exports
  // ---------------------------------------------------------------------
  function exportRecords() {
    const o = state.opts;
    return state.filtered.map(r => {
      const props = {
        statut: TAG_LABEL[r.category],
        etiquettes: r.tags.map(t => TAG_LABEL[t] || t).join(', '),
        identifiant: r.key,
        distance_m: r.distance === null ? '' : Number(r.distance.toFixed(2)),
        nb_ecarts: r.a && r.b ? r.diffs.length : '',
        champs_en_ecart: r.diffs.map(d => d.a).join(', ')
      };
      o.fieldPairs.forEach(p => {
        props['A_' + p.a] = r.a ? r.a.props[p.a] : '';
        props['B_' + p.b] = r.b ? r.b.props[p.b] : '';
      });
      const c = v => v === null ? null : Number(v.toFixed(7));
      props.lat_A = r.a ? c(r.a.lat) : null; props.lon_A = r.a ? c(r.a.lon) : null;
      props.lat_B = r.b ? c(r.b.lat) : null; props.lon_B = r.b ? c(r.b.lon) : null;
      return { props, pos: posOf(r) };
    });
  }

  const stamp = () => new Date().toISOString().slice(0, 10);

  $('btn-export-csv').addEventListener('click', () => {
    const recs = exportRecords();
    if (!recs.length) return;
    const header = Object.keys(recs[0].props);
    const lines = recs.map(r => header.map(h => {
      const v = r.props[h];
      return typeof v === 'number' ? String(v).replace('.', ',') : v;
    }));
    IO.download(`comparaison_bacs_${stamp()}.csv`, IO.toCSV(header, lines), 'text/csv;charset=utf-8');
  });

  $('btn-export-geojson').addEventListener('click', () => {
    const features = exportRecords().filter(r => r.pos).map(r => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [r.pos[1], r.pos[0]] },
      properties: r.props
    }));
    IO.download(`comparaison_bacs_${stamp()}.geojson`,
      JSON.stringify({ type: 'FeatureCollection', features }), 'application/geo+json');
  });

  // ---------------------------------------------------------------------
  // Exemple
  // ---------------------------------------------------------------------
  $('btn-demo').addEventListener('click', () => {
    const d = Demo.generate(1500, 42);
    $('label-a').value = 'Base SIG';
    $('label-b').value = 'Base facturation';
    $('file-a').nextElementSibling.textContent = 'exemple_sig (généré)';
    $('file-b').nextElementSibling.textContent = 'exemple_facturation (généré)';
    state.src.A = null;
    setSource('B', { kind: 'demo', sheets: { exemple: d.metier } });
    setSource('A', { kind: 'demo', sheets: { exemple: d.sig } });
    runCompare();
  });
})();
