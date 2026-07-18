<script>
  import { untrack } from 'svelte';
  import { goBack, navigate, route } from '../lib/router.svelte.js';
  import { apiGet, apiPost, apiDelete } from '../lib/api.js';
  import { flags } from '../lib/store.svelte.js';
  import { BackIssue, plugins, bridgeRefs } from '../lib/plugins.svelte.js';
  import { parseIndexerString, serializeIndexers } from '../lib/util.js';
  import { openIndexerModal, testIndexer } from './IndexerModal.svelte';
  import { confirmDialog } from './DialogModal.svelte';
  import { notify } from '../lib/toasts.svelte.js';
  import Icon from '../lib/Icon.svelte';

  let { active = false } = $props();

  const DEFAULT_PORTS = { sabnzbd: '8080', nzbget: '6789' };

  // "Split detail" settings: a top tab rail shows ONE page at a time. Every
  // page stays MOUNTED (CSS-hidden, never {#if}-removed) — the generic set-*
  // form scan reads hidden fields fine, and plugin-injected DOM must survive
  // tab switches.
  const TABS = [
    { id: 'overview', label: 'Overview', icon: 'bar-chart' },
    { id: 'library', label: 'Library', icon: 'library' },
    { id: 'downloading', label: 'Downloading', icon: 'download' },
    { id: 'sources', label: 'Sources', icon: 'target' },
    { id: 'metadata', label: 'Metadata', icon: 'tag' },
    { id: 'signin', label: 'Sign-in', icon: 'shield' },
    { id: 'notifications', label: 'Notifications', icon: 'bell' },
  ];
  let activeTab = $state('overview');
  let libPanel = $state('libraries');   // libraries | org | maint
  let srcPanel = $state('usenet');      // usenet | torrent | priority
  let libDrill = $state(false);         // mobile: rail list → panel detail
  let srcDrill = $state(false);
  let anySourceOn = $state(false);
  let srcOn = $state({ usenet: false, torrent: false }); // live toggle state (pre-save)
  let srcManaged = $state(false); // an indexer-provider plugin (e.g. Prowlarr) is managing the indexer lists
  let enabledSourceCount = $state(0);
  let dirtySections = $state(new Set()); // tab ids with unsaved edits
  let filterQuery = $state('');
  let loadedSettings = $state({});       // last-loaded settings (Overview reads it)
  let notifyChannels = $state(0);        // plugin-injected channel cards

  function pickTab(id) {
    activeTab = id;
    libDrill = false; srcDrill = false; // mobile drill resets on tab switch
    if (id === 'overview') refreshOverview();
  }

  // Indexer lists ({ name, url, apiKey }) — shared row UI for both modes.
  let indexerList = $state([]);   // newznab (usenet)
  let torznabList = $state([]);   // torznab (torrent)
  const MODE_LISTS = { newznab: () => indexerList, torznab: () => torznabList };
  const MODE_ENDPOINTS = { newznab: '/api/indexers/test', torznab: '/api/torznab/test' };

  // Explicit libraries (named containers with a behavior type, shown in the
  // sidebar). CRUD applies immediately — not part of the settings Save cycle.
  let libs = $state([]);
  let newLib = $state({ name: '', type: 'comic', rootFolder: '' });
  let LIB_TYPES = $state([['comic', 'Comics'], ['manga', 'Manga']]);
  const parseRoots = (text) => String(text || '').split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
  const withFolders = (l) => ({ ...l, folders: parseRoots(l.root_folder).length ? parseRoots(l.root_folder) : [''] });
  async function loadLibs() {
    try {
      const r = await apiGet('/api/libraries');
      libs = (r.libraries || []).map(withFolders);
      if (Array.isArray(r.types) && r.types.length) LIB_TYPES = r.types.map((t) => [t.id, t.label]);
    } catch { /* offline */ }
  }
  $effect(() => { if (active) loadLibs(); });
  async function addLib() {
    if (!newLib.name.trim()) return notify('Give the library a name.', 'error');
    const r = await apiPost('/api/libraries', { name: newLib.name.trim(), type: newLib.type, rootFolder: newLib.rootFolder.trim() || null });
    if (r.error) return notify(r.error, 'error');
    libs = r.libraries.map(withFolders); newLib = { name: '', type: 'comic', rootFolder: '' };
    notify('Library created — it now shows in the sidebar.', 'ok');
  }
  async function saveLib(l) {
    const rootFolder = (l.folders || []).map((s) => s.trim()).filter(Boolean).join('\n');
    const r = await apiPost('/api/libraries/' + l.id, { name: l.name, type: l.type, rootFolder: rootFolder || null, folderPattern: l.folder_pattern || null, restricted: !!l.restricted });
    if (r.error) return notify(r.error, 'error');
    libs = r.libraries.map(withFolders); notify('Library updated.', 'ok');
  }
  const libAddFolder = (l) => { l.folders = [...l.folders, '']; };
  const libRemoveFolder = (l, i) => { l.folders = l.folders.filter((_, k) => k !== i); if (!l.folders.length) l.folders = ['']; saveLib(l); };
  const libMakeDefault = (l, i) => { if (i <= 0) return; const next = [...l.folders]; const [f] = next.splice(i, 1); l.folders = [f, ...next]; saveLib(l); };
  async function removeLib(l) {
    if (!(await confirmDialog({
      title: `Delete “${l.name}”?`,
      message: `Its ${l.series_count} series stay in your collection (moved to another library) — nothing is deleted from disk.`,
      confirmLabel: 'Delete library', danger: true,
    }))) return;
    const r = await apiDelete('/api/libraries/' + l.id);
    if (r.error) return notify(r.error, 'error');
    libs = r.libraries.map(withFolders); notify('Library deleted — series kept.', 'ok');
  }

  // Source priority (order enabled sources are tried), from /api/sources.
  let sourceOrder = $state([]);

  // Live example path for the folder/file naming patterns.
  let namingPreview = $state('');
  let namingTimer;
  function previewNaming() {
    clearTimeout(namingTimer);
    namingTimer = setTimeout(async () => {
      const folderPattern = root?.querySelector('#set-folderPattern')?.value || '';
      const filePattern = root?.querySelector('#set-filePattern')?.value || '';
      try { namingPreview = (await apiPost('/api/naming/preview', { folderPattern, filePattern })).example || ''; }
      catch { namingPreview = ''; }
    }, 250);
  }

  let root = $state(null); // this page's DOM root, for the generic set-* field scan

  // Every settings field carries id="set-<configKey>"; core and plugin-injected
  // fields are read/written generically (that's why these inputs are
  // deliberately uncontrolled). Checkboxes map to booleans.
  function applySettingsToForm(s) {
    for (const el of document.querySelectorAll('[id^="set-"]')) {
      const key = el.id.slice(4);
      if (s[key] == null) continue;
      if (el.type === 'checkbox') el.checked = !!s[key];
      else el.value = s[key];
    }
  }
  function collectSettingsFromForm() {
    const body = {};
    for (const el of document.querySelectorAll('[id^="set-"]')) {
      body[el.id.slice(4)] = el.type === 'checkbox' ? el.checked : el.value;
    }
    body.newznabIndexers = serializeIndexers(indexerList);
    body.torznabIndexers = serializeIndexers(torznabList);
    // rootFolders is DERIVED from the libraries' folders — never sent.
    if (sourceOrder.length) body.sourcePriority = sourceOrder.map((s) => s.id).join(',');
    return body;
  }

  // Swap client credential fields to the selected client, hint default ports,
  // and let plugins report whether their source is enabled.
  function syncSourceUI() {
    if (!root) return;
    const usenet = root.querySelector('#set-usenetEnabled').checked;
    const cfg = root.querySelector('#usenet-config');
    cfg.classList.remove('client-sabnzbd', 'client-nzbget');
    const client = root.querySelector('#set-nzbClient').value;
    cfg.classList.add('client-' + client);
    const port = root.querySelector('#set-nzbClientPort');
    port.placeholder = DEFAULT_PORTS[client] || '';
    if (!port.value) port.value = DEFAULT_PORTS[client] || '';
    const torrent = root.querySelector('#set-torrentEnabled').checked;
    const qport = root.querySelector('#set-qbPort');
    qport.placeholder = '8080';
    if (!qport.value) qport.value = '8080';
    srcOn = { usenet, torrent };
    // An indexer-provider plugin (e.g. Prowlarr) may be managing the lists.
    srcManaged = BackIssue._indexerManagedHooks.some((fn) => { try { return !!fn(); } catch { return false; } });
    const pluginEnabled = BackIssue._sourceSyncHooks.map((fn) => { try { return !!fn(); } catch { return false; } });
    enabledSourceCount = [usenet, torrent, ...pluginEnabled].filter(Boolean).length;
    anySourceOn = enabledSourceCount > 0;
    wireSourceCards();
    scanPluginBlocks();
  }
  bridgeRefs.refreshSourceUI = syncSourceUI;

  // Plugin source blocks, surfaced as rail entries. Each injected .src-block
  // stays exactly where the plugin put it (mounts must never lose children —
  // plugins guard against re-injecting); the rail just class-toggles which one
  // is visible. Label/note/dot are read from the block's own header.
  let pluginSrc = $state([]);
  function scanPluginBlocks() {
    const mount = document.getElementById('settings-plugin-sources');
    if (!mount) return;
    const out = [];
    [...mount.querySelectorAll(':scope > .src-block')].forEach((block, i) => {
      const key = 'plugin:' + (block.id || i);
      block.dataset.setxKey = key;
      const sw = block.querySelector('.switch input');
      out.push({
        key,
        label: block.querySelector('.src-toggle b')?.textContent?.trim() || 'Plugin source',
        note: block.querySelector('.src-toggle .modal__note')?.textContent?.trim().slice(0, 48) || 'Plugin source',
        on: !!sw?.checked,
      });
      if (sw && !sw.dataset.setxWired) { sw.dataset.setxWired = '1'; sw.addEventListener('change', () => syncSourceUI()); }
    });
    pluginSrc = out;
  }
  // Reflect the selected panel onto the plugin blocks (in place, CSS only).
  $effect(() => {
    void srcPanel; void pluginSrc;
    const mount = document.getElementById('settings-plugin-sources');
    if (!mount) return;
    for (const block of mount.querySelectorAll(':scope > .src-block')) {
      block.classList.toggle('setx-active', block.dataset.setxKey === srcPanel);
    }
  });

  // Make every source card (core + plugin-injected) collapsible. Idempotent.
  function wireSourceCards() {
    if (!root) return;
    for (const block of root.querySelectorAll('.src-block')) {
      if (block.dataset.wired) continue;
      block.dataset.wired = '1';
      const header = block.querySelector('.src-toggle');
      if (header) header.addEventListener('click', (e) => {
        if (e.target.closest('.switch')) return;
        block.classList.toggle('is-open');
      });
      const sw = block.querySelector('.switch input');
      if (sw) sw.addEventListener('change', () => { if (sw.checked) block.classList.add('is-open'); });
    }
  }

  async function openSettings() {
    const s = await apiGet('/api/settings');
    loadedSettings = s || {};
    applySettingsToForm(s);
    indexerList = parseIndexerString(s.newznabIndexers);
    torznabList = parseIndexerString(s.torznabIndexers);
    try { sourceOrder = (await apiGet('/api/sources')).sources || []; } catch { sourceOrder = []; }
    for (const cb of BackIssue._settingsHooks) { try { cb(s); } catch { /* ignore */ } }
    syncSourceUI();
    previewNaming();
    for (const b of root.querySelectorAll('.src-block')) {
      const sw = b.querySelector('.switch input');
      if (sw) b.classList.toggle('is-open', sw.checked);
    }
    refreshOverview();
    dirty = false;               // everything above was programmatic
    dirtySections = new Set();
  }

  /* ---- Overview (health) ---- */
  let overview = $state({ cards: [], attention: [] });
  function refreshOverview() {
    const s = loadedSettings;
    notifyChannels = document.getElementById('settings-plugin-notifications')?.children.length || 0;
    const cvKeys = parseRoots(s.comicvineKeys || '');
    const libFolders = libs.filter((l) => (l.folders || []).some((f) => f.trim())).length;
    const totalSeries = libs.reduce((n, l) => n + (l.series_count || 0), 0);
    const tone = (t) => t; // green | amber | red
    overview.cards = [
      { id: 'sources', tab: 'sources', icon: 'target', label: 'Sources',
        value: `${enabledSourceCount} enabled`, note: enabledSourceCount >= 2 ? 'Fallback order applies' : enabledSourceCount === 1 ? 'No fallback if it misses' : 'Nothing can download',
        tone: tone(enabledSourceCount >= 2 ? 'green' : enabledSourceCount === 1 ? 'amber' : 'red') },
      { id: 'comicvine', tab: 'metadata', icon: 'tag', label: 'ComicVine',
        value: cvKeys.length ? 'Configured' : 'No API key', note: cvKeys.length ? 'Metadata lookups active' : 'Search and matching need a key',
        tone: tone(cvKeys.length ? 'green' : 'red') },
      { id: 'libraries', tab: 'library', icon: 'library', label: 'Libraries',
        value: `${libs.length} librar${libs.length === 1 ? 'y' : 'ies'}`, note: `${totalSeries} series in the collection`,
        tone: tone(libs.length ? 'green' : 'amber') },
      { id: 'storage', tab: 'library', icon: 'book', label: 'Storage',
        value: libFolders ? `${libFolders} with folders` : 'No folders set', note: libFolders ? 'Downloads file into library folders' : 'Set a folder on a library',
        tone: tone(libFolders ? 'green' : 'amber') },
      { id: 'downloading', tab: 'downloading', icon: 'download', label: 'Downloading',
        value: `${s.downloadConcurrency || 4} at once`, note: `Format: ${(s.format || 'cbz').toUpperCase()}${s.autoDownloadOnAdd ? ' · downloads on add' : ''}`,
        tone: 'green' },
      { id: 'notifications', tab: 'notifications', icon: 'bell', label: 'Notifications',
        value: notifyChannels ? `${notifyChannels} channel${notifyChannels > 1 ? 's' : ''}` : 'None installed', note: notifyChannels ? 'Outbound alerts configured' : 'In-app bell only',
        tone: tone(notifyChannels ? 'green' : 'amber') },
    ];
    const attention = [];
    if (!cvKeys.length) attention.push({ tone: 'red', title: 'ComicVine API key is missing', body: 'Search, matching, and metadata need a key (free at comicvine.gamespot.com).', action: 'Add key', tab: 'metadata' });
    if (enabledSourceCount === 0) attention.push({ tone: 'red', title: 'No download sources enabled', body: 'New comics can’t be downloaded until a source is turned on.', action: 'Enable', tab: 'sources' });
    else if (enabledSourceCount === 1) attention.push({ tone: 'amber', title: 'Only one download source enabled', body: 'A second source gives searches a fallback when the first misses.', action: 'Review', tab: 'sources' });
    if (libs.length && !libFolders) attention.push({ tone: 'amber', title: 'No library has a folder', body: 'Downloads fall back to the downloads folder until a library gets one.', action: 'Set folder', tab: 'library' });
    // A populated library without its own folder files into another library's
    // root — worth surfacing per library (e.g. the auto-created Manga library).
    for (const l of libs) {
      if (l.series_count > 0 && !(l.folders || []).some((f) => f.trim()) && libFolders) {
        attention.push({ tone: 'amber', title: `The ${l.name} library has no folder`, body: 'Its downloads file into the first library that has one — set a folder to keep them separate.', action: 'Set folder', tab: 'library' });
      }
    }
    overview.attention = attention;
  }

  /* ---- Cross-tab search: while typing, all pages show and non-matching
     rows hide. Clearing restores the tab view. Never marks dirty. ---- */
  function applyFilter() {
    const q = filterQuery.trim().toLowerCase();
    root?.classList.toggle('is-searching', !!q);
    if (!q) {
      for (const el of root.querySelectorAll('.set-hidden')) el.classList.remove('set-hidden');
      return;
    }
    for (const page of root.querySelectorAll('.setx-page')) {
      if (page.dataset.tab === 'overview') { page.classList.add('set-hidden'); continue; }
      const rows = [...page.querySelectorAll('.field, .setx-card, .src-block, .libcard, .notify-cat')];
      let shown = 0;
      for (const row of rows) {
        if (row.parentElement.closest('.field, .setx-card, .src-block, .libcard')) continue; // only top-level rows
        const hit = row.textContent.toLowerCase().includes(q);
        row.classList.toggle('set-hidden', !hit);
        if (hit) shown++;
      }
      page.classList.toggle('set-hidden', shown === 0);
    }
  }

  /* ---- Unsaved-changes guard ---- */
  let dirty = $state(false);
  function markDirty(e) {
    if (e?.target?.closest?.('.setx-search')) return; // searching isn't a setting
    dirty = true;
    const page = e?.target?.closest?.('.setx-page');
    if (page?.dataset.tab && !dirtySections.has(page.dataset.tab)) {
      dirtySections = new Set(dirtySections).add(page.dataset.tab);
    }
  }

  // Deep-link: /settings?tab=notifications opens that tab (e.g. a plugin's
  // Configure button). Runs when the page activates or the ?tab= changes; a
  // manual tab click doesn't touch the URL, so it isn't overridden.
  $effect(() => {
    if (!active) return;
    const want = new URLSearchParams(route.search).get('tab');
    if (want && TABS.some((t) => t.id === want)) untrack(() => pickTab(want));
  });

  // Load when opened — and again when plugin assets finish loading. Never
  // reload over unsaved edits.
  $effect(() => {
    void plugins.ready;
    if (active && !dirty) openSettings();
  });

  let wasActive = false;
  $effect(() => {
    if (active) { wasActive = true; return; }
    if (!wasActive) return;
    wasActive = false;
    if (!dirty) return;
    (async () => {
      const discard = await confirmDialog({
        title: 'Discard unsaved changes?',
        message: 'You edited settings but didn’t save them.',
        confirmLabel: 'Discard changes', danger: true,
      });
      if (discard) dirty = false;
      else navigate('/settings'); // page never unmounted — edits still there
    })();
  });

  function onBeforeUnload(e) {
    if (dirty && location.pathname === '/settings') e.preventDefault();
  }

  async function save() {
    let r;
    try { r = await apiPost('/api/settings', collectSettingsFromForm()); }
    catch { return notify('Save failed — is the app reachable?', 'error'); }
    if (r?.error) return notify('Save failed: ' + r.error, 'error');
    flags.usenetEnabled = !!root.querySelector('#set-usenetEnabled')?.checked;
    flags.torrentEnabled = !!root.querySelector('#set-torrentEnabled')?.checked;
    loadedSettings = { ...loadedSettings, ...collectSettingsFromForm() };
    dirty = false;
    dirtySections = new Set();
    refreshOverview();
    notify('Settings saved.', 'ok');
  }
  async function discardEdits() {
    dirty = false;
    dirtySections = new Set();
    await openSettings();
    notify('Changes discarded.', 'info');
  }

  /* ---- Indexer rows ---- */
  function saveIndexer(ix, editIndex, mode) {
    const list = MODE_LISTS[mode]();
    if (editIndex >= 0) list[editIndex] = ix;
    else list.push(ix);
    dirty = true;
  }
  async function testRow(ix, mode) {
    ix._st = { cls: 'is-testing', text: 'Testing…', title: '' };
    const r = await testIndexer(ix, MODE_ENDPOINTS[mode]);
    ix._st = { cls: r.ok ? 'is-ok' : 'is-bad', icon: r.ok ? 'check' : 'close', text: r.ok ? 'OK' : 'Failed', title: r.message };
  }

  /* ---- Connection tests (download clients + CV keys) ---- */
  let tests = $state({ client: null, qb: null, cv: null });
  async function runTest(key, endpoint, collect) {
    tests[key] = { cls: 'is-testing', text: 'Testing…' };
    let r;
    try { r = await apiPost(endpoint, collect()); }
    catch (e) { r = { ok: false, message: String(e) }; }
    tests[key] = { cls: r.ok ? 'is-ok' : 'is-bad', icon: r.ok ? 'check' : 'close', text: r.message };
  }
  const v = (sel) => root.querySelector(sel)?.value ?? '';
  const checked = (sel) => !!root.querySelector(sel)?.checked;
  const testClient = () => runTest('client', '/api/clients/test', () => ({
    nzbClient: v('#set-nzbClient'),
    nzbClientHost: v('#set-nzbClientHost').trim(),
    nzbClientPort: v('#set-nzbClientPort').trim(),
    nzbClientSsl: checked('#set-nzbClientSsl'),
    nzbClientApiKey: v('#set-nzbClientApiKey').trim(),
    nzbClientUser: v('#set-nzbClientUser').trim(),
    nzbClientPass: v('#set-nzbClientPass'),
  }));
  const testQb = () => runTest('qb', '/api/torrent-client/test', () => ({
    qbHost: v('#set-qbHost').trim(),
    qbPort: v('#set-qbPort').trim(),
    qbSsl: checked('#set-qbSsl'),
    qbUser: v('#set-qbUser').trim(),
    qbPass: v('#set-qbPass'),
  }));
  const testCv = () => runTest('cv', '/api/cv/test', () => ({ keys: v('#set-comicvineKeys') }));

  function movePriority(i, dir) {
    const j = i + dir;
    [sourceOrder[i], sourceOrder[j]] = [sourceOrder[j], sourceOrder[i]];
    dirty = true;
  }
  const priorityLabel = (s) => (s.label || s.id).replace(/^./, (c) => c.toUpperCase());

  // Tab dot: amber on Sources when <2 sources, accent when the tab holds edits.
  function tabDot(id) {
    if (id === 'sources' && enabledSourceCount < 2) return 'is-warn';
    return dirtySections.has(id) ? 'is-edit' : null;
  }
</script>

{#snippet indexerRows(mode, list)}
  {#if !list.length}
    <p class="indexer-empty">No indexers yet.</p>
  {/if}
  {#each list as ix, i (i)}
    <div class="indexer-row">
      <div class="indexer-row__info"><b>{ix.name}</b><span>{ix.url}</span></div>
      <span class="indexer-row__status {ix._st?.cls || ''}" title={ix._st?.title || ''}>{#if ix._st?.icon}<Icon name={ix._st.icon} /> {/if}{ix._st?.text || ''}</span>
      <button class="link-btn" type="button" onclick={() => testRow(ix, mode)}>Test</button>
      <button class="link-btn" type="button" onclick={() => openIndexerModal(i, mode, ix, saveIndexer)}>Edit</button>
      <button class="indexer-row__x" type="button" title="Remove" onclick={() => { list.splice(i, 1); dirty = true; }}><Icon name="close" /></button>
    </div>
  {/each}
{/snippet}

{#snippet railItem(kind, key, icon, label, note, dot)}
  <button type="button" class="setx-rail__item"
    class:is-active={(kind === 'lib' ? libPanel : srcPanel) === key}
    onclick={() => { if (kind === 'lib') { libPanel = key; libDrill = true; } else { srcPanel = key; srcDrill = true; } }}>
    <span class="setx-rail__icon"><Icon name={icon} size={15} /></span>
    <span class="setx-rail__text"><b>{label}</b><span>{note}</span></span>
    <span class="setx-dot setx-dot--{dot}"></span>
  </button>
{/snippet}

<svelte:window onbeforeunload={onBeforeUnload} />

<main id="settings-page" class="scan-page settings-page setx-shell" bind:this={root} oninput={markDirty} onchange={markDirty}>
  <!-- Header bar -->
  <div class="setx-head">
    <button id="settings-back" class="btn btn--ghost btn--sm" onclick={goBack}><Icon name="arrow-left" /> Back</button>
    <h2 class="setx-head__title">Settings</h2>
    <label class="setx-search">
      <Icon name="search" size={14} />
      <input type="text" placeholder="Search settings…" autocomplete="off" spellcheck="false" bind:value={filterQuery} oninput={applyFilter} />
    </label>
    <button class="btn btn--ghost btn--sm setx-head__wizard" title="Walk through the first-run setup again (keys, folders, sources)" onclick={() => navigate('/?onboarding=1')}>Setup wizard</button>
    <button id="settings-save" class="btn btn--primary" onclick={save}>Save</button>
  </div>

  <!-- Tab rail -->
  <nav class="setx-tabs" aria-label="Settings pages">
    {#each TABS as t (t.id)}
      <button type="button" class="setx-tab" class:is-active={activeTab === t.id} onclick={() => pickTab(t.id)}>
        <Icon name={t.icon} size={14} /> {t.label}
        {#if tabDot(t.id)}<span class="setx-tab__dot {tabDot(t.id)}"></span>{/if}
      </button>
    {/each}
  </nav>

  <div class="setx-body">
    <!-- OVERVIEW -->
    <div class="setx-page setx-page--narrow" data-tab="overview" class:is-active={activeTab === 'overview'}>
      <p class="setx-intro">How BackIssue is configured at a glance — click a card to jump to its page.</p>
      <div class="setx-cards">
        {#each overview.cards as c (c.id)}
          <button type="button" class="setx-scard setx-scard--{c.tone}" onclick={() => pickTab(c.tab)}>
            <span class="setx-scard__top">
              <span class="setx-scard__chip"><Icon name={c.icon} size={15} /></span>
              <span class="setx-scard__label">{c.label}</span>
              <span class="setx-dot setx-dot--{c.tone}"></span>
            </span>
            <span class="setx-scard__value">{c.value}</span>
            <span class="setx-scard__note">{c.note}</span>
          </button>
        {/each}
      </div>
      <div class="setx-card setx-attention">
        <h3 class="setx-card__head">Needs attention</h3>
        {#if !overview.attention.length}
          <div class="setx-attn"><span class="setx-attn__icon setx-attn__icon--green"><Icon name="check" size={15} /></span>
            <span class="setx-attn__text"><b>All good</b><span>Nothing needs attention right now.</span></span></div>
        {/if}
        {#each overview.attention as a (a.title)}
          <div class="setx-attn">
            <span class="setx-attn__icon setx-attn__icon--{a.tone}"><Icon name="alert-triangle" size={15} /></span>
            <span class="setx-attn__text"><b>{a.title}</b><span>{a.body}</span></span>
            <button class="btn btn--ghost btn--sm" type="button" onclick={() => pickTab(a.tab)}>{a.action}</button>
          </div>
        {/each}
      </div>
    </div>

    <!-- LIBRARY (master–detail) -->
    <div class="setx-page" data-tab="library" class:is-active={activeTab === 'library'}>
      <div class="setx-split" class:is-drilled={libDrill}>
        <div class="setx-rail">
          {@render railItem('lib', 'libraries', 'library', 'Libraries', `${libs.length} librar${libs.length === 1 ? 'y' : 'ies'}`, libs.length ? 'green' : 'amber')}
          {@render railItem('lib', 'org', 'book', 'File organization', 'Naming patterns', 'green')}
          {@render railItem('lib', 'maint', 'tag', 'Maintenance', 'Fallbacks & workers', 'green')}
        </div>
        <div class="setx-detail">
          <button type="button" class="setx-backlink" onclick={() => { libDrill = false; }}><Icon name="arrow-left" size={14} /> Library</button>

          <div class="setx-panel" class:is-active={libPanel === 'libraries'}>
            <h3 class="setx-panel__title">Libraries</h3>
            <p class="setx-panel__sub">Split the collection into named libraries — each shows as its own entry in the sidebar. A library's <b>type</b> sets how its series behave (manga = chapter-style search, right-to-left reading); its folders are where its comics are filed and scanned. Move series from a volume's ⋯ menu.</p>
            {#each libs as l (l.id)}
              <div class="libcard">
                <div class="libcard__head">
                  <span class="libcard__icon"><Icon name="book" /></span>
                  <input class="libcard__name" type="text" spellcheck="false" bind:value={l.name} onchange={() => saveLib(l)} title="Library name" />
                  <select bind:value={l.type} onchange={() => saveLib(l)} title="Library type — sets how its series behave">
                    {#each LIB_TYPES as [tv, label] (tv)}<option value={tv}>{label}</option>{/each}
                  </select>
                  <label class="field field--check libcard__mature" title="Hide this library (and everything in it) from roles without the “View mature content” permission">
                    <input type="checkbox" checked={!!l.restricted} onchange={(e) => { l.restricted = e.currentTarget.checked ? 1 : 0; saveLib(l); }} /><span>Mature</span></label>
                  <span class="scan-muted libcard__count">{l.series_count} series</span>
                  <button class="rootrow__x" type="button" title="Delete this library (series are kept)" aria-label="Delete library" onclick={() => removeLib(l)}><Icon name="trash" size={15} /></button>
                </div>
                <div class="rootlist">
                  {#each l.folders as _f, i (i)}
                    <div class="rootrow">
                      <input class="rootrow__path" type="text" spellcheck="false" bind:value={l.folders[i]} onchange={() => saveLib(l)}
                        placeholder={i === 0 ? 'D:\\Comics   or   \\\\NAS\\comics' : 'another folder to scan…'} />
                      {#if i === 0}
                        <span class="rootrow__badge" title="New comics for this library are filed here">Default</span>
                      {:else}
                        <button class="link-btn rootrow__def" type="button" onclick={() => libMakeDefault(l, i)} title="Make this the default folder for new comics">Make default</button>
                      {/if}
                      {#if l.folders.length > 1}
                        <button class="rootrow__x" type="button" title="Remove this folder (files stay on disk)" aria-label="Remove folder" onclick={() => libRemoveFolder(l, i)}><Icon name="close" size={15} /></button>
                      {/if}
                    </div>
                  {/each}
                  <button class="link-btn rootlist__add" type="button" onclick={() => libAddFolder(l)}><Icon name="plus" size={14} /> Add folder</button>
                </div>
                <div class="libcard__extras">
                  <label class="field"><span>Folder pattern</span>
                    <input type="text" spellcheck="false" placeholder="blank = global pattern" bind:value={l.folder_pattern} onchange={() => saveLib(l)} title="Per-library folder pattern, e.g. {'{series}'} for a tree without publisher folders" /></label>
                </div>
              </div>
            {/each}
            <div class="rootrow libcard__new">
              <input class="rootrow__path" style="max-width:200px" type="text" spellcheck="false" placeholder="New library name…" bind:value={newLib.name} onkeydown={(e) => { if (e.key === 'Enter') addLib(); }} />
              <select bind:value={newLib.type}>
                {#each LIB_TYPES as [tv, label] (tv)}<option value={tv}>{label}</option>{/each}
              </select>
              <button class="btn btn--ghost btn--sm" type="button" onclick={addLib}><Icon name="plus" size={14} /> Create library</button>
            </div>
            <!-- Plugin library-behavior settings inject here (plain DOM — stays mounted). -->
            <div id="settings-plugin-library"></div>
          </div>

          <div class="setx-panel" class:is-active={libPanel === 'org'}>
            <h3 class="setx-panel__title">File organization</h3>
            <p class="setx-panel__sub">How downloaded comics are named and filed.</p>
            <div class="setx-card">
              <label class="field"><span>Folder pattern</span><input id="set-folderPattern" class="mono" type="text" spellcheck="false" placeholder={'{publisher}/{series} ({year})'} oninput={previewNaming} /></label>
              <label class="field"><span>File pattern</span><input id="set-filePattern" class="mono" type="text" spellcheck="false" placeholder={'{series} V{year} #{issue}'} oninput={previewNaming} /></label>
              {#if namingPreview}<p class="setx-preview mono">{namingPreview}</p>{/if}
              <label class="field field--check">
                <span class="switch"><input id="set-renameDownloads" type="checkbox" /><span class="switch__track"></span></span>
                <span>Rename downloaded files to the file pattern (off = keep the source's original filename)</span>
              </label>
              <p class="modal__note">Tokens: <code>{'{publisher}'}</code> <code>{'{series}'}</code> <code>{'{year}'}</code> <code>{'{issue}'}</code> (<code>{'{issue:2}'}</code> sets the pad width) <code>{'{issueTitle}'}</code> <code>{'{date}'}</code> <code>{'{edition}'}</code>. Changing these affects <b>new</b> downloads — for existing files use <b>Reorganize library</b> on the Tools page.</p>
            </div>
          </div>

          <div class="setx-panel" class:is-active={libPanel === 'maint'}>
            <h3 class="setx-panel__title">Maintenance</h3>
            <p class="setx-panel__sub">Fallback locations and how hard the library tools work.</p>
            <div class="setx-card">
              <label class="field"><span>Downloads folder (fallback)</span><input id="set-downloadsDir" class="mono" type="text" spellcheck="false" /></label>
              <p class="modal__note">Only used when no library has a folder — normally every download files into its library.</p>
              <label class="field"><span>Tool workers</span><input id="set-toolsConcurrency" type="number" min="1" max="16" /></label>
              <p class="modal__note">How many files the library tools (convert / verify / tag) process at once — higher overlaps I/O but uses more memory per in-flight file.</p>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- DOWNLOADING -->
    <div class="setx-page setx-page--narrow" data-tab="downloading" class:is-active={activeTab === 'downloading'}>
      <h3 class="setx-panel__title">Downloading</h3>
      <p class="setx-panel__sub">What happens when you add a series, and how downloads run.</p>
      <div class="setx-card">
        <label class="field field--check">
          <span class="switch"><input id="set-autoDownloadOnAdd" type="checkbox" /><span class="switch__track"></span></span>
          <span>Download on add</span>
        </label>
        <p class="modal__note">Adding a series (Library, Discover, Releases, reading lists) immediately queues every issue for download. Off = series add empty and you press "Download missing" yourself.</p>
        <label class="field">
          <span>Download format</span>
          <select id="set-format"><option value="cbz">CBZ (with metadata)</option><option value="pdf">PDF</option></select>
        </label>
        <label class="field"><span>Simultaneous downloads</span><input id="set-downloadConcurrency" type="number" min="1" max="16" /></label>
        <p class="modal__note">How many issues download at once. Higher is faster but more likely to trip a source's rate limits. Applies to the next download.</p>
      </div>
    </div>

    <!-- SOURCES (master–detail) -->
    <div class="setx-page" data-tab="sources" class:is-active={activeTab === 'sources'}>
      <div class="setx-split" class:is-drilled={srcDrill}>
        <div class="setx-rail">
          {@render railItem('src', 'usenet', 'download', 'Usenet', 'Newznab + SABnzbd/NZBGet', srcOn.usenet ? 'green' : 'muted')}
          {@render railItem('src', 'torrent', 'download', 'Torrents', 'Torznab + qBittorrent', srcOn.torrent ? 'green' : 'muted')}
          {#each pluginSrc as pb (pb.key)}
            {@render railItem('src', pb.key, 'download', pb.label, pb.note, pb.on ? 'green' : 'muted')}
          {/each}
          {#if sourceOrder.length >= 2}
            {@render railItem('src', 'priority', 'arrow-up-down', 'Source priority', 'Which source tries first', 'green')}
          {/if}
          {#if !anySourceOn}
            <p class="setx-railwarn"><Icon name="alert-triangle" size={14} /> No sources enabled — nothing can download.</p>
          {/if}
        </div>
        <div class="setx-detail">
          <button type="button" class="setx-backlink" onclick={() => { srcDrill = false; }}><Icon name="arrow-left" size={14} /> Sources</button>

          <div class="setx-panel" class:is-active={srcPanel === 'usenet'}>
            <div class="setx-card setx-srchead">
              <label class="switch"><input id="set-usenetEnabled" type="checkbox" onchange={syncSourceUI} /><span class="switch__track"></span></label>
              <div class="setx-srchead__text">
                <b>Usenet</b>
                <span>Search Newznab indexers and download via SABnzbd or NZBGet.</span>
              </div>
              <span class="setx-dot setx-dot--{srcOn.usenet ? 'green' : 'muted'}"></span>
            </div>
            <div id="usenet-config" class="src-config setx-srcbody">
              <div class="setx-card" class:is-managed={srcManaged}>
                <h4 class="setx-card__head">Indexers</h4>
                {#if srcManaged}
                  <p class="modal__note indexers-managed"><Icon name="target" size={14} /> Managed by an indexer plugin — these manual indexers are ignored while it's enabled.</p>
                {/if}
                <div id="indexer-list" class="indexer-list">
                  {@render indexerRows('newznab', indexerList)}
                </div>
                <button id="add-indexer" class="btn btn--ghost btn--add" type="button" disabled={srcManaged} onclick={() => openIndexerModal(-1, 'newznab', null, saveIndexer)}>+ Add indexer</button>
                <p class="modal__note">Newznab (the standard indexer API — e.g. NZBgeek) indexers, searched in order; results are merged.</p>
              </div>

              <div class="setx-card">
                <h4 class="setx-card__head">Download client</h4>
                <label class="field"><span>Client</span>
                  <select id="set-nzbClient" onchange={syncSourceUI}><option value="sabnzbd">SABnzbd</option><option value="nzbget">NZBGet</option></select>
                </label>
                <label class="field"><span>Host</span><input id="set-nzbClientHost" class="mono" type="text" spellcheck="false" placeholder="nas or 192.168.1.10" /></label>
                <label class="field"><span>Port</span><input id="set-nzbClientPort" class="mono" type="number" min="1" max="65535" placeholder="8080" /></label>
                <label class="field field--check"><input id="set-nzbClientSsl" type="checkbox" /><span>Use HTTPS</span></label>
                <div class="only-sabnzbd">
                  <label class="field"><span>API key</span><input id="set-nzbClientApiKey" class="mono" type="text" spellcheck="false" /></label>
                </div>
                <div class="only-nzbget">
                  <label class="field"><span>Username</span><input id="set-nzbClientUser" type="text" spellcheck="false" /></label>
                  <label class="field"><span>Password</span><input id="set-nzbClientPass" type="password" spellcheck="false" /></label>
                </div>
                <label class="field"><span>Category</span><input id="set-nzbCategory" type="text" spellcheck="false" placeholder="backissue" /></label>
                <div class="client-test">
                  <button id="client-test" class="btn btn--ghost" type="button" onclick={testClient}>Test connection</button>
                  {#if tests.client}<span id="client-test-result" class="client-status {tests.client.cls}">{#if tests.client.icon}<Icon name={tests.client.icon} /> {/if}{tests.client.text}</span>{/if}
                </div>
              </div>

              <div class="setx-card">
                <h4 class="setx-card__head">Completed downloads</h4>
                <label class="field"><span>Folder (this app's view)</span><input id="set-usenetCompleteDir" class="mono" type="text" spellcheck="false" placeholder="\\NAS\dl\complete" /></label>
                <label class="field"><span>Folder (client's view)</span><input id="set-usenetCompleteDirRemote" class="mono" type="text" spellcheck="false" placeholder="/downloads/complete" /></label>
                <p class="modal__note">Only needed if the client runs on another machine. Map the folder it writes finished downloads to (client's view) onto the path this app reads it at over the network. <code>.cbr</code> releases are converted to <code>.cbz</code> so they can be tagged.</p>
              </div>

              <div class="setx-card">
                <h4 class="setx-card__head">Polling</h4>
                <div class="fields-row">
                  <label class="field"><span>Poll every (s)</span><input id="set-usenetPollSeconds" type="number" min="5" max="600" /></label>
                  <label class="field"><span>Give up after (min)</span><input id="set-usenetTimeoutMinutes" type="number" min="1" max="1440" /></label>
                </div>
                <p class="modal__note">BackIssue hands the NZB to your client under the category you set above (default <code>backissue</code>), watches it, imports each download when it completes (tag + file), and removes it from the client. Downloads are tracked in the database, so an app restart resumes them.</p>
              </div>
            </div>
          </div>

          <div class="setx-panel" class:is-active={srcPanel === 'torrent'}>
            <div class="setx-card setx-srchead">
              <label class="switch"><input id="set-torrentEnabled" type="checkbox" onchange={syncSourceUI} /><span class="switch__track"></span></label>
              <div class="setx-srchead__text">
                <b>Torrents</b>
                <span>Search Torznab indexers (Jackett/Prowlarr) and download via qBittorrent.</span>
              </div>
              <span class="setx-dot setx-dot--{srcOn.torrent ? 'green' : 'muted'}"></span>
            </div>
            <div id="torrent-config" class="src-config setx-srcbody">
              <div class="setx-card" class:is-managed={srcManaged}>
                <h4 class="setx-card__head">Indexers (Torznab)</h4>
                {#if srcManaged}
                  <p class="modal__note indexers-managed"><Icon name="target" size={14} /> Managed by an indexer plugin — these manual indexers are ignored while it's enabled.</p>
                {/if}
                <div id="torznab-list" class="indexer-list">
                  {@render indexerRows('torznab', torznabList)}
                </div>
                <button id="add-torznab" class="btn btn--ghost btn--add" type="button" disabled={srcManaged} onclick={() => openIndexerModal(-1, 'torznab', null, saveIndexer)}>+ Add indexer</button>
                <p class="modal__note">Torznab (the standard indexer API — e.g. Jackett or Prowlarr) feeds, searched in order; results are merged and ranked by seeders.</p>
              </div>

              <div class="setx-card">
                <h4 class="setx-card__head">qBittorrent</h4>
                <label class="field"><span>Host</span><input id="set-qbHost" class="mono" type="text" spellcheck="false" placeholder="nas or 192.168.1.10" /></label>
                <label class="field"><span>Port</span><input id="set-qbPort" class="mono" type="number" min="1" max="65535" placeholder="8080" /></label>
                <label class="field field--check"><input id="set-qbSsl" type="checkbox" /><span>Use HTTPS</span></label>
                <label class="field"><span>Username</span><input id="set-qbUser" type="text" spellcheck="false" /></label>
                <label class="field"><span>Password</span><input id="set-qbPass" type="password" spellcheck="false" /></label>
                <label class="field"><span>Category</span><input id="set-torrentCategory" type="text" spellcheck="false" placeholder="backissue" /></label>
                <div class="client-test">
                  <button id="qb-test" class="btn btn--ghost" type="button" onclick={testQb}>Test connection</button>
                  {#if tests.qb}<span id="qb-test-result" class="client-status {tests.qb.cls}">{#if tests.qb.icon}<Icon name={tests.qb.icon} /> {/if}{tests.qb.text}</span>{/if}
                </div>
              </div>

              <div class="setx-card">
                <h4 class="setx-card__head">Completed downloads</h4>
                <label class="field"><span>Folder (this app's view)</span><input id="set-torrentCompleteDir" class="mono" type="text" spellcheck="false" placeholder="\\NAS\dl\complete" /></label>
                <label class="field"><span>Folder (client's view)</span><input id="set-torrentCompleteDirRemote" class="mono" type="text" spellcheck="false" placeholder="/downloads/complete" /></label>
                <p class="modal__note">Only needed if qBittorrent runs on another machine. Map its content path onto the path this app reads over the network.</p>
              </div>

              <div class="setx-card">
                <h4 class="setx-card__head">Polling</h4>
                <div class="fields-row">
                  <label class="field"><span>Poll every (s)</span><input id="set-torrentPollSeconds" type="number" min="5" max="600" /></label>
                  <label class="field"><span>Give up after (min)</span><input id="set-torrentTimeoutMinutes" type="number" min="1" max="1440" /></label>
                </div>
                <p class="modal__note">BackIssue hands the magnet/.torrent to qBittorrent, watches it, and imports each torrent when it completes. After import the torrent is <b>left seeding</b> — manage ratio and removal in qBittorrent.</p>
              </div>

              <div class="setx-card">
                <h4 class="setx-card__head">Weekly 0-Day pack</h4>
                <label class="field"><span>Search phrase</span><input id="set-zeroDayQuery" type="text" spellcheck="false" placeholder="0-Day Week" /></label>
                <label class="field field--check"><input id="set-zeroDayAddNew" type="checkbox" /><span>Add new series I don't follow (confident ComicVine matches only)</span></label>
                <p class="modal__note">A scheduled job finds the newest <b>0-Day Week of …</b> pack on your Torznab indexers, downloads it, and imports the <b>missing</b> issues of series already in your collection. Turn the schedule on from the <b>Jobs</b> page.</p>
              </div>
            </div>
          </div>

          <div class="setx-panel" class:is-active={srcPanel === 'priority'}>
            <h3 class="setx-panel__title">Source priority</h3>
            <p class="setx-panel__sub">When more than one source can serve an issue, they're tried top-to-bottom — the first with a match wins.</p>
            <div class="setx-card" id="source-priority-list">
              {#each sourceOrder as s, i (s.id)}
                <div class="srcpri-row">
                  <span class="srcpri-rank">{i + 1}</span><span class="srcpri-name">{priorityLabel(s)}</span>
                  <button class="srcpri-btn" type="button" disabled={i === 0} onclick={() => movePriority(i, -1)}><Icon name="arrow-up" /></button>
                  <button class="srcpri-btn" type="button" disabled={i === sourceOrder.length - 1} onclick={() => movePriority(i, 1)}><Icon name="arrow-down" /></button>
                </div>
              {/each}
            </div>
            <!-- Plugin priority widgets inject here (plain DOM — must stay mounted). -->
            <div id="settings-plugin-priority"></div>
          </div>

          <!-- Plugin source blocks inject here (plain DOM — must stay mounted; each
               block is surfaced as its own rail entry and class-toggled in place,
               never moved, so plugin re-injection guards keep working). -->
          <div id="settings-plugin-sources"></div>
        </div>
      </div>
    </div>

    <!-- METADATA -->
    <div class="setx-page setx-page--narrow" data-tab="metadata" class:is-active={activeTab === 'metadata'}>
      <h3 class="setx-panel__title">Metadata</h3>
      <p class="setx-panel__sub">ComicVine keys and where release and tagging data come from.</p>
      <div class="setx-card">
        <h4 class="setx-card__head">ComicVine API</h4>
        <label class="field"><span>API key</span><input id="set-comicvineKeys" class="mono" type="text" spellcheck="false" autocomplete="off" placeholder="ComicVine API key…" /></label>
        <p class="modal__note">Free at comicvine.gamespot.com — it identifies every series and issue.</p>
        <div class="client-test"><button id="cv-test" class="btn btn--ghost" type="button" onclick={testCv}>Test key</button>
          {#if tests.cv}<span id="cv-test-result" class="client-status {tests.cv.cls}">{#if tests.cv.icon}<Icon name={tests.cv.icon} /> {/if}{tests.cv.text}</span>{/if}</div>
        <label class="field"><span>API base URL (optional)</span><input id="set-cvBaseUrl" class="mono" type="text" spellcheck="false" placeholder="https://data.backissue.app/api" /></label>
        <p class="modal__note">Point metadata lookups at a ComicVine-compatible server instead of the official API — no rate limits, and politeness delays are skipped automatically. Blank = official ComicVine.</p>
      </div>
      <div class="setx-card">
        <h4 class="setx-card__head">Tagging &amp; files</h4>
        <label class="field">
          <span>Tag on download</span>
          <select id="set-tagOnDownload"><option value="off">Off</option><option value="on">On</option></select>
        </label>
        <p class="modal__note">ComicInfo.xml is written straight into the CBZ from the metadata source; <code>.cbr</code> downloads are converted to <code>.cbz</code> so they can be tagged.</p>
      </div>
      <div class="setx-card">
        <h4 class="setx-card__head">Enrichment</h4>
        <label class="field field--check">
          <span class="switch"><input id="set-cvEnrich" type="checkbox" /><span class="switch__track"></span></span>
          <span>Enrich metadata (content ratings, series status, issue extras)</span>
        </label>
        <p class="modal__note">When the metadata server supports it, adds Metron data — content ratings, series status and end year, and per-issue extras like price, UPC, and story titles. The official ComicVine API ignores the request, so it's safe either way.</p>
      </div>
      <div class="setx-card">
        <h4 class="setx-card__head">Manga</h4>
        <label class="field">
          <span>Content rating ceiling</span>
          <select id="set-mangaRating">
            <option value="safe">Safe only</option>
            <option value="suggestive">Up to Suggestive</option>
            <option value="erotica">Up to Erotica (default)</option>
            <option value="pornographic">Everything</option>
          </select>
        </label>
        <p class="modal__note">How far manga search reaches into MangaDex's content ratings — each level includes the ones below it. Applies to the Add dialog's manga lane and manga-library imports.</p>
      </div>
      <div class="setx-card">
        <h4 class="setx-card__head">Releases</h4>
        <label class="field"><span>Release provider URL</span><input id="set-releaseProviderUrl" class="mono" type="text" spellcheck="false" placeholder="https://data.backissue.app" /></label>
        <p class="modal__note">The release provider feeds "This week's releases".</p>
      </div>
    </div>

    <!-- SIGN-IN -->
    <div class="setx-page setx-page--narrow" data-tab="signin" class:is-active={activeTab === 'signin'}>
      <h3 class="setx-panel__title">Sign-in</h3>
      <p class="setx-panel__sub">How people sign in. Password login always works for admins.</p>
      <div class="setx-card">
        <p class="modal__note">Add an SSO provider (e.g. OIDC) or another login backend from the <b>Plugins</b> page to let users sign in with an identity provider.</p>
        <!-- Auth plugin config (e.g. OIDC/SSO, WHMCS) injects here (plain DOM — stays mounted). -->
        <div id="settings-plugin-auth"></div>
        <label class="field field--check">
          <span class="switch"><input id="set-passwordLoginDisabled" type="checkbox" /><span class="switch__track"></span></span>
          <span>Disable password login (SSO only — admins keep a password fallback)</span>
        </label>
      </div>
    </div>

    <!-- NOTIFICATIONS -->
    <div class="setx-page setx-page--narrow" data-tab="notifications" class:is-active={activeTab === 'notifications'}>
      <h3 class="setx-panel__title">Notifications</h3>
      <p class="setx-panel__sub">Where BackIssue sends alerts. The in-app bell always records everything regardless. Open a channel to configure it.</p>
      <!-- Outbound channels are provided by plugins (the notifications hub
           injects one collapsible card per channel, like the source cards). -->
      <div id="settings-plugin-notifications"></div>
      {#if !notifyChannels}
        <div class="setx-card setx-empty">
          <span class="setx-empty__icon"><Icon name="bell" size={22} /></span>
          <b>No outbound channels installed</b>
          <p class="modal__note">Add the <b>Notifications Hub</b> plugin to send alerts to Discord, Telegram, Pushover, ntfy, or any webhook.</p>
          <button class="btn btn--ghost btn--sm" type="button" onclick={() => navigate('/plugins')}>Browse plugins</button>
        </div>
      {/if}
    </div>
  </div>

  <!-- Unsaved-changes save bar -->
  {#if dirty}
    <div class="setx-savebar">
      <span class="setx-savebar__dot"></span>
      <span class="setx-savebar__text">You have unsaved changes.</span>
      <button class="btn btn--ghost btn--sm" type="button" onclick={discardEdits}>Discard</button>
      <button class="btn btn--primary btn--sm" type="button" onclick={save}>Save changes</button>
    </div>
  {/if}
</main>
