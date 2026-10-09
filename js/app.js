/* Interface : chargement, paramétrage, géocodage, carte, tableaux et exports. */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const PAGE_SIZE = 100;

  // Catégories affichées (indicateurs, carte, tableau) selon le type d'analyse.
  const CATS = {
    bacs: {
      identique: { label: 'Identiques', color: '--c-identique' },
      attributs: { label: 'Écarts attributaires', color: '--c-attributs' },
      deplace: { label: 'Déplacés', color: '--c-deplace' },
      seulA: { label: 'Uniquement A', color: '--c-seulA' },
      seulB: { label: 'Uniquement B', color: '--c-seulB' },
      doublon: { label: 'Doublons', color: '--c-doublon' }
    },
    levees: {
      identique: { label: 'Levés régulièrement', color: '--c-identique' },
      faible: { label: 'Taux de présentation faible', color: '--c-attributs' },
      arret: { label: 'Plus levés récemment', color: '--c-arret' },
      seulA: { label: 'Jamais levés', color: '--c-seulA' },
      recent: { label: 'Livrés récemment, pas encore levés', color: '--c-recent' },
      seulB: { label: 'Puces levées non référencées', color: '--c-seulB' },
      deplace: { label: 'Écart de position', color: '--c-deplace' }
    }
  };
  const TAGS = {
    bacs: { identique: 'identique', attributs: 'attributs', deplace: 'déplacé', seulA: 'seul A', seulB: 'seul B',
      doublon: 'doublon', sans_cle: 'sans identifiant', sans_coord: 'sans coordonnées' },
    levees: { identique: 'régulier', faible: 'taux faible', arret: 'arrêt', seulA: 'jamais levé', recent: 'récent',
      seulB: 'non référencé', deplace: 'écart position', doublon: 'doublon', sans_cle: 'sans identifiant' }
  };
  const TRANCHES = ['0 % (jamais levé)', '1 – 24 %', '25 – 49 %', '50 – 74 %', '75 – 100 %'];

  const state = {
    src: { A: null, B: null },       // { source, sheet, preview, cols, count }
    result: null, opts: null,
    filter: { tag: null, field: null, tranche: null, group: null, search: '' },
    sort: { col: null, asc: true },
    page: 0, filtered: []
  };

  const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const esc = v => String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const fmt = n => n === null || n === undefined || !Number.isFinite(n) ? '' : n.toLocaleString('fr-FR', { maximumFractionDigits: 1 });
  const pct = (n, d) => d ? (100 * n / d).toFixed(1).replace('.', ',') + ' %' : '';
  const label = side => $(side === 'A' ? 'label-a' : 'label-b').value || 'Base ' + side;
  const isLevees = () => $('type-b').value === 'levees';
  const lev = () => state.opts && state.opts.mode === 'levees';
  const plain = cols => cols.filter(c => !c.startsWith('__'));

  function cats() {
    const o = state.opts;
    const c = JSON.parse(JSON.stringify(CATS[lev() ? 'levees' : 'bacs']));
    if (lev()) {
      c.faible.label = `Taux de présentation < ${o.seuilTaux} %`;
      c.arret.label = `Sans levée depuis ≥ ${o.seuilArret} sem.`;
    } else {
      c.seulA.label = 'Uniquement dans ' + label('A');
      c.seulB.label = 'Uniquement dans ' + label('B');
    }
    return c;
  }
  const tagLabel = t => TAGS[lev() ? 'levees' : 'bacs'][t] || t;
  const priority = () => lev() ? Levees.PRIORITE : Compare.CATEGORIES;

  // ---------------------------------------------------------------------
  // Chargement des fichiers
  // ---------------------------------------------------------------------
  ['A', 'B'].forEach(side => {
    const s = side.toLowerCase();
    $('file-' + s).addEventListener('change', async e => {
      const file = e.target.files[0];
      if (!file) return;
      const info = $('info-' + s);
      info.textContent = file.size > 10e6 ? 'Lecture du fichier… (gros fichier : jusqu\'à 30 s)' : 'Lecture…';
      e.target.nextElementSibling.textContent = file.name;
      await new Promise(r => setTimeout(r, 30)); // laisse le message s'afficher
      try {
        setSource(side, await IO.readFile(file));
      } catch (err) {
        info.textContent = 'Erreur : ' + err.message;
      }
    });
    $('sheet-' + s).querySelector('select').addEventListener('change', ev => selectSheet(side, ev.target.value));
    $('label-' + s).addEventListener('input', () => { if (state.result) renderAll(); });
  });

  function setSource(side, source) {
    state.src[side] = { source };
    const names = source.sheetNames;
    const box = $('sheet-' + side.toLowerCase());
    box.classList.toggle('hidden', names.length < 2);
    // Par défaut : l'onglet le plus rempli (évite les onglets « Lisez-moi »).
    const best = names.reduce((x, y) => source.count(y) > source.count(x) ? y : x);
    const sel = box.querySelector('select');
    sel.innerHTML = names.map(n => `<option>${esc(n)}</option>`).join('');
    sel.value = best;
    selectSheet(side, best);
  }

  function selectSheet(side, name) {
    const src = state.src[side];
    src.sheet = name;
    src.preview = src.source.preview(name);
    src.cols = IO.columnsOf(src.preview);
    src.count = src.source.count(name);
    const approx = src.source.kind === 'csv' ? '≈ ' : '';
    $('info-' + side.toLowerCase()).textContent = `${approx}${fmt(src.count)} lignes · ${plain(src.cols).length} colonnes${src.source.geo ? ' · géométrie GeoJSON' : ''}`;
    if (side === 'A') setupGeo();
    if (side === 'B') $('type-b').value = looksLikeLevees(src) ? 'levees' : 'bacs';
    if (state.src.A && state.src.B) buildConfig();
  }

  function looksLikeLevees(src) {
    if (!IO.guessDate(src.preview, src.cols)) return false;
    return src.cols.some(c => /lev[ée]e|tourn[ée]e|collecte|horodat|v[ée]hicule/i.test(c)) ||
      (state.src.A && src.count > 3 * state.src.A.count);
  }

  // ---------------------------------------------------------------------
  // Géocodage de la base A
  // ---------------------------------------------------------------------
  const GEO_FIELDS = ['numero', 'indice', 'typeVoie', 'voie', 'cp', 'commune'];

  function setupGeo() {
    const A = state.src.A;
    const cols = plain(A.cols);
    const guess = Geocode.guessColumns(cols);
    const xy = IO.guessXY(A.cols);
    const box = $('geo-a');
    box.classList.toggle('hidden', !(guess.voie || guess.commune));
    box.open = !(xy.x && xy.y);
    GEO_FIELDS.forEach(f => fillSelect($('geo-' + f), cols, guess[f], true));
    $('geo-noise').value = Geocode.detectNoise(A.preview, guess.voie);
    $('geo-status').textContent = '';
    $('btn-geo-export').classList.add('hidden');
    $('btn-geocode').textContent = `Géocoder les ${fmt(A.count)} adresses`;
    geoExample();
  }

  function geoColumns() {
    const c = {};
    GEO_FIELDS.forEach(f => { c[f] = $('geo-' + f).value; });
    return c;
  }

  function geoExample() {
    const A = state.src.A;
    const row = A.preview.find(r => r[$('geo-voie').value]) || A.preview[0];
    if (!row) return;
    const a = Geocode.buildAddress(row, geoColumns(), $('geo-noise').value.trim());
    $('geo-example').textContent = `Exemple envoyé : « ${a.adresse}, ${a.commune} »` + (a.secteur ? ` · secteur : ${a.secteur}` : '');
  }
  GEO_FIELDS.forEach(f => $('geo-' + f).addEventListener('change', geoExample));
  $('geo-noise').addEventListener('input', geoExample);

  $('btn-geocode').addEventListener('click', async () => {
    const A = state.src.A;
    const btn = $('btn-geocode'), bar = $('geo-progress'), status = $('geo-status');
    const cols = geoColumns(), noise = $('geo-noise').value.trim();
    if (!cols.voie && !cols.commune) { status.textContent = 'Choisissez au moins la voie et la commune.'; return; }
    btn.disabled = true;
    bar.classList.remove('hidden');
    try {
      const rows = A.source.all(A.sheet);
      const addrs = rows.map(r => Geocode.buildAddress(r, cols, noise));
      const res = await Geocode.geocodeAll(addrs, (done, total, msg) => {
        bar.firstElementChild.style.width = (total ? 100 * done / total : 100) + '%';
        status.textContent = `${fmt(done)} / ${fmt(total)} adresses distinctes${msg ? ' · ' + msg : ''}`;
      });
      let ok = 0, douteux = 0;
      rows.forEach((r, i) => {
        const g = res[i];
        if (noise) r.secteur = addrs[i].secteur;
        r.geo_adresse = g ? g.label : '';
        r.geo_score = g ? Math.round(g.score * 100) / 100 : '';
        r.geo_lat = g ? g.lat : '';
        r.geo_lon = g ? g.lon : '';
        if (g) { ok++; if (g.score < 0.5) douteux++; }
      });
      // La base A devient une table en mémoire enrichie des colonnes géocodées.
      const sheet = A.sheet;
      state.src.A = { source: IO.arraySource({ [sheet]: rows }) };
      selectSheetKeepGeo(sheet);
      status.textContent = `${fmt(ok)} bacs géocodés sur ${fmt(rows.length)}` +
        (douteux ? ` · ${fmt(douteux)} à vérifier (score < 0,5 : adresse approximative)` : '') +
        (rows.length - ok ? ` · ${fmt(rows.length - ok)} non trouvés` : '');
      $('btn-geo-export').classList.remove('hidden');
    } catch (e) {
      status.textContent = 'Échec du géocodage : ' + e.message + '. Vérifiez la connexion Internet (le service data.geopf.fr doit être accessible).';
    } finally {
      btn.disabled = false;
    }
  });

  function selectSheetKeepGeo(sheet) {
    const A = state.src.A;
    A.sheet = sheet;
    A.preview = A.source.preview(sheet);
    A.cols = IO.columnsOf(A.preview);
    A.count = A.source.count(sheet);
    $('info-a').textContent = `${fmt(A.count)} lignes · ${plain(A.cols).length} colonnes (dont géocodage)`;
    if (state.src.B) {
      buildConfig(true);
      $('x-a').value = 'geo_lon'; $('y-a').value = 'geo_lat'; $('crs-a').value = 'EPSG:4326';
    }
  }

  $('btn-geo-export').addEventListener('click', () => {
    const rows = state.src.A.source.all(state.src.A.sheet);
    const header = plain(IO.columnsOf(rows));
    IO.download('base_geocodee.csv', IO.toCSV(header, rows.map(r => header.map(h => r[h]))), 'text/csv;charset=utf-8');
  });

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
  const CONFIG_SELECTS = ['key-a', 'key-b', 'x-a', 'y-a', 'crs-a', 'x-b', 'y-b', 'crs-b', 'date-b', 'weight-b', 'date-a', 'count-a'];

  function updateModeUI() {
    const levees = isLevees();
    const spatial = !levees && document.querySelector('input[name=mode]:checked').value === 'spatial';
    document.querySelectorAll('.only-levees').forEach(e => e.classList.toggle('hidden', !levees));
    document.querySelectorAll('.only-bacs').forEach(e => e.classList.toggle('hidden', levees));
    document.querySelectorAll('.opt-key').forEach(e => e.classList.toggle('hidden', spatial));
    document.querySelectorAll('.opt-spatial').forEach(e => e.classList.toggle('hidden', !spatial));
    $('move-label').textContent = levees ? 'Écart de position bac ↔ levées signalé au-delà de (m)' : 'Seuil « déplacé » (m)';
    $('fields-title').textContent = levees ? 'Colonnes de A à afficher' : 'Champs à comparer';
    $('btn-compare').textContent = levees ? 'Analyser les levées' : 'Comparer';
    $('key-b').previousElementSibling.textContent = levees ? 'Identifiant dans les levées' : 'Identifiant B';
  }

  function buildConfig(preserve) {
    const prev = {};
    if (preserve) CONFIG_SELECTS.forEach(id => { prev[id] = $(id).value; });
    const A = state.src.A, B = state.src.B;
    const plainA = plain(A.cols), plainB = plain(B.cols);
    const levees = isLevees();
    updateModeUI();
    $('move-threshold').value = levees ? 50 : 20;

    const pair = IO.guessKeyPair(A.preview, A.cols, B.preview, B.cols);
    fillSelect($('key-a'), plainA, pair.a, true);
    fillSelect($('key-b'), plainB, pair.b, true);
    $('opt-zeros').checked = pair.score > 0 && pair.scoreExact < pair.score * 0.8;
    $('key-hint').textContent = pair.score
      ? `${fmt(pair.score)} identifiants communs trouvés dans un échantillon` + ($('opt-zeros').checked ? ' (zéros en tête ignorés : ils diffèrent entre les deux fichiers)' : '') + '.'
      : 'Aucun identifiant commun détecté dans les 2 000 premières lignes : vérifiez les deux colonnes.';

    const crsOpts = Object.keys(IO.CRS);
    [['a', A], ['b', B]].forEach(([s, src]) => {
      const xy = IO.guessXY(src.cols);
      fillSelect($('x-' + s), src.cols, xy.x, true);
      fillSelect($('y-' + s), src.cols, xy.y, true);
      $('crs-' + s).innerHTML = crsOpts.map(c => `<option value="${c}">${IO.CRS[c]}</option>`).join('');
      $('crs-' + s).value = IO.guessCRS(src.preview, xy.x, xy.y);
    });

    fillSelect($('date-b'), plainB, IO.guessDate(B.preview, plainB), true);
    fillSelect($('weight-b'), plainB, IO.guessWeight(plainB), true);
    fillSelect($('date-a'), plainA, plainA.find(c => /livraison|mise en service|date.?pose|install/i.test(c)), true);
    fillSelect($('count-a'), plainA, plainA.find(c => /apparition|nb.*lev|nombre.*lev|pr[ée]sentation|passage/i.test(c)), true);

    if (levees) buildDisplayFields(plainA, pair.a);
    else buildFieldPairs(plainA, plainB, pair.a);

    if (preserve) CONFIG_SELECTS.forEach(id => { if (prev[id] && $(id).querySelector(`option[value="${CSS.escape(prev[id])}"]`)) $(id).value = prev[id]; });

    const group = $('group-by');
    fillSelect(group, plainA, plainA.find(c => /activit/i.test(c)) || plainA.find(c => /^secteur$/i.test(c)) ||
      plainA.find(c => /commune|ville/i.test(c)) || plainA.find(c => /flux/i.test(c)) || '', false);
    $('config').classList.remove('hidden');
  }

  // Mode inventaire : appariement automatique des colonnes de même nom.
  function buildFieldPairs(plainA, plainB, keyA) {
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
      sel.value = bByName.get(normName($('fp-' + sel.dataset.for).dataset.a)) || '';
      sel.addEventListener('change', () => { $('fp-' + sel.dataset.for).checked = !!sel.value; });
    });
  }

  // Mode levées : colonnes de la base client à afficher dans les résultats.
  function buildDisplayFields(plainA, keyA) {
    const skip = new Set([keyA, $('x-a').value, $('y-a').value, 'geo_lat', 'geo_lon', 'geo_score']);
    const useful = /commune|ville|^num[ée]ro$|type.*voie|nom.*voie|^nom$|activit|r[ée]cipient|secteur|geo_adresse|flux|volume/i;
    $('fields').innerHTML = plainA.map((c, i) => `<div class="pair single">
        <input type="checkbox" id="fp-${i}" data-a="${esc(c)}" ${!skip.has(c) && useful.test(c) ? 'checked' : ''}>
        <label class="name" for="fp-${i}" title="${esc(c)}">${esc(c)}</label>
      </div>`).join('');
  }

  $('type-b').addEventListener('change', () => { if (state.src.A && state.src.B) buildConfig(true); else updateModeUI(); });
  document.querySelectorAll('input[name=mode]').forEach(r => r.addEventListener('change', updateModeUI));

  function readOptions() {
    const levees = isLevees();
    const fieldPairs = [], display = [];
    $('fields').querySelectorAll('.pair').forEach(p => {
      const cb = p.querySelector('input'), sel = p.querySelector('select');
      if (!cb.checked) return;
      if (levees) display.push(cb.dataset.a);
      else if (sel.value) fieldPairs.push({ a: cb.dataset.a, b: sel.value });
    });
    return {
      mode: levees ? 'levees' : document.querySelector('input[name=mode]:checked').value,
      keyA: $('key-a').value, keyB: $('key-b').value,
      moveThreshold: Number($('move-threshold').value) || 0,
      matchRadius: Number($('match-radius').value) || 15,
      fieldPairs, display,
      dateCol: $('date-b').value, weightCol: $('weight-b').value,
      dateA: $('date-a').value, countA: $('count-a').value,
      seuilTaux: Number($('seuil-taux').value) || 0,
      seuilArret: Number($('seuil-arret').value) || 8,
      ignoreCase: $('opt-case').checked,
      ignoreAccents: $('opt-accents').checked,
      ignoreLeadingZeros: $('opt-zeros').checked
    };
  }

  $('btn-compare').addEventListener('click', runCompare);

  async function runCompare() {
    const err = $('error');
    err.classList.add('hidden');
    $('btn-compare').disabled = true;
    $('empty').classList.add('hidden');
    $('busy').classList.remove('hidden');
    $('busy-msg').textContent = isLevees() ? `Lecture de ${fmt(state.src.B.count)} levées…` : '';
    await new Promise(r => setTimeout(r, 50)); // laisse le message s'afficher
    try {
      const opts = readOptions();
      const A = state.src.A, B = state.src.B;
      const recA = IO.toRecords(A.source.all(A.sheet), $('x-a').value, $('y-a').value, $('crs-a').value);
      let result;
      if (opts.mode === 'levees') {
        if (!opts.keyA || !opts.keyB || !opts.dateCol) throw new Error('Choisissez les deux colonnes identifiant et la colonne date de levée.');
        const agg = Levees.createAggregator({
          keyCol: opts.keyB, dateCol: opts.dateCol, weightCol: opts.weightCol,
          xCol: $('x-b').value, yCol: $('y-b').value, project: IO.projector($('crs-b').value),
          ignoreLeadingZeros: opts.ignoreLeadingZeros
        });
        B.source.each(B.sheet, agg.add);
        const ag = agg.result();
        if (!ag.stats.levees) {
          throw new Error(`Aucune levée exploitable sur ${fmt(ag.stats.lignes)} lignes (${fmt(ag.stats.dateInvalide)} dates illisibles, ${fmt(ag.stats.sansCle)} sans identifiant). Vérifiez les colonnes date et identifiant.`);
        }
        result = Levees.analyser(recA, ag, opts);
      } else {
        const recB = IO.toRecords(B.source.all(B.sheet), $('x-b').value, $('y-b').value, $('crs-b').value);
        if (opts.mode === 'spatial' && (!recA.some(r => r.lat !== null) || !recB.some(r => r.lat !== null))) {
          throw new Error('Le mode proximité nécessite des coordonnées valides dans les deux bases.');
        }
        result = Compare.compare(recA, recB, opts);
      }
      result.rows.forEach((r, i) => { r._i = i; });
      state.result = result;
      state.opts = opts;
      state.filter = { tag: null, field: null, tranche: null, group: null, search: '' };
      state.sort = { col: null, asc: true };
      state.page = 0;
      $('search').value = '';
      $('busy').classList.add('hidden');
      $('results').classList.remove('hidden');
      initMap();
      renderAll(true);
    } catch (e) {
      $('busy').classList.add('hidden');
      (state.result ? $('results') : $('empty')).classList.remove('hidden');
      err.textContent = e.message;
      err.classList.remove('hidden');
    } finally {
      $('btn-compare').disabled = false;
    }
  }

  // ---------------------------------------------------------------------
  // Rendu
  // ---------------------------------------------------------------------
  function renderAll(fit) {
    renderKPIs();
    renderSide();
    renderSynth();
    applyFilters(fit);
  }

  function renderKPIs() {
    const { stats, rows } = state.result;
    const c = cats();
    const hasDist = rows.some(r => r.distance !== null);
    const spatial = state.opts.mode === 'spatial';
    $('kpis').innerHTML = Object.keys(c).map(tag => {
      const n = stats.byTag[tag] || 0;
      let na = false, sub;
      if (spatial && (tag === 'deplace' || tag === 'doublon')) { na = true; sub = 'mode identifiant uniquement'; }
      else if (lev() && tag === 'deplace' && !hasDist) { na = true; sub = 'coordonnées requises des deux côtés'; }
      else if (lev() && tag === 'seulB') sub = `${fmt(stats.leveesNonRef)} levées concernées`;
      else sub = pct(n, lev() ? stats.bacsClient : stats.total) + (lev() ? ' des bacs' : '');
      return `<button class="kpi ${state.filter.tag === tag ? 'active' : ''}" data-tag="${tag}" style="--kc:${cssVar(c[tag].color)}" ${na ? 'disabled' : ''}>
        <div class="v">${na ? '—' : fmt(n)}</div>
        <div class="l">${esc(c[tag].label)}</div>
        <div class="p">${esc(sub)}</div>
      </button>`;
    }).join('');
    $('kpis').querySelectorAll('.kpi').forEach(b => b.addEventListener('click', () => {
      state.filter.tag = state.filter.tag === b.dataset.tag ? null : b.dataset.tag;
      state.page = 0;
      renderKPIs();
      applyFilters();
    }));
  }

  function barRow(attrs, labelHtml, n, max, extra) {
    return `<tr ${attrs}><td>${labelHtml}<div class="bar" style="width:${max ? (100 * n / max).toFixed(0) : 0}%"></div></td><td class="n">${fmt(n)}</td>${extra || ''}</tr>`;
  }

  function renderSide() {
    const { stats } = state.result;
    let html;
    if (lev()) {
      const L = stats.levees;
      html = `<h3>Levées analysées</h3><table class="mini">
        <tr><td>Période</td><td class="n">${Levees.formatDay(L.debut)} → ${Levees.formatDay(L.fin)}</td></tr>
        <tr><td>Semaines</td><td class="n">${fmt(L.semainesPeriode)}</td></tr>
        <tr><td>Levées exploitées</td><td class="n">${fmt(L.levees)}</td></tr>
        ${L.sansCle ? `<tr><td>Levées sans identifiant</td><td class="n">${fmt(L.sansCle)}</td></tr>` : ''}
        ${L.dateInvalide ? `<tr><td>Dates illisibles</td><td class="n">${fmt(L.dateInvalide)}</td></tr>` : ''}
        <tr><td>Taux de présentation médian</td><td class="n">${stats.tauxMedian === null ? '—' : fmt(stats.tauxMedian) + ' %'}</td></tr>
      </table>`;

      const maxT = Math.max(...stats.tranches);
      html += `<h3>Taux de présentation des bacs</h3><table class="mini">` +
        stats.tranches.map((n, i) => barRow(`class="clickable ${state.filter.tranche === i ? 'active' : ''}" data-tranche="${i}"`, esc(TRANCHES[i]), n, maxT)).join('') +
        '</table><p class="muted">Semaines avec au moins une levée / semaines où le bac était en service.</p>';

      const mois = L.parMois;
      const med = Levees.median(mois.map(m => m[1])) || 0;
      const maxM = Math.max(...mois.map(m => m[1]));
      let alerte = false;
      html += `<h3>Levées par mois</h3><table class="mini">` + mois.map(([m, n]) => {
        const bas = n < 0.75 * med;
        alerte = alerte || bas;
        const [y, mm] = m.split('-');
        return barRow('', `${mm}/${y}${bas ? ' <span class="warn" title="Nettement sous la médiane">⚠</span>' : ''}`, n, maxM);
      }).join('') + '</table>' +
        (alerte ? '<p class="muted">⚠ Mois nettement sous la médiane : export incomplet, ou baisse réelle (vacances, intempéries) ?</p>' : '');

      if (state.opts.countA) {
        let ok = 0, ko = 0;
        for (const r of state.result.rows) {
          if (!r.a || r.lv.declare === null) continue;
          if (Math.abs(r.lv.ecart) <= Math.max(2, 0.1 * r.lv.declare)) ok++; else ko++;
        }
        html += `<h3>« ${esc(state.opts.countA)} »</h3><table class="mini">
          <tr><td>Concordant avec les levées (± 10 %)</td><td class="n">${fmt(ok)}</td></tr>
          <tr><td>Écart plus important</td><td class="n">${fmt(ko)}</td></tr></table>
          <p class="muted">Comparaison indicative : la période du fichier de levées peut différer de celle de la base client.</p>`;
      }
    } else {
      const max = Math.max(1, ...stats.byField.map(f => f.count));
      const rows = stats.byField.slice().sort((x, y) => y.count - x.count);
      html = '<h3>Écarts par champ</h3><table class="mini">' + (rows.length
        ? rows.map(f => barRow(`class="clickable ${state.filter.field === f.a ? 'active' : ''}" data-field="${esc(f.a)}"`,
          esc(f.a) + (f.a !== f.b ? ` <span class="muted">↔ ${esc(f.b)}</span>` : ''), f.count, max)).join('')
        : '<tr><td class="muted">Aucun champ comparé.</td></tr>') + '</table>';
      const md = stats.medianDistance;
      html += `<p class="muted">${fmt(stats.pairs)} bacs appariés` + (md !== null ? ` · écart de position médian : ${fmt(md)} m` : '') + '</p>';
    }
    $('side').innerHTML = html;
    $('side').querySelectorAll('tr[data-field]').forEach(tr => tr.addEventListener('click', () => {
      state.filter.field = state.filter.field === tr.dataset.field ? null : tr.dataset.field;
      state.page = 0; renderSide(); applyFilters();
    }));
    $('side').querySelectorAll('tr[data-tranche]').forEach(tr => tr.addEventListener('click', () => {
      const t = Number(tr.dataset.tranche);
      state.filter.tranche = state.filter.tranche === t ? null : t;
      state.page = 0; renderSide(); applyFilters();
    }));
  }

  // --- Synthèse par groupe (activité, secteur, commune...) ---
  const trancheOf = r => {
    if (!r.a || r.category === 'recent' || !r.lv || r.lv.taux === null) return null;
    const t = r.lv.taux;
    return t === 0 ? 0 : t < 25 ? 1 : t < 50 ? 2 : t < 75 ? 3 : 4;
  };
  function groupOf(r) {
    const col = $('group-by').value;
    if (!r.a) return '(absent de ' + label('A') + ')';
    const v = r.a.props[col];
    return v === undefined || v === null || String(v).trim() === '' ? '(vide)' : String(v).trim();
  }

  function renderSynth() {
    const c = cats();
    const keys = Object.keys(c).filter(k => k !== 'doublon');
    const groups = new Map();
    for (const r of state.result.rows) {
      const g = groupOf(r);
      if (!groups.has(g)) groups.set(g, { n: 0, cats: {}, taux: [] });
      const x = groups.get(g);
      x.n++;
      for (const k of keys) if (r.tags.includes(k)) x.cats[k] = (x.cats[k] || 0) + 1;
      if (lev() && r.a && r.b && r.lv.taux !== null) x.taux.push(r.lv.taux);
    }
    const list = Array.from(groups.entries()).sort((a, b) => b[1].n - a[1].n).slice(0, 300);
    $('synth').innerHTML = `<thead><tr><th>${esc($('group-by').value || '—')}</th><th class="n">Bacs</th>` +
      keys.map(k => `<th class="n"><i class="sw" style="background:${cssVar(c[k].color)}"></i>${esc(c[k].label)}</th>`).join('') +
      (lev() ? '<th class="n">Taux médian</th>' : '') + '</tr></thead><tbody>' +
      list.map(([g, x]) => `<tr data-group="${esc(g)}" class="${state.filter.group === g ? 'active' : ''}"><td>${esc(g)}</td><td class="n">${fmt(x.n)}</td>` +
        keys.map(k => `<td class="n">${x.cats[k] ? fmt(x.cats[k]) + ` <span class="muted">${pct(x.cats[k], x.n)}</span>` : ''}</td>`).join('') +
        (lev() ? `<td class="n">${x.taux.length ? fmt(Levees.median(x.taux)) + ' %' : ''}</td>` : '') + '</tr>').join('') + '</tbody>';
    $('synth').querySelectorAll('tbody tr').forEach(tr => tr.addEventListener('click', () => {
      state.filter.group = state.filter.group === tr.dataset.group ? null : tr.dataset.group;
      state.page = 0; renderSynth(); applyFilters();
    }));
  }
  $('group-by').addEventListener('change', () => { state.filter.group = null; renderSynth(); applyFilters(); });

  // --- Filtres ---
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
      (f.tranche === null || trancheOf(r) === f.tranche) &&
      (f.group === null || groupOf(r) === f.group) &&
      (!q || searchText(r).includes(q)));

    if (state.sort.col) {
      const col = columns().find(c => c.id === state.sort.col);
      const dir = state.sort.asc ? 1 : -1;
      if (col) {
        rows = rows.slice().sort((x, y) => {
          const vx = col.sort(x), vy = col.sort(y);
          if (vx === vy) return 0;
          if (vx === null || vx === undefined || vx === '') return 1;
          if (vy === null || vy === undefined || vy === '') return -1;
          return (typeof vx === 'number' && typeof vy === 'number' ? vx - vy : String(vx).localeCompare(String(vy), 'fr', { numeric: true })) * dir;
        });
      }
    }
    state.filtered = rows;

    const badges = [];
    if (f.tag) badges.push(cats()[f.tag].label);
    if (f.field) badges.push('écart sur « ' + f.field + ' »');
    if (f.tranche !== null) badges.push('taux ' + TRANCHES[f.tranche]);
    if (f.group !== null) badges.push($('group-by').value + ' = ' + f.group);
    $('filter-badge').classList.toggle('hidden', !badges.length);
    $('filter-badge').textContent = badges.join(' + ') + ' ✕';

    renderTable();
    renderMap(fit);
  }

  $('filter-badge').addEventListener('click', () => {
    state.filter = Object.assign(state.filter, { tag: null, field: null, tranche: null, group: null });
    state.page = 0;
    renderKPIs(); renderSide(); renderSynth(); applyFilters();
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
    const c = cats();
    return r.tags.map(t => `<span class="tag" style="--tc:${cssVar((c[t] || CATS.bacs.doublon).color)}">${esc(tagLabel(t))}</span>`).join('');
  }

  const aVal = (r, col) => r.a ? r.a.props[col] : '';

  // Identifiant tel qu'écrit dans la base A (ex. avec son zéro en tête), sinon dans B.
  function keyOf(r) {
    const o = state.opts;
    const v = r.a && o.keyA ? r.a.props[o.keyA] : r.b ? r.b.props[lev() ? 'identifiant' : o.keyB] : '';
    return v === undefined || v === null || v === '' ? r.key : String(v);
  }

  function columns() {
    const o = state.opts;
    const cols = [
      { id: 'statut', title: 'Statut', html: tagsHtml, sort: r => priority().indexOf(r.category) },
      { id: 'cle', title: 'Identifiant', html: r => esc(keyOf(r)), sort: keyOf }
    ];
    if (lev()) {
      o.display.forEach(d => cols.push({ id: 'a:' + d, title: d, html: r => esc(aVal(r, d)), sort: r => aVal(r, d) }));
      const ag = r => r.b ? r.b.agg : null;
      cols.push(
        { id: 'n', title: 'Levées', cls: 'n', html: r => ag(r) ? fmt(ag(r).n) : (r.a ? '0' : ''), sort: r => ag(r) ? ag(r).n : 0 },
        { id: 'sem', title: 'Semaines levées', cls: 'n', html: r => r.a ? `${ag(r) ? ag(r).semaines : 0} / ${fmt(r.lv.semainesPossibles)}` : (ag(r) ? ag(r).semaines : ''), sort: r => ag(r) ? ag(r).semaines : 0 },
        { id: 'taux', title: 'Taux présentation', cls: 'n', html: r => r.lv.taux === null ? '' : fmt(r.lv.taux) + ' %', sort: r => r.lv.taux },
        { id: 'last', title: 'Dernière levée', html: r => ag(r) ? Levees.formatDay(ag(r).last) : '', sort: r => ag(r) ? ag(r).last : null },
        { id: 'first', title: 'Première levée', html: r => ag(r) ? Levees.formatDay(ag(r).first) : '', sort: r => ag(r) ? ag(r).first : null }
      );
      if (o.weightCol) cols.push({ id: 'poids', title: 'Poids moyen (kg)', cls: 'n', html: r => ag(r) ? fmt(ag(r).poidsMoyen) : '', sort: r => ag(r) ? ag(r).poidsMoyen : null });
      if (o.dateA) cols.push({ id: 'liv', title: 'Livraison', html: r => esc(aVal(r, o.dateA)), sort: r => r.lv.livraison });
      if (o.countA) cols.push(
        { id: 'decl', title: 'Déclaré (A)', cls: 'n', html: r => fmt(r.lv.declare), sort: r => r.lv.declare },
        { id: 'ecart', title: 'Écart levées − déclaré', cls: 'n', html: r => r.lv.ecart === null ? '' : (r.lv.ecart > 0 ? '+' : '') + fmt(r.lv.ecart), sort: r => r.lv.ecart === null ? null : Math.abs(r.lv.ecart) }
      );
      if (state.result.rows.some(r => r.distance !== null)) {
        cols.push({ id: 'dist', title: 'Écart position (m)', cls: 'n', html: r => r.distance === null ? '' : fmt(Math.round(r.distance)), sort: r => r.distance });
      }
      return cols;
    }
    cols.push(
      { id: 'dist', title: 'Distance (m)', cls: 'n', html: r => r.distance === null ? '' : r.distance.toFixed(1).replace('.', ','), sort: r => r.distance },
      { id: 'nb', title: 'Nb écarts', cls: 'n', html: r => r.a && r.b ? r.diffs.length : '', sort: r => r.a && r.b ? r.diffs.length : null }
    );
    o.fieldPairs.forEach(p => {
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
    state.page = Math.max(0, Math.min(state.page, pages - 1));
    const slice = rows.slice(state.page * PAGE_SIZE, (state.page + 1) * PAGE_SIZE);

    $('table').innerHTML =
      '<thead><tr>' + cols.map(c => `<th data-col="${esc(c.id)}" class="${c.cls || ''} ${state.sort.col === c.id ? 'sorted' + (state.sort.asc ? ' asc' : '') : ''}">${esc(c.title)}</th>`).join('') + '</tr></thead>' +
      '<tbody>' + slice.map(r => `<tr data-i="${r._i}">` + cols.map(c => `<td class="${c.cls || ''}">${c.html(r)}</td>`).join('') + '</tr>').join('') + '</tbody>';

    $('page-info').textContent = rows.length
      ? `${fmt(state.page * PAGE_SIZE + 1)}–${fmt(state.page * PAGE_SIZE + slice.length)} sur ${fmt(rows.length)}`
      : 'Aucun résultat';
    $('prev').disabled = state.page === 0;
    $('next').disabled = state.page >= pages - 1;

    $('table').querySelectorAll('th').forEach(th => th.addEventListener('click', () => {
      state.sort = { col: th.dataset.col, asc: state.sort.col === th.dataset.col ? !state.sort.asc : th.classList.contains('n') ? false : true };
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
    const c = cats();
    const counts = {};
    let nonPlaces = 0;
    for (const r of state.filtered) {
      const p = posOf(r);
      if (!p) { nonPlaces++; continue; }
      const color = cssVar(c[r.category].color);
      counts[r.category] = (counts[r.category] || 0) + 1;
      if (r.tags.includes('deplace') && r.a && r.b && r.b.lat !== null) {
        L.polyline([p, [r.b.lat, r.b.lon]], { color, weight: 2, dashArray: '4 4', interactive: false }).addTo(dataLayer);
        L.circleMarker([r.b.lat, r.b.lon], { radius: 3, color, weight: 1, fillOpacity: 0, interactive: false }).addTo(dataLayer);
      }
      const m = L.circleMarker(p, { radius: 5, color: '#fff', weight: 1, fillColor: color, fillOpacity: 0.9 })
        .bindPopup(() => popupHtml(r), { maxWidth: 440 });
      m.addTo(dataLayer);
      markers.set(r._i, m);
    }
    legend.getContainer().innerHTML = priority().filter(k => counts[k])
      .map(k => `<div><i style="background:${cssVar(c[k].color)}"></i>${esc(c[k].label)} (${fmt(counts[k])})</div>`).join('') +
      (nonPlaces ? `<div class="muted">${fmt(nonPlaces)} sans position${lev() ? ' (géocodez la base A)' : ''}</div>` : '') || '<div>Aucun point localisé</div>';
    if (fit && dataLayer.getLayers().length) map.fitBounds(dataLayer.getBounds(), { padding: [20, 20] });
    setTimeout(() => map.invalidateSize(), 0);
  }

  function popupHtml(r) {
    const o = state.opts;
    const head = `<div class="pop"><h4>${esc(keyOf(r) || '(sans identifiant)')}</h4>${tagsHtml(r)}`;
    if (lev()) {
      const ag = r.b ? r.b.agg : null;
      const lines = o.display.filter(d => r.a && r.a.props[d] !== '' && r.a.props[d] !== undefined).map(d => [d, r.a.props[d]]);
      if (r.a) {
        lines.push(['Levées', ag ? fmt(ag.n) : '0']);
        lines.push(['Taux de présentation', r.lv.taux === null ? '—' : `${fmt(r.lv.taux)} % (${ag ? ag.semaines : 0} sem. / ${fmt(r.lv.semainesPossibles)})`]);
      } else lines.push(['Levées (puce absente de ' + label('A') + ')', fmt(ag.n)]);
      if (ag) lines.push(['Première / dernière levée', Levees.formatDay(ag.first) + ' → ' + Levees.formatDay(ag.last)]);
      if (ag && ag.poidsMoyen !== null) lines.push(['Poids moyen', fmt(ag.poidsMoyen) + ' kg']);
      if (r.lv.declare !== null) lines.push(['Déclaré dans ' + label('A'), fmt(r.lv.declare)]);
      if (r.distance !== null) lines.push(['Écart bac ↔ position des levées', fmt(Math.round(r.distance)) + ' m']);
      return head + `<table>${lines.map(([k, v]) => `<tr><td>${esc(k)}</td><td><b>${esc(v)}</b></td></tr>`).join('')}</table></div>`;
    }
    const lines = [];
    if (o.keyA || o.keyB) lines.push({ name: 'Identifiant', va: r.a && o.keyA ? r.a.props[o.keyA] : '', vb: r.b && o.keyB ? r.b.props[o.keyB] : '', diff: false });
    o.fieldPairs.forEach(p => lines.push({ name: p.a, va: r.a ? r.a.props[p.a] : '', vb: r.b ? r.b.props[p.b] : '', diff: r.diffs.some(d => d.a === p.a) }));
    const dist = r.distance !== null ? `<p>Distance entre les deux positions : <b>${r.distance.toFixed(1).replace('.', ',')} m</b></p>` : '';
    return head + `${dist}<table><tr><th>Champ</th><th>${esc(label('A'))}</th><th>${esc(label('B'))}</th></tr>
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
  const c7 = v => v === null || v === undefined ? null : Number(v.toFixed(7));

  function exportRecords() {
    const o = state.opts;
    return state.filtered.map(r => {
      const props = {
        statut: tagLabel(r.category),
        etiquettes: r.tags.map(tagLabel).join(', '),
        identifiant: keyOf(r)
      };
      if (lev()) {
        const ag = r.b ? r.b.agg : null;
        o.display.forEach(d => { props[d] = r.a ? r.a.props[d] : ''; });
        Object.assign(props, {
          nb_levees: ag ? ag.n : 0,
          jours_avec_levee: ag ? ag.jours : 0,
          semaines_avec_levee: ag ? ag.semaines : 0,
          semaines_en_service: r.a ? r.lv.semainesPossibles : '',
          taux_presentation_pct: r.lv.taux === null ? '' : Number(r.lv.taux.toFixed(1)),
          premiere_levee: ag ? Levees.formatDay(ag.first) : '',
          derniere_levee: ag ? Levees.formatDay(ag.last) : '',
          poids_total_kg: ag && ag.poidsTotal !== null ? Number(ag.poidsTotal.toFixed(1)) : '',
          poids_moyen_kg: ag && ag.poidsMoyen !== null ? Number(ag.poidsMoyen.toFixed(1)) : '',
          nb_declare: r.lv.declare === null ? '' : r.lv.declare,
          ecart_levees_declare: r.lv.ecart === null ? '' : r.lv.ecart,
          ecart_position_m: r.distance === null ? '' : Math.round(r.distance),
          lat_bac: r.a ? c7(r.a.lat) : null, lon_bac: r.a ? c7(r.a.lon) : null,
          lat_levees: r.b ? c7(r.b.lat) : null, lon_levees: r.b ? c7(r.b.lon) : null
        });
      } else {
        Object.assign(props, {
          distance_m: r.distance === null ? '' : Number(r.distance.toFixed(2)),
          nb_ecarts: r.a && r.b ? r.diffs.length : '',
          champs_en_ecart: r.diffs.map(d => d.a).join(', ')
        });
        o.fieldPairs.forEach(p => {
          props['A_' + p.a] = r.a ? r.a.props[p.a] : '';
          props['B_' + p.b] = r.b ? r.b.props[p.b] : '';
        });
        props.lat_A = r.a ? c7(r.a.lat) : null; props.lon_A = r.a ? c7(r.a.lon) : null;
        props.lat_B = r.b ? c7(r.b.lat) : null; props.lon_B = r.b ? c7(r.b.lon) : null;
      }
      return { props, pos: posOf(r) };
    });
  }

  const stamp = () => new Date().toISOString().slice(0, 10);
  const exportName = () => (lev() ? 'analyse_levees_' : 'comparaison_bacs_') + stamp();

  $('btn-export-csv').addEventListener('click', () => {
    const recs = exportRecords();
    if (!recs.length) return;
    const header = Object.keys(recs[0].props);
    const lines = recs.map(r => header.map(h => {
      const v = r.props[h];
      return typeof v === 'number' ? String(v).replace('.', ',') : v;
    }));
    IO.download(exportName() + '.csv', IO.toCSV(header, lines), 'text/csv;charset=utf-8');
  });

  $('btn-export-geojson').addEventListener('click', () => {
    const features = exportRecords().filter(r => r.pos).map(r => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [r.pos[1], r.pos[0]] },
      properties: r.props
    }));
    IO.download(exportName() + '.geojson', JSON.stringify({ type: 'FeatureCollection', features }), 'application/geo+json');
  });

  // ---------------------------------------------------------------------
  // Exemples
  // ---------------------------------------------------------------------
  function loadDemo(labelA, labelB, fileA, fileB, sheetsA, sheetsB) {
    $('label-a').value = labelA;
    $('label-b').value = labelB;
    $('file-a').nextElementSibling.textContent = fileA;
    $('file-b').nextElementSibling.textContent = fileB;
    state.src.A = state.src.B = null;
    setSource('A', IO.arraySource(sheetsA));
    setSource('B', IO.arraySource(sheetsB));
    runCompare();
  }

  $('btn-demo').addEventListener('click', () => {
    const d = Demo.generate(1500, 42);
    loadDemo('Base SIG', 'Base facturation', 'exemple_sig (généré)', 'exemple_facturation (généré)',
      { exemple: d.sig }, { exemple: d.metier });
  });

  $('btn-demo-levees').addEventListener('click', () => {
    const d = Demo.generateLevees(1500, 7);
    loadDemo('Base client', 'Levées 2025', 'base_bacs_biodechets (fictive)', 'levees_2025 (fictives)',
      { Feuil1: d.clients }, { 'Levées': d.levees });
  });

  updateModeUI();
})();
