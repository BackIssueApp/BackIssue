<script>
  import { goBack, navigate } from '../lib/router.svelte.js';
  import { apiGet, apiPost } from '../lib/api.js';
  import { flags } from '../lib/store.svelte.js';
  import { BackIssue, plugins, bridgeRefs } from '../lib/plugins.svelte.js';
  import { parseIndexerString, serializeIndexers } from '../lib/util.js';
  import { openIndexerModal, testIndexer } from './IndexerModal.svelte';
  import { confirmDialog } from './DialogModal.svelte';
  import { notify } from '../lib/toasts.svelte.js';
  import Icon from '../lib/Icon.svelte';

  let { active = false } = $props();

  const DEFAULT_PORTS = { sabnzbd: '8080', nzbget: '6789' };

  // The section groups, in scroll order. The index rail is built from this and
  // scroll-spy highlights whichever one the reader is in.
  const SECTIONS = [
    { id: 'library', label: 'Library' },
    { id: 'downloading', label: 'Downloading' },
    { id: 'sources', label: 'Sources' },
    { id: 'metadata', label: 'Metadata' },
    { id: 'signin', label: 'Sign-in' },
    { id: 'notifications', label: 'Notifications' },
  ];
  let activeSection = $state('library');
  let anySourceOn = $state(false);          // drives the Sources dot + rail status
  let dirtySections = $state(new Set());    // sections with unsaved edits (accent dot)
  let filterQuery = $state('');
  let emptySections = $state(new Set());    // sections with no filter matches (dimmed)
  let noMatches = $state(false);
  let contentEl = $state(null);             // the scroll container

  // Indexer lists ({ name, url, apiKey }) — shared row UI for both modes.
  let indexerList = $state([]);   // newznab (usenet)
  let torznabList = $state([]);   // torznab (torrent)

  // Library root folders as editable rows. [0] is the DEFAULT — where new
  // comics are filed; the rest are additional locations that get scanned on
  // Import / Scan library. Stored as a newline-joined string in rootFolders.
  let rootFolderList = $state(['']);
  const parseRoots = (text) => String(text || '').split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
  const addRoot = () => { rootFolderList = [...rootFolderList, '']; dirty = true; };
  const removeRoot = (i) => {
    rootFolderList = rootFolderList.filter((_, k) => k !== i);
    if (!rootFolderList.length) rootFolderList = [''];
    dirty = true;
  };
  const makeDefaultRoot = (i) => {
    if (i <= 0) return;
    const next = [...rootFolderList];
    const [r] = next.splice(i, 1);
    rootFolderList = [r, ...next];
    dirty = true;
  };
  const MODE_LISTS = { newznab: () => indexerList, torznab: () => torznabList };
  const MODE_ENDPOINTS = { newznab: '/api/indexers/test', torznab: '/api/torznab/test' };

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

  // Webhook notification categories (empty saved value = all enabled).
  const NOTIFY_CATS = [
    ['import', 'Imports & downloads'], ['failure', 'Failures'],
    ['release', 'New releases'], ['request', 'Requests'], ['system', 'System'],
  ];
  let webhookCats = $state(Object.fromEntries(NOTIFY_CATS.map(([k]) => [k, true])));
  function loadWebhookCats(csv) {
    const list = String(csv || '').split(',').map((s) => s.trim()).filter(Boolean);
    const all = list.length === 0; // empty = all on
    for (const [k] of NOTIFY_CATS) webhookCats[k] = all || list.includes(k);
  }
  function serializeWebhookCats() {
    const on = NOTIFY_CATS.filter(([k]) => webhookCats[k]).map(([k]) => k);
    return on.length === NOTIFY_CATS.length ? '' : on.join(','); // all → empty (= all)
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
    body.rootFolders = rootFolderList.map((s) => s.trim()).filter(Boolean).join('\n');
    body.notifyWebhookEvents = serializeWebhookCats();
    if (sourceOrder.length) body.sourcePriority = sourceOrder.map((s) => s.id).join(',');
    return body;
  }

  // Show/hide each source card's config, swap client credential fields to the
  // selected client, hint its default port, and let plugins report whether their
  // source is enabled (for the "no sources" status). Config VISIBILITY is driven
  // by .src-block.is-open (see wireSourceCards) so a source can be expanded to
  // configure it whether or not it's enabled — including plugin-injected ones.
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
    const pluginEnabled = BackIssue._sourceSyncHooks.map((fn) => { try { return !!fn(); } catch { return false; } });
    anySourceOn = usenet || torrent || pluginEnabled.some(Boolean);
    wireSourceCards();
  }
  bridgeRefs.refreshSourceUI = syncSourceUI;

  // Make every source card (core + plugin-injected) collapsible: clicking the
  // header row toggles it open; enabling a source auto-opens it to configure.
  // Idempotent — safe to call on every sync as plugin blocks appear.
  function wireSourceCards() {
    if (!root) return;
    for (const block of root.querySelectorAll('.src-block')) {
      if (block.dataset.wired) continue;
      block.dataset.wired = '1';
      const header = block.querySelector('.src-toggle');
      if (header) header.addEventListener('click', (e) => {
        if (e.target.closest('.switch')) return; // the enable switch does its own thing
        block.classList.toggle('is-open');
      });
      const sw = block.querySelector('.switch input');
      if (sw) sw.addEventListener('change', () => { if (sw.checked) block.classList.add('is-open'); });
    }
  }

  async function openSettings() {
    const s = await apiGet('/api/settings');
    applySettingsToForm(s);
    indexerList = parseIndexerString(s.newznabIndexers);
    torznabList = parseIndexerString(s.torznabIndexers);
    rootFolderList = parseRoots(s.rootFolders);
    if (!rootFolderList.length) rootFolderList = [''];
    loadWebhookCats(s.notifyWebhookEvents);
    try { sourceOrder = (await apiGet('/api/sources')).sources || []; } catch { sourceOrder = []; }
    for (const cb of BackIssue._settingsHooks) { try { cb(s); } catch { /* ignore */ } }
    syncSourceUI();
    previewNaming();
    // Start each source expanded iff it's enabled — a tidy collapsed row when off.
    for (const b of root.querySelectorAll('.src-block')) {
      b.classList.toggle('is-open', !!b.querySelector('.switch input')?.checked);
    }
    dirty = false;               // everything above was programmatic, not user edits
    dirtySections = new Set();
  }

  /* ---- Section navigation (index rail + scroll-spy) ----
     Positions are measured relative to the scroll container with
     getBoundingClientRect — offsetTop is relative to the nearest positioned
     ancestor, not the pane, so it would overshoot past each section's title. */
  function scrollToSection(id) {
    const el = document.getElementById('sec-' + id);
    if (!el || !contentEl) return;
    const top = el.getBoundingClientRect().top - contentEl.getBoundingClientRect().top + contentEl.scrollTop;
    contentEl.scrollTo({ top: Math.max(0, top - 12), behavior: 'smooth' });
  }
  function onSpy() {
    if (!contentEl) return;
    const cTop = contentEl.getBoundingClientRect().top;
    let best = SECTIONS[0].id;
    for (const s of SECTIONS) {
      const el = document.getElementById('sec-' + s.id);
      if (el && el.getBoundingClientRect().top - cTop <= 80) best = s.id;
    }
    activeSection = best;
  }
  $effect(() => { if (contentEl && active) onSpy(); });

  /* ---- Filter: hide non-matching rows, dim empty sections ---- */
  function applyFilter() {
    const q = filterQuery.trim().toLowerCase();
    contentEl?.classList.toggle('is-filtering', !!q);
    const empty = new Set();
    let anyVisible = false;
    for (const s of SECTIONS) {
      const group = document.getElementById('sec-' + s.id);
      if (!group) continue;
      const headHit = group.querySelector('.set-group__head').textContent.toLowerCase().includes(q);
      const rows = [...group.querySelectorAll('.field, .notify-cat')]
        .filter((r) => !r.closest('.src-block'))
        .concat([...group.querySelectorAll('.src-block')]);
      let shown = 0;
      for (const row of rows) {
        const hit = !q || headHit || row.textContent.toLowerCase().includes(q);
        row.classList.toggle('set-hidden', !hit);
        if (hit) shown++;
      }
      const visible = !q || headHit || shown > 0;
      group.classList.toggle('set-hidden', !visible);
      if (visible) anyVisible = true; else empty.add(s.id);
    }
    emptySections = empty;
    noMatches = !!q && !anyVisible;
  }

  /* ---- Unsaved-changes guard ----
     User edits fire input/change events (delegated on the page root); loading
     saved values programmatically doesn't, so `dirty` means real edits. The
     page stays mounted when navigated away, so "Keep editing" can return to it
     with every edit intact. */
  let dirty = $state(false);
  function markDirty(e) {
    if (e?.target?.closest?.('.settings-filter')) return; // the filter box isn't a setting
    dirty = true;
    const g = e?.target?.closest?.('.set-group');
    if (g) {
      const id = g.id.replace('sec-', '');
      if (!dirtySections.has(id)) dirtySections = new Set(dirtySections).add(id);
    }
  }

  // Load when opened — and again if plugin assets finish loading while the page
  // is already open (their injected fields need populating too). Never reload
  // over unsaved edits (that's what makes "Keep editing" work).
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
      else navigate('/settings'); // page never unmounted — the edits are still there
    })();
  });

  function onBeforeUnload(e) {
    if (dirty && location.pathname === '/settings') e.preventDefault();
  }

  async function save() {
    // A failed save must never look like a successful one.
    let r;
    try { r = await apiPost('/api/settings', collectSettingsFromForm()); }
    catch { return notify('Save failed — is the app reachable?', 'error'); }
    if (r?.error) return notify('Save failed: ' + r.error, 'error');
    // keep the per-issue actions in sync
    flags.usenetEnabled = !!root.querySelector('#set-usenetEnabled')?.checked;
    flags.torrentEnabled = !!root.querySelector('#set-torrentEnabled')?.checked;
    dirty = false;
    dirtySections = new Set();
    notify('Settings saved.', 'ok');
    goBack();
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
  // THE Test-connection wiring — collect the form fields, POST, render ✓/✕.
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

  // A chip's attention dot: amber on Sources when no source is enabled, accent
  // on a section holding unsaved edits, nothing otherwise (quiet by default).
  function chipDot(id) {
    if (id === 'sources' && !anySourceOn) return 'is-warn';
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

<svelte:window onbeforeunload={onBeforeUnload} />

<main id="settings-page" class="scan-page settings-page" bind:this={root} oninput={markDirty} onchange={markDirty}>
  <div class="scan-page__bar">
    <button id="settings-back" class="btn btn--ghost" onclick={goBack}><Icon name="arrow-left" /> Back</button>
    <h2 class="scan-page__title">Settings</h2>
    <label class="settings-filter">
      <Icon name="search" size={14} />
      <input type="text" placeholder="Filter settings…" autocomplete="off" spellcheck="false" bind:value={filterQuery} oninput={applyFilter} />
    </label>
    <button class="btn btn--ghost btn--sm" title="Walk through the first-run setup again (keys, folders, sources)" onclick={() => navigate('/?onboarding=1')}>Setup wizard</button>
    <button id="settings-save" class="btn btn--primary" onclick={save}>Save</button>
  </div>

  <!-- Section chips: the same filter-chip language as the Library page. Click
       to jump; scroll-spy fills the chip you're in; a dot flags attention
       (amber = no sources enabled, accent = unsaved edits in that section). -->
  <nav class="settings-chips" aria-label="Settings sections">
    {#each SECTIONS as s (s.id)}
      <button type="button" class="coll-chip settings-chip" class:is-active={activeSection === s.id}
        class:is-dim={!!filterQuery && emptySections.has(s.id)} onclick={() => scrollToSection(s.id)}>
        {s.label}{#if chipDot(s.id)}<span class="settings-chip__dot {chipDot(s.id)}"></span>{/if}
      </button>
    {/each}
  </nav>

  <div class="settings-shell">
    <!-- Scrolling content -->
    <div class="settings-content" bind:this={contentEl} onscroll={onSpy}>
      <div class="settings-measure">
        {#if noMatches}<p class="settings-nomatch">No settings match “{filterQuery}”.</p>{/if}

        <!-- LIBRARY -->
        <section class="set-group" id="sec-library">
          <h3 class="set-group__head">Library</h3>
          <p class="set-group__sub">Where comics live on disk and how the maintenance tools run.</p>
          <section class="settings-section">
            <div class="field field--col">
              <span>Root folders</span>
              <div class="rootlist">
                {#each rootFolderList as _root, i (i)}
                  <div class="rootrow">
                    <input class="rootrow__path" type="text" spellcheck="false" bind:value={rootFolderList[i]}
                      placeholder={i === 0 ? 'D:\\Comics   or   \\\\NAS\\comics' : 'another folder to scan…'} />
                    {#if i === 0}
                      <span class="rootrow__badge" title="New comics are filed here by default">Default</span>
                    {:else}
                      <button class="link-btn rootrow__def" type="button" onclick={() => makeDefaultRoot(i)} title="Make this the default folder for new comics">Make default</button>
                    {/if}
                    {#if rootFolderList.length > 1}
                      <button class="rootrow__x" type="button" title="Remove this folder" aria-label="Remove folder" onclick={() => removeRoot(i)}><Icon name="close" size={15} /></button>
                    {/if}
                  </div>
                {/each}
              </div>
              <button class="link-btn rootlist__add" type="button" onclick={addRoot}><Icon name="plus" size={14} /> Add folder</button>
            </div>
            <label class="field"><span>Downloads folder</span><input id="set-downloadsDir" type="text" spellcheck="false" /></label>
            <p class="modal__note">Comics are filed as <b>root</b>/Publisher/Title (Year). New comics land in the <b>Default</b> folder. Add more folders so BackIssue also scans them for existing comics when you <b>Import</b> or run <b>Scan library</b> — reorder with <b>Make default</b> to change where new comics go. Changing this never moves files already on disk. The <b>downloads folder</b> below is only a fallback when no root folder is set.</p>
            <label class="field"><span>Tool workers</span><input id="set-toolsConcurrency" type="number" min="1" max="16" /></label>
            <p class="modal__note">How many files the library tools (convert / verify / tag) process at once — higher overlaps I/O but uses more memory per in-flight file.</p>

            <p class="modal__subhead modal__subhead--sub">File organization</p>
            <label class="field"><span>Folder pattern</span><input id="set-folderPattern" type="text" spellcheck="false" placeholder={'{publisher}/{series} ({year})'} oninput={previewNaming} /></label>
            <label class="field"><span>File pattern</span><input id="set-filePattern" type="text" spellcheck="false" placeholder={'{series} V{year} #{issue}'} oninput={previewNaming} /></label>
            {#if namingPreview}<p class="modal__note">Example: <code class="mono">{namingPreview}</code></p>{/if}
            <label class="field field--check"><input id="set-renameDownloads" type="checkbox" /><span>Rename downloaded files to the file pattern (off = keep the source's original filename)</span></label>
            <p class="modal__note">Tokens: <code>{'{publisher}'}</code> <code>{'{series}'}</code> <code>{'{year}'}</code> <code>{'{issue}'}</code> (<code>{'{issue:2}'}</code> sets the pad width) <code>{'{issueTitle}'}</code> <code>{'{date}'}</code> <code>{'{edition}'}</code>. Blank uses the defaults shown above; empty tokens are dropped and spacing is tidied. Changing these affects <b>new</b> downloads — to apply to existing files, use <b>Reorganize library</b> on the Tools page, or a volume's <b>Rename files</b> action.</p>
          </section>
        </section>

        <!-- DOWNLOADING -->
        <section class="set-group" id="sec-downloading">
          <h3 class="set-group__head">Downloading</h3>
          <p class="set-group__sub">What happens when you add a series, and how downloads run.</p>
          <section class="settings-section">
            <label class="field field--check">
              <span>Download on add</span>
              <span class="switch"><input id="set-autoDownloadOnAdd" type="checkbox" /><span class="switch__track"></span></span>
            </label>
            <p class="modal__note">Adding a series (Library, Discover, Releases, reading lists) immediately queues every issue for download. Off = series add empty and you press "Download missing" yourself.</p>
            <label class="field">
              <span>Download format</span>
              <select id="set-format"><option value="cbz">CBZ (with metadata)</option><option value="pdf">PDF</option></select>
            </label>
            <label class="field"><span>Simultaneous downloads</span><input id="set-downloadConcurrency" type="number" min="1" max="16" /></label>
            <p class="modal__note">How many issues download at once. Higher is faster but more likely to trip a source's rate limits. Applies to the next download.</p>
          </section>
        </section>

        <!-- SOURCES -->
        <section class="set-group" id="sec-sources">
          <h3 class="set-group__head">Sources</h3>
          <p class="set-group__sub">Turn on where BackIssue searches and downloads from. Open a source to configure it — enabling one expands it automatically.</p>

          <!-- Plugin source blocks inject here (plain DOM — must stay mounted). -->
          <div id="settings-plugin-sources"></div>

          <div class="src-block">
            <div class="src-toggle">
              <label class="switch"><input id="set-usenetEnabled" type="checkbox" onchange={syncSourceUI} /><span class="switch__track"></span></label>
              <div class="src-toggle__text">
                <b>Usenet</b>
                <span class="modal__note src-toggle__note">Search Newznab indexers and download via SABnzbd or NZBGet.</span>
              </div>
            </div>
            <div id="usenet-config" class="src-config">
              <p class="modal__subhead modal__subhead--sub">Indexers</p>
              <div id="indexer-list" class="indexer-list">
                {@render indexerRows('newznab', indexerList)}
              </div>
              <button id="add-indexer" class="btn btn--ghost btn--add" type="button" onclick={() => openIndexerModal(-1, 'newznab', null, saveIndexer)}>+ Add indexer</button>
              <p class="modal__note">Newznab (the standard indexer API — e.g. NZBgeek) indexers, searched in order; results are merged.</p>

              <p class="modal__subhead modal__subhead--sub">Download client</p>
              <label class="field"><span>Client</span>
                <select id="set-nzbClient" onchange={syncSourceUI}><option value="sabnzbd">SABnzbd</option><option value="nzbget">NZBGet</option></select>
              </label>
              <label class="field"><span>Host</span><input id="set-nzbClientHost" type="text" spellcheck="false" placeholder="nas or 192.168.1.10" /></label>
              <label class="field"><span>Port</span><input id="set-nzbClientPort" type="number" min="1" max="65535" placeholder="8080" /></label>
              <label class="field field--check"><input id="set-nzbClientSsl" type="checkbox" /><span>Use HTTPS</span></label>
              <div class="only-sabnzbd">
                <label class="field"><span>API key</span><input id="set-nzbClientApiKey" type="text" spellcheck="false" /></label>
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

              <p class="modal__subhead modal__subhead--sub">Completed downloads</p>
              <label class="field"><span>Folder (this app's view)</span><input id="set-usenetCompleteDir" type="text" spellcheck="false" placeholder="\\NAS\dl\complete" /></label>
              <label class="field"><span>Folder (client's view)</span><input id="set-usenetCompleteDirRemote" type="text" spellcheck="false" placeholder="/downloads/complete" /></label>
              <p class="modal__note">Only needed if the client runs on another machine. Map the folder it writes finished downloads to (client's view) onto the path this app reads it at over the network. <code>.cbr</code> releases are converted to <code>.cbz</code> so they can be tagged.</p>

              <div class="fields-row">
                <label class="field"><span>Poll every (s)</span><input id="set-usenetPollSeconds" type="number" min="5" max="600" /></label>
                <label class="field"><span>Give up after (min)</span><input id="set-usenetTimeoutMinutes" type="number" min="1" max="1440" /></label>
              </div>
              <p class="modal__note">BackIssue hands the NZB to your client under the category you set above (default <code>backissue</code>), watches it, imports each download when it completes (tag + file), and removes it from the client. Downloads are tracked in the database, so an app restart resumes them; on boot it reconciles anything that finished while it was down.</p>
            </div>
          </div>

          <div class="src-block">
            <div class="src-toggle">
              <label class="switch"><input id="set-torrentEnabled" type="checkbox" onchange={syncSourceUI} /><span class="switch__track"></span></label>
              <div class="src-toggle__text">
                <b>Torrents</b>
                <span class="modal__note src-toggle__note">Search Torznab indexers (Jackett/Prowlarr) and download via qBittorrent.</span>
              </div>
            </div>
            <div id="torrent-config" class="src-config">
              <p class="modal__subhead modal__subhead--sub">Torrent indexers (Torznab)</p>
              <div id="torznab-list" class="indexer-list">
                {@render indexerRows('torznab', torznabList)}
              </div>
              <button id="add-torznab" class="btn btn--ghost btn--add" type="button" onclick={() => openIndexerModal(-1, 'torznab', null, saveIndexer)}>+ Add indexer</button>
              <p class="modal__note">Torznab (the standard indexer API — e.g. Jackett or Prowlarr) feeds, searched in order; results are merged and ranked by seeders.</p>

              <p class="modal__subhead modal__subhead--sub">qBittorrent</p>
              <label class="field"><span>Host</span><input id="set-qbHost" type="text" spellcheck="false" placeholder="nas or 192.168.1.10" /></label>
              <label class="field"><span>Port</span><input id="set-qbPort" type="number" min="1" max="65535" placeholder="8080" /></label>
              <label class="field field--check"><input id="set-qbSsl" type="checkbox" /><span>Use HTTPS</span></label>
              <label class="field"><span>Username</span><input id="set-qbUser" type="text" spellcheck="false" /></label>
              <label class="field"><span>Password</span><input id="set-qbPass" type="password" spellcheck="false" /></label>
              <label class="field"><span>Category</span><input id="set-torrentCategory" type="text" spellcheck="false" placeholder="backissue" /></label>
              <div class="client-test">
                <button id="qb-test" class="btn btn--ghost" type="button" onclick={testQb}>Test connection</button>
                {#if tests.qb}<span id="qb-test-result" class="client-status {tests.qb.cls}">{#if tests.qb.icon}<Icon name={tests.qb.icon} /> {/if}{tests.qb.text}</span>{/if}
              </div>

              <p class="modal__subhead modal__subhead--sub">Completed downloads</p>
              <label class="field"><span>Folder (this app's view)</span><input id="set-torrentCompleteDir" type="text" spellcheck="false" placeholder="\\NAS\dl\complete" /></label>
              <label class="field"><span>Folder (client's view)</span><input id="set-torrentCompleteDirRemote" type="text" spellcheck="false" placeholder="/downloads/complete" /></label>
              <p class="modal__note">Only needed if qBittorrent runs on another machine. Map its content path onto the path this app reads over the network.</p>

              <div class="fields-row">
                <label class="field"><span>Poll every (s)</span><input id="set-torrentPollSeconds" type="number" min="5" max="600" /></label>
                <label class="field"><span>Give up after (min)</span><input id="set-torrentTimeoutMinutes" type="number" min="1" max="1440" /></label>
              </div>
              <p class="modal__note">BackIssue hands the magnet/.torrent to qBittorrent under the category you set above (default <code>backissue</code>), watches it, and imports each torrent when it completes. After import the torrent is <b>left seeding</b> in qBittorrent — manage ratio and removal there.</p>

              <p class="modal__subhead modal__subhead--sub">Weekly 0-Day pack</p>
              <label class="field"><span>Search phrase</span><input id="set-zeroDayQuery" type="text" spellcheck="false" placeholder="0-Day Week" /></label>
              <label class="field field--check"><input id="set-zeroDayAddNew" type="checkbox" /><span>Add new series I don't follow (confident ComicVine matches only)</span></label>
              <p class="modal__note">A scheduled job finds the newest <b>0-Day Week of …</b> pack on your Torznab indexers, downloads it, and post-processes it — importing the <b>missing</b> issues of series already in your collection (the rest still seeds). With <b>Add new series</b> on, it also adds+follows any series it can confidently match to ComicVine, so brand-new series start being tracked. Turn the schedule on and set how often on the <b>Jobs</b> page (“Grab weekly 0-Day pack”), or Run it now from there.</p>
            </div>
          </div>

          {#if !anySourceOn}
            <p class="modal__note src-warning"><Icon name="alert-triangle" /> No download sources are enabled — new comics can't be downloaded until you turn one on.</p>
          {/if}

          {#if sourceOrder.length >= 2}
            <section class="settings-section" id="source-priority">
              <p class="modal__subhead modal__subhead--sub">Source priority</p>
              <p class="modal__note">When more than one source can serve an issue, they're tried top-to-bottom — the first with a match wins.</p>
              <div id="source-priority-list">
                {#each sourceOrder as s, i (s.id)}
                  <div class="srcpri-row">
                    <span class="srcpri-rank">{i + 1}</span><span class="srcpri-name">{priorityLabel(s)}</span>
                    <button class="srcpri-btn" type="button" disabled={i === 0} onclick={() => movePriority(i, -1)}><Icon name="arrow-up" /></button>
                    <button class="srcpri-btn" type="button" disabled={i === sourceOrder.length - 1} onclick={() => movePriority(i, 1)}><Icon name="arrow-down" /></button>
                  </div>
                {/each}
              </div>
            </section>
          {/if}
          <!-- Plugin priority widgets inject here (plain DOM — must stay mounted). -->
          <div id="settings-plugin-priority"></div>
        </section>

        <!-- METADATA -->
        <section class="set-group" id="sec-metadata">
          <h3 class="set-group__head">Metadata</h3>
          <p class="set-group__sub">ComicVine keys and where release and tagging data come from.</p>
          <section class="settings-section">
            <label class="field">
              <span>Tag on download</span>
              <select id="set-tagOnDownload"><option value="off">Off</option><option value="on">On</option></select>
            </label>
            <label class="field"><span>API key</span><input id="set-comicvineKeys" type="text" spellcheck="false" autocomplete="off" /></label>
            <div class="client-test"><button id="cv-test" class="btn btn--ghost" type="button" onclick={testCv}>Test key</button>
              {#if tests.cv}<span id="cv-test-result" class="client-status {tests.cv.cls}">{#if tests.cv.icon}<Icon name={tests.cv.icon} /> {/if}{tests.cv.text}</span>{/if}</div>
            <label class="field"><span>API base URL (optional)</span><input id="set-cvBaseUrl" type="text" spellcheck="false" placeholder="https://data.backissue.app/api" /></label>
            <p class="modal__note">Point metadata lookups at a ComicVine-compatible server instead of the official API — no rate limits, and politeness delays are skipped automatically. Blank = official ComicVine.</p>
            <label class="field field--check"><input id="set-cvEnrich" type="checkbox" /><span>Enrich metadata (content ratings, series status, issue extras)</span></label>
            <p class="modal__note">When the metadata server supports it (a self-hosted CloneVine), adds Metron data — content ratings, series status and end year, and per-issue extras like price, UPC, and story titles. The official ComicVine API ignores the request, so it's safe either way.</p>
            <label class="field"><span>Release provider URL</span><input id="set-releaseProviderUrl" type="text" spellcheck="false" placeholder="https://data.backissue.app" /></label>
            <p class="modal__note">ComicInfo.xml is written straight into the CBZ from the metadata source. The release provider feeds "This week's releases".</p>
          </section>
        </section>

        <!-- SIGN-IN -->
        <section class="set-group" id="sec-signin">
          <h3 class="set-group__head">Sign-in</h3>
          <p class="set-group__sub">How people sign in. Password login always works for admins.</p>
          <section class="settings-section">
            <p class="modal__note">Add an SSO provider (e.g. OIDC) or another login backend from the <b>Plugins</b> page to let users sign in with an identity provider.</p>
            <!-- Auth plugin config (e.g. OIDC/SSO, WHMCS) injects here (plain DOM — stays mounted). -->
            <div id="settings-plugin-auth"></div>
            <label class="field field--check"><input id="set-passwordLoginDisabled" type="checkbox" /><span>Disable password login (SSO only — admins keep a password fallback)</span></label>
          </section>
        </section>

        <!-- NOTIFICATIONS -->
        <section class="set-group" id="sec-notifications">
          <h3 class="set-group__head">Notifications</h3>
          <p class="set-group__sub">Where BackIssue sends alerts. The in-app bell always records everything regardless.</p>
          <section class="settings-section">
            <label class="field"><span>Webhook URL</span><input id="set-notifyWebhookUrl" type="text" spellcheck="false" placeholder="https://discord.com/api/webhooks/…" /></label>
            <p class="modal__note">POSTed for the categories below (Discord-compatible JSON: <code>{'{ content, type, category, level, … }'}</code>). Also a post-event hook — point it at anything that should react (e.g. a reader-scan trigger). Blank = off.</p>
            <div class="notify-cats">
              {#each NOTIFY_CATS as [key, label] (key)}
                <label class="notify-cat"><input type="checkbox" bind:checked={webhookCats[key]} />{label}</label>
              {/each}
            </div>
          </section>
        </section>
      </div>
    </div>
  </div>
</main>
