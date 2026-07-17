<script>
  import { trapFocus } from '../lib/dom.js';
  // First-run wizard: a full-screen, step-railed setup. Collects just enough to
  // be useful — a ComicVine key, one or more named libraries, optionally one
  // download source, optional plugins — and points at Settings for the rest.
  // Skippable at every step; skipping only sets the onboardingDone flag.
  import { apiGet, apiPost } from '../lib/api.js';
  import { route, setQuery } from '../lib/router.svelte.js';
  import { flags, loadFlags, loadCollection } from '../lib/store.svelte.js';
  import { notify } from '../lib/toasts.svelte.js';
  import Icon from '../lib/Icon.svelte';

  // ?onboarding=1 forces the wizard regardless of state — for testing/demoing
  // it on a configured install. Finish/skip strips the param.
  const forced = $derived(new URLSearchParams(route.search).has('onboarding'));
  const open = $derived(flags.needsOnboarding || forced);

  let step = $state(0);
  const STEPS = ['Welcome', 'ComicVine', 'Library', 'Downloads', 'Plugins', 'Finish'];
  const EYEBROWS = ['', 'Step 2 · Metadata', 'Step 3 · Storage', 'Step 4 · Sources', 'Step 5 · Extend', ''];

  // Collected values
  let cvKey = $state(''); // the app uses a single ComicVine key now
  let source = $state('none'); // 'none' | 'usenet' | 'torrent'
  // usenet
  let ixName = $state(''), ixUrl = $state(''), ixKey = $state('');
  let nzbClient = $state('sabnzbd'), nzbHost = $state(''), nzbPort = $state(''), nzbApiKey = $state(''), nzbUser = $state(''), nzbPass = $state('');
  // torrent
  let tzName = $state(''), tzUrl = $state(''), tzKey = $state('');
  let qbHost = $state(''), qbPort = $state('8080'), qbUser = $state(''), qbPass = $state('');

  // Named libraries (the new model — no rootFolders). Seed one Comics library.
  let libs = $state([{ id: 1, name: 'Comics', type: 'comic', folder: '' }]);
  let libTypes = $state([{ id: 'comic', label: 'Comics' }, { id: 'manga', label: 'Manga' }]);
  let libTypesFetched = false;
  async function loadLibTypes() {
    if (libTypesFetched) return; libTypesFetched = true;
    try { const r = await apiGet('/api/libraries'); if (Array.isArray(r.types) && r.types.length) libTypes = r.types; } catch { /* keep defaults */ }
  }
  $effect(() => { if (step === 2) loadLibTypes(); });
  function addLib() { libs = [...libs, { id: Date.now(), name: '', type: 'comic', folder: '' }]; }
  function removeLib(id) { libs = libs.filter((l) => l.id !== id); }

  // Plugin catalog — fetched when the Plugins step is reached; installed at finish.
  let catalogPlugins = $state([]);
  let pluginSel = $state({});       // id → selected
  let pluginsFetched = $state(false);
  let installing = $state(false);
  async function loadPluginCatalog() {
    if (pluginsFetched) return;
    pluginsFetched = true;
    try {
      const r = await apiGet('/api/plugins/catalog');
      catalogPlugins = (r.plugins || []).filter((p) => !p.installed);
      for (const p of catalogPlugins) pluginSel[p.id] = p.id === 'reader'; // pre-tick the reader
    } catch { catalogPlugins = []; }
  }
  $effect(() => { if (step === 4) loadPluginCatalog(); });

  // Shared test-button state
  let tests = $state({ cv: null, ix: null, client: null });
  async function runTest(slot, endpoint, body) {
    tests[slot] = { cls: 'is-testing', text: 'Testing…' };
    let r;
    try { r = await apiPost(endpoint, body); }
    catch (e) { r = { ok: false, message: String(e) }; }
    tests[slot] = { cls: r.ok ? 'is-ok' : 'is-bad', icon: r.ok ? 'check' : 'close', text: r.message, ok: !!r.ok };
  }
  const testCv = () => runTest('cv', '/api/cv/test', { keys: cvKey });
  const testIx = () => runTest('ix', source === 'torrent' ? '/api/torznab/test' : '/api/indexers/test',
    source === 'torrent' ? { name: tzName, url: tzUrl.trim(), apiKey: tzKey.trim() } : { name: ixName, url: ixUrl.trim(), apiKey: ixKey.trim() });
  const testClient = () => runTest('client',
    source === 'torrent' ? '/api/torrent-client/test' : '/api/clients/test',
    source === 'torrent'
      ? { qbHost: qbHost.trim(), qbPort: qbPort.trim(), qbSsl: false, qbUser: qbUser.trim(), qbPass }
      : { nzbClient, nzbClientHost: nzbHost.trim(), nzbClientPort: nzbPort.trim(), nzbClientSsl: false, nzbClientApiKey: nzbApiKey.trim(), nzbClientUser: nzbUser.trim(), nzbClientPass: nzbPass });

  const cvTone = $derived(tests.cv?.ok ? 'var(--green)' : tests.cv?.cls === 'is-bad' ? 'var(--red)' : 'var(--muted)');
  const namedLibs = $derived(libs.filter((l) => l.name.trim()));

  let saving = $state(false);
  async function finish() {
    saving = true;
    // Only send what the user actually filled in — defaults stay untouched.
    // Libraries are created via /api/libraries (they OWN the storage paths now),
    // so no rootFolders here.
    const body = { onboardingDone: true };
    if (cvKey.trim()) body.comicvineKeys = cvKey.trim();
    if (source === 'usenet') {
      body.usenetEnabled = true;
      if (ixUrl.trim()) body.newznabIndexers = [ixName.trim() || ixUrl.trim(), ixUrl.trim().replace(/\/+$/, ''), ixKey.trim()].join(' | ');
      body.nzbClient = nzbClient;
      if (nzbHost.trim()) body.nzbClientHost = nzbHost.trim();
      if (nzbPort.trim()) body.nzbClientPort = nzbPort.trim();
      if (nzbApiKey.trim()) body.nzbClientApiKey = nzbApiKey.trim();
      if (nzbUser.trim()) body.nzbClientUser = nzbUser.trim();
      if (nzbPass) body.nzbClientPass = nzbPass;
    } else if (source === 'torrent') {
      body.torrentEnabled = true;
      if (tzUrl.trim()) body.torznabIndexers = [tzName.trim() || tzUrl.trim(), tzUrl.trim().replace(/\/+$/, ''), tzKey.trim()].join(' | ');
      if (qbHost.trim()) body.qbHost = qbHost.trim();
      if (qbPort.trim()) body.qbPort = qbPort.trim();
      if (qbUser.trim()) body.qbUser = qbUser.trim();
      if (qbPass) body.qbPass = qbPass;
    }
    try {
      await apiPost('/api/settings', body);
      // Create the named libraries the user defined (skip empty-name rows). A
      // blank folder is allowed — the library exists as a container and its
      // folder can be set later.
      for (const l of namedLibs) {
        try { await apiPost('/api/libraries', { name: l.name.trim(), type: l.type, rootFolder: l.folder.trim() }); }
        catch { /* skip a failed one — the rest still land */ }
      }
      // Install any plugins the user ticked, then restart to load them.
      const chosen = catalogPlugins.filter((p) => pluginSel[p.id]);
      if (chosen.length) {
        installing = true;
        for (const p of chosen) {
          try { await apiPost('/api/plugins/install', { id: p.id }); } catch { /* skip a failed one */ }
        }
        installing = false;
      }
      flags.needsOnboarding = false;
      if (forced) setQuery({ onboarding: null });
      if (chosen.length) {
        notify('Plugins installed — restarting BackIssue to activate them…', 'ok');
        try { await apiPost('/api/restart'); } catch { /* the connection drops as it restarts */ }
        setTimeout(() => location.reload(), 4000);
        return;
      }
      await loadFlags();
      loadCollection();
      notify('You’re set up — add a series with “+ Add”, or import an existing library from the sidebar.', 'ok');
    } catch {
      notify('Could not save setup — check the app is reachable and try again.', 'error');
    }
    saving = false;
  }

  async function skip() {
    try { await apiPost('/api/settings', { onboardingDone: true }); } catch { /* still hide */ }
    flags.needsOnboarding = false;
    if (forced) setQuery({ onboarding: null });
  }

  const nextLabel = $derived(step === STEPS.length - 1 ? (installing ? 'Installing plugins…' : saving ? 'Saving…' : 'Finish setup') : step === 0 ? 'Get started' : 'Continue');
  const summaryRows = $derived([
    { label: 'ComicVine key', value: cvKey.trim() ? (tests.cv?.ok ? 'Verified' : 'Added') : 'Skipped', tone: cvKey.trim() ? 'var(--green)' : 'var(--muted)', icon: 'tag' },
    { label: 'Libraries', value: namedLibs.length ? `${namedLibs.length} ${namedLibs.length === 1 ? 'library' : 'libraries'}` : 'None', tone: namedLibs.length ? 'var(--green)' : 'var(--muted)', icon: 'book' },
    { label: 'Download source', value: source === 'usenet' ? 'Usenet' : source === 'torrent' ? 'Torrents' : 'None yet', tone: source === 'none' ? 'var(--muted)' : 'var(--green)', icon: 'download' },
    { label: 'Plugins', value: `${catalogPlugins.filter((p) => pluginSel[p.id]).length} selected`, tone: 'var(--green)', icon: 'puzzle' },
  ]);
</script>

{#if open}
  <div class="obx">
    <aside class="obx__rail">
      <div class="obx__brand"><span class="obx__logo">BackIssue</span></div>
      <div class="obx__steps">
        {#each STEPS as label, i (label)}
          <button class="obx__step" class:is-active={i === step} class:is-done={i < step} onclick={() => { step = i; }}>
            <span class="obx__dot">{#if i < step}<Icon name="check" size={13} />{:else}{i + 1}{/if}</span>
            <span class="obx__step-label">{label}</span>
          </button>
        {/each}
      </div>
      <div class="obx__progress">
        <div class="obx__progress-track"><div class="obx__progress-fill" style="width:{Math.round((step / (STEPS.length - 1)) * 100)}%"></div></div>
        <div class="obx__progress-text">Step {step + 1} of {STEPS.length} · about two minutes</div>
      </div>
    </aside>

    <div class="obx__main" use:trapFocus role="dialog" aria-label="First-run setup">
      <div class="obx__content">
        <div class="obx__inner">
          {#if EYEBROWS[step]}<div class="obx__eyebrow">{EYEBROWS[step]}</div>{/if}

          {#if step === 0}
            <div class="obx__hero obx__hero--brand"><Icon name="book" size={30} /></div>
            <h1 class="obx__h1 obx__h1--big">Welcome to BackIssue</h1>
            <p class="obx__lead">A self-hosted manager for your comic collection — track the series you want, download new issues as they release, and keep everything tagged and organized on disk.</p>
            <p class="obx__sub">Setup takes about two minutes: a ComicVine API key, where your comics live, and optionally a download source. Everything can be changed later in <b>Settings</b>.</p>
            <div class="obx__bullets">
              <div class="obx__bullet"><span class="obx__bullet-ico"><Icon name="tag" size={16} /></span><div><div class="obx__bullet-t">Rich metadata</div><div class="obx__bullet-b">Covers, credits and issue lists from ComicVine.</div></div></div>
              <div class="obx__bullet"><span class="obx__bullet-ico"><Icon name="download" size={16} /></span><div><div class="obx__bullet-t">Automatic downloads</div><div class="obx__bullet-b">New issues grabbed as they release.</div></div></div>
              <div class="obx__bullet"><span class="obx__bullet-ico"><Icon name="folder" size={16} /></span><div><div class="obx__bullet-t">Organized on disk</div><div class="obx__bullet-b">Tagged and filed into a clean folder tree.</div></div></div>
            </div>
          {:else if step === 1}
            <h1 class="obx__h1">ComicVine API key</h1>
            <p class="obx__lead">ComicVine provides every comic's identity — series, issues, covers, credits. A key is free from <a href="https://comicvine.gamespot.com/api/" target="_blank" rel="noreferrer">comicvine.gamespot.com/api <Icon name="external-link" size={13} /></a>.</p>
            <label class="obx__label">API key</label>
            <input class="obx__input obx__input--mono" type="text" spellcheck="false" autocomplete="off" placeholder="paste your key…" bind:value={cvKey} />
            <div class="obx__testrow">
              <button class="obx__test" type="button" disabled={!cvKey.trim()} onclick={testCv}>Test key</button>
              {#if tests.cv}<span class="obx__teststatus" style="color:{cvTone};">{#if tests.cv.icon}<Icon name={tests.cv.icon} size={14} /> {/if}{tests.cv.text}</span>{/if}
            </div>
            <div class="obx__note obx__note--cyan">You can skip this and add a key later in <b>Settings → Metadata</b>, but search and matching won't work until you do.</div>
          {:else if step === 2}
            <h1 class="obx__h1">Set up your libraries</h1>
            <p class="obx__lead">A library is a named collection with a type and a folder on disk. Create one to start — add more here or in <b>Settings</b> later. Files are organized into <b>folder</b>/Publisher/Title (Year).</p>
            <div class="obx__libs">
              {#each libs as l (l.id)}
                <div class="obx__lib">
                  <div class="obx__lib-top">
                    <span class="obx__lib-ico"><Icon name="book" size={16} /></span>
                    <input class="obx__lib-name" placeholder="Library name" bind:value={l.name} />
                    <select class="obx__lib-type" bind:value={l.type}>
                      {#each libTypes as t (t.id)}<option value={t.id}>{t.label}</option>{/each}
                    </select>
                    {#if libs.length > 1}<button class="obx__lib-rm" aria-label="Remove library" onclick={() => removeLib(l.id)}><Icon name="close" size={14} /></button>{/if}
                  </div>
                  <div class="obx__lib-folder">
                    <span class="obx__lib-fico"><Icon name="folder" size={16} /></span>
                    <input class="obx__input--mono obx__lib-path" placeholder={'D:\\Comics  or  \\\\NAS\\comics'} spellcheck="false" bind:value={l.folder} />
                  </div>
                </div>
              {/each}
            </div>
            <button class="obx__addlib" onclick={addLib}><Icon name="plus" size={14} /> Add another library</button>
            <div class="obx__note obx__note--amber"><span class="obx__note-ico"><Icon name="info" size={16} /></span><p>Already have comics in these folders? After setup, use <b>Import</b> in the sidebar to match them to ComicVine and pull them into the collection. Leave a folder blank to decide later.</p></div>
          {:else if step === 3}
            <h1 class="obx__h1">Download source</h1>
            <p class="obx__lead">How should BackIssue download issues? Pick one to configure now — enable more or fine-tune later in Settings.</p>
            <div class="obx__sources">
              <button class="obx__source" class:is-active={source === 'usenet'} onclick={() => { source = 'usenet'; tests.ix = tests.client = null; }}>
                <span class="obx__source-ico"><Icon name="download" size={16} /></span><span class="obx__source-label">Usenet</span><span class="obx__source-desc">SABnzbd / NZBGet</span></button>
              <button class="obx__source" class:is-active={source === 'torrent'} onclick={() => { source = 'torrent'; tests.ix = tests.client = null; }}>
                <span class="obx__source-ico"><Icon name="globe" size={16} /></span><span class="obx__source-label">Torrents</span><span class="obx__source-desc">qBittorrent</span></button>
              <button class="obx__source" class:is-active={source === 'none'} onclick={() => { source = 'none'; }}>
                <span class="obx__source-ico"><Icon name="info" size={16} /></span><span class="obx__source-label">Decide later</span><span class="obx__source-desc">Skip for now</span></button>
            </div>
            {#if source === 'usenet'}
              <div class="obx__cfg">
                <div>
                  <div class="obx__cfg-h">Indexer (Newznab)</div>
                  <div class="obx__grid2"><input class="obx__input" placeholder="Name (NZBgeek)" bind:value={ixName} /><input class="obx__input obx__input--mono" placeholder="https://api.nzbgeek.info" bind:value={ixUrl} /></div>
                  <input class="obx__input obx__input--mono obx__mt" placeholder="API key" bind:value={ixKey} />
                  <div class="obx__testrow obx__mt"><button class="obx__test" type="button" disabled={!ixUrl.trim()} onclick={testIx}>Test indexer</button>{#if tests.ix}<span class="obx__teststatus obx__ts--{tests.ix.cls}">{#if tests.ix.icon}<Icon name={tests.ix.icon} size={14} /> {/if}{tests.ix.text}</span>{/if}</div>
                </div>
                <div>
                  <div class="obx__cfg-h">Download client</div>
                  <select class="obx__input" bind:value={nzbClient}><option value="sabnzbd">SABnzbd</option><option value="nzbget">NZBGet</option></select>
                  <div class="obx__grid-hp obx__mt"><input class="obx__input" placeholder="Host" bind:value={nzbHost} /><input class="obx__input" placeholder="Port" bind:value={nzbPort} /></div>
                  {#if nzbClient === 'sabnzbd'}
                    <input class="obx__input obx__input--mono obx__mt" placeholder="API key" bind:value={nzbApiKey} />
                  {:else}
                    <div class="obx__grid2 obx__mt"><input class="obx__input" placeholder="Username" bind:value={nzbUser} /><input class="obx__input" type="password" placeholder="Password" bind:value={nzbPass} /></div>
                  {/if}
                  <div class="obx__testrow obx__mt"><button class="obx__test" type="button" disabled={!nzbHost.trim()} onclick={testClient}>Test connection</button>{#if tests.client}<span class="obx__teststatus obx__ts--{tests.client.cls}">{#if tests.client.icon}<Icon name={tests.client.icon} size={14} /> {/if}{tests.client.text}</span>{/if}</div>
                </div>
              </div>
            {:else if source === 'torrent'}
              <div class="obx__cfg">
                <div>
                  <div class="obx__cfg-h">Indexer (Torznab — Jackett/Prowlarr)</div>
                  <div class="obx__grid2"><input class="obx__input" placeholder="Name" bind:value={tzName} /><input class="obx__input obx__input--mono" placeholder="http://prowlarr:9696/1/api" bind:value={tzUrl} /></div>
                  <input class="obx__input obx__input--mono obx__mt" placeholder="API key" bind:value={tzKey} />
                  <div class="obx__testrow obx__mt"><button class="obx__test" type="button" disabled={!tzUrl.trim()} onclick={testIx}>Test indexer</button>{#if tests.ix}<span class="obx__teststatus obx__ts--{tests.ix.cls}">{#if tests.ix.icon}<Icon name={tests.ix.icon} size={14} /> {/if}{tests.ix.text}</span>{/if}</div>
                </div>
                <div>
                  <div class="obx__cfg-h">qBittorrent</div>
                  <div class="obx__grid-hp"><input class="obx__input" placeholder="Host" bind:value={qbHost} /><input class="obx__input" placeholder="8080" bind:value={qbPort} /></div>
                  <div class="obx__grid2 obx__mt"><input class="obx__input" placeholder="Username" bind:value={qbUser} /><input class="obx__input" type="password" placeholder="Password" bind:value={qbPass} /></div>
                  <div class="obx__testrow obx__mt"><button class="obx__test" type="button" disabled={!qbHost.trim()} onclick={testClient}>Test connection</button>{#if tests.client}<span class="obx__teststatus obx__ts--{tests.client.cls}">{#if tests.client.icon}<Icon name={tests.client.icon} size={14} /> {/if}{tests.client.text}</span>{/if}</div>
                </div>
              </div>
            {:else}
              <div class="obx__note">No usenet or torrent setup? That's fine — plugins can add other download sources later from the <b>Plugins</b> page. You can still track series and import files you already have.</div>
            {/if}
          {:else if step === 4}
            <h1 class="obx__h1">Add plugins</h1>
            <p class="obx__lead">BackIssue is modular — pick plugins to install now, or add them anytime from the <b>Plugins</b> page. Selected plugins activate when you finish.</p>
            {#if !pluginsFetched}
              <div class="obx__note">Loading catalog…</div>
            {:else if !catalogPlugins.length}
              <div class="obx__note">No plugins available right now — you can add them later from the Plugins page.</div>
            {:else}
              <div class="obx__plugins">
                {#each catalogPlugins as p (p.id)}
                  <label class="obx__plugin" class:is-on={pluginSel[p.id]}>
                    <span class="obx__plugin-check">{#if pluginSel[p.id]}<Icon name="check" size={13} />{/if}</span>
                    <input type="checkbox" bind:checked={pluginSel[p.id]} hidden />
                    <span class="obx__plugin-info">
                      <span class="obx__plugin-top"><b>{p.name}</b>{#if p.version}<span class="obx__plugin-ver">v{p.version}</span>{/if}</span>
                      <span class="obx__plugin-desc">{p.description}</span>
                    </span>
                  </label>
                {/each}
              </div>
            {/if}
          {:else}
            <div class="obx__hero obx__hero--done"><Icon name="check" size={30} /></div>
            <h1 class="obx__h1 obx__h1--big">Ready to go</h1>
            <p class="obx__lead">Your setup is complete. Here's what you configured:</p>
            <div class="obx__summary">
              {#each summaryRows as r (r.label)}
                <div class="obx__srow"><span class="obx__sico" style="color:{r.tone}; background:color-mix(in srgb, {r.tone} 12%, transparent);"><Icon name={r.icon} size={14} /></span><span class="obx__slabel">{r.label}</span><span class="obx__svalue" style="color:{r.tone};">{r.value}</span></div>
              {/each}
            </div>
            <p class="obx__sub">Next: add a series with <b>+ Add</b> (searches ComicVine), or pull in an existing library via <b>Import</b> in the sidebar.</p>
          {/if}
        </div>
      </div>

      <div class="obx__foot">
        <button class="obx__skip" onclick={skip}>Skip setup</button>
        <div class="obx__foot-right">
          {#if step > 0}<button class="obx__back" onclick={() => { step -= 1; }}>Back</button>{/if}
          {#if step < STEPS.length - 1}
            <button class="obx__next" onclick={() => { step += 1; }}>{nextLabel} <Icon name="arrow-right" size={16} /></button>
          {:else}
            <button class="obx__next" disabled={saving} onclick={finish}>{nextLabel}</button>
          {/if}
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  .obx { position: fixed; inset: 0; z-index: 200; display: flex; overflow: hidden;
    background: radial-gradient(1100px 700px at 18% -10%, rgba(255,45,111,.14), transparent 60%), #0f0d15; color: var(--text); }
  .obx__rail { width: 236px; flex: none; background: rgba(13,11,18,.55); border-right: 1px solid #221e2c; padding: 26px 18px; display: flex; flex-direction: column; }
  .obx__brand { padding: 4px 6px 26px; }
  .obx__logo { font-family: var(--font-display); font-size: 24px; letter-spacing: .04em; position: relative; padding-right: 12px; }
  .obx__logo::after { content: ''; position: absolute; right: 0; top: 2px; width: 8px; height: 8px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 10px rgba(255,45,111,.7); }
  .obx__steps { display: flex; flex-direction: column; gap: 3px; flex: 1; }
  .obx__step { display: flex; align-items: center; gap: 12px; padding: 9px 10px; border-radius: 9px; border: none; background: transparent; color: var(--faint); font: 600 13px var(--font-body); cursor: pointer; text-align: left; }
  .obx__step.is-done { color: #b3adc4; }
  .obx__step.is-active { background: rgba(255,45,111,.1); color: var(--text); }
  .obx__dot { width: 24px; height: 24px; border-radius: 50%; flex: none; display: grid; place-items: center; font: 600 11px var(--font-mono); background: var(--panel-2); color: var(--faint); }
  .obx__step.is-active .obx__dot { background: var(--accent); color: #fff; }
  .obx__step.is-done .obx__dot { background: var(--green); color: #0f0d15; }
  .obx__step-label { flex: 1; }
  .obx__progress { padding-top: 16px; }
  .obx__progress-track { height: 5px; border-radius: 3px; background: #221e2c; overflow: hidden; }
  .obx__progress-fill { height: 100%; background: var(--accent); transition: width .3s; }
  .obx__progress-text { font-size: 11px; color: #6f6885; margin-top: 8px; }

  .obx__main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .obx__content { flex: 1; overflow-y: auto; padding: 56px 48px; }
  .obx__inner { max-width: 560px; margin: 0 auto; }
  .obx__eyebrow { font-size: 12px; text-transform: uppercase; letter-spacing: .09em; color: var(--accent); margin-bottom: 10px; }
  .obx__hero { width: 60px; height: 60px; border-radius: 16px; display: grid; place-items: center; margin-bottom: 26px; }
  .obx__hero--brand { background: linear-gradient(150deg, var(--accent), #b3164e); color: #fff; box-shadow: 0 12px 34px rgba(255,45,111,.34); }
  .obx__hero--done { background: linear-gradient(150deg, var(--green), #2f9c5e); color: #0f0d15; box-shadow: 0 12px 34px rgba(95,211,138,.28); }
  .obx__h1 { font-family: var(--font-display); font-size: 30px; letter-spacing: .02em; margin: 0 0 14px; font-weight: 400; }
  .obx__h1--big { font-size: 36px; }
  .obx__lead { font-size: 14px; color: #b3adc4; line-height: 1.6; margin: 0 0 22px; }
  .obx__sub { font-size: 13.5px; color: var(--faint); line-height: 1.65; margin: 0; }
  .obx__lead b, .obx__sub b { color: var(--text); }

  .obx__bullets { display: flex; flex-direction: column; gap: 12px; }
  .obx__bullet { display: flex; align-items: center; gap: 13px; padding: 13px 15px; background: rgba(255,255,255,.02); border: 1px solid #2a2536; border-radius: 11px; }
  .obx__bullet-ico { width: 34px; height: 34px; border-radius: 9px; background: var(--panel-2); display: grid; place-items: center; color: var(--accent); flex: none; }
  .obx__bullet-t { font-size: 13.5px; font-weight: 600; }
  .obx__bullet-b { font-size: 12px; color: var(--faint); margin-top: 2px; }

  .obx__label { font-size: 11px; text-transform: uppercase; letter-spacing: .07em; color: var(--muted); margin-bottom: 6px; display: block; }
  .obx__input { width: 100%; height: 40px; padding: 0 12px; background: var(--ink); border: 1px solid var(--line); border-radius: 9px; color: var(--text); font: 14px var(--font-body); }
  .obx__input:focus { outline: none; border-color: var(--accent); }
  .obx__input--mono { font-family: var(--font-mono); font-size: 13px; }
  .obx__mt { margin-top: 10px; }
  .obx__grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .obx__grid-hp { display: grid; grid-template-columns: 1fr 90px; gap: 10px; }
  .obx__testrow { display: flex; align-items: center; gap: 12px; }
  .obx__test { height: 38px; padding: 0 16px; border: 1px solid var(--line); background: transparent; color: var(--muted); border-radius: 9px; font: 600 12.5px var(--font-body); cursor: pointer; }
  .obx__test:disabled { opacity: .5; cursor: default; }
  .obx__teststatus { font-size: 12.5px; display: inline-flex; align-items: center; gap: 5px; }
  .obx__ts--is-ok { color: var(--green); }
  .obx__ts--is-bad { color: var(--red); }
  .obx__ts--is-testing { color: var(--muted); }
  .obx__note { margin-top: 22px; padding: 13px 15px; border: 1px solid #2a2536; background: rgba(255,255,255,.02); border-radius: 11px; font-size: 12.5px; color: var(--muted); line-height: 1.55; display: flex; gap: 11px; align-items: flex-start; }
  .obx__note b { color: var(--text); }
  .obx__note p { margin: 0; }
  .obx__note--cyan { border-color: rgba(43,212,217,.25); background: rgba(43,212,217,.05); color: #9fd9dc; }
  .obx__note--amber .obx__note-ico { color: var(--amber); flex: none; display: flex; margin-top: 1px; }
  .obx__note-ico { flex: none; }

  .obx__libs { display: flex; flex-direction: column; gap: 12px; }
  .obx__lib { border: 1px solid var(--line); border-radius: 12px; padding: 14px; background: rgba(255,255,255,.015); }
  .obx__lib-top { display: flex; align-items: center; gap: 10px; margin-bottom: 11px; }
  .obx__lib-ico { color: var(--accent); display: flex; flex: none; }
  .obx__lib-name { flex: 1 1 120px; min-width: 100px; height: 36px; padding: 0 10px; background: var(--ink); border: 1px solid var(--line); border-radius: 8px; color: var(--text); font: 600 13px var(--font-body); }
  .obx__lib-name:focus, .obx__lib-type:focus, .obx__lib-path:focus { outline: none; border-color: var(--accent); }
  .obx__lib-type { height: 36px; padding: 0 8px; background: var(--ink); border: 1px solid var(--line); border-radius: 8px; color: var(--text); font: 13px var(--font-body); }
  .obx__lib-rm { flex: none; width: 32px; height: 32px; display: grid; place-items: center; background: none; border: none; color: var(--faint); cursor: pointer; border-radius: 6px; }
  .obx__lib-rm:hover { color: var(--text); }
  .obx__lib-folder { display: flex; align-items: center; gap: 8px; }
  .obx__lib-fico { color: var(--faint); display: flex; flex: none; }
  .obx__lib-path { flex: 1; min-width: 0; height: 36px; padding: 0 10px; background: var(--ink); border: 1px solid var(--line); border-radius: 8px; color: var(--text); }
  .obx__addlib { margin-top: 12px; height: 38px; padding: 0 14px; border: 1px dashed var(--line); background: transparent; color: var(--muted); border-radius: 9px; font: 600 12.5px var(--font-body); cursor: pointer; display: inline-flex; align-items: center; gap: 7px; }

  .obx__sources { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; margin-bottom: 22px; }
  .obx__source { display: flex; flex-direction: column; align-items: flex-start; text-align: left; padding: 15px 14px; border-radius: 12px; border: 1px solid var(--line); background: rgba(255,255,255,.015); color: var(--text); cursor: pointer; }
  .obx__source.is-active { border-color: var(--accent); background: rgba(255,45,111,.08); }
  .obx__source-ico { display: flex; margin-bottom: 9px; color: var(--faint); }
  .obx__source.is-active .obx__source-ico { color: var(--accent); }
  .obx__source-label { font-size: 13.5px; font-weight: 600; }
  .obx__source-desc { font-size: 11.5px; color: var(--faint); margin-top: 3px; line-height: 1.4; }
  .obx__cfg { display: flex; flex-direction: column; gap: 16px; }
  .obx__cfg-h { font-size: 11px; text-transform: uppercase; letter-spacing: .07em; color: var(--faint); margin-bottom: 10px; }

  .obx__plugins { display: flex; flex-direction: column; gap: 10px; }
  .obx__plugin { display: flex; align-items: flex-start; gap: 12px; padding: 13px 15px; border-radius: 11px; border: 1px solid var(--line); background: rgba(255,255,255,.015); cursor: pointer; }
  .obx__plugin.is-on { border-color: var(--accent); background: rgba(255,45,111,.06); }
  .obx__plugin-check { width: 20px; height: 20px; border-radius: 6px; flex: none; margin-top: 1px; display: grid; place-items: center; color: #fff; border: 1px solid var(--line); }
  .obx__plugin.is-on .obx__plugin-check { border-color: var(--accent); background: var(--accent); }
  .obx__plugin-info { flex: 1; min-width: 0; }
  .obx__plugin-top { display: flex; align-items: center; gap: 8px; }
  .obx__plugin-top b { font-size: 13.5px; }
  .obx__plugin-ver { font: 10.5px var(--font-mono); color: #6f6885; }
  .obx__plugin-desc { display: block; font-size: 12px; color: var(--faint); margin-top: 3px; line-height: 1.45; }

  .obx__summary { display: flex; flex-direction: column; gap: 10px; margin-bottom: 26px; }
  .obx__srow { display: flex; align-items: center; gap: 12px; padding: 12px 15px; background: rgba(255,255,255,.02); border: 1px solid #2a2536; border-radius: 11px; }
  .obx__sico { width: 26px; height: 26px; border-radius: 7px; display: grid; place-items: center; flex: none; }
  .obx__slabel { flex: 1; font-size: 13px; color: var(--muted); }
  .obx__svalue { font-size: 13px; font-weight: 600; }

  .obx__foot { flex: none; display: flex; align-items: center; gap: 12px; padding: 16px 48px; border-top: 1px solid #221e2c; }
  .obx__skip { height: 40px; padding: 0 16px; border: none; background: none; color: var(--faint); font: 600 13px var(--font-body); cursor: pointer; }
  .obx__foot-right { margin-left: auto; display: flex; gap: 10px; }
  .obx__back { height: 40px; padding: 0 20px; border: 1px solid var(--line); background: transparent; color: var(--text); border-radius: 9px; font: 600 13.5px var(--font-body); cursor: pointer; }
  .obx__next { height: 40px; padding: 0 24px; border: none; background: var(--accent); color: #fff; border-radius: 9px; font: 600 13.5px var(--font-body); cursor: pointer; display: inline-flex; align-items: center; gap: 8px; }
  .obx__next:disabled { opacity: .7; cursor: default; }

  @media (max-width: 720px) {
    .obx__rail { display: none; }
    .obx__content { padding: 32px 22px; }
    .obx__foot { padding: 14px 22px; }
    .obx__sources { grid-template-columns: 1fr; }
  }
</style>
