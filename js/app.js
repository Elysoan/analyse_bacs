/* Interface : assistant de chargement, paramétrage, géocodage, carte, tableaux et exports. */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const PAGE_SIZE = 100;

  // Catégories, dans l'ordre d'affichage des indicateurs (les priorités métier d'abord).
  const CATS = {
    levees: {
      seulB: { label: 'Puces levées non référencées', color: '--c-seulB' },
      autre_flux: { label: 'Levés aussi sur un autre flux', color: '--c-autre' },
      seulA: { label: 'Jamais levés', color: '--c-seulA' },
      arret: { label: 'Plus levés récemment', color: '--c-arret' },
      faible: { label: 'Taux de présentation faible', color: '--c-faible' },
      recent: { label: 'Livrés récemment, pas encore levés', color: '--c-recent' },
      identique: { label: 'Levés régulièrement', color: '--c-identique' },
      deplace: { label: 'Écart de position', color: '--c-deplace' }
    },
    bacs: {
      seulA: { label: 'Uniquement A', color: '--c-seulA' },
      seulB: { label: 'Uniquement B', color: '--c-seulB' },
      attributs: { label: 'Écarts attributaires', color: '--c-autre' },
      deplace: { label: 'Déplacés', color: '--c-deplace' },
      doublon: { label: 'Doublons', color: '--c-doublon' },
      identique: { label: 'Identiques', color: '--c-identique' }
    }
  };
  // Seules 3 catégories sont colorées dans la vue d'ensemble de la carte (lisibilité, daltonisme).
  const OVERVIEW = { levees: ['seulB', 'seulA', 'autre_flux'], bacs: ['seulB', 'seulA', 'attributs'] };
  const TAGS = {
    bacs: { identique: 'identique', attributs: 'attributs', deplace: 'déplacé', seulA: 'seul A', seulB: 'seul B',
      doublon: 'doublon', sans_cle: 'sans identifiant', sans_coord: 'sans coordonnées' },
    levees: { identique: 'régulier', faible: 'taux faible', arret: 'arrêt', seulA: 'jamais levé', recent: 'récent',
      seulB: 'non référencé', autre_flux: 'autre flux', deplace: 'écart position', doublon: 'doublon', sans_cle: 'sans identifiant' }
  };
  const TRANCHES = ['0 % (jamais levé)', '1 – 24 %', '25 – 49 %', '50 – 74 %', '75 – 100 %'];

  const state = {
    src: { A: null, B: null },       // { source, sheet, preview, cols, count, name }
    result: null, opts: null,
    filter: {}, sort: { col: null, asc: true },
    page: 0, filtered: [], tab: null
  };
  const NO_FILTER = () => ({ tag: null, field: null, tranche: null, group: null, flux: null, statut: null, search: '' });
  state.filter = NO_FILTER();

  const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const esc = v => String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const fmt = n => n === null || n === undefined || !Number.isFinite(n) ? '' : n.toLocaleString('fr-FR', { maximumFractionDigits: 1 });
  const pct = (n, d) => d ? (100 * n / d).toFixed(1).replace('.', ',') + ' %' : '';
  const label = side => $(side === 'A' ? 'label-a' : 'label-b').value || (side === 'A' ? 'Base client' : 'Base 2');
  const isLevees = () => $('type-b').value === 'levees';
  const lev = () => state.opts && state.opts.mode === 'levees';
  const mode = () => lev() ? 'levees' : 'bacs';
  const plain = cols => cols.filter(c => !c.startsWith('__'));
  const fluxLabel = () => state.opts && state.opts.fluxKeep ? Array.from(state.opts.fluxKeep).join(', ') : '';
  const tagLabel = t => TAGS[mode()][t] || t;
  const priority = () => lev() ? Levees.PRIORITE : Compare.CATEGORIES;
  const tick = () => new Promise(r => setTimeout(r, 30)); // laisse le navigateur afficher un message

  function cats() {
    const o = state.opts;
    const c = JSON.parse(JSON.stringify(CATS[mode()]));
    if (lev()) {
      c.faible.label = `Taux de présentation < ${o.seuilTaux} %`;
      c.arret.label = `Sans levée depuis ≥ ${o.seuilArret} sem.`;
      const fl = fluxLabel();
      if (fl) {
        c.seulA.label = `Jamais levés en ${fl}`;
        c.seulB.label = `Puces ${fl} levées, absentes de la base client`;
        c.autre_flux.label = `Bacs client levés aussi hors ${fl}`;
      } else delete c.autre_flux;
    } else {
      c.seulA.label = 'Uniquement dans ' + label('A');
      c.seulB.label = 'Uniquement dans ' + label('B');
    }
    return c;
  }

  function describe(tag) {
    const o = state.opts || { seuilTaux: 25, seuilArret: 8, moveThreshold: 50 };
    const fl = fluxLabel() || 'FFOM';
    const D = {
      levees: {
        seulB: `Puces levées en ${fl} qui n'existent pas dans la base client. Position = point médian de leurs levées. À vérifier / facturer.`,
        autre_flux: `Bacs de la base client levés au moins une fois sur un autre flux (ex. OMR) : erreur de tournée ou puce mal affectée ?`,
        seulA: `Bacs de la base client sans aucune levée ${fl} retenue sur la période.`,
        arret: `Bacs levés pendant la période, mais plus depuis ${o.seuilArret} semaines : retirés, vacants, puce hors service ?`,
        faible: `Bacs présentés moins de ${o.seuilTaux} % des semaines où ils étaient en service.`,
        recent: `Jamais levés, mais livrés trop récemment pour conclure.`,
        identique: `Bacs levés régulièrement, sans autre anomalie.`,
        deplace: `Bac situé à plus de ${o.moveThreshold} m de la position médiane de ses levées (adresse ou géocodage à vérifier).`
      },
      bacs: {
        seulA: `Bacs présents uniquement dans ${label('A')}.`,
        seulB: `Bacs présents uniquement dans ${label('B')}.`,
        attributs: 'Au moins un des champs comparés diffère.',
        deplace: `Même identifiant, positions distantes de plus de ${o.moveThreshold} m.`,
        doublon: 'Identifiant présent plusieurs fois dans une base.',
        identique: 'Mêmes valeurs et même position.'
      }
    };
    return (D[state.opts ? mode() : 'levees'] || {})[tag] || '';
  }

  // ---------------------------------------------------------------------
  // Notifications, aide, menus
  // ---------------------------------------------------------------------
  function toast(msg, type) {
    const t = document.createElement('div');
    t.className = 'toast' + (type === 'error' ? ' error' : '');
    t.textContent = msg;
    $('toasts').appendChild(t);
    setTimeout(() => t.remove(), type === 'error' ? 9000 : 4500);
  }

  $('btn-help').addEventListener('click', () => {
    const keys = Object.keys(CATS.levees);
    const saved = state.opts;
    if (!lev()) state.opts = null; // définitions du mode levées
    $('help-defs').innerHTML = keys.map(k => `<dt><i class="sw" style="background:${cssVar(CATS.levees[k].color)}"></i>${esc(CATS.levees[k].label)}</dt><dd>${esc(describe(k))}</dd>`).join('');
    state.opts = saved;
    $('help').showModal();
  });
  $('help').addEventListener('click', e => { if (e.target === $('help') || e.target.hasAttribute('data-close')) $('help').close(); });

  $('btn-examples').addEventListener('click', e => { e.stopPropagation(); $('menu-examples').classList.toggle('hidden'); });
  document.addEventListener('click', () => $('menu-examples').classList.add('hidden'));

  $('btn-toggle-side').addEventListener('click', () => {
    const c = $('layout').classList.toggle('collapsed');
    $('btn-toggle-side').textContent = c ? '⟩ Réglages' : '⟨ Réglages';
    if (map) setTimeout(() => map.invalidateSize(), 50);
  });

  // ---------------------------------------------------------------------
  // Étapes 1 et 2 : chargement des fichiers (clic ou glisser-déposer)
  // ---------------------------------------------------------------------
  ['A', 'B'].forEach(side => {
    const s = side.toLowerCase();
    const drop = $('drop-' + s);
    $('file-' + s).addEventListener('change', e => { if (e.target.files[0]) loadFile(side, e.target.files[0]); e.target.value = ''; });
    ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, () => drop.classList.remove('over')));
    drop.addEventListener('drop', e => { e.preventDefault(); if (e.dataTransfer.files[0]) loadFile(side, e.dataTransfer.files[0]); });
    $('sheet-' + s).querySelector('select').addEventListener('change', ev => selectSheet(side, ev.target.value));
    $('label-' + s).addEventListener('input', () => { if (state.result) renderAll(); });
  });
  document.querySelectorAll('[data-change]').forEach(b => b.addEventListener('click', () => resetSide(b.dataset.change.toUpperCase())));

  async function loadFile(side, file) {
    const s = side.toLowerCase();
    const drop = $('drop-' + s);
    drop.classList.add('loading');
    drop.querySelector('b').textContent = file.size > 10e6 ? `Lecture de ${file.name} (gros fichier, jusqu'à 30 s)` : 'Lecture de ' + file.name;
    await tick();
    try {
      const source = await IO.readFile(file);
      source.name = file.name;
      setSource(side, source);
    } catch (err) {
      toast(`Impossible de lire ${file.name} : ${err.message}`, 'error');
    } finally {
      drop.classList.remove('loading');
      drop.querySelector('b').textContent = 'Déposer le fichier ici';
    }
  }

  function resetSide(side) {
    const s = side.toLowerCase();
    state.src[side] = null;
    $('chip-' + s).classList.add('hidden');
    $('drop-' + s).classList.remove('hidden');
    $('sheet-' + s).classList.add('hidden');
    if (side === 'A') $('geo-a').classList.add('hidden');
    if (side === 'B') $('type-b-box').classList.add('hidden');
    updateSteps();
  }

  function setSource(side, source) {
    state.src[side] = { source, name: source.name || '' };
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
    const s = side.toLowerCase();
    const src = state.src[side];
    src.sheet = name;
    src.preview = src.source.preview(name);
    src.cols = IO.columnsOf(src.preview);
    src.count = src.source.count(name);
    const approx = src.source.kind === 'csv' ? '≈ ' : '';
    $('name-' + s).textContent = src.name || 'Fichier chargé';
    $('info-' + s).textContent = `${approx}${fmt(src.count)} lignes · ${plain(src.cols).length} colonnes${src.source.geo ? ' · géométrie' : ''}`;
    $('chip-' + s).classList.remove('hidden');
    $('drop-' + s).classList.add('hidden');
    if (side === 'A') setupGeo();
    if (side === 'B') {
      $('type-b-box').classList.remove('hidden');
      $('type-b').value = looksLikeLevees(src) ? 'levees' : 'bacs';
    }
    if (state.src.A && state.src.B) buildConfig();
    updateSteps();
  }

  function looksLikeLevees(src) {
    if (!IO.guessDate(src.preview, src.cols)) return false;
    return src.cols.some(c => /lev[ée]e|tourn[ée]e|collecte|horodat|v[ée]hicule|\bbom\b/i.test(c)) ||
      (state.src.A && src.count > 3 * state.src.A.count);
  }

  function updateSteps() {
    const a = !!state.src.A, b = !!state.src.B;
    $('step-a').classList.toggle('done', a);
    $('step-b').classList.toggle('done', b);
    $('step-a').classList.toggle('active', !a);
    $('step-b').classList.toggle('active', a && !b);
    $('step-c').classList.toggle('locked', !(a && b));
    $('step-c').classList.toggle('active', a && b);
    $('config').classList.toggle('hidden', !(a && b));
    $('btn-compare').disabled = !(a && b);
    $('run-hint').textContent = a && b ? 'Vérifiez les colonnes proposées, puis lancez.' : !a ? 'Commencez par la base client.' : 'Ajoutez maintenant le fichier des levées.';
  }

  // ---------------------------------------------------------------------
  // Géocodage de la base client
  // ---------------------------------------------------------------------
  const GEO_FIELDS = ['numero', 'indice', 'typeVoie', 'voie', 'cp', 'commune'];

  function setupGeo() {
    const A = state.src.A;
    const cols = plain(A.cols);
    const guess = Geocode.guessColumns(cols);
    const xy = IO.guessXY(A.cols);
    $('geo-a').classList.toggle('hidden', !(guess.voie || guess.commune));
    $('geo-a').open = false;
    $('geo-a').querySelector('summary').innerHTML = xy.x && xy.y
      ? '📍 Coordonnées trouvées <span class="muted">· géocoder quand même</span>'
      : '📍 Placer les bacs sur la carte <span class="muted">(pas de coordonnées : géocodage)</span>';
    GEO_FIELDS.forEach(f => fillSelect($('geo-' + f), cols, guess[f], true));
    $('geo-noise').value = Geocode.detectNoise(A.preview, guess.voie);
    $('geo-status').textContent = '';
    $('btn-geo-export').classList.add('hidden');
    $('geo-progress').classList.add('hidden');
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
    $('geo-example').innerHTML = `Exemple envoyé : <b>${esc(a.adresse)}, ${esc(a.commune)}</b>` + (a.secteur ? ` · secteur : ${esc(a.secteur)}` : '');
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
      // La base devient une table en mémoire enrichie des colonnes géocodées.
      const sheet = A.sheet, name = A.name;
      state.src.A = { source: IO.arraySource({ [sheet]: rows }), name };
      const S = state.src.A;
      S.sheet = sheet; S.preview = S.source.preview(sheet); S.cols = IO.columnsOf(S.preview); S.count = S.source.count(sheet);
      $('info-a').textContent = `${fmt(S.count)} lignes · ${plain(S.cols).length} colonnes · géocodée`;
      if (state.src.B) {
        buildConfig(true);
        $('x-a').value = 'geo_lon'; $('y-a').value = 'geo_lat'; $('crs-a').value = 'EPSG:4326';
      }
      status.textContent = `${fmt(ok)} bacs géocodés sur ${fmt(rows.length)}` +
        (douteux ? ` · ${fmt(douteux)} à vérifier (score < 0,5 : adresse approximative)` : '') +
        (rows.length - ok ? ` · ${fmt(rows.length - ok)} non trouvés` : '');
      $('btn-geo-export').classList.remove('hidden');
      toast(`Géocodage terminé : ${fmt(ok)} bacs placés sur la carte.`);
    } catch (e) {
      status.textContent = 'Échec : ' + e.message;
      toast('Géocodage impossible : le service data.geopf.fr (IGN) doit être accessible depuis votre poste.', 'error');
    } finally {
      btn.disabled = false;
    }
  });

  $('btn-geo-export').addEventListener('click', () => {
    const rows = state.src.A.source.all(state.src.A.sheet);
    const header = plain(IO.columnsOf(rows));
    IO.download('base_geocodee.csv', IO.toCSV(header, rows.map(r => header.map(h => r[h]))), 'text/csv;charset=utf-8');
  });

  // ---------------------------------------------------------------------
  // Étape 3 : paramétrage
  // ---------------------------------------------------------------------
  function fillSelect(sel, cols, value, allowEmpty) {
    const opts = (allowEmpty ? ['<option value="">—</option>'] : [])
      .concat(cols.map(c => `<option value="${esc(c)}">${esc(c === '__x' ? '(géométrie X)' : c === '__y' ? '(géométrie Y)' : c)}</option>`));
    sel.innerHTML = opts.join('');
    sel.value = value || '';
  }

  const normName = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const CONFIG_SELECTS = ['flux-b', 'statut-b', 'key-a', 'key-b', 'x-a', 'y-a', 'crs-a', 'x-b', 'y-b', 'crs-b', 'date-b', 'weight-b', 'date-a', 'count-a'];

  function updateModeUI() {
    const levees = isLevees();
    const spatial = !levees && document.querySelector('input[name=mode]:checked').value === 'spatial';
    document.querySelectorAll('.only-levees').forEach(e => e.classList.toggle('hidden', !levees));
    document.querySelectorAll('.only-bacs').forEach(e => e.classList.toggle('hidden', levees));
    document.querySelectorAll('.opt-key').forEach(e => e.classList.toggle('hidden', spatial));
    document.querySelectorAll('.opt-spatial').forEach(e => e.classList.toggle('hidden', !spatial));
    $('step-b').querySelector('h2').textContent = levees ? 'Levées' : 'Deuxième base';
    $('move-label').textContent = levees ? 'Écart bac ↔ levées signalé au-delà de (m)' : 'Seuil « déplacé » (m)';
    $('fields-title').textContent = levees ? 'Colonnes de la base client affichées' : 'Champs à comparer';
    $('key-b-label').textContent = levees ? 'Identifiant levées' : 'Identifiant base 2';
    $('x-b-label').textContent = levees ? 'X levées' : 'X base 2';
    $('y-b-label').textContent = levees ? 'Y levées' : 'Y base 2';
    if (!levees && $('label-b').value === 'Levées') $('label-b').value = 'Base 2';
    if (levees && $('label-b').value === 'Base 2') $('label-b').value = 'Levées';
  }

  function guessStatut(cols) {
    return cols.find(c => /libell/i.test(c) && /lev[ée]e/i.test(c)) ||
      cols.find(c => /(statut|[ée]tat|r[ée]sultat).*lev[ée]e/i.test(c)) || '';
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
    const hint = $('key-hint');
    hint.className = 'hint ' + (pair.score ? 'ok' : 'ko');
    hint.textContent = pair.score
      ? `✓ ${fmt(pair.score)} identifiants communs trouvés sur un échantillon` + ($('opt-zeros').checked ? ' (0 en tête retiré par Excel : géré)' : '')
      : '⚠ Aucun identifiant commun détecté : choisissez les deux colonnes à rapprocher.';

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
    fillSelect($('flux-b'), plainB, IO.guessFlux(B.preview, plainB), true);
    fillSelect($('statut-b'), plainB, guessStatut(plainB), true);
    fillSelect($('date-a'), plainA, plainA.find(c => /livraison|mise en service|date.?pose|install/i.test(c)), true);
    fillSelect($('count-a'), plainA, plainA.find(c => /apparition|nb.*lev|nombre.*lev|pr[ée]sentation|passage/i.test(c)), true);

    if (levees) buildDisplayFields(plainA, pair.a);
    else buildFieldPairs(plainA, plainB, pair.a);

    if (preserve) CONFIG_SELECTS.forEach(id => { if (prev[id] && $(id).querySelector(`option[value="${CSS.escape(prev[id])}"]`)) $(id).value = prev[id]; });
    fillPills('flux', preserve);
    fillPills('statut', preserve);

    fillSelect($('group-by'), plainA, plainA.find(c => /activit/i.test(c)) || plainA.find(c => /^secteur$/i.test(c)) ||
      plainA.find(c => /commune|ville/i.test(c)) || plainA.find(c => /flux/i.test(c)) || '', false);
  }

  // Inventaires : appariement automatique des colonnes de même nom.
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

  // Levées : colonnes de la base client à afficher dans les résultats.
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

  /*
   * Pastilles de valeurs pour les filtres de levées (lues sur tout le fichier) :
   * flux -> ceux qui évoquent les biodéchets cochés par défaut ;
   * statut -> tout sauf les levées « non collectées ».
   */
  const pillsCol = { flux: null, statut: null };
  function fillPills(kind, preserve) {
    const col = $(kind + '-b').value;
    const box = $(kind + '-values');
    $(kind + '-box').classList.toggle('hidden', !col);
    if (!col) { box.innerHTML = ''; pillsCol[kind] = null; return; }
    const prevChecked = preserve && pillsCol[kind] === col
      ? new Set(Array.from(box.querySelectorAll('input:checked')).map(i => i.value)) : null;
    const B = state.src.B;
    const values = B.source.distinct ? B.source.distinct(B.sheet, col) : [];
    let def;
    if (kind === 'flux') {
      const bio = values.filter(([v]) => /ffom|bio|ferment|alimentaire|d[ée]chets? verts?/i.test(v)).map(([v]) => v);
      def = new Set(bio.length ? bio : values.map(([v]) => v));
    } else {
      def = new Set(values.filter(([v]) => !/non[ -]?collect/i.test(v)).map(([v]) => v));
    }
    box.innerHTML = values.map(([v, n]) => `<label class="pill" title="${esc(v)} : ${fmt(n)} levées"><input type="checkbox" value="${esc(v)}" ${(prevChecked || def).has(v) ? 'checked' : ''}><span>${esc(v)} <small>${fmt(n)}</small></span></label>`).join('');
    pillsCol[kind] = col;
  }
  $('flux-b').addEventListener('change', () => fillPills('flux', false));
  $('statut-b').addEventListener('change', () => fillPills('statut', false));

  const checkedSet = id => new Set(Array.from($(id).querySelectorAll('input:checked')).map(i => i.value));

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
      fluxCol: levees ? $('flux-b').value : '',
      fluxKeep: levees && $('flux-b').value ? checkedSet('flux-values') : null,
      statutCol: levees ? $('statut-b').value : '',
      statutKeep: levees && $('statut-b').value ? checkedSet('statut-values') : null,
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
    const t0 = Date.now();
    $('btn-compare').disabled = true;
    ['empty', 'results'].forEach(id => $(id).classList.add('hidden'));
    $('busy').classList.remove('hidden');
    $('busy-msg').textContent = isLevees() ? `Lecture de ${fmt(state.src.B.count)} levées et rapprochement avec ${fmt(state.src.A.count)} bacs…` : 'Rapprochement des deux bases…';
    await tick();
    try {
      const opts = readOptions();
      const A = state.src.A, B = state.src.B;
      const recA = IO.toRecords(A.source.all(A.sheet), $('x-a').value, $('y-a').value, $('crs-a').value);
      let result;
      if (opts.mode === 'levees') {
        if (!opts.keyA || !opts.keyB || !opts.dateCol) throw new Error('Choisissez les deux colonnes identifiant et la colonne date de levée (réglages avancés).');
        if (opts.fluxKeep && !opts.fluxKeep.size) throw new Error('Cochez au moins un flux à analyser.');
        if (opts.statutKeep && !opts.statutKeep.size) throw new Error('Cochez au moins un statut de levée à retenir.');
        const agg = Levees.createAggregator({
          keyCol: opts.keyB, dateCol: opts.dateCol, weightCol: opts.weightCol,
          xCol: $('x-b').value, yCol: $('y-b').value, project: IO.projector($('crs-b').value),
          fluxCol: opts.fluxCol, fluxKeep: opts.fluxKeep,
          statutCol: opts.statutCol, statutKeep: opts.statutKeep,
          ignoreLeadingZeros: opts.ignoreLeadingZeros
        });
        B.source.each(B.sheet, agg.add);
        const ag = agg.result();
        if (!ag.stats.levees) {
          const s = ag.stats;
          throw new Error(`Aucune levée exploitable sur ${fmt(s.lignes)} lignes (${fmt(s.dateInvalide)} dates illisibles, ${fmt(s.sansCle)} sans identifiant` +
            (s.autresFlux ? `, ${fmt(s.autresFlux)} sur d'autres flux` : '') + (s.statutsExclus ? `, ${fmt(s.statutsExclus)} statuts écartés` : '') +
            '). Vérifiez les colonnes date, identifiant et flux.');
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
      state.filter = NO_FILTER();
      state.sort = { col: null, asc: true };
      state.page = 0;
      state.tab = null;
      $('search').value = '';
      $('busy').classList.add('hidden');
      $('results').classList.remove('hidden');
      $('btn-toggle-side').classList.remove('hidden');
      initMap();
      renderAll(true);
      toast(`Analyse terminée en ${((Date.now() - t0) / 1000).toFixed(1).replace('.', ',')} s.`);
    } catch (e) {
      $('busy').classList.add('hidden');
      $(state.result ? 'results' : 'empty').classList.remove('hidden');
      toast(e.message, 'error');
      $('run-hint').textContent = e.message;
    } finally {
      $('btn-compare').disabled = false;
    }
  }

  // ---------------------------------------------------------------------
  // Rendu des résultats
  // ---------------------------------------------------------------------
  function renderAll(fit) {
    renderContext();
    renderKPIs();
    renderSide();
    renderSynth();
    applyFilters(fit);
  }

  function renderContext() {
    const { stats } = state.result;
    if (lev()) {
      const L = stats.levees;
      $('context').textContent = `${fmt(stats.bacsClient)} bacs client · ${fmt(L.levees)} levées analysées` +
        (fluxLabel() ? ` (${fluxLabel()})` : '') + ` · du ${Levees.formatDay(L.debut)} au ${Levees.formatDay(L.fin)}`;
    } else {
      $('context').textContent = `${label('A')} × ${label('B')} · ${fmt(stats.pairs)} bacs appariés sur ${fmt(stats.total)}`;
    }
  }

  function renderKPIs() {
    const { stats, rows } = state.result;
    const c = cats();
    const hasDist = rows.some(r => r.distance !== null);
    const spatial = state.opts.mode === 'spatial';
    const prio = OVERVIEW[mode()];
    $('kpis').innerHTML = Object.keys(c).map(tag => {
      const n = stats.byTag[tag] || 0;
      let na = false, sub;
      if (spatial && (tag === 'deplace' || tag === 'doublon')) { na = true; sub = 'mode identifiant uniquement'; }
      else if (lev() && tag === 'deplace' && !hasDist) { na = true; sub = 'coordonnées requises des deux côtés'; }
      else if (lev() && tag === 'seulB') sub = `${fmt(stats.leveesNonRef)} levées concernées`;
      else sub = pct(n, lev() ? stats.bacsClient : stats.total) + (lev() ? ' des bacs client' : '');
      if (na) return ''; // indicateur non calculable avec ces données : on ne l'affiche pas
      return `<button class="kpi ${prio.includes(tag) ? 'prio' : ''} ${state.filter.tag === tag ? 'active' : ''}" data-tag="${tag}"
          style="--kc:${cssVar(c[tag].color)}" title="${esc(describe(tag))}">
        <div class="v">${fmt(n)}</div>
        <div class="l">${esc(c[tag].label)}</div>
        <div class="p">${esc(sub)}</div>
      </button>`;
    }).join('');
    $('kpis').querySelectorAll('.kpi').forEach(b => b.addEventListener('click', () => {
      state.filter.tag = state.filter.tag === b.dataset.tag ? null : b.dataset.tag;
      state.page = 0;
      renderKPIs();
      applyFilters(true);
    }));
  }

  function barRow(attrs, labelHtml, n, max, extra) {
    return `<tr ${attrs}><td>${labelHtml}<div class="bar" style="width:${max ? Math.max(1, 100 * n / max).toFixed(0) : 0}%"></div></td><td class="n">${fmt(n)}</td>${extra || ''}</tr>`;
  }

  // --- Panneau latéral à onglets ---
  function sideTabs() {
    if (!lev()) return [['ecarts', 'Écarts par champ']];
    const t = [];
    if (state.opts.fluxCol || state.opts.statutCol) t.push(['flux', 'Flux & statuts']);
    t.push(['mois', 'Par mois'], ['taux', 'Présentation'], ['qualite', 'Qualité']);
    return t;
  }

  function renderSide() {
    const tabs = sideTabs();
    if (!tabs.some(t => t[0] === state.tab)) state.tab = tabs[0][0];
    $('side-tabs').innerHTML = tabs.map(([id, t]) => `<button data-tab="${id}" class="${state.tab === id ? 'active' : ''}">${t}</button>`).join('');
    $('side-tabs').querySelectorAll('button').forEach(b => b.addEventListener('click', () => { state.tab = b.dataset.tab; renderSide(); }));
    const { stats } = state.result;
    const L = stats.levees;
    let html = '';

    if (state.tab === 'ecarts') {
      const max = Math.max(1, ...stats.byField.map(f => f.count));
      const rows = stats.byField.slice().sort((x, y) => y.count - x.count);
      html = '<h3>Écarts par champ</h3><table class="mini">' + (rows.length
        ? rows.map(f => barRow(`class="clickable ${state.filter.field === f.a ? 'active' : ''}" data-field="${esc(f.a)}"`,
          esc(f.a) + (f.a !== f.b ? ` <span class="muted">↔ ${esc(f.b)}</span>` : ''), f.count, max)).join('')
        : '<tr><td class="muted">Aucun champ comparé.</td></tr>') + '</table>';
      const md = stats.medianDistance;
      html += `<p class="note">${fmt(stats.pairs)} bacs appariés` + (md !== null ? ` · écart de position médian : ${fmt(md)} m` : '') + '</p>';
    }

    if (state.tab === 'flux') {
      const dimTable = (titre, list, key, note) => {
        if (!list.length) return '';
        const max = Math.max(...list.map(f => f.levees));
        return `<h3>${titre}</h3><table class="mini"><tr><th></th><th class="n">Levées</th><th class="n">Puces</th></tr>` +
          list.map(f => barRow(`class="clickable ${f.retenu ? '' : 'off'} ${state.filter[key] === f.valeur ? 'active' : ''}" data-${key}="${esc(f.valeur)}"`,
            esc(f.valeur) + (f.retenu ? ' <span class="muted">✓</span>' : ''), f.levees, max, `<td class="n">${fmt(f.puces)}</td>`)).join('') +
          `</table><p class="note">${note}</p>`;
      };
      html += dimTable('Levées par flux', L.flux, 'flux',
        `✓ = flux analysé. Cliquez un flux pour lister les puces levées sur ce flux.`);
      html += dimTable('Statut des levées', L.statuts, 'statut',
        `✓ = levées retenues. Cliquez un statut pour lister les puces concernées (ex. « non autorisé »).`);
    }

    if (state.tab === 'mois') {
      html += '<h3>Levées par mois</h3>' + monthChart(L.parMois);
    }

    if (state.tab === 'taux') {
      const maxT = Math.max(...stats.tranches);
      html += `<h3>Taux de présentation des bacs client</h3><table class="mini">` +
        stats.tranches.map((n, i) => barRow(`class="clickable ${state.filter.tranche === i ? 'active' : ''}" data-tranche="${i}"`, esc(TRANCHES[i]), n, maxT)).join('') +
        `</table><p class="note">Semaines avec au moins une levée / semaines où le bac était en service (date de livraison prise en compte). Médiane : <b>${stats.tauxMedian === null ? '—' : fmt(stats.tauxMedian) + ' %'}</b>.</p>`;
    }

    if (state.tab === 'qualite') {
      html += `<h3>Fichier des levées</h3><table class="mini">
        <tr><td>Lignes lues</td><td class="n">${fmt(L.lignes)}</td></tr>
        <tr><td>Levées analysées${fluxLabel() ? ' (' + esc(fluxLabel()) + ')' : ''}</td><td class="n">${fmt(L.levees)}</td></tr>
        ${L.autresFlux ? `<tr><td>Levées sur d'autres flux</td><td class="n">${fmt(L.autresFlux)}</td></tr>` : ''}
        ${L.statutsExclus ? `<tr><td>Levées écartées (statut)</td><td class="n">${fmt(L.statutsExclus)}</td></tr>` : ''}
        ${L.sansCle ? `<tr><td>Levées sans puce lue</td><td class="n">${fmt(L.sansCle)} <span class="muted">${pct(L.sansCle, L.lignes)}</span></td></tr>` : ''}
        ${L.dateInvalide ? `<tr><td>Dates illisibles</td><td class="n">${fmt(L.dateInvalide)}</td></tr>` : ''}
        ${stats.pucesCorrigees ? `<tr><td>Puces reconstituées <span class="muted">(abîmées par Excel)</span></td><td class="n">${fmt(stats.pucesCorrigees)}</td></tr>` : ''}
        <tr><td>Période</td><td class="n">${Levees.formatDay(L.debut)} → ${Levees.formatDay(L.fin)}</td></tr>
        <tr><td>Semaines</td><td class="n">${fmt(L.semainesPeriode)}</td></tr>
      </table>`;
      if (state.opts.countA) {
        let ok = 0, ko = 0;
        for (const r of state.result.rows) {
          if (!r.a || r.lv.declare === null) continue;
          if (Math.abs(r.lv.ecart) <= Math.max(2, 0.1 * r.lv.declare)) ok++; else ko++;
        }
        html += `<h3>« ${esc(state.opts.countA)} »</h3><table class="mini">
          <tr><td>Concordant avec les levées (± 10 %)</td><td class="n">${fmt(ok)}</td></tr>
          <tr><td>Écart plus important</td><td class="n">${fmt(ko)}</td></tr></table>
          <p class="note">Indicatif : la période de la base client peut différer de celle des levées. Triez la colonne « Écart » du tableau pour voir les plus gros écarts.</p>`;
      }
    }

    $('side').innerHTML = html;
    const bind = (attr, key, conv) => $('side').querySelectorAll(`tr[data-${attr}]`).forEach(tr => tr.addEventListener('click', () => {
      const v = conv ? conv(tr.dataset[attr]) : tr.dataset[attr];
      state.filter[key] = state.filter[key] === v ? null : v;
      state.page = 0; renderSide(); applyFilters(true);
    }));
    bind('field', 'field'); bind('flux', 'flux'); bind('statut', 'statut'); bind('tranche', 'tranche', Number);
    bindChartTips();
  }

  // Histogramme mensuel (SVG) : une seule série, barres arrondies côté valeur, infobulle au survol.
  const MOIS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
  function monthChart(mois) {
    if (!mois.length) return '<p class="note">Aucune donnée.</p>';
    const W = 320, H = 150, top = 16, bottom = 22, left = 4;
    const max = Math.max(...mois.map(m => m[1]));
    const med = Levees.median(mois.map(m => m[1])) || 0;
    const slot = (W - left) / mois.length;
    const bw = Math.max(4, slot - 4);
    const y = v => top + (H - top - bottom) * (1 - v / max);
    let low = false;
    const bars = mois.map(([m, n], i) => {
      const [yy, mm] = m.split('-');
      const x = left + i * slot + (slot - bw) / 2;
      const yv = y(n), h = H - bottom - yv;
      const isLow = n < 0.75 * med;
      low = low || isLow;
      const r = Math.min(4, bw / 2, h);
      const path = `M${x},${H - bottom} V${yv + r} Q${x},${yv} ${x + r},${yv} H${x + bw - r} Q${x + bw},${yv} ${x + bw},${yv + r} V${H - bottom} Z`;
      const tip = `${MOIS[+mm - 1]} ${yy} : ${fmt(n)} levées${isLow ? ' · nettement sous la médiane' : ''}`;
      const lbl = mois.length <= 13 || i % 2 === 0 ? `<text class="axis-label" x="${x + bw / 2}" y="${H - 6}" text-anchor="middle">${MOIS[+mm - 1].slice(0, 3)}</text>` : '';
      return `<g data-tip="${esc(tip)}"><rect class="hit" x="${left + i * slot}" y="${top}" width="${slot}" height="${H - top - bottom}"></rect>
        <path class="barm ${isLow ? 'low' : ''}" d="${path}"></path>${isLow ? `<text class="axis-label" x="${x + bw / 2}" y="${yv - 4}" text-anchor="middle">⚠</text>` : ''}${lbl}</g>`;
    }).join('');
    const svg = `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Nombre de levées par mois">
      <line class="gridline" x1="0" x2="${W}" y1="${y(max)}" y2="${y(max)}"></line>
      <text class="axis-label" x="${W}" y="${y(max) - 4}" text-anchor="end">${fmt(max)}</text>
      <line class="gridline" x1="0" x2="${W}" y1="${H - bottom}" y2="${H - bottom}"></line>${bars}</svg></div>`;
    const note = low ? '<p class="note">⚠ Mois nettement sous la médiane : export incomplet, ou baisse réelle (vacances, intempéries) ?</p>' : '';
    const table = `<details class="note"><summary>Voir les chiffres</summary><table class="mini">${mois.map(([m, n]) => {
      const [yy, mm] = m.split('-'); return `<tr><td>${MOIS[+mm - 1]} ${yy}</td><td class="n">${fmt(n)}</td></tr>`;
    }).join('')}</table></details>`;
    return svg + note + table;
  }

  function bindChartTips() {
    const tip = $('tip');
    $('side').querySelectorAll('g[data-tip]').forEach(g => {
      g.addEventListener('mousemove', e => { tip.textContent = g.dataset.tip; tip.style.left = e.clientX + 'px'; tip.style.top = e.clientY + 'px'; tip.classList.remove('hidden'); });
      g.addEventListener('mouseleave', () => tip.classList.add('hidden'));
    });
  }

  // --- Synthèse par groupe (activité, secteur, commune...) ---
  const trancheOf = r => {
    if (!r.a || r.category === 'recent' || !r.lv || r.lv.taux === null) return null;
    const t = r.lv.taux;
    return t === 0 ? 0 : t < 25 ? 1 : t < 50 ? 2 : t < 75 ? 3 : 4;
  };
  function groupOf(r) {
    const col = $('group-by').value;
    if (!r.a) return '(absent de la base client)';
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
      keys.map(k => `<th class="n" title="${esc(describe(k))}"><i class="sw" style="background:${cssVar(c[k].color)}"></i>${esc(c[k].label)}</th>`).join('') +
      (lev() ? '<th class="n">Taux médian</th>' : '') + '</tr></thead><tbody>' +
      list.map(([g, x]) => `<tr data-group="${esc(g)}" class="${state.filter.group === g ? 'active' : ''}"><td>${esc(g)}</td><td class="n">${fmt(x.n)}</td>` +
        keys.map(k => `<td class="n">${x.cats[k] ? fmt(x.cats[k]) + ` <span class="muted">${pct(x.cats[k], x.n)}</span>` : ''}</td>`).join('') +
        (lev() ? `<td class="n">${x.taux.length ? fmt(Levees.median(x.taux)) + ' %' : ''}</td>` : '') + '</tr>').join('') + '</tbody>';
    $('synth').querySelectorAll('tbody tr').forEach(tr => tr.addEventListener('click', () => {
      state.filter.group = state.filter.group === tr.dataset.group ? null : tr.dataset.group;
      state.page = 0; renderSynth(); applyFilters(true);
    }));
  }
  $('group-by').addEventListener('change', () => { state.filter.group = null; renderSynth(); applyFilters(); });

  // --- Filtres ---
  function searchText(r) {
    if (r._s === undefined) {
      const parts = [r.key, keyOf(r)];
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
      (f.flux === null || (r.flux && r.flux[f.flux] > 0)) &&
      (f.statut === null || (r.statuts && r.statuts[f.statut] > 0)) &&
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
    if (f.flux !== null) badges.push('levé en ' + f.flux);
    if (f.statut !== null) badges.push('« ' + f.statut + ' »');
    $('filter-badge').classList.toggle('hidden', !badges.length);
    $('filter-badge').textContent = badges.join(' + ') + '  ✕';
    $('table-title').textContent = badges.length ? 'Sélection' : 'Détail';
    $('map-title').textContent = f.tag ? cats()[f.tag].label : 'Carte' + (badges.length ? ' · sélection' : ' · vue d\'ensemble');

    renderTable();
    renderMap(fit);
  }

  $('filter-badge').addEventListener('click', () => {
    state.filter = Object.assign(NO_FILTER(), { search: state.filter.search });
    state.page = 0;
    renderKPIs(); renderSide(); renderSynth(); applyFilters(true);
  });

  let searchTimer;
  $('search').addEventListener('input', e => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.filter.search = e.target.value; state.page = 0; applyFilters(); }, 200);
  });

  // ---------------------------------------------------------------------
  // Tableau détaillé
  // ---------------------------------------------------------------------
  function tagsHtml(r) {
    const c = cats();
    return r.tags.filter(t => c[t] || TAGS[mode()][t]).map(t => `<span class="tag" style="--tc:${cssVar((c[t] || CATS.bacs.doublon).color)}">${esc(tagLabel(t))}</span>`).join('');
  }

  const aVal = (r, col) => r.a ? r.a.props[col] : '';

  // Identifiant tel qu'écrit dans la base client (avec son zéro en tête), sinon dans les levées.
  function keyOf(r) {
    const o = state.opts;
    const v = r.a && o.keyA ? r.a.props[o.keyA] : r.b ? r.b.props[lev() ? 'identifiant' : o.keyB] : '';
    return v === undefined || v === null || v === '' ? r.key : String(v);
  }

  // Flux non analysés présents dans les levées (une colonne chacun).
  const autresFlux = () => state.opts.fluxCol ? state.result.stats.levees.flux.filter(f => !f.retenu).map(f => f.flux).slice(0, 10) : [];

  function columns() {
    const o = state.opts;
    const cols = [
      { id: 'statut', title: 'Statut', html: tagsHtml, sort: r => priority().indexOf(r.category) },
      { id: 'cle', title: lev() ? 'Puce' : 'Identifiant', html: r => `<b>${esc(keyOf(r))}</b>`, sort: keyOf }
    ];
    if (lev()) {
      // Colonnes de la base client masquées si la vue ne contient que des puces absentes de cette base.
      const showA = !state.filtered.length || state.filtered.some(r => r.a);
      if (showA) o.display.forEach(d => cols.push({ id: 'a:' + d, title: d, html: r => esc(aVal(r, d)), sort: r => aVal(r, d) }));
      const ag = r => r.b ? r.b.agg : null;
      cols.push(
        { id: 'n', title: fluxLabel() ? 'Levées ' + fluxLabel() : 'Levées', cls: 'n', html: r => ag(r) ? fmt(ag(r).n) : (r.a ? '0' : ''), sort: r => ag(r) ? ag(r).n : 0 },
        ...autresFlux().map(f => ({ id: 'flux:' + f, title: 'Levées ' + f, cls: 'n', html: r => r.flux && r.flux[f] ? fmt(r.flux[f]) : '', sort: r => r.flux && r.flux[f] ? r.flux[f] : null })),
        { id: 'taux', title: 'Taux présentation', cls: 'n', html: r => r.lv.taux === null ? '' : fmt(r.lv.taux) + ' %', sort: r => r.lv.taux },
        { id: 'sem', title: 'Semaines levées', cls: 'n', html: r => r.a ? `${ag(r) ? ag(r).semaines : 0} / ${fmt(r.lv.semainesPossibles)}` : (ag(r) ? ag(r).semaines : ''), sort: r => ag(r) ? ag(r).semaines : 0 },
        { id: 'last', title: 'Dernière levée', html: r => ag(r) ? Levees.formatDay(ag(r).last) : '', sort: r => ag(r) ? ag(r).last : null },
        { id: 'first', title: 'Première levée', html: r => ag(r) ? Levees.formatDay(ag(r).first) : '', sort: r => ag(r) ? ag(r).first : null }
      );
      if (o.weightCol) cols.push({ id: 'poids', title: 'Poids moyen (kg)', cls: 'n', html: r => ag(r) ? fmt(ag(r).poidsMoyen) : '', sort: r => ag(r) ? ag(r).poidsMoyen : null });
      if (o.dateA && showA) cols.push({ id: 'liv', title: 'Livraison', html: r => esc(aVal(r, o.dateA)), sort: r => r.lv.livraison });
      if (o.countA && showA) cols.push(
        { id: 'decl', title: 'Déclaré client', cls: 'n', html: r => fmt(r.lv.declare), sort: r => r.lv.declare },
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
      '<thead><tr>' + cols.map(c => `<th data-col="${esc(c.id)}" class="${c.cls || ''} ${state.sort.col === c.id ? 'sorted' + (state.sort.asc ? ' asc' : '') : ''}" title="Trier">${esc(c.title)}</th>`).join('') + '</tr></thead>' +
      '<tbody>' + slice.map(r => `<tr data-i="${r._i}" title="Localiser sur la carte">` + cols.map(c => `<td class="${c.cls || ''}">${c.html(r)}</td>`).join('') + '</tr>').join('') + '</tbody>';

    $('page-info').textContent = rows.length
      ? `${fmt(state.page * PAGE_SIZE + 1)}–${fmt(state.page * PAGE_SIZE + slice.length)} sur ${fmt(rows.length)}`
      : 'Aucun résultat';
    $('prev').disabled = state.page === 0;
    $('next').disabled = state.page >= pages - 1;

    $('table').querySelectorAll('th').forEach(th => th.addEventListener('click', () => {
      state.sort = { col: th.dataset.col, asc: state.sort.col === th.dataset.col ? !state.sort.asc : !th.classList.contains('n') };
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
      'Plan IGN (gris)': ign('GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2', 'image/png'),
      'Photos aériennes IGN': ign('ORTHOIMAGERY.ORTHOPHOTOS', 'image/jpeg'),
      'OpenStreetMap': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© contributeurs OpenStreetMap' })
    };
    bases['Plan IGN (gris)'].addTo(map);
    L.control.layers(bases, null, { position: 'topright' }).addTo(map);
    L.control.scale({ imperial: false }).addTo(map);
    dataLayer = L.featureGroup().addTo(map);
    legend = L.control({ position: 'bottomleft' });
    legend.onAdd = () => L.DomUtil.create('div', 'legend');
    legend.addTo(map);
    map.setView([46.6, 2.4], 6);
  }

  $('btn-map-size').addEventListener('click', () => {
    const big = $('map-card').classList.toggle('big');
    $('btn-map-size').textContent = big ? '⤡ Réduire' : '⤢ Agrandir';
    setTimeout(() => map.invalidateSize(), 50);
  });

  function posOf(r) {
    const rec = r.a && r.a.lat !== null ? r.a : (r.b && r.b.lat !== null ? r.b : null);
    return rec ? [rec.lat, rec.lon] : null;
  }

  /*
   * Vue d'ensemble : 3 catégories prioritaires en couleur, le reste en gris discret (contexte).
   * Avec un indicateur sélectionné, tous les points affichés prennent sa couleur.
   */
  function renderMap(fit) {
    dataLayer.clearLayers();
    markers.clear();
    const c = cats();
    const focus = state.filter.tag;
    const overview = OVERVIEW[mode()].filter(k => c[k]);
    const ctxColor = cssVar('--c-context');
    const counts = {};
    let contexte = 0, nonPlaces = 0;
    const colored = [];
    for (const r of state.filtered) {
      const p = posOf(r);
      if (!p) { nonPlaces++; continue; }
      const cat = focus || overview.find(k => r.tags.includes(k));
      if (!cat) {
        contexte++;
        const m = L.circleMarker(p, { radius: 3.5, stroke: false, fillColor: ctxColor, fillOpacity: 0.9 }).bindPopup(() => popupHtml(r), { maxWidth: 440 });
        m.addTo(dataLayer);
        markers.set(r._i, m);
      } else {
        counts[cat] = (counts[cat] || 0) + 1;
        colored.push([r, p, cssVar(c[cat].color)]);
      }
    }
    // Les points colorés au-dessus du contexte.
    for (const [r, p, color] of colored) {
      if (r.tags.includes('deplace') && r.a && r.b && r.b.lat !== null) {
        L.polyline([p, [r.b.lat, r.b.lon]], { color, weight: 2, dashArray: '4 4', interactive: false }).addTo(dataLayer);
      }
      const m = L.circleMarker(p, { radius: 6, color: cssVar('--surface'), weight: 2, fillColor: color, fillOpacity: 1 })
        .bindPopup(() => popupHtml(r), { maxWidth: 440 });
      m.addTo(dataLayer);
      markers.set(r._i, m);
    }
    const keys = focus ? [focus] : overview;
    legend.getContainer().innerHTML = keys.filter(k => counts[k]).map(k => `<div><i style="background:${cssVar(c[k].color)}"></i>${esc(c[k].label)} <b>${fmt(counts[k])}</b></div>`).join('') +
      (contexte ? `<div class="muted"><i class="ctx" style="background:${ctxColor}"></i>Autres bacs ${fmt(contexte)}</div>` : '') +
      (nonPlaces ? `<div class="muted">${fmt(nonPlaces)} sans position${lev() ? ' (géocoder la base client)' : ''}</div>` : '') || '<div>Aucun point localisé</div>';
    if (fit && dataLayer.getLayers().length) map.fitBounds(dataLayer.getBounds(), { padding: [24, 24], maxZoom: 17 });
    setTimeout(() => map.invalidateSize(), 0);
  }

  function popupHtml(r) {
    const o = state.opts;
    const head = `<div class="pop"><h4>${esc(keyOf(r) || '(sans identifiant)')}</h4>${tagsHtml(r)}`;
    const detail = obj => Object.entries(obj).sort((x, y) => y[1] - x[1]).map(([k, n]) => `${k} : ${n}`).join('\n');
    if (lev()) {
      const ag = r.b ? r.b.agg : null;
      const lines = o.display.filter(d => r.a && r.a.props[d] !== '' && r.a.props[d] !== undefined).map(d => [d, r.a.props[d]]);
      if (r.a) {
        lines.push(['Levées' + (fluxLabel() ? ' ' + fluxLabel() : ''), ag ? fmt(ag.n) : '0']);
        lines.push(['Taux de présentation', r.lv.taux === null ? '—' : `${fmt(r.lv.taux)} % (${ag ? ag.semaines : 0} sem. / ${fmt(r.lv.semainesPossibles)})`]);
      } else lines.push([`Levées${fluxLabel() ? ' ' + fluxLabel() : ''} (puce absente de la base client)`, fmt(ag.n)]);
      if (r.flux && Object.keys(r.flux).length > 1) lines.push(['Levées par flux', detail(r.flux)]);
      if (r.statuts) lines.push(['Statuts', detail(r.statuts)]);
      if (ag) lines.push(['Première / dernière levée', Levees.formatDay(ag.first) + ' → ' + Levees.formatDay(ag.last)]);
      if (ag && ag.poidsMoyen !== null) lines.push(['Poids moyen', fmt(ag.poidsMoyen) + ' kg']);
      if (r.lv.declare !== null) lines.push(['Déclaré dans la base client', fmt(r.lv.declare)]);
      if (r.distance !== null) lines.push(['Écart bac ↔ position des levées', fmt(Math.round(r.distance)) + ' m']);
      return head + `<table>${lines.map(([k, v]) => `<tr><td>${esc(k)}</td><td><b>${esc(v).replace(/\n/g, '<br>')}</b></td></tr>`).join('')}</table></div>`;
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
    if (!m) { toast('Ce bac n\'a pas de position (géocodez la base client pour le placer).'); return; }
    $('map-card').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    map.setView(m.getLatLng(), Math.max(map.getZoom(), 18));
    m.openPopup();
  }

  // ---------------------------------------------------------------------
  // Exports (respectent les filtres)
  // ---------------------------------------------------------------------
  const c7 = v => v === null || v === undefined ? null : Number(v.toFixed(7));
  const detailTxt = obj => obj ? Object.entries(obj).sort((x, y) => y[1] - x[1]).map(([k, n]) => `${k}: ${n}`).join(' | ') : '';

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
          ...Object.fromEntries((o.fluxCol ? state.result.stats.levees.flux.map(f => f.flux) : []).map(f => ['levees_' + f, r.flux && r.flux[f] ? r.flux[f] : 0])),
          statuts_levees: detailTxt(r.statuts),
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
  const exportName = () => {
    const sel = state.filter.tag ? '_' + normName(tagLabel(state.filter.tag)) : '';
    return (lev() ? 'analyse_levees' : 'comparaison_bacs') + sel + '_' + stamp();
  };

  $('btn-export-csv').addEventListener('click', () => {
    const recs = exportRecords();
    if (!recs.length) return toast('Rien à exporter : la sélection est vide.');
    const header = Object.keys(recs[0].props);
    const lines = recs.map(r => header.map(h => {
      const v = r.props[h];
      return typeof v === 'number' ? String(v).replace('.', ',') : v;
    }));
    IO.download(exportName() + '.csv', IO.toCSV(header, lines), 'text/csv;charset=utf-8');
    toast(`${fmt(recs.length)} lignes exportées (CSV, ouverture directe dans Excel).`);
  });

  $('btn-export-geojson').addEventListener('click', () => {
    const features = exportRecords().filter(r => r.pos).map(r => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [r.pos[1], r.pos[0]] },
      properties: r.props
    }));
    if (!features.length) return toast('Aucun point localisé dans la sélection.');
    IO.download(exportName() + '.geojson', JSON.stringify({ type: 'FeatureCollection', features }), 'application/geo+json');
    toast(`${fmt(features.length)} points exportés (GeoJSON → ArcGIS Pro : « JSON vers entités »).`);
  });

  // ---------------------------------------------------------------------
  // Exemples
  // ---------------------------------------------------------------------
  async function loadDemo(labelA, labelB, fileA, fileB, sheetsA, sheetsB, type) {
    $('label-a').value = labelA;
    $('label-b').value = labelB;
    state.src.A = state.src.B = null;
    const a = IO.arraySource(sheetsA); a.name = fileA;
    const b = IO.arraySource(sheetsB); b.name = fileB;
    setSource('A', a);
    setSource('B', b);
    if ($('type-b').value !== type) { $('type-b').value = type; buildConfig(true); }
    await runCompare();
  }

  function demoLevees() {
    const d = Demo.generateLevees(1500, 7);
    return loadDemo('Base client', 'Levées', 'Exemple · base bacs biodéchets (fictive)', 'Exemple · levées 2025 (fictives)',
      { Feuil1: d.clients }, { Feuil1: d.levees }, 'levees');
  }
  function demoInventaires() {
    const d = Demo.generate(1500, 42);
    return loadDemo('Base SIG', 'Base facturation', 'Exemple · base SIG (fictive)', 'Exemple · base facturation (fictive)',
      { exemple: d.sig }, { exemple: d.metier }, 'bacs');
  }
  $('btn-demo-levees').addEventListener('click', demoLevees);
  $('btn-demo').addEventListener('click', demoInventaires);
  document.querySelectorAll('[data-demo]').forEach(b => b.addEventListener('click', demoLevees));

  updateModeUI();
  updateSteps();
})();
