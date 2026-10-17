<script>
  import { untrack, tick } from 'svelte';
  import { goBack, navigate, route } from '../lib/router.svelte.js';
  import { apiGet, apiPost, apiDelete } from '../lib/api.js';
  import { flags } from '../lib/store.svelte.js';
  import { BackIssue, plugins, bridgeRefs } from '../lib/plugins.svelte.js';
  import { parseIndexerString, serializeIndexers } from '../lib/util.js';
  import { openIndexerModal, testIndexer } from './IndexerModal.svelte';
  import { confirmDialog } from './DialogModal.svelte';
  import { notify } from '../lib/toasts.svelte.js';
  import { t, th, hasMessage } from '../lib/i18n.svelte.js';
  import Icon from '../lib/Icon.svelte';
  import { hscroll } from '../lib/hscroll.js';

  // A label a plugin or source card sends may be a catalog key ('myplugin.apiKey')
  // or a plain string; show the translation when there is one.
  const lbl = (x) => (typeof x === 'string' && hasMessage(x) ? t(x) : x);
  let { active = false } = $props();

  const DEFAULT_PORTS = { sabnzbd: '8080', nzbget: '6789' };
  const TORRENT_PORTS = { qbittorrent: ['#set-qbPort', '8080'], transmission: ['#set-trPort', '9091'], deluge: ['#set-delugePort', '8112'] };

  // "Split detail" settings: a top tab rail shows ONE page at a time. Every
  // page stays MOUNTED (CSS-hidden, never {#if}-removed) — the generic set-*
  // form scan reads hidden fields fine, and plugin-injected DOM must survive
  // tab switches. `label` is a catalog key, resolved where rendered.
  const TABS = [
    { id: 'overview', label: 'settingsPage.tabOverview', icon: 'bar-chart' },
    { id: 'library', label: 'settingsPage.tabLibrary', icon: 'library' },
    { id: 'downloading', label: 'settingsPage.tabDownloading', icon: 'download' },
    { id: 'sources', label: 'settingsPage.tabSources', icon: 'target' },
    { id: 'metadata', label: 'settingsPage.tabMetadata', icon: 'tag' },
    { id: 'plugins', label: 'settingsPage.tabPlugins', icon: 'puzzle' }, // hidden until a plugin mounts a panel
    { id: 'signin', label: 'settingsPage.tabSignin', icon: 'shield' },
    { id: 'notifications', label: 'settingsPage.tabNotifications', icon: 'bell' },
  ];
  let activeTab = $state('overview');
  let libPanel = $state('libraries');   // libraries | org | maint
  let srcPanel = $state('usenet');      // usenet | torrent | priority
  let plgPanel = $state('');            // selected plugin panel (Plugins tab)
  let libDrill = $state(false);         // mobile: rail list → panel detail
  let srcDrill = $state(false);
  let plgDrill = $state(false);
  let anySourceOn = $state(false);
  let srcOn = $state({ usenet: false, torrent: false }); // live toggle state (pre-save)
  let srcManaged = $state(false); // an indexer-provider plugin (e.g. Prowlarr) is managing the indexer lists
  let enabledSourceCount = $state(0);
  // Sources defined through the toolkit (api.defineSource): the server sends
  // their settings cards, and this page renders them — a site plugin ships no
  // client code. kitOn mirrors each card's toggle for the rail dot.
  let kitCards = $state([]);
  let kitOn = $state({});
  let kitTests = $state({});
  const kitNote = (text) => {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    const one = (s.match(/^[^.!?]*[.!?]/)?.[0] || s).trim();
    return one.length > 90 ? one.slice(0, 89).replace(/\s+\S*$/, '') + '…' : (one || t('settingsPage.downloadSource'));
  };
  async function testKitSource(c) {
    kitTests[c.id] = { cls: 'is-testing', text: t('settingsPage.testing') };
    const body = { [c.id + 'Enabled']: !!root.querySelector('#set-' + c.id + 'Enabled')?.checked };
    for (const f of c.fields) {
      const el = root.querySelector('#set-' + f.key);
      if (el) body[f.key] = f.type === 'bool' ? !!el.checked : (f.type === 'int' ? Number(el.value) : String(el.value).trim());
    }
    let r;
    try { r = await apiPost('/api/sources/' + c.id + '/test', body); }
    catch (e) { r = { ok: false, message: String(e) }; }
    kitTests[c.id] = { cls: r.ok ? 'is-ok' : 'is-bad', icon: r.ok ? 'check' : 'close', text: r.message, ok: !!r.ok };
  }
  let dirtySections = $state(new Set()); // tab ids with unsaved edits
  let filterQuery = $state('');
  let loadedSettings = $state({});       // last-loaded settings (Overview reads it)
  let notifyChannels = $state(0);        // plugin-injected channel cards

  function pickTab(id) {
    activeTab = id;
    libDrill = false; srcDrill = false; plgDrill = false; // mobile drill resets on tab switch
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
  let LIB_TYPES = $state([['comic', t('settingsPage.libTypeComics')], ['manga', t('settingsPage.libTypeManga')]]);
  const parseRoots = (text) => String(text || '').split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
  const withFolders = (l) => ({ ...l, folders: parseRoots(l.root_folder).length ? parseRoots(l.root_folder) : [''] });
  async function loadLibs() {
    try {
      const r = await apiGet('/api/libraries');
      libs = (r.libraries || []).map(withFolders);
      if (Array.isArray(r.types) && r.types.length) LIB_TYPES = r.types.map((x) => [x.id, x.label]);
    } catch { notify(t('settingsPage.librariesLoadFailed'), 'error'); }
  }
  $effect(() => { if (active) loadLibs(); });
  async function addLib() {
    if (!newLib.name.trim()) return notify(t('settingsPage.libraryNeedsName'), 'error');
    const r = await apiPost('/api/libraries', { name: newLib.name.trim(), type: newLib.type, rootFolder: newLib.rootFolder.trim() || null });
    if (r.error) return notify(r.error, 'error');
    libs = r.libraries.map(withFolders); newLib = { name: '', type: 'comic', rootFolder: '' };
    notify(t('settingsPage.libraryCreated'), 'ok');
  }
  async function saveLib(l) {
    const rootFolder = (l.folders || []).map((s) => s.trim()).filter(Boolean).join('\n');
    const r = await apiPost('/api/libraries/' + l.id, { name: l.name, type: l.type, rootFolder: rootFolder || null, folderPattern: l.folder_pattern || null, restricted: !!l.restricted, tagPlacement: l.tag_placement || null });
    if (r.error) return notify(r.error, 'error');
    libs = r.libraries.map(withFolders); notify(t('settingsPage.libraryUpdated'), 'ok');
  }
  const libAddFolder = (l) => { l.folders = [...l.folders, '']; };
  const libRemoveFolder = (l, i) => { l.folders = l.folders.filter((_, k) => k !== i); if (!l.folders.length) l.folders = ['']; saveLib(l); };
  const libMakeDefault = (l, i) => { if (i <= 0) return; const next = [...l.folders]; const [f] = next.splice(i, 1); l.folders = [f, ...next]; saveLib(l); };
  async function removeLib(l) {
    if (!(await confirmDialog({
      title: t('settingsPage.deleteLibraryTitle', { name: l.name }),
      message: t('settingsPage.deleteLibraryMessage', { count: l.series_count }),
      confirmLabel: t('settingsPage.deleteLibraryConfirm'), danger: true,
    }))) return;
    const r = await apiDelete('/api/libraries/' + l.id);
    if (r.error) return notify(r.error, 'error');
    libs = r.libraries.map(withFolders); notify(t('settingsPage.libraryDeleted'), 'ok');
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
    body.metadataSources = metaOrder.filter((p) => p.enabled).map((p) => p.id).join(',');
    return body;
  }

  // Metadata providers come from the server in priority order with the
  // fields each needs; every row is rendered generically and its fields stay
  // mounted (their set-* ids are collected on save) whether or not it is on.
  let metaOrder = $state([]);
  const providerName = (p) => String(p?.label || p?.id || '').split(' (')[0];
  function touchMeta() {
    dirty = true;
    if (!dirtySections.has('metadata')) dirtySections = new Set(dirtySections).add('metadata');
  }
  function moveMeta(i, dir) {
    const j = i + dir;
    [metaOrder[i], metaOrder[j]] = [metaOrder[j], metaOrder[i]];
    touchMeta();
  }
  function toggleMeta(p, on) { p.enabled = on; touchMeta(); refreshOverview(); }
  const testProvider = (p) => runTest(`prov-${p.id}`, '/api/metadata/providers/test',
    () => ({ provider: p.id, values: Object.fromEntries(p.fields.map((f) => [f.key, v('#set-' + f.key)])) }));
  const providerTestLabel = (p) => !p.fields.length ? t('settingsPage.testSource') : p.fields.length === 1 ? t('settingsPage.testKey') : t('settingsPage.testSignIn');

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
    const tcfg = root.querySelector('#torrent-config');
    tcfg.classList.remove('client-qbittorrent', 'client-transmission', 'client-deluge');
    const tclient = root.querySelector('#set-torrentClient').value;
    tcfg.classList.add('client-' + tclient);
    const [tportSel, tportDefault] = TORRENT_PORTS[tclient] || TORRENT_PORTS.qbittorrent;
    const tport = root.querySelector(tportSel);
    tport.placeholder = tportDefault;
    if (!tport.value) tport.value = tportDefault;
    srcOn = { usenet, torrent };
    // An indexer-provider plugin (e.g. Prowlarr) may be managing the lists.
    srcManaged = BackIssue._indexerManagedHooks.some((fn) => { try { return !!fn(); } catch { return false; } });
    const pluginEnabled = BackIssue._sourceSyncHooks.map((fn) => { try { return !!fn(); } catch { return false; } });
    const kitEnabled = kitCards.map((c) => !!root.querySelector('#set-' + c.id + 'Enabled')?.checked);
    kitOn = Object.fromEntries(kitCards.map((c, i) => [c.id, kitEnabled[i]]));
    enabledSourceCount = [usenet, torrent, ...pluginEnabled, ...kitEnabled].filter(Boolean).length;
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
  let pluginPanels = $state([]); // the dedicated Plugins tab (settings-plugin-panels)
  function scanMount(mountId) {
    const mount = document.getElementById(mountId);
    if (!mount) return [];
    const out = [];
    // The rail note is the description's first sentence — whole words, never a
    // hard cut mid-word (a 48-character slice used to end in "hubs via t").
    const firstSentence = (text) => {
      const s = String(text || '').replace(/\s+/g, ' ').trim();
      const one = (s.match(/^[^.!?]*[.!?]/)?.[0] || s).trim();
      return one.length > 90 ? one.slice(0, 89).replace(/\s+\S*$/, '') + '…' : one;
    };
    [...mount.querySelectorAll(':scope > .src-block')].forEach((block, i) => {
      const key = 'plugin:' + (block.id || i);
      block.dataset.setxKey = key;
      const sw = block.querySelector('.switch input');
      out.push({
        key,
        label: block.querySelector('.src-toggle b')?.textContent?.trim() || 'Plugin',
        note: firstSentence(block.querySelector('.src-toggle .modal__note')?.textContent) || 'Plugin settings',
        on: !!sw?.checked,
      });
      if (sw && !sw.dataset.setxWired) { sw.dataset.setxWired = '1'; sw.addEventListener('change', () => syncSourceUI()); }
    });
    return out;
  }
  function scanPluginBlocks() {
    pluginSrc = scanMount('settings-plugin-sources');
    pluginPanels = scanMount('settings-plugin-panels');
    // The Plugins tab's rail needs a selection once panels exist.
    if (pluginPanels.length && !pluginPanels.some((p) => p.key === plgPanel)) plgPanel = pluginPanels[0].key;
  }
  // Reflect the selected panel onto the plugin blocks (in place, CSS only).
  function reflectMount(mountId, selected) {
    const mount = document.getElementById(mountId);
    if (!mount) return;
    for (const block of mount.querySelectorAll(':scope > .src-block')) {
      block.classList.toggle('setx-active', block.dataset.setxKey === selected);
    }
  }
  $effect(() => { void pluginSrc; reflectMount('settings-plugin-sources', srcPanel); });
  $effect(() => { void pluginPanels; reflectMount('settings-plugin-panels', plgPanel); });

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
    const [s, srcInfo, prov] = await Promise.all([apiGet('/api/settings'), apiGet('/api/sources').catch(() => ({})), apiGet('/api/metadata/providers').catch(() => [])]);
    loadedSettings = s || {};
    // Toolkit source cards and provider fields must exist in the DOM before
    // the form is filled.
    kitCards = srcInfo?.cards || [];
    metaOrder = (Array.isArray(prov) ? prov : []).map((p) => ({ ...p }));
    await tick();
    applySettingsToForm(s);
    indexerList = parseIndexerString(s.newznabIndexers);
    torznabList = parseIndexerString(s.torznabIndexers);
    sourceOrder = srcInfo?.sources || [];
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
    const metaOn = metaOrder.filter((p) => p.enabled);
    const metaBad = metaOn.filter((p) => !p.configured);
    const libFolders = libs.filter((l) => (l.folders || []).some((f) => f.trim())).length;
    const totalSeries = libs.reduce((n, l) => n + (l.series_count || 0), 0);
    const tone = (x) => x; // green | amber | red
    overview.cards = [
      { id: 'sources', tab: 'sources', icon: 'target', label: t('settingsPage.ovSources'),
        value: t('settingsPage.ovEnabledCount', { count: enabledSourceCount }),
        note: enabledSourceCount >= 2 ? t('settingsPage.ovFallbackApplies') : enabledSourceCount === 1 ? t('settingsPage.ovNoFallback') : t('settingsPage.ovNothingDownloads'),
        tone: tone(enabledSourceCount >= 2 ? 'green' : enabledSourceCount === 1 ? 'amber' : 'red') },
      { id: 'comicvine', tab: 'metadata', icon: 'tag', label: t('settingsPage.ovMetadata'),
        value: metaOn.length >= 2 ? t('settingsPage.ovSourcesCount', { count: metaOn.length }) : metaOn[0] && metaOn[0].id !== 'hosted' ? providerName(metaOn[0]) : t('settingsPage.ovBuiltIn'),
        note: metaBad.length ? t('settingsPage.ovNotSetUp', { name: providerName(metaBad[0]) })
          : metaOn.length >= 2 ? t('settingsPage.ovMerge')
          : metaOn[0] && metaOn[0].id !== 'hosted' ? t('settingsPage.ovDirect')
          : t('settingsPage.ovCached'),
        tone: tone(metaBad.length ? 'red' : 'green') },
      { id: 'libraries', tab: 'library', icon: 'library', label: t('settingsPage.ovLibraries'),
        value: t('settingsPage.ovLibrariesCount', { count: libs.length }), note: t('settingsPage.ovSeriesCount', { count: totalSeries }),
        tone: tone(libs.length ? 'green' : 'amber') },
      { id: 'storage', tab: 'library', icon: 'book', label: t('settingsPage.ovStorage'),
        value: libFolders ? t('settingsPage.ovWithFolders', { count: libFolders }) : t('settingsPage.ovNoFolders'),
        note: libFolders ? t('settingsPage.ovFilesInto') : t('settingsPage.ovSetFolder'),
        tone: tone(libFolders ? 'green' : 'amber') },
      { id: 'downloading', tab: 'downloading', icon: 'download', label: t('settingsPage.ovDownloading'),
        value: t('settingsPage.ovAtOnce', { count: s.downloadConcurrency || 4 }),
        note: t('settingsPage.ovFormat', { format: (s.format || 'cbz').toUpperCase() }) + (s.autoDownloadOnAdd ? t('settingsPage.ovDownloadsOnAdd') : ''),
        tone: 'green' },
      { id: 'notifications', tab: 'notifications', icon: 'bell', label: t('settingsPage.ovNotifications'),
        value: notifyChannels ? t('settingsPage.ovChannels', { count: notifyChannels }) : t('settingsPage.ovNoneInstalled'),
        note: notifyChannels ? t('settingsPage.ovOutbound') : t('settingsPage.ovBellOnly'),
        tone: tone(notifyChannels ? 'green' : 'amber') },
    ];
    const attention = [];
    for (const p of metaBad) attention.push({ tone: 'red', title: t('settingsPage.ovNotSetUp', { name: providerName(p) }), body: t(metaOn.length >= 2 ? 'settingsPage.attnProviderBodyOthers' : 'settingsPage.attnProviderBody'), action: t('settingsPage.attnSetUp'), tab: 'metadata' });
    if (enabledSourceCount === 0) attention.push({ tone: 'red', title: t('settingsPage.attnNoSourcesTitle'), body: t('settingsPage.attnNoSourcesBody'), action: t('settingsPage.attnEnable'), tab: 'sources' });
    else if (enabledSourceCount === 1) attention.push({ tone: 'amber', title: t('settingsPage.attnOneSourceTitle'), body: t('settingsPage.attnOneSourceBody'), action: t('settingsPage.attnReview'), tab: 'sources' });
    if (libs.length && !libFolders) attention.push({ tone: 'amber', title: t('settingsPage.attnNoFolderTitle'), body: t('settingsPage.attnNoFolderBody'), action: t('settingsPage.attnSetFolder'), tab: 'library' });
    // A populated library without its own folder files into another library's
    // root — worth surfacing per library (e.g. the auto-created Manga library).
    for (const l of libs) {
      if (l.series_count > 0 && !(l.folders || []).some((f) => f.trim()) && libFolders) {
        attention.push({ tone: 'amber', title: t('settingsPage.attnLibNoFolderTitle', { name: l.name }), body: t('settingsPage.attnLibNoFolderBody'), action: t('settingsPage.attnSetFolder'), tab: 'library' });
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
    if (want && TABS.some((tb) => tb.id === want)) untrack(() => pickTab(want));
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
        title: t('settingsPage.discardTitle'),
        message: t('settingsPage.discardMessage'),
        confirmLabel: t('settingsPage.discardConfirm'), danger: true,
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
    catch { return notify(t('settingsPage.saveFailedUnreachable'), 'error'); }
    if (r?.error) return notify(t('settingsPage.saveFailed', { error: r.error }), 'error');
    flags.usenetEnabled = !!root.querySelector('#set-usenetEnabled')?.checked;
    flags.torrentEnabled = !!root.querySelector('#set-torrentEnabled')?.checked;
    loadedSettings = { ...loadedSettings, ...collectSettingsFromForm() };
    dirty = false;
    dirtySections = new Set();
    refreshOverview();
    notify(t('settingsPage.saved'), 'ok');
  }
  async function discardEdits() {
    dirty = false;
    dirtySections = new Set();
    await openSettings();
    notify(t('settingsPage.discarded'), 'info');
  }

  /* ---- Indexer rows ---- */
  function saveIndexer(ix, editIndex, mode) {
    const list = MODE_LISTS[mode]();
    if (editIndex >= 0) list[editIndex] = ix;
    else list.push(ix);
    dirty = true;
  }
  async function testRow(ix, mode) {
    ix._st = { cls: 'is-testing', text: t('settingsPage.testing'), title: '' };
    const r = await testIndexer(ix, MODE_ENDPOINTS[mode]);
    ix._st = { cls: r.ok ? 'is-ok' : 'is-bad', icon: r.ok ? 'check' : 'close', text: r.ok ? t('settingsPage.testOk') : t('settingsPage.testFailed'), title: r.message };
  }

  /* ---- Connection tests (download clients + CV keys) ---- */
  let tests = $state({ client: null, qb: null, cv: null, meta: null });
  async function runTest(key, endpoint, collect) {
    tests[key] = { cls: 'is-testing', text: t('settingsPage.testing') };
    let r;
    try { r = await apiPost(endpoint, collect()); }
    catch (e) { r = { ok: false, message: String(e) }; }
    tests[key] = { cls: r.ok ? 'is-ok' : 'is-bad', icon: r.ok ? 'check' : 'close', text: r.message, ok: !!r.ok };
  }
  const v = (sel) => root.querySelector(sel)?.value ?? '';
  const checked = (sel) => !!root.querySelector(sel)?.checked;
  const testClient = () => runTest('client', '/api/clients/test', () => ({
    nzbClient: v('#set-nzbClient'),
    nzbClientHost: v('#set-nzbClientHost').trim(),
    nzbClientUrlBase: v('#set-nzbClientUrlBase').trim(),
    nzbClientPort: v('#set-nzbClientPort').trim(),
    nzbClientSsl: checked('#set-nzbClientSsl'),
    nzbClientApiKey: v('#set-nzbClientApiKey').trim(),
    nzbClientUser: v('#set-nzbClientUser').trim(),
    nzbClientPass: v('#set-nzbClientPass'),
  }));
  const testQb = () => runTest('qb', '/api/torrent-client/test', () => ({
    torrentClient: v('#set-torrentClient'),
    qbHost: v('#set-qbHost').trim(),
    qbUrlBase: v('#set-qbUrlBase').trim(),
    qbPort: v('#set-qbPort').trim(),
    qbSsl: checked('#set-qbSsl'),
    qbUser: v('#set-qbUser').trim(),
    qbPass: v('#set-qbPass'),
    trHost: v('#set-trHost').trim(),
    trUrlBase: v('#set-trUrlBase').trim(),
    trPort: v('#set-trPort').trim(),
    trSsl: checked('#set-trSsl'),
    trUser: v('#set-trUser').trim(),
    trPass: v('#set-trPass'),
    delugeHost: v('#set-delugeHost').trim(),
    delugeUrlBase: v('#set-delugeUrlBase').trim(),
    delugePort: v('#set-delugePort').trim(),
    delugeSsl: checked('#set-delugeSsl'),
    delugePass: v('#set-delugePass'),
  }));
  // Built-in service: registration + round trip. A success may have JUST
  // provisioned the key — refresh loadedSettings so the status line updates.
  const testMeta = async () => {
    await runTest('meta', '/api/metadata/test', () => ({}));
    if (tests.meta?.ok) { try { loadedSettings = { ...loadedSettings, ...(await apiGet('/api/settings')) }; } catch { /* status refreshes next open */ } }
  };

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
    <p class="indexer-empty">{t('settingsPage.noIndexers')}</p>
  {/if}
  {#each list as ix, i (i)}
    <div class="indexer-row">
      <div class="indexer-row__info"><b>{ix.name}</b><span>{ix.url}</span></div>
      <span class="indexer-row__status {ix._st?.cls || ''}" title={ix._st?.title || ''}>{#if ix._st?.icon}<Icon name={ix._st.icon} /> {/if}{ix._st?.text || ''}</span>
      <button class="link-btn" type="button" onclick={() => testRow(ix, mode)}>{t('settingsPage.test')}</button>
      <button class="link-btn" type="button" onclick={() => openIndexerModal(i, mode, ix, saveIndexer)}>{t('common.edit')}</button>
      <button class="indexer-row__x" type="button" title={t('common.remove')} onclick={() => { list.splice(i, 1); dirty = true; }}><Icon name="close" /></button>
    </div>
  {/each}
{/snippet}

{#snippet railItem(kind, key, icon, label, note, dot)}
  <button type="button" class="setx-rail__item"
    class:is-active={(kind === 'lib' ? libPanel : kind === 'plg' ? plgPanel : srcPanel) === key}
    onclick={() => {
      if (kind === 'lib') { libPanel = key; libDrill = true; }
      else if (kind === 'plg') { plgPanel = key; plgDrill = true; }
      else { srcPanel = key; srcDrill = true; }
    }}>
    <span class="setx-rail__icon"><Icon name={icon} size={15} /></span>
    <span class="setx-rail__text"><b>{label}</b><span>{note}</span></span>
    <span class="setx-dot setx-dot--{dot}"></span>
  </button>
{/snippet}

<svelte:window onbeforeunload={onBeforeUnload} />

<main id="settings-page" class="scan-page settings-page setx-shell" bind:this={root} oninput={markDirty} onchange={markDirty}>
  <!-- Header bar -->
  <div class="setx-head">
    <button id="settings-back" class="btn btn--ghost btn--sm" onclick={goBack}><Icon name="arrow-left" /> {t('common.back')}</button>
    <h2 class="setx-head__title">{t('common.settings')}</h2>
    <label class="setx-search">
      <Icon name="search" size={14} />
      <input type="text" placeholder={t('settingsPage.searchPlaceholder')} autocomplete="off" spellcheck="false" bind:value={filterQuery} oninput={applyFilter} />
    </label>
    <button class="btn btn--ghost btn--sm setx-head__wizard" title={t('settingsPage.wizardTitle')} onclick={() => navigate('/?onboarding=1')}>{t('settingsPage.setupWizard')}</button>
    <button id="settings-save" class="btn btn--primary" onclick={save}>{t('common.save')}</button>
  </div>

  <!-- Tab rail -->
  <nav class="setx-tabs" aria-label={t('settingsPage.tabsLabel')} use:hscroll>
    {#each TABS.filter((tb) => tb.id !== 'plugins' || pluginPanels.length) as tb (tb.id)}
      <button type="button" class="setx-tab" class:is-active={activeTab === tb.id} onclick={() => pickTab(tb.id)}>
        <Icon name={tb.icon} size={14} /> {t(tb.label)}
        {#if tabDot(tb.id)}<span class="setx-tab__dot {tabDot(tb.id)}"></span>{/if}
      </button>
    {/each}
  </nav>

  <div class="setx-body">
    <!-- OVERVIEW -->
    <div class="setx-page setx-page--narrow" data-tab="overview" class:is-active={activeTab === 'overview'}>
      <p class="setx-intro">{t('settingsPage.ovIntro')}</p>
      <div class="setx-cards">
        {#each overview.cards as c (c.id)}
          <button type="button" class="setx-scard setx-scard--{c.tone}" onclick={() => pickTab(c.tab)}>
            <span class="setx-scard__top">
              <span class="setx-scard__chip"><Icon name={c.icon} size={15} /></span>
              <span class="setx-scard__label">{lbl(c.label)}</span>
              <span class="setx-dot setx-dot--{c.tone}"></span>
            </span>
            <span class="setx-scard__value">{c.value}</span>
            <span class="setx-scard__note">{lbl(c.note)}</span>
          </button>
        {/each}
      </div>
      <div class="setx-card setx-attention">
        <h3 class="setx-card__head">{t('settingsPage.needsAttention')}</h3>
        {#if !overview.attention.length}
          <div class="setx-attn"><span class="setx-attn__icon setx-attn__icon--green"><Icon name="check" size={15} /></span>
            <span class="setx-attn__text"><b>{t('settingsPage.allGood')}</b><span>{t('settingsPage.allGoodBody')}</span></span></div>
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
          {@render railItem('lib', 'libraries', 'library', t('settingsPage.railLibraries'), t('settingsPage.ovLibrariesCount', { count: libs.length }), libs.length ? 'green' : 'amber')}
          {@render railItem('lib', 'org', 'book', t('settingsPage.railOrg'), t('settingsPage.railOrgNote'), 'green')}
          {@render railItem('lib', 'maint', 'tag', t('settingsPage.railMaint'), t('settingsPage.railMaintNote'), 'green')}
        </div>
        <div class="setx-detail">
          <button type="button" class="setx-backlink" onclick={() => { libDrill = false; }}><Icon name="arrow-left" size={14} /> {t('settingsPage.backLibrary')}</button>

          <div class="setx-panel" class:is-active={libPanel === 'libraries'}>
            <h3 class="setx-panel__title">{t('settingsPage.librariesTitle')}</h3>
            <p class="setx-panel__sub">{@html th('settingsPage.librariesSub')}</p>
            {#each libs as l (l.id)}
              <div class="libcard">
                <div class="libcard__head">
                  <span class="libcard__icon"><Icon name="book" /></span>
                  <input class="libcard__name" type="text" spellcheck="false" bind:value={l.name} onchange={() => saveLib(l)} title={t('settingsPage.libraryName')} />
                  <select bind:value={l.type} onchange={() => saveLib(l)} title={t('settingsPage.libraryTypeTitle')}>
                    {#each LIB_TYPES as [tv, label] (tv)}<option value={tv}>{label}</option>{/each}
                  </select>
                  <label class="field field--check libcard__mature" title={t('settingsPage.matureTitle')}>
                    <input type="checkbox" checked={!!l.restricted} onchange={(e) => { l.restricted = e.currentTarget.checked ? 1 : 0; saveLib(l); }} /><span>{t('settingsPage.mature')}</span></label>
                  <span class="scan-muted libcard__count">{t('settingsPage.seriesCount', { count: l.series_count })}</span>
                  <button class="rootrow__x" type="button" title={t('settingsPage.deleteLibraryBtnTitle')} aria-label={t('settingsPage.deleteLibrary')} onclick={() => removeLib(l)}><Icon name="trash" size={15} /></button>
                </div>
                <div class="rootlist">
                  {#each l.folders as _f, i (i)}
                    <div class="rootrow">
                      <input class="rootrow__path" type="text" spellcheck="false" bind:value={l.folders[i]} onchange={() => saveLib(l)}
                        placeholder={i === 0 ? 'D:\\Comics   or   \\\\NAS\\comics' : t('settingsPage.anotherFolder')} />
                      {#if i === 0}
                        <span class="rootrow__badge" title={t('settingsPage.defaultTitle')}>{t('settingsPage.defaultBadge')}</span>
                      {:else}
                        <button class="link-btn rootrow__def" type="button" onclick={() => libMakeDefault(l, i)} title={t('settingsPage.makeDefaultTitle')}>{t('settingsPage.makeDefault')}</button>
                      {/if}
                      {#if l.folders.length > 1}
                        <button class="rootrow__x" type="button" title={t('settingsPage.removeFolderTitle')} aria-label={t('settingsPage.removeFolder')} onclick={() => libRemoveFolder(l, i)}><Icon name="close" size={15} /></button>
                      {/if}
                    </div>
                  {/each}
                  <button class="link-btn rootlist__add" type="button" onclick={() => libAddFolder(l)}><Icon name="plus" size={14} /> {t('settingsPage.addFolder')}</button>
                </div>
                <div class="libcard__extras">
                  <label class="field"><span>{t('settingsPage.folderPattern')}</span>
                    <input type="text" spellcheck="false" placeholder={t('settingsPage.folderPatternPlaceholder')} bind:value={l.folder_pattern} onchange={() => saveLib(l)} title={t('settingsPage.libFolderPatternTitle')} /></label>
                  <label class="field"><span>{t('settingsPage.tagPlacement')}</span>
                    <select bind:value={l.tag_placement} onchange={() => saveLib(l)} title={t('settingsPage.tagPlacementTitle')}>
                      <option value={null}>{t('settingsPage.tagGlobal')}</option>
                      <option value="embed">{t('settingsPage.tagEmbed')}</option>
                      <option value="sidecar">{t('settingsPage.tagSidecar')}</option>
                    </select></label>
                </div>
              </div>
            {/each}
            <div class="rootrow libcard__new">
              <input class="rootrow__path" style="max-width:200px" type="text" spellcheck="false" placeholder={t('settingsPage.newLibraryPlaceholder')} bind:value={newLib.name} onkeydown={(e) => { if (e.key === 'Enter') addLib(); }} />
              <select bind:value={newLib.type}>
                {#each LIB_TYPES as [tv, label] (tv)}<option value={tv}>{label}</option>{/each}
              </select>
              <button class="btn btn--ghost btn--sm" type="button" onclick={addLib}><Icon name="plus" size={14} /> {t('settingsPage.createLibrary')}</button>
            </div>
            <!-- Plugin library-behavior settings inject here (plain DOM — stays mounted). -->
            <div id="settings-plugin-library"></div>
          </div>

          <div class="setx-panel" class:is-active={libPanel === 'org'}>
            <h3 class="setx-panel__title">{t('settingsPage.orgTitle')}</h3>
            <p class="setx-panel__sub">{t('settingsPage.orgSub')}</p>
            <div class="setx-card">
              <label class="field"><span>{t('settingsPage.folderPattern')}</span><input id="set-folderPattern" class="mono" type="text" spellcheck="false" placeholder={'{publisher}/{series} ({year})'} oninput={previewNaming} /></label>
              <label class="field"><span>{t('settingsPage.filePattern')}</span><input id="set-filePattern" class="mono" type="text" spellcheck="false" placeholder={'{series} V{year} #{issue}'} oninput={previewNaming} /></label>
              {#if namingPreview}<p class="setx-preview mono">{namingPreview}</p>{/if}
              <label class="field field--check">
                <span class="switch"><input id="set-renameDownloads" type="checkbox" /><span class="switch__track"></span></span>
                <span>{t('settingsPage.renameDownloads')}</span>
              </label>
              <p class="modal__note">{@html th('settingsPage.tokensNote')}</p>
              <p class="modal__note">{@html th('settingsPage.dateNote')}</p>
              <p class="modal__note">{@html th('settingsPage.patternsNote')}</p>
            </div>
          </div>

          <div class="setx-panel" class:is-active={libPanel === 'maint'}>
            <h3 class="setx-panel__title">{t('settingsPage.maintTitle')}</h3>
            <p class="setx-panel__sub">{t('settingsPage.maintSub')}</p>
            <div class="setx-card">
              <label class="field"><span>{t('settingsPage.downloadsDir')}</span><input id="set-downloadsDir" class="mono" type="text" spellcheck="false" /></label>
              <p class="modal__note">{t('settingsPage.downloadsDirNote')}</p>
              <label class="field"><span>{t('settingsPage.toolWorkers')}</span><input id="set-toolsConcurrency" type="number" min="1" max="16" /></label>
              <p class="modal__note">{t('settingsPage.toolWorkersNote')}</p>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- DOWNLOADING -->
    <div class="setx-page setx-page--narrow" data-tab="downloading" class:is-active={activeTab === 'downloading'}>
      <h3 class="setx-panel__title">{t('settingsPage.dlTitle')}</h3>
      <p class="setx-panel__sub">{t('settingsPage.dlSub')}</p>
      <div class="setx-card">
        <label class="field field--check">
          <span class="switch"><input id="set-autoDownloadOnAdd" type="checkbox" /><span class="switch__track"></span></span>
          <span>{t('settingsPage.downloadOnAdd')}</span>
        </label>
        <p class="modal__note">{t('settingsPage.downloadOnAddNote')}</p>
        <label class="field">
          <span>{t('settingsPage.monitorAdded')}</span>
          <select id="set-defaultMonitor"><option value="all">{t('settingsPage.monitorAll')}</option><option value="new">{t('settingsPage.monitorNew')}</option><option value="none">{t('settingsPage.monitorOff')}</option></select>
        </label>
        <p class="modal__note">{@html th('settingsPage.monitorNote')}</p>
        <label class="field field--check">
          <span class="switch"><input id="set-addDownloadOnlyRequested" type="checkbox" /><span class="switch__track"></span></span>
          <span>{t('settingsPage.onlyRequested')}</span>
        </label>
        <p class="modal__note">{t('settingsPage.onlyRequestedNote')}</p>
        <label class="field">
          <span>{t('settingsPage.downloadFormat')}</span>
          <select id="set-format"><option value="cbz">{t('settingsPage.formatCbz')}</option><option value="pdf">{t('settingsPage.formatPdf')}</option></select>
        </label>
        <label class="field"><span>{t('settingsPage.simultaneous')}</span><input id="set-downloadConcurrency" type="number" min="1" max="16" /></label>
        <p class="modal__note">{t('settingsPage.simultaneousNote')}</p>
        <label class="field"><span>{t('settingsPage.flaresolverrUrl')}</span><input id="set-flaresolverrUrl" type="text" spellcheck="false" placeholder={'http://flaresolverr:8191/v1'} /></label>
        <p class="modal__note">{@html th('settingsPage.flaresolverrNote')}</p>
      </div>
    </div>

    <!-- SOURCES (master–detail) -->
    <div class="setx-page" data-tab="sources" class:is-active={activeTab === 'sources'}>
      <div class="setx-split" class:is-drilled={srcDrill}>
        <div class="setx-rail">
          {@render railItem('src', 'usenet', 'download', t('settingsPage.usenet'), t('settingsPage.usenetRailNote'), srcOn.usenet ? 'green' : 'muted')}
          {@render railItem('src', 'torrent', 'download', t('settingsPage.torrents'), t('settingsPage.torrentsRailNote'), srcOn.torrent ? 'green' : 'muted')}
          {#each kitCards as c (c.id)}
            {@render railItem('src', 'kit:' + c.id, 'download', c.label, kitNote(c.description), kitOn[c.id] ? 'green' : 'muted')}
          {/each}
          {#each pluginSrc as pb (pb.key)}
            {@render railItem('src', pb.key, 'download', pb.label, pb.note, pb.on ? 'green' : 'muted')}
          {/each}
          {#if sourceOrder.length >= 2}
            {@render railItem('src', 'priority', 'arrow-up-down', t('settingsPage.sourcePriority'), t('settingsPage.sourcePriorityNote'), 'green')}
          {/if}
          {#if !anySourceOn}
            <p class="setx-railwarn"><Icon name="alert-triangle" size={14} /> {t('settingsPage.noSourcesWarn')}</p>
          {/if}
        </div>
        <div class="setx-detail">
          <button type="button" class="setx-backlink" onclick={() => { srcDrill = false; }}><Icon name="arrow-left" size={14} /> {t('settingsPage.backSources')}</button>

          <div class="setx-panel" class:is-active={srcPanel === 'usenet'}>
            <div class="setx-card setx-srchead">
              <label class="switch"><input id="set-usenetEnabled" type="checkbox" onchange={syncSourceUI} /><span class="switch__track"></span></label>
              <div class="setx-srchead__text">
                <b>{t('settingsPage.usenet')}</b>
                <span>{t('settingsPage.usenetDesc')}</span>
              </div>
              <span class="setx-dot setx-dot--{srcOn.usenet ? 'green' : 'muted'}"></span>
            </div>
            <div id="usenet-config" class="src-config setx-srcbody">
              <div class="setx-card" class:is-managed={srcManaged}>
                <h4 class="setx-card__head">{t('settingsPage.indexers')}</h4>
                {#if srcManaged}
                  <p class="modal__note indexers-managed"><Icon name="target" size={14} /> {t('settingsPage.managedNote')}</p>
                {/if}
                <div id="indexer-list" class="indexer-list">
                  {@render indexerRows('newznab', indexerList)}
                </div>
                <button id="add-indexer" class="btn btn--ghost btn--add" type="button" disabled={srcManaged} onclick={() => openIndexerModal(-1, 'newznab', null, saveIndexer)}>{t('settingsPage.addIndexer')}</button>
                <p class="modal__note">{t('settingsPage.newznabNote')}</p>
              </div>

              <div class="setx-card">
                <h4 class="setx-card__head">{t('settingsPage.downloadClient')}</h4>
                <label class="field"><span>{t('settingsPage.client')}</span>
                  <select id="set-nzbClient" onchange={syncSourceUI}><option value="sabnzbd">{'SABnzbd'}</option><option value="nzbget">{'NZBGet'}</option></select>
                </label>
                <label class="field"><span>{t('settingsPage.host')}</span><input id="set-nzbClientHost" class="mono" type="text" spellcheck="false" placeholder={t('settingsPage.hostPlaceholder')} /></label>
                <label class="field"><span>{t('settingsPage.port')}</span><input id="set-nzbClientPort" class="mono" type="number" min="1" max="65535" placeholder="8080" /></label>
                <label class="field"><span>{t('settingsPage.urlBase')}</span><input id="set-nzbClientUrlBase" class="mono" type="text" spellcheck="false" placeholder={t('settingsPage.urlBasePlaceholder', { example: '/sabnzbd' })} /></label>
                <label class="field field--check"><input id="set-nzbClientSsl" type="checkbox" /><span>{t('settingsPage.useHttps')}</span></label>
                <div class="only-sabnzbd">
                  <label class="field"><span>{t('settingsPage.apiKey')}</span><input id="set-nzbClientApiKey" class="mono" type="text" spellcheck="false" /></label>
                </div>
                <div class="only-nzbget">
                  <label class="field"><span>{t('settingsPage.username')}</span><input id="set-nzbClientUser" type="text" spellcheck="false" /></label>
                  <label class="field"><span>{t('settingsPage.password')}</span><input id="set-nzbClientPass" type="password" spellcheck="false" /></label>
                </div>
                <label class="field"><span>{t('settingsPage.category')}</span><input id="set-nzbCategory" type="text" spellcheck="false" placeholder={'backissue'} /></label>
                <div class="client-test">
                  <button id="client-test" class="btn btn--ghost" type="button" onclick={testClient}>{t('settingsPage.testConnection')}</button>
                  {#if tests.client}<span id="client-test-result" class="client-status {tests.client.cls}">{#if tests.client.icon}<Icon name={tests.client.icon} /> {/if}{tests.client.text}</span>{/if}
                </div>
              </div>

              <div class="setx-card">
                <h4 class="setx-card__head">{t('settingsPage.completedDownloads')}</h4>
                <label class="field"><span>{t('settingsPage.folderAppView')}</span><input id="set-usenetCompleteDir" class="mono" type="text" spellcheck="false" placeholder={'\\\\NAS\\dl\\complete'} /></label>
                <label class="field"><span>{t('settingsPage.folderClientView')}</span><input id="set-usenetCompleteDirRemote" class="mono" type="text" spellcheck="false" placeholder={'/downloads/complete'} /></label>
                <p class="modal__note">{@html th('settingsPage.usenetCompleteNote')}</p>
              </div>

              <div class="setx-card">
                <h4 class="setx-card__head">{t('settingsPage.polling')}</h4>
                <div class="fields-row">
                  <label class="field"><span>{t('settingsPage.pollEvery')}</span><input id="set-usenetPollSeconds" type="number" min="5" max="600" /></label>
                  <label class="field"><span>{t('settingsPage.giveUpAfter')}</span><input id="set-usenetTimeoutMinutes" type="number" min="1" max="1440" /></label>
                </div>
                <p class="modal__note">{@html th('settingsPage.usenetPollingNote')}</p>
              </div>
            </div>
          </div>

          <div class="setx-panel" class:is-active={srcPanel === 'torrent'}>
            <div class="setx-card setx-srchead">
              <label class="switch"><input id="set-torrentEnabled" type="checkbox" onchange={syncSourceUI} /><span class="switch__track"></span></label>
              <div class="setx-srchead__text">
                <b>{t('settingsPage.torrents')}</b>
                <span>{t('settingsPage.torrentDesc')}</span>
              </div>
              <span class="setx-dot setx-dot--{srcOn.torrent ? 'green' : 'muted'}"></span>
            </div>
            <div id="torrent-config" class="src-config setx-srcbody">
              <div class="setx-card" class:is-managed={srcManaged}>
                <h4 class="setx-card__head">{t('settingsPage.indexersTorznab')}</h4>
                {#if srcManaged}
                  <p class="modal__note indexers-managed"><Icon name="target" size={14} /> {t('settingsPage.managedNote')}</p>
                {/if}
                <div id="torznab-list" class="indexer-list">
                  {@render indexerRows('torznab', torznabList)}
                </div>
                <button id="add-torznab" class="btn btn--ghost btn--add" type="button" disabled={srcManaged} onclick={() => openIndexerModal(-1, 'torznab', null, saveIndexer)}>{t('settingsPage.addIndexer')}</button>
                <p class="modal__note">{t('settingsPage.torznabNote')}</p>
              </div>

              <div class="setx-card">
                <h4 class="setx-card__head">{t('settingsPage.downloadClient')}</h4>
                <label class="field"><span>{t('settingsPage.client')}</span>
                  <select id="set-torrentClient" onchange={syncSourceUI}><option value="qbittorrent">{'qBittorrent'}</option><option value="transmission">{'Transmission'}</option><option value="deluge">{'Deluge'}</option></select>
                </label>
                <div class="only-qbittorrent">
                  <label class="field"><span>{t('settingsPage.host')}</span><input id="set-qbHost" class="mono" type="text" spellcheck="false" placeholder={t('settingsPage.hostPlaceholder')} /></label>
                  <label class="field"><span>{t('settingsPage.port')}</span><input id="set-qbPort" class="mono" type="number" min="1" max="65535" placeholder="8080" /></label>
                  <label class="field"><span>{t('settingsPage.urlBase')}</span><input id="set-qbUrlBase" class="mono" type="text" spellcheck="false" placeholder={t('settingsPage.urlBasePlaceholder', { example: '/qbittorrent' })} /></label>
                  <label class="field field--check"><input id="set-qbSsl" type="checkbox" /><span>{t('settingsPage.useHttps')}</span></label>
                  <label class="field"><span>{t('settingsPage.username')}</span><input id="set-qbUser" type="text" spellcheck="false" /></label>
                  <label class="field"><span>{t('settingsPage.password')}</span><input id="set-qbPass" type="password" spellcheck="false" /></label>
                </div>
                <div class="only-transmission">
                  <label class="field"><span>{t('settingsPage.host')}</span><input id="set-trHost" class="mono" type="text" spellcheck="false" placeholder={t('settingsPage.hostPlaceholder')} /></label>
                  <label class="field"><span>{t('settingsPage.port')}</span><input id="set-trPort" class="mono" type="number" min="1" max="65535" placeholder="9091" /></label>
                  <label class="field"><span>{t('settingsPage.urlBase')}</span><input id="set-trUrlBase" class="mono" type="text" spellcheck="false" placeholder={t('settingsPage.urlBasePlaceholder', { example: '/transmission' })} /></label>
                  <label class="field field--check"><input id="set-trSsl" type="checkbox" /><span>{t('settingsPage.useHttps')}</span></label>
                  <label class="field"><span>{t('settingsPage.username')}</span><input id="set-trUser" type="text" spellcheck="false" /></label>
                  <label class="field"><span>{t('settingsPage.password')}</span><input id="set-trPass" type="password" spellcheck="false" /></label>
                </div>
                <div class="only-deluge">
                  <label class="field"><span>{t('settingsPage.host')}</span><input id="set-delugeHost" class="mono" type="text" spellcheck="false" placeholder={t('settingsPage.hostPlaceholder')} /></label>
                  <label class="field"><span>{t('settingsPage.port')}</span><input id="set-delugePort" class="mono" type="number" min="1" max="65535" placeholder="8112" /></label>
                  <label class="field"><span>{t('settingsPage.urlBase')}</span><input id="set-delugeUrlBase" class="mono" type="text" spellcheck="false" placeholder={t('settingsPage.urlBasePlaceholder', { example: '/deluge' })} /></label>
                  <label class="field field--check"><input id="set-delugeSsl" type="checkbox" /><span>{t('settingsPage.useHttps')}</span></label>
                  <label class="field"><span>{t('settingsPage.password')}</span><input id="set-delugePass" type="password" spellcheck="false" /></label>
                </div>
                <label class="field"><span>{t('settingsPage.category')}</span><input id="set-torrentCategory" type="text" spellcheck="false" placeholder={'backissue'} /></label>
                <div class="client-test">
                  <button id="qb-test" class="btn btn--ghost" type="button" onclick={testQb}>{t('settingsPage.testConnection')}</button>
                  {#if tests.qb}<span id="qb-test-result" class="client-status {tests.qb.cls}">{#if tests.qb.icon}<Icon name={tests.qb.icon} /> {/if}{tests.qb.text}</span>{/if}
                </div>
              </div>

              <div class="setx-card">
                <h4 class="setx-card__head">{t('settingsPage.completedDownloads')}</h4>
                <label class="field"><span>{t('settingsPage.folderAppView')}</span><input id="set-torrentCompleteDir" class="mono" type="text" spellcheck="false" placeholder={'\\\\NAS\\dl\\complete'} /></label>
                <label class="field"><span>{t('settingsPage.folderClientView')}</span><input id="set-torrentCompleteDirRemote" class="mono" type="text" spellcheck="false" placeholder={'/downloads/complete'} /></label>
                <p class="modal__note">{t('settingsPage.torrentCompleteNote')}</p>
              </div>

              <div class="setx-card">
                <h4 class="setx-card__head">{t('settingsPage.polling')}</h4>
                <div class="fields-row">
                  <label class="field"><span>{t('settingsPage.pollEvery')}</span><input id="set-torrentPollSeconds" type="number" min="5" max="600" /></label>
                  <label class="field"><span>{t('settingsPage.giveUpAfter')}</span><input id="set-torrentTimeoutMinutes" type="number" min="1" max="1440" /></label>
                </div>
                <p class="modal__note">{@html th('settingsPage.torrentPollingNote')}</p>
              </div>

              <div class="setx-card">
                <h4 class="setx-card__head">{t('settingsPage.zeroDay')}</h4>
                <label class="field"><span>{t('settingsPage.searchPhrase')}</span><input id="set-zeroDayQuery" type="text" spellcheck="false" placeholder={'0-Day Week'} /></label>
                <label class="field field--check"><input id="set-zeroDayAddNew" type="checkbox" /><span>{t('settingsPage.zeroDayAddNew')}</span></label>
                <p class="modal__note">{@html th('settingsPage.zeroDayNote')}</p>
              </div>
            </div>
          </div>

          {#each kitCards as c (c.id)}
            <div class="setx-panel" class:is-active={srcPanel === 'kit:' + c.id}>
              <div class="setx-card setx-srchead">
                <label class="switch"><input id="set-{c.id}Enabled" type="checkbox" disabled={!!c.unavailable} onchange={syncSourceUI} /><span class="switch__track"></span></label>
                <div class="setx-srchead__text">
                  <b>{lbl(c.label)}</b>
                  <span>{c.description || t('settingsPage.kitDefaultDesc')}</span>
                </div>
                <span class="setx-dot setx-dot--{c.unavailable ? 'muted' : kitOn[c.id] ? 'green' : 'muted'}"></span>
              </div>
              <div class="src-config setx-srcbody">
                <div class="setx-card">
                  {#if c.unavailable}
                    <p class="modal__note"><Icon name="alert-triangle" size={14} /> {c.unavailable}</p>
                  {:else if c.cloudflare}
                    <p class="modal__note">{@html th(c.browser === 'fallback' ? 'settingsPage.cloudflareNoteBrowser' : 'settingsPage.cloudflareNote')}</p>
                  {/if}
                  {#each c.fields as f (f.key)}
                    {#if f.type === 'bool'}
                      <label class="field field--check"><span class="switch"><input id="set-{f.key}" type="checkbox" /><span class="switch__track"></span></span><span>{lbl(f.label)}</span></label>
                    {:else if f.type === 'int'}
                      <label class="field"><span>{lbl(f.label)}</span><input id="set-{f.key}" type="number" placeholder={f.placeholder || (f.default ?? '')} /></label>
                    {:else}
                      <label class="field"><span>{lbl(f.label)}</span><input id="set-{f.key}" type={f.secret ? 'password' : 'text'} spellcheck="false" autocomplete={f.secret ? 'off' : null} placeholder={f.placeholder || (f.default ?? '')} /></label>
                    {/if}
                    {#if f.note}<p class="modal__note">{lbl(f.note)}</p>{/if}
                  {/each}
                  {#if c.testable}
                    <div class="client-test">
                      <button class="btn btn--ghost" type="button" onclick={() => testKitSource(c)}>{t('settingsPage.testConnection')}</button>
                      {#if kitTests[c.id]}<span class="client-status {kitTests[c.id].cls}">{#if kitTests[c.id].icon}<Icon name={kitTests[c.id].icon} /> {/if}{kitTests[c.id].text}</span>{/if}
                    </div>
                  {/if}
                </div>
              </div>
            </div>
          {/each}

          <div class="setx-panel" class:is-active={srcPanel === 'priority'}>
            <h3 class="setx-panel__title">{t('settingsPage.priorityTitle')}</h3>
            <p class="setx-panel__sub">{t('settingsPage.prioritySub')}</p>
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

    <!-- PLUGINS (master–detail; the tab shows only when a plugin mounted a panel) -->
    <div class="setx-page" data-tab="plugins" class:is-active={activeTab === 'plugins'}>
      <div class="setx-split" class:is-drilled={plgDrill}>
        <div class="setx-rail">
          {#each pluginPanels as pb (pb.key)}
            {@render railItem('plg', pb.key, 'puzzle', pb.label, pb.note, pb.on ? 'green' : 'muted')}
          {/each}
        </div>
        <div class="setx-detail">
          <button type="button" class="setx-backlink" onclick={() => { plgDrill = false; }}><Icon name="arrow-left" size={14} /> {t('settingsPage.backPlugins')}</button>
          <!-- Plugin settings panels inject here (plain DOM — must stay mounted;
               same contract as settings-plugin-sources, for plugins that are
               NOT download sources: each block becomes a rail entry). -->
          <div id="settings-plugin-panels"></div>
        </div>
      </div>
    </div>

    <!-- METADATA -->
    <div class="setx-page setx-page--narrow" data-tab="metadata" class:is-active={activeTab === 'metadata'}>
      <h3 class="setx-panel__title">{t('settingsPage.metaTitle')}</h3>
      <p class="setx-panel__sub">{t('settingsPage.metaSub')}</p>
      <div class="setx-card">
        <h4 class="setx-card__head">{t('settingsPage.metaSources')}</h4>
        <p class="modal__note">{t('settingsPage.metaSourcesNote')}</p>
        <div id="metadata-source-list">
          {#each metaOrder as p, i (p.id)}
            <div class="metasrc" class:is-on={p.enabled}>
              <div class="srcpri-row">
                <span class="srcpri-rank">{i + 1}</span>
                <label class="switch"><input type="checkbox" checked={p.enabled} aria-label={t('settingsPage.useProvider', { name: providerName(p) })} onchange={(e) => toggleMeta(p, e.currentTarget.checked)} /><span class="switch__track"></span></label>
                <span class="srcpri-name">{p.label}{#if p.enabled && !p.configured}<span class="metasrc__warn">{t('settingsPage.notSetUp')}</span>{/if}</span>
                <button class="srcpri-btn" type="button" disabled={i === 0} onclick={() => moveMeta(i, -1)} aria-label={t('settingsPage.moveUp')}><Icon name="arrow-up" /></button>
                <button class="srcpri-btn" type="button" disabled={i === metaOrder.length - 1} onclick={() => moveMeta(i, 1)} aria-label={t('settingsPage.moveDown')}><Icon name="arrow-down" /></button>
              </div>
              <!-- Each source's details stay mounted (their set-* ids are
                   collected on save); hidden just removes them from view. -->
              <div class="metasrc__body" hidden={!p.enabled}>
                {#if p.id === 'hosted'}
                  <p class="modal__note">
                    {#if loadedSettings.metadataInstanceKey}
                      <Icon name="check" /> {@html th('settingsPage.registered', { key: String(loadedSettings.metadataInstanceKey).slice(-6) })}
                    {:else}
                      {t('settingsPage.notRegistered')}
                    {/if}
                  </p>
                  <div class="client-test"><button class="btn btn--ghost" type="button" onclick={testMeta}>{t('settingsPage.testService')}</button>
                    {#if tests.meta}<span class="client-status {tests.meta.cls}">{#if tests.meta.icon}<Icon name={tests.meta.icon} /> {/if}{tests.meta.text}</span>{/if}</div>
                {:else}
                  {#if p.note}<p class="modal__note list-note--warn"><Icon name="info" /> {p.note}</p>{/if}
                  {#each p.fields as f (f.key)}
                    <label class="field"><span>{lbl(f.label)}</span><input id="set-{f.key}" class="mono" type={f.type === 'password' ? 'password' : 'text'} spellcheck="false" autocomplete="off" placeholder={f.placeholder || ''} /></label>
                  {/each}
                  <div class="client-test"><button class="btn btn--ghost" type="button" onclick={() => testProvider(p)}>{providerTestLabel(p)}</button>
                    {#if tests['prov-' + p.id]}<span class="client-status {tests['prov-' + p.id].cls}">{#if tests['prov-' + p.id].icon}<Icon name={tests['prov-' + p.id].icon} /> {/if}{tests['prov-' + p.id].text}</span>{/if}</div>
                {/if}
              </div>
            </div>
          {/each}
        </div>
        <!-- Service URL (self-hosted metadata instance) is an advanced escape
             hatch: kept mounted so a saved value persists, but not shown. It
             remains settable via the API / a previously saved value. -->
        <div hidden>
          <label class="field"><span>{t('settingsPage.serviceUrl')}</span><input id="set-cvBaseUrl" class="mono" type="text" spellcheck="false" placeholder={'https://data.backissue.app/api'} /></label>
        </div>
      </div>
      <div class="setx-card">
        <h4 class="setx-card__head">{t('settingsPage.taggingFiles')}</h4>
        <label class="field">
          <span>{t('settingsPage.tagOnDownload')}</span>
          <select id="set-tagOnDownload"><option value="off">{t('common.off')}</option><option value="on">{t('common.on')}</option></select>
        </label>
        <label class="field">
          <span>{t('settingsPage.tagPlacement')}</span>
          <select id="set-tagPlacement"><option value="embed">{t('settingsPage.tagEmbed')}</option><option value="sidecar">{t('settingsPage.tagSidecar')}</option></select>
        </label>
        <p class="modal__note">{@html th('settingsPage.tagNote')}</p>
      </div>
      <div class="setx-card">
        <h4 class="setx-card__head">{t('settingsPage.enrichment')}</h4>
        <label class="field field--check">
          <span class="switch"><input id="set-cvEnrich" type="checkbox" /><span class="switch__track"></span></span>
          <span>{t('settingsPage.enrichLabel')}</span>
        </label>
        <p class="modal__note">{@html th('settingsPage.enrichNote')}</p>
      </div>
      <div class="setx-card">
        <h4 class="setx-card__head">{t('settingsPage.manga')}</h4>
        <label class="field">
          <span>{t('settingsPage.ratingCeiling')}</span>
          <select id="set-mangaRating">
            <option value="safe">{t('settingsPage.ratingSafe')}</option>
            <option value="suggestive">{t('settingsPage.ratingSuggestive')}</option>
            <option value="erotica">{t('settingsPage.ratingErotica')}</option>
            <option value="pornographic">{t('settingsPage.ratingAll')}</option>
          </select>
        </label>
        <p class="modal__note">{t('settingsPage.mangaNote')}</p>
      </div>
      <div class="setx-card">
        <h4 class="setx-card__head">{t('settingsPage.releases')}</h4>
        <label class="field"><span>{t('settingsPage.releaseProviderUrl')}</span><input id="set-releaseProviderUrl" class="mono" type="text" spellcheck="false" placeholder={'https://data.backissue.app'} /></label>
        <p class="modal__note">{t('settingsPage.releaseNote')}</p>
      </div>
    </div>

    <!-- SIGN-IN -->
    <div class="setx-page setx-page--narrow" data-tab="signin" class:is-active={activeTab === 'signin'}>
      <h3 class="setx-panel__title">{t('settingsPage.signinTitle')}</h3>
      <p class="setx-panel__sub">{t('settingsPage.signinSub')}</p>
      <div class="setx-card">
        <p class="modal__note">{@html th('settingsPage.signinNote')}</p>
        <!-- Auth plugin config (e.g. OIDC/SSO, WHMCS) injects here (plain DOM — stays mounted). -->
        <div id="settings-plugin-auth"></div>
        <label class="field field--check">
          <span class="switch"><input id="set-passwordLoginDisabled" type="checkbox" /><span class="switch__track"></span></span>
          <span>{t('settingsPage.disablePasswordLogin')}</span>
        </label>
      </div>
    </div>

    <!-- NOTIFICATIONS -->
    <div class="setx-page setx-page--narrow" data-tab="notifications" class:is-active={activeTab === 'notifications'}>
      <h3 class="setx-panel__title">{t('settingsPage.notifTitle')}</h3>
      <p class="setx-panel__sub">{t('settingsPage.notifSub')}</p>
      <!-- Outbound channels are provided by plugins (the notifications hub
           injects one collapsible card per channel, like the source cards). -->
      <div id="settings-plugin-notifications"></div>
      {#if !notifyChannels}
        <div class="setx-card setx-empty">
          <span class="setx-empty__icon"><Icon name="bell" size={22} /></span>
          <b>{t('settingsPage.noChannels')}</b>
          <p class="modal__note">{@html th('settingsPage.noChannelsNote')}</p>
          <button class="btn btn--ghost btn--sm" type="button" onclick={() => navigate('/plugins')}>{t('settingsPage.browsePlugins')}</button>
        </div>
      {/if}
    </div>
  </div>

  <!-- Unsaved-changes save bar -->
  {#if dirty}
    <div class="setx-savebar">
      <span class="setx-savebar__dot"></span>
      <span class="setx-savebar__text">{t('settingsPage.unsaved')}</span>
      <button class="btn btn--ghost btn--sm" type="button" onclick={discardEdits}>{t('settingsPage.discard')}</button>
      <button class="btn btn--primary btn--sm" type="button" onclick={save}>{t('settingsPage.saveChanges')}</button>
    </div>
  {/if}
</main>
