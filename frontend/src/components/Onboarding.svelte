<script>
  import { trapFocus } from '../lib/dom.js';
  // First-run wizard: shown once, when the app has never been onboarded and has
  // no ComicVine key. Collects just enough to be useful — CV keys, root
  // folders, optionally one download source — and points at Settings for the
  // rest. Skippable at every step; skipping only sets the onboardingDone flag.
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

  // Collected values
  let cvKeys = $state('');
  let rootFolders = $state('');
  let source = $state('none'); // 'none' | 'usenet' | 'torrent'
  // usenet
  let ixName = $state(''), ixUrl = $state(''), ixKey = $state('');
  let nzbClient = $state('sabnzbd'), nzbHost = $state(''), nzbPort = $state(''), nzbApiKey = $state(''), nzbUser = $state(''), nzbPass = $state('');
  // torrent
  let tzName = $state(''), tzUrl = $state(''), tzKey = $state('');
  let qbHost = $state(''), qbPort = $state('8080'), qbUser = $state(''), qbPass = $state('');

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
    tests[slot] = { cls: r.ok ? 'is-ok' : 'is-bad', icon: r.ok ? 'check' : 'close', text: r.message };
  }
  const testCv = () => runTest('cv', '/api/cv/test', { keys: cvKeys });
  const testIx = () => runTest('ix', source === 'torrent' ? '/api/torznab/test' : '/api/indexers/test',
    source === 'torrent' ? { name: tzName, url: tzUrl.trim(), apiKey: tzKey.trim() } : { name: ixName, url: ixUrl.trim(), apiKey: ixKey.trim() });
  const testClient = () => runTest('client',
    source === 'torrent' ? '/api/torrent-client/test' : '/api/clients/test',
    source === 'torrent'
      ? { qbHost: qbHost.trim(), qbPort: qbPort.trim(), qbSsl: false, qbUser: qbUser.trim(), qbPass }
      : { nzbClient, nzbClientHost: nzbHost.trim(), nzbClientPort: nzbPort.trim(), nzbClientSsl: false, nzbClientApiKey: nzbApiKey.trim(), nzbClientUser: nzbUser.trim(), nzbClientPass: nzbPass });

  let saving = $state(false);
  async function finish() {
    saving = true;
    // Only send what the user actually filled in — defaults stay untouched.
    const body = { onboardingDone: true };
    if (cvKeys.trim()) body.comicvineKeys = cvKeys.trim();
    if (rootFolders.trim()) body.rootFolders = rootFolders.trim();
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
</script>

{#if open}
  <div class="onboard">
    <div class="onboard__card" use:trapFocus role="dialog" aria-label="First-run setup">
      <div class="onboard__steps">
        {#each STEPS as label, i (label)}
          <span class="onboard__step" class:is-active={i === step} class:is-done={i < step}>{label}</span>
        {/each}
      </div>

      {#if step === 0}
        <h2 class="onboard__title">Welcome to BackIssue</h2>
        <p class="onboard__text">A self-hosted manager for your comic collection — track the series you want, download new issues as they release, and keep everything tagged and organized on disk.</p>
        <p class="onboard__text">Setup takes about two minutes: a ComicVine API key (comic metadata), where your comics live, and optionally a download source. Everything can be changed later in <b>Settings</b>.</p>
      {:else if step === 1}
        <h2 class="onboard__title">ComicVine API key</h2>
        <p class="onboard__text">ComicVine provides every comic's identity — series, issues, covers, credits. Keys are free: <a href="https://comicvine.gamespot.com/api/" target="_blank" rel="noreferrer">comicvine.gamespot.com/api <Icon name="external-link" size={14} /></a>. </p>
        <input class="dialog-input" type="text" spellcheck="false" autocomplete="off" placeholder="Your API key…" bind:value={cvKeys} />
        <div class="client-test">
          <button class="btn btn--ghost" type="button" disabled={!cvKeys.trim()} onclick={testCv}>Test key</button>
          {#if tests.cv}<span class="client-status {tests.cv.cls}">{#if tests.cv.icon}<Icon name={tests.cv.icon} /> {/if}{tests.cv.text}</span>{/if}
        </div>
      {:else if step === 2}
        <h2 class="onboard__title">Where do your comics live?</h2>
        <p class="onboard__text">Root folders on disk (one per line or comma-separated) — comics are organized into <b>root</b>/Publisher/Title (Year). Network shares work fine. Leave blank to decide later.</p>
        <textarea class="dialog-input" rows="2" spellcheck="false" placeholder={'\\\\NAS\\main\\comics\nD:\\Comics'} bind:value={rootFolders}></textarea>
        <p class="onboard__note">Already have comics in these folders? After setup, use <b>Import</b> in the sidebar to match them to ComicVine and pull them into the collection.</p>
      {:else if step === 3}
        <h2 class="onboard__title">Download source</h2>
        <p class="onboard__text">How should BackIssue download issues? Pick one to configure now — you can enable more (or fine-tune folder mappings for remote clients) in Settings.</p>
        <div class="onboard__choices">
          <button class="onboard__choice" class:is-active={source === 'usenet'} onclick={() => { source = 'usenet'; tests.ix = tests.client = null; }}>
            <b>Usenet</b><span>Newznab indexers → SABnzbd / NZBGet</span></button>
          <button class="onboard__choice" class:is-active={source === 'torrent'} onclick={() => { source = 'torrent'; tests.ix = tests.client = null; }}>
            <b>Torrents</b><span>Torznab (Jackett/Prowlarr) → qBittorrent</span></button>
          <button class="onboard__choice" class:is-active={source === 'none'} onclick={() => { source = 'none'; }}>
            <b>Skip for now</b><span>Browse + import only</span></button>
        </div>
        <p class="onboard__note">No usenet or torrent setup? Plugins can add other download sources later — see the Plugins page once you're in.</p>
        {#if source === 'usenet'}
          <p class="onboard__sub">Indexer (Newznab)</p>
          <div class="onboard__row">
            <input class="dialog-input" type="text" spellcheck="false" placeholder="Name (NZBgeek)" bind:value={ixName} />
            <input class="dialog-input" type="text" spellcheck="false" placeholder="https://api.nzbgeek.info" bind:value={ixUrl} />
            <input class="dialog-input" type="text" spellcheck="false" placeholder="API key" bind:value={ixKey} />
            <button class="btn btn--ghost btn--sm" type="button" disabled={!ixUrl.trim()} onclick={testIx}>Test</button>
          </div>
          {#if tests.ix}<span class="client-status {tests.ix.cls}">{#if tests.ix.icon}<Icon name={tests.ix.icon} /> {/if}{tests.ix.text}</span>{/if}
          <p class="onboard__sub">Download client</p>
          <div class="onboard__row">
            <select class="dialog-input" bind:value={nzbClient}><option value="sabnzbd">SABnzbd</option><option value="nzbget">NZBGet</option></select>
            <input class="dialog-input" type="text" spellcheck="false" placeholder="Host" bind:value={nzbHost} />
            <input class="dialog-input" type="text" spellcheck="false" placeholder="Port" bind:value={nzbPort} />
            {#if nzbClient === 'sabnzbd'}
              <input class="dialog-input" type="text" spellcheck="false" placeholder="API key" bind:value={nzbApiKey} />
            {:else}
              <input class="dialog-input" type="text" spellcheck="false" placeholder="Username" bind:value={nzbUser} />
              <input class="dialog-input" type="password" spellcheck="false" placeholder="Password" bind:value={nzbPass} />
            {/if}
            <button class="btn btn--ghost btn--sm" type="button" disabled={!nzbHost.trim()} onclick={testClient}>Test</button>
          </div>
          {#if tests.client}<span class="client-status {tests.client.cls}">{#if tests.client.icon}<Icon name={tests.client.icon} /> {/if}{tests.client.text}</span>{/if}
        {:else if source === 'torrent'}
          <p class="onboard__sub">Indexer (Torznab — Jackett/Prowlarr feed)</p>
          <div class="onboard__row">
            <input class="dialog-input" type="text" spellcheck="false" placeholder="Name" bind:value={tzName} />
            <input class="dialog-input" type="text" spellcheck="false" placeholder="http://localhost:9696/1/api" bind:value={tzUrl} />
            <input class="dialog-input" type="text" spellcheck="false" placeholder="API key" bind:value={tzKey} />
            <button class="btn btn--ghost btn--sm" type="button" disabled={!tzUrl.trim()} onclick={testIx}>Test</button>
          </div>
          <p class="onboard__note">Copy it from Prowlarr → indexer → Torznab feed.</p>
          {#if tests.ix}<span class="client-status {tests.ix.cls}">{#if tests.ix.icon}<Icon name={tests.ix.icon} /> {/if}{tests.ix.text}</span>{/if}
          <p class="onboard__sub">qBittorrent</p>
          <div class="onboard__row">
            <input class="dialog-input" type="text" spellcheck="false" placeholder="Host" bind:value={qbHost} />
            <input class="dialog-input" type="text" spellcheck="false" placeholder="Port" bind:value={qbPort} />
            <input class="dialog-input" type="text" spellcheck="false" placeholder="Username" bind:value={qbUser} />
            <input class="dialog-input" type="password" spellcheck="false" placeholder="Password" bind:value={qbPass} />
            <button class="btn btn--ghost btn--sm" type="button" disabled={!qbHost.trim()} onclick={testClient}>Test</button>
          </div>
          {#if tests.client}<span class="client-status {tests.client.cls}">{#if tests.client.icon}<Icon name={tests.client.icon} /> {/if}{tests.client.text}</span>{/if}
        {/if}
      {:else if step === 4}
        <h2 class="onboard__title">Add plugins</h2>
        <p class="onboard__text">BackIssue is modular — pick the plugins to install now. You can add or remove more anytime from the <b>Plugins</b> page. Selected plugins download and activate when you finish setup.</p>
        {#if !pluginsFetched}
          <p class="onboard__note">Loading catalog…</p>
        {:else if !catalogPlugins.length}
          <p class="onboard__note">No plugins available right now — you can add them later from the Plugins page.</p>
        {:else}
          <div class="onboard__plugins">
            {#each catalogPlugins as p (p.id)}
              <label class="onboard__plugin">
                <input type="checkbox" bind:checked={pluginSel[p.id]} />
                <span class="onboard__plugin-info">
                  <b>{p.name}</b>{#if p.version}<span class="onboard__plugin-ver">v{p.version}</span>{/if}
                  <span class="onboard__plugin-desc">{p.description}</span>
                </span>
              </label>
            {/each}
          </div>
        {/if}
      {:else}
        <h2 class="onboard__title">Ready to go</h2>
        <p class="onboard__text">
          {#if cvKeys.trim()}<Icon name="check" /> ComicVine key set{:else}· No ComicVine key yet (add one in Settings → Metadata){/if}<br />
          {#if rootFolders.trim()}<Icon name="check" /> Root folders set{:else}· No root folders yet (Settings → Library){/if}<br />
          {#if source === 'none'}· No download source yet (Settings → Download sources){:else}<Icon name="check" /> {source === 'usenet' ? 'Usenet' : 'Torrents'} configured{/if}
        </p>
        <p class="onboard__text">Next: add a series with <b>+ Add</b> (searches ComicVine), or pull in an existing library via <b>Import</b> in the sidebar.</p>
      {/if}

      <div class="onboard__foot">
        <button class="btn btn--ghost" onclick={skip}>Skip setup</button>
        <span class="modal__foot-spacer"></span>
        {#if step > 0}<button class="btn btn--ghost" onclick={() => { step -= 1; }}>Back</button>{/if}
        {#if step < STEPS.length - 1}
          <button class="btn btn--primary" onclick={() => { step += 1; }}>Next</button>
        {:else}
          <button class="btn btn--primary" disabled={saving} onclick={finish}>{installing ? 'Installing plugins…' : saving ? 'Saving…' : 'Finish setup'}</button>
        {/if}
      </div>
    </div>
  </div>
{/if}
