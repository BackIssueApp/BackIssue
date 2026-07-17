<script>
  // Plugin management: everything installed under plugins/, what each one
  // registered, and per-plugin enable/disable. State changes persist
  // immediately but apply on the next server restart (plugins register
  // routes/jobs/sources at boot and can't be hot-unloaded).
  import { navigate } from '../lib/router.svelte.js';
  import { apiGet, apiPost } from '../lib/api.js';
  import { notify } from '../lib/toasts.svelte.js';
  import Icon from '../lib/Icon.svelte';

  let { active = false } = $props();

  let plugins = $state([]);
  let restartRequired = $state(false);
  let loaded = $state(false);

  // Remote catalog of installable first-party plugins.
  let catalog = $state([]);
  let catalogError = $state('');
  let busy = $state({}); // plugin id → true while installing/removing

  let cat = $state('all'); // active category tab
  let q = $state('');       // search text

  async function refresh() {
    try {
      const r = await apiGet('/api/plugins');
      plugins = r.plugins || [];
      restartRequired = !!r.restartRequired;
      loaded = true;
    } catch { /* keep last */ }
  }

  async function loadCatalog() {
    try {
      const r = await apiGet('/api/plugins/catalog');
      catalog = r.plugins || [];
      catalogError = r.error ? String(r.error) : '';
    } catch {
      catalog = [];
      catalogError = 'Could not reach the plugin catalog.';
    }
  }

  $effect(() => { if (active) { refresh(); loadCatalog(); } });

  async function install(entry) {
    busy = { ...busy, [entry.id]: true };
    try {
      const r = await apiPost('/api/plugins/install', { id: entry.id });
      if (r.error) throw new Error(r.error);
      restartRequired = true;
      await refresh(); await loadCatalog();
      notify(`Installed ${entry.name} — restart BackIssue to activate it.`, 'ok');
    } catch (e) {
      notify('Install failed: ' + String(e.message || e), 'error');
    } finally {
      busy = { ...busy, [entry.id]: false };
    }
  }

  async function uninstall(entry) {
    busy = { ...busy, [entry.id]: true };
    try {
      const r = await apiPost('/api/plugins/uninstall', { id: entry.id });
      if (r.error) throw new Error(r.error);
      restartRequired = true;
      await refresh(); await loadCatalog();
      notify(`Removed ${entry.name} — restart BackIssue to finish.`, 'ok');
    } catch (e) {
      notify('Remove failed: ' + String(e.message || e), 'error');
    } finally {
      busy = { ...busy, [entry.id]: false };
    }
  }

  async function toggle(p) {
    const enabled = !p.enabled;
    try {
      const r = await apiPost(`/api/plugins/${encodeURIComponent(p.name)}/enabled`, { enabled });
      plugins = r.plugins || [];
      restartRequired = !!r.restartRequired;
      notify(`${p.name} ${enabled ? 'enabled' : 'disabled'} — restart BackIssue to apply.`, 'ok');
    } catch {
      notify('Could not update the plugin — is the app running?', 'error');
    }
  }

  // Capability summary → chips. Same label logic as before (COUNT_LABELS), one
  // pill per non-zero count, singular/plural, plus a per-capability icon.
  const CAP_META = {
    sources:  { icon: 'globe',    s: 'download source', p: 'download sources' },
    routes:   { icon: 'route',    s: 'API route',       p: 'API routes' },
    jobs:     { icon: 'clock',    s: 'job',             p: 'jobs' },
    assets:   { icon: 'panel',    label: 'UI' },
    settings: { icon: 'settings', s: 'settings section', p: 'settings sections' },
    startups: { icon: 'zap',      s: 'startup task',    p: 'startup tasks' },
  };
  function capsOf(p) {
    const out = [];
    for (const [key, meta] of Object.entries(CAP_META)) {
      const n = p.counts?.[key] || 0;
      if (!n) continue;
      out.push({ icon: meta.icon, label: key === 'assets' ? meta.label : `${n} ${n === 1 ? meta.s : meta.p}` });
    }
    return out;
  }

  const statusOf = (p) => p.error ? 'failed' : p.restartRequired ? 'restart' : p.loaded ? 'running' : 'disabled';
  const statusLabel = (p) => p.error ? 'failed'
    : p.restartRequired ? `restart to ${p.enabled ? 'enable' : 'disable'}`
    : p.loaded ? 'running' : 'disabled';

  // The catalog and manifests carry no category yet — respect an explicit
  // `category` if a plugin ever declares one, else infer from what it registers
  // and its name. Purely cosmetic (tab grouping + icon tint); a wrong guess only
  // changes which tab a card sits under.
  const CAT_META = {
    notifications: { label: 'Notifications',   icon: 'bell',   tone: 'var(--accent)' },
    sources:       { label: 'Download source', icon: 'globe',  tone: 'var(--cyan)' },
    metadata:      { label: 'Metadata',        icon: 'tag',    tone: 'var(--green)' },
    auth:          { label: 'Authentication',  icon: 'shield', tone: 'var(--amber)' },
    utility:       { label: 'Utility',         icon: 'tools',  tone: 'var(--muted)' },
  };
  function categoryOf(p) {
    if (p.category && CAT_META[p.category]) return p.category;
    const c = p.counts || {};
    const name = `${p.name || ''} ${p.id || ''} ${p.description || ''}`.toLowerCase();
    if (/\b(notif|discord|telegram|pushover|ntfy|webhook|alert)\b/.test(name)) return 'notifications';
    if (/\b(auth|oidc|sso|sign[- ]?in|login|openid|whmcs|ldap|saml)\b/.test(name)) return 'auth';
    if (c.sources) return 'sources';
    if (/\b(metadata|comic\s?vine|comicvine|gcd|metron|tagging|catalog)\b/.test(name)) return 'metadata';
    if (/\b(reader|opds|request|discover)\b/.test(name)) return 'utility';
    return 'utility';
  }

  const CATS = [
    { id: 'all', label: 'All', icon: 'grid' },
    { id: 'notifications', label: 'Notifications', icon: 'bell' },
    { id: 'sources', label: 'Sources', icon: 'globe' },
    { id: 'metadata', label: 'Metadata', icon: 'tag' },
    { id: 'auth', label: 'Auth', icon: 'shield' },
    { id: 'utility', label: 'Utility', icon: 'tools' },
  ];

  const ql = $derived(q.trim().toLowerCase());
  const matchCat = (x) => cat === 'all' || categoryOf(x) === cat;
  const matchQ = (x) => !ql || `${x.name} ${x.description || ''}`.toLowerCase().includes(ql);
  const flt = (x) => matchCat(x) && matchQ(x);

  // Category counts over the whole dataset (installed + not-yet-installed).
  const pool = $derived([...plugins, ...catalog.filter((c) => !c.installed)]);
  const catCount = (id) => id === 'all' ? pool.length : pool.filter((x) => categoryOf(x) === id).length;

  const installedVis = $derived(plugins.filter(flt));
  // Available lists only what ISN'T installed — an installed plugin lives in
  // the Installed section (its available-update, if any, surfaces there).
  const catalogVis = $derived(catalog.filter((c) => !c.installed).filter(flt));
  const isEmpty = $derived(loaded && !installedVis.length && !catalogVis.length);
  const nRunning = $derived(plugins.filter((p) => p.loaded).length);

  // Match an installed plugin to its catalog entry (by name) so an available
  // update can be offered right on the Installed card.
  const catalogByName = $derived(new Map(catalog.map((c) => [String(c.name).toLowerCase(), c])));
  const updateFor = (p) => { const c = catalogByName.get(String(p.name).toLowerCase()); return c?.updateAvailable ? c : null; };

  // Configure deep-links to the settings tab a plugin's category maps to (its
  // settings mount lives there) rather than dumping the user on the overview.
  const SETTINGS_TAB = { notifications: 'notifications', auth: 'signin', sources: 'sources', metadata: 'metadata', utility: 'library' };
  const settingsTabFor = (p) => SETTINGS_TAB[categoryOf(p)] || 'overview';

  // Restart the app and wait for it to come back, then re-read the catalog so
  // the restart banner and per-card chips settle.
  let restarting = $state(false);
  async function restartApp() {
    restarting = true;
    try { await apiPost('/api/restart'); } catch { /* the connection may drop mid-response — that's the restart */ }
    const deadline = Date.now() + 90_000;
    await new Promise((r) => setTimeout(r, 2500)); // let the old process die first
    while (Date.now() < deadline) {
      try {
        await apiGet('/api/status');
        await refresh();
        restarting = false;
        notify('BackIssue restarted — plugin changes are live.', 'ok');
        return;
      } catch { /* still coming up */ }
      await new Promise((r) => setTimeout(r, 1000));
    }
    restarting = false;
    notify('The app has not come back yet — check the server, then reload this page.', 'error');
  }
</script>

<main id="plugins-page" class="scan-page plugins-page plx">
  <!-- header -->
  <div class="plx__head">
    <h2 class="plx__title">Plugins</h2>
    <span class="plx__summary">{loaded ? `${plugins.length} installed · ${nRunning} running` : ''}</span>
    <div class="plx__search">
      <Icon name="search" size={16} />
      <input placeholder="Search plugins…" bind:value={q} spellcheck="false" />
    </div>
  </div>

  <!-- restart banner -->
  {#if restartRequired || restarting}
    <div class="plx__banner">
      <Icon name="alert-triangle" size={16} />
      <span class="plx__banner-text">{restarting ? 'Restarting BackIssue…' : 'Changes saved — restart BackIssue to apply them. Plugins register routes, jobs and sources at boot.'}</span>
      <button id="restart-app-btn" class="plx__banner-btn" disabled={restarting} onclick={restartApp}>
        <span class="plx__banner-ico" class:is-spin={restarting}><Icon name="refresh" size={14} /></span>{restarting ? 'Restarting…' : 'Restart now'}</button>
    </div>
  {/if}

  <!-- category tabs -->
  <div class="plx__tabs">
    {#each CATS as c (c.id)}
      {@const n = catCount(c.id)}
      <button class="plx__tab" class:is-active={cat === c.id} onclick={() => (cat = c.id)}>
        <Icon name={c.icon} size={15} />{c.label}{#if n}<span class="plx__tab-count">{n}</span>{/if}
      </button>
    {/each}
  </div>

  <!-- body -->
  <div class="plx__scroll">
    <div class="plx__inner">
      {#if isEmpty}
        <div class="plx__empty">
          <div class="plx__empty-art"><Icon name="puzzle" size={26} /></div>
          <div class="plx__empty-title">{ql || cat !== 'all' ? 'No matching plugins' : 'No plugins installed'}</div>
          <p class="plx__empty-body">{ql || cat !== 'all'
            ? 'Try a different category or search term.'
            : (catalogError || 'Install plugins from the catalog, or drop a folder with an index.js into plugins/ and restart.')}</p>
        </div>
      {/if}

      {#if installedVis.length}
        <div class="plx__section"><span class="plx__section-name">Installed</span><span class="plx__section-count">{installedVis.length} shown</span></div>
        <div class="plx__grid">
          {#each installedVis as p (p.name)}
            {@const cm = CAT_META[categoryOf(p)]}
            {@const st = statusOf(p)}
            {@const caps = capsOf(p)}
            {@const upd = updateFor(p)}
            <div class="plx__card" class:is-off={!p.enabled} class:is-failed={!!p.error}>
              <div class="plx__card-head">
                <div class="plx__ico" style="background:color-mix(in srgb, {cm.tone} 14%, transparent); color:{cm.tone};"><Icon name={cm.icon} size={20} /></div>
                <div class="plx__card-id">
                  <div class="plx__card-title"><span class="plx__name">{p.name}</span>{#if p.version}<span class="plx__ver">v{p.version}</span>{/if}</div>
                  <div class="plx__catlabel">{cm.label}</div>
                </div>
                <span class="plx__status plx__status--{st}"><span class="plx__dot"></span>{statusLabel(p)}</span>
              </div>
              {#if p.description}<p class="plx__desc">{p.description}</p>{/if}
              {#if p.error}<div class="plx__err">Load error: {p.error}</div>{/if}
              {#if caps.length && !p.error}
                <div class="plx__caps">
                  {#each caps as cap (cap.label)}
                    <span class="plx__cap"><Icon name={cap.icon} size={13} />{cap.label}</span>
                  {/each}
                </div>
              {/if}
              <div class="plx__card-foot">
                <label class="plx__toggle">
                  <span class="switch switch--sm"><input type="checkbox" checked={p.enabled} onchange={() => toggle(p)} /><span class="switch__track"></span></span>
                  <span class="plx__toggle-label">{p.enabled ? 'Enabled' : 'Disabled'}</span>
                </label>
                <div class="plx__foot-actions">
                  {#if upd}
                    <button class="plx__install plx__install--sm" disabled={busy[upd.id]} onclick={() => install(upd)}>{busy[upd.id] ? '…' : `Update → v${upd.version}`}</button>
                  {/if}
                  {#if p.counts?.settings && !p.error}
                    <button class="plx__configure" onclick={() => navigate('/settings?tab=' + settingsTabFor(p))}>Configure</button>
                  {/if}
                </div>
              </div>
            </div>
          {/each}
        </div>
      {/if}

      {#if catalogVis.length}
        <div class="plx__section plx__section--gap"><span class="plx__section-name">Available</span><span class="plx__section-count">{catalogVis.length} shown</span></div>
        {#if catalogError}<div class="plx__cat-note">{catalogError}</div>{/if}
        <div class="plx__grid">
          {#each catalogVis as c (c.id)}
            {@const cm = CAT_META[categoryOf(c)]}
            <div class="plx__card">
              <div class="plx__card-head">
                <div class="plx__ico" style="background:color-mix(in srgb, {cm.tone} 14%, transparent); color:{cm.tone};"><Icon name={cm.icon} size={20} /></div>
                <div class="plx__card-id">
                  <div class="plx__card-title">
                    <span class="plx__name">{c.name}</span>
                    {#if c.version}<span class="plx__ver">v{c.version}</span>{/if}
                    {#if c.updateAvailable}<span class="plx__badge plx__badge--update">Update</span>
                    {:else if c.installed}<span class="plx__badge plx__badge--installed">Installed</span>{/if}
                  </div>
                  <div class="plx__catlabel">{cm.label}</div>
                </div>
              </div>
              {#if c.description}<p class="plx__desc plx__desc--grow">{c.description}</p>{/if}
              <div class="plx__card-actions">
                {#if c.installed}
                  {#if c.updateAvailable}
                    <button class="plx__install" disabled={busy[c.id]} onclick={() => install(c)}>{busy[c.id] ? '…' : `Update → v${c.version}`}</button>
                  {/if}
                  <button class="plx__remove" disabled={busy[c.id]} onclick={() => uninstall(c)}>Remove</button>
                {:else}
                  <button class="plx__install" disabled={busy[c.id]} onclick={() => install(c)}>{busy[c.id] ? 'Installing…' : 'Install'}</button>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </div>
</main>

<style>
  .plx { min-width: 0; }
  .plx__head { display: flex; align-items: center; gap: 12px; padding: 12px 18px; border-bottom: 1px solid var(--line); flex: none; flex-wrap: wrap; }
  .plx__title { margin: 0; font-family: var(--font-display); font-size: 22px; letter-spacing: .03em; font-weight: 400; }
  .plx__summary { font-size: 12.5px; color: var(--faint); }
  .plx__search { margin-left: auto; position: relative; display: flex; align-items: center; color: var(--faint); }
  .plx__search :global(svg) { position: absolute; left: 11px; pointer-events: none; }
  .plx__search input { height: 36px; width: 230px; max-width: 46vw; padding: 0 12px 0 34px; background: var(--ink); border: 1px solid var(--line); border-radius: 8px; color: var(--text); font: 14px var(--font-body); }
  .plx__search input:focus { outline: none; border-color: var(--accent); }

  .plx__banner { display: flex; align-items: center; gap: 12px; padding: 12px 18px; background: rgba(255,194,75,.08); border-bottom: 1px solid rgba(255,194,75,.3); flex: none; flex-wrap: wrap; color: var(--amber); }
  .plx__banner-text { flex: 1; min-width: 180px; font-size: 13px; color: var(--text); }
  .plx__banner-btn { height: 34px; padding: 0 15px; border: none; background: var(--amber); color: var(--ink); border-radius: 8px; font: 600 12.5px var(--font-body); cursor: pointer; display: inline-flex; align-items: center; gap: 7px; }
  .plx__banner-btn:disabled { opacity: .8; cursor: default; }
  .plx__banner-ico { display: flex; }
  .plx__banner-ico.is-spin { animation: plx-spin .9s linear infinite; }
  @keyframes plx-spin { to { transform: rotate(360deg); } }

  .plx__tabs { display: flex; gap: 6px; padding: 11px 18px; border-bottom: 1px solid var(--line); overflow-x: auto; flex: none; scrollbar-width: none; }
  .plx__tabs::-webkit-scrollbar { display: none; }
  .plx__tab { display: flex; align-items: center; gap: 7px; height: 34px; padding: 0 13px; border-radius: 8px; border: 1px solid var(--line); background: transparent; color: var(--muted); font: 600 12.5px var(--font-body); cursor: pointer; white-space: nowrap; flex: none; }
  .plx__tab.is-active { background: var(--accent); border-color: var(--accent); color: #fff; }
  .plx__tab-count { font: 600 11px var(--font-mono); background: var(--panel-2); color: var(--faint); border-radius: 999px; padding: 1px 7px; }
  .plx__tab.is-active .plx__tab-count { background: rgba(255,255,255,.2); color: #fff; }

  .plx__scroll { flex: 1; overflow-y: auto; padding: 20px 18px 60px; }
  .plx__inner { max-width: 960px; margin: 0 auto; }

  .plx__section { display: flex; align-items: baseline; gap: 10px; margin: 4px 2px 12px; }
  .plx__section--gap { margin-top: 26px; }
  .plx__section-name { font-family: var(--font-display); font-size: 15px; letter-spacing: .04em; text-transform: uppercase; color: #c4bdd4; }
  .plx__section-count { font-size: 12px; color: var(--faint); }
  .plx__cat-note { font-size: 12.5px; color: var(--amber); background: rgba(255,194,75,.06); border: 1px solid rgba(255,194,75,.25); border-radius: 8px; padding: 10px 13px; margin-bottom: 12px; }

  .plx__grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  .plx__card { border: 1px solid var(--line); border-radius: 13px; background: rgba(255,255,255,.015); padding: 16px; display: flex; flex-direction: column; }
  .plx__card.is-off { opacity: .72; }
  .plx__card.is-failed { border-color: rgba(255,90,82,.3); }
  .plx__card-head { display: flex; align-items: flex-start; gap: 12px; }
  .plx__ico { width: 42px; height: 42px; border-radius: 11px; flex: none; display: grid; place-items: center; }
  .plx__card-id { flex: 1; min-width: 0; }
  .plx__card-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .plx__name { font-size: 14.5px; font-weight: 600; }
  .plx__ver { font: 500 11px var(--font-mono); color: var(--faint); }
  .plx__catlabel { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--faint); margin-top: 3px; }
  .plx__badge { font: 600 10px var(--font-body); text-transform: uppercase; letter-spacing: .04em; border-radius: 5px; padding: 2px 7px; }
  .plx__badge--update { color: var(--amber); border: 1px solid rgba(255,194,75,.4); }
  .plx__badge--installed { color: var(--green); border: 1px solid rgba(95,211,138,.4); }

  .plx__status { display: inline-flex; align-items: center; gap: 6px; flex: none; font: 600 10.5px var(--font-body); text-transform: uppercase; letter-spacing: .04em; border-radius: 6px; padding: 4px 9px; white-space: nowrap; }
  .plx__dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  .plx__status--running { color: var(--green); background: rgba(95,211,138,.1); border: 1px solid rgba(95,211,138,.3); }
  .plx__status--disabled { color: var(--muted); background: rgba(255,255,255,.04); border: 1px solid var(--line); }
  .plx__status--restart { color: var(--amber); background: rgba(255,194,75,.1); border: 1px solid rgba(255,194,75,.3); }
  .plx__status--failed { color: var(--red); background: rgba(255,90,82,.1); border: 1px solid rgba(255,90,82,.3); }

  .plx__desc { font-size: 12.5px; color: var(--muted); line-height: 1.5; margin: 12px 0 0; }
  .plx__desc--grow { flex: 1; }
  .plx__err { font-size: 12px; color: var(--red); margin-top: 10px; background: rgba(255,90,82,.08); border: 1px solid rgba(255,90,82,.22); border-radius: 7px; padding: 6px 10px; line-height: 1.45; }
  .plx__caps { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
  .plx__cap { display: inline-flex; align-items: center; gap: 5px; font: 500 11px var(--font-body); color: #c4bdd4; background: var(--panel-2); border-radius: 6px; padding: 4px 9px; }
  .plx__cap :global(svg) { color: var(--faint); }

  .plx__card-foot { display: flex; align-items: center; gap: 12px; margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--line); }
  .plx__toggle { display: flex; align-items: center; gap: 9px; cursor: pointer; }
  .plx__toggle-label { font-size: 12.5px; color: var(--muted); }
  .plx__foot-actions { margin-left: auto; display: flex; align-items: center; gap: 8px; }
  .plx__configure { height: 30px; padding: 0 12px; border: 1px solid var(--line); background: transparent; color: var(--muted); border-radius: 7px; font: 600 12px var(--font-body); cursor: pointer; }
  .plx__configure:hover { color: var(--text); border-color: var(--muted); }
  .plx__install--sm { height: 30px; padding: 0 12px; font-size: 12px; }

  .plx__card-actions { display: flex; align-items: center; gap: 8px; margin-top: 14px; }
  .plx__install { height: 34px; padding: 0 16px; border: none; background: var(--accent); color: #fff; border-radius: 8px; font: 600 12.5px var(--font-body); cursor: pointer; }
  .plx__install:disabled { opacity: .6; cursor: default; }
  .plx__remove { height: 34px; padding: 0 14px; border: 1px solid var(--line); background: transparent; color: var(--muted); border-radius: 8px; font: 600 12.5px var(--font-body); cursor: pointer; }
  .plx__remove:hover { color: var(--text); border-color: var(--muted); }

  .plx__empty { border: 1px solid var(--line); border-radius: 14px; background: rgba(255,255,255,.015); padding: 56px 24px; text-align: center; margin-top: 16px; }
  .plx__empty-art { width: 56px; height: 56px; margin: 0 auto 16px; border-radius: 15px; background: var(--panel-2); display: grid; place-items: center; color: var(--faint); }
  .plx__empty-title { font-size: 16px; font-weight: 600; margin-bottom: 6px; }
  .plx__empty-body { font-size: 13px; color: var(--faint); margin: 0 auto; max-width: 380px; line-height: 1.6; }

  @media (max-width: 760px) {
    .plx__grid { grid-template-columns: 1fr; }
    .plx__search { display: none; }
  }
</style>
