<script>
  // Plugin management: everything installed under plugins/, what each one
  // registered, and per-plugin enable/disable. State changes persist
  // immediately but apply on the next server restart (plugins register
  // routes/jobs/sources at boot and can't be hot-unloaded).
  import { navigate } from '../lib/router.svelte.js';
  import { apiGet, apiGetOk, apiPost, errorText } from '../lib/api.js';
  import LoadError from './LoadError.svelte';
  import { notify } from '../lib/toasts.svelte.js';
  import { confirmDialog } from './DialogModal.svelte';
  import Icon from '../lib/Icon.svelte';
  import { hscroll } from '../lib/hscroll.js';
  import { t, th, currentLang, st as serverText } from '../lib/i18n.svelte.js';

  let { active = false } = $props();

  let plugins = $state([]);
  let restartRequired = $state(false);
  let pending = $state([]); // installs/updates/removes since boot, from the server — survives navigation and reloads
  let loaded = $state(false);

  // Remote catalog of installable download sites and first-party plugins.
  let catalog = $state([]);
  let catalogError = $state('');
  let busy = $state({}); // plugin id → true while installing/removing

  let cat = $state('all'); // active category tab
  let q = $state('');       // search text

  // The page shows one of two things: plugins, or the download sites the app
  // can install. Sites are their own world — installed into sources/, switched
  // on in Settings — so they get a view rather than a section in the list.
  let view = $state('plugins');          // 'plugins' | 'sources'
  let srcCatalog = $state([]);           // installable sites, from the catalog
  let srcCatalogError = $state('');
  let srcFilter = $state('all');         // all | comics | manga

  let loadError = $state('');
  async function refresh() {
    try {
      const r = await apiGetOk('/api/plugins');
      plugins = r.plugins || [];
      restartRequired = !!r.restartRequired;
      pending = r.pending || [];
      loaded = true;
      loadError = '';
      return true;
    } catch (e) { loadError = errorText(e); return false; } // keep the last good list
  }

  async function loadCatalog() {
    try {
      const r = await apiGet('/api/plugins/catalog');
      catalog = r.plugins || [];
      catalogError = r.error ? String(r.error) : '';
    } catch {
      catalog = [];
      catalogError = t('pluginsPage.catalogUnreachable');
    }
  }

  async function loadSourceCatalog() {
    try {
      const r = await apiGet('/api/sources/catalog');
      srcCatalog = r.sources || [];
      srcCatalogError = r.error ? String(r.error) : '';
    } catch {
      srcCatalog = [];
      srcCatalogError = t('pluginsPage.siteCatalogUnreachable');
    }
  }

  $effect(() => { if (active) { refresh(); loadCatalog(); loadSourceCatalog(); } });

  // ---- download sites ------------------------------------------------------
  // What is installed comes from the app (it loaded them); what is on offer
  // comes from the catalog. A site can be in either or both.
  const installedSites = $derived(plugins.filter((p) => p.kind === 'source'));
  const siteRows = $derived((() => {
    const byId = new Map();
    for (const p of installedSites) {
      byId.set(p.name, {
        id: p.name, name: p.name, description: p.description || '', version: p.version || null,
        installed: true, error: p.error || null, loaded: !!p.loaded,
        content: null, requires: null, updateAvailable: false, catalogVersion: null,
      });
    }
    for (const c of srcCatalog) {
      const row = byId.get(c.id) || { id: c.id, installed: false, error: null, loaded: false };
      byId.set(c.id, {
        ...row,
        name: c.name || row.name || c.id,
        description: c.description || row.description || '',
        version: row.version || c.version || null,
        content: c.content || null,
        requires: c.requires || null,
        catalogVersion: c.version || null,
        updateAvailable: !!c.updateAvailable,
      });
    }
    return [...byId.values()].sort((a, b) => Number(b.installed) - Number(a.installed) || a.name.localeCompare(b.name));
  })());
  const siteFilters = $derived([
    { id: 'all', label: t('pluginsPage.filterAll'), count: siteRows.length },
    { id: 'comics', label: t('pluginsPage.filterComics'), count: siteRows.filter((r) => r.content === 'comics').length },
    { id: 'manga', label: t('pluginsPage.filterManga'), count: siteRows.filter((r) => r.content === 'manga').length },
  ].filter((f) => f.id === 'all' || f.count));
  const sitesVis = $derived(siteRows
    .filter((r) => srcFilter === 'all' || r.content === srcFilter)
    .filter((r) => !ql || `${r.name} ${r.description}`.toLowerCase().includes(ql)));
  const sitesInstalled = $derived(sitesVis.filter((r) => r.installed));
  const sitesAvailable = $derived(sitesVis.filter((r) => !r.installed));
  const siteUpdates = $derived(siteRows.filter((r) => r.updateAvailable).length);

  async function installSite(row) {
    busy = { ...busy, [row.id]: true };
    try {
      const r = await apiPost('/api/sources/install', { id: row.id });
      if (r?.error) return notify(r.error, 'error');
      notify(t('pluginsPage.siteInstalled', { name: row.name }), 'ok');
      await refresh();
      await loadSourceCatalog();
    } catch (e) {
      notify(t('pluginsPage.siteInstallFailed', { name: row.name, error: String(e) }), 'error');
    } finally {
      busy = { ...busy, [row.id]: false };
    }
  }

  async function removeSite(row) {
    const ok = await confirmDialog({
      title: t('pluginsPage.removeSiteTitle', { name: row.name }),
      message: t('pluginsPage.removeSiteMessage'),
      confirmLabel: t('common.remove'),
      danger: true,
    });
    if (!ok) return;
    busy = { ...busy, [row.id]: true };
    try {
      const r = await apiPost('/api/sources/uninstall', { id: row.id });
      if (r?.error) return notify(r.error, 'error');
      notify(t('pluginsPage.siteRemoved', { name: row.name }), 'ok');
      await refresh();
      await loadSourceCatalog();
    } catch (e) {
      notify(t('pluginsPage.siteRemoveFailed', { name: row.name, error: String(e) }), 'error');
    } finally {
      busy = { ...busy, [row.id]: false };
    }
  }

  const configureSite = () => navigate('/settings?tab=sources');

  async function install(entry) {
    busy = { ...busy, [entry.id]: true };
    try {
      const r = await apiPost('/api/plugins/install', { id: entry.id });
      if (r.error) throw new Error(r.error);
      await refresh(); await loadCatalog();
      restartRequired = true; // the server agrees (it recorded the change), but never let a slow refresh hide the banner
      notify(r.updated
        ? t('pluginsPage.pluginUpdated', { name: entry.name, version: r.version || entry.version })
        : t('pluginsPage.pluginInstalled', { name: entry.name }), 'ok');
    } catch (e) {
      notify(t('pluginsPage.installFailed', { error: String(e.message || e) }), 'error');
    } finally {
      busy = { ...busy, [entry.id]: false };
    }
  }

  // Remove an INSTALLED plugin from its card. A plugin's on-disk folder name is
  // its uninstall id (that's also the enable/disable key), so `name` works for
  // catalog-installed and hand-dropped plugins alike. Deleting the folder is
  // destructive, so confirm first.
  async function removeInstalled(p) {
    if (!(await confirmDialog({
      title: t('pluginsPage.removePluginTitle', { name: p.name }),
      message: t('pluginsPage.removePluginMessage'),
      confirmLabel: t('common.remove'), danger: true,
    }))) return;
    await uninstall({ id: p.name, name: p.name });
  }

  async function uninstall(entry) {
    busy = { ...busy, [entry.id]: true };
    try {
      const r = await apiPost('/api/plugins/uninstall', { id: entry.id });
      if (r.error) throw new Error(r.error);
      await refresh(); await loadCatalog();
      restartRequired = true;
      notify(t('pluginsPage.pluginRemoved', { name: entry.name }), 'ok');
    } catch (e) {
      notify(t('pluginsPage.removeFailed', { error: String(e.message || e) }), 'error');
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
      notify(t(enabled ? 'pluginsPage.pluginEnabled' : 'pluginsPage.pluginDisabled', { name: p.name }), 'ok');
    } catch {
      notify(t('pluginsPage.toggleFailed'), 'error');
    }
  }

  // Capability summary → chips. One pill per non-zero count (plural forms from
  // the catalog), plus a per-capability icon.
  const CAP_META = {
    sources:  { icon: 'globe',    key: 'pluginsPage.capSources' },
    routes:   { icon: 'route',    key: 'pluginsPage.capRoutes' },
    jobs:     { icon: 'clock',    key: 'pluginsPage.capJobs' },
    assets:   { icon: 'panel',    key: 'pluginsPage.capUi', flat: true },
    settings: { icon: 'settings', key: 'pluginsPage.capSettings' },
    startups: { icon: 'zap',      key: 'pluginsPage.capStartups' },
  };
  function capsOf(p) {
    const out = [];
    for (const [key, meta] of Object.entries(CAP_META)) {
      const n = p.counts?.[key] || 0;
      if (!n) continue;
      out.push({ icon: meta.icon, label: meta.flat ? t(meta.key) : t(meta.key, { count: n }) });
    }
    return out;
  }

  // A plugin whose site is now installed from Download sites is not loaded at
  // all — it is not "disabled", it has been replaced, and saying so is what
  // tells someone it is safe to delete.
  const statusOf = (p) => p.error ? 'failed' : p.superseded ? 'superseded' : p.restartRequired ? 'restart' : p.loaded ? 'running' : 'disabled';
  const PENDING_LABEL = { installed: 'pluginsPage.statusRestartToActivate', updated: 'pluginsPage.statusRestartToUpdate', removed: 'pluginsPage.statusRestartToRemove' };
  const statusLabel = (p) => p.error ? t('pluginsPage.statusFailed')
    : p.superseded ? t('pluginsPage.statusReplaced')
    : p.pending ? t(PENDING_LABEL[p.pending] || 'pluginsPage.statusRestartRequired')
    : p.restartRequired ? t(p.enabled ? 'pluginsPage.statusRestartToEnable' : 'pluginsPage.statusRestartToDisable')
    : p.loaded ? t('pluginsPage.statusRunning') : t('pluginsPage.statusDisabled');

  // The banner names what is waiting: "Installed X 1.2.5, updated Y to 2.0 — restart to apply."
  const pendingText = $derived.by(() => {
    const parts = pending.map((c) => c.action === 'installed'
      ? (c.version ? t('pluginsPage.pendingInstalledVersion', { name: c.name, version: c.version }) : t('pluginsPage.pendingInstalled', { name: c.name }))
      : c.action === 'updated'
        ? (c.version ? t('pluginsPage.pendingUpdatedTo', { name: c.name, version: c.version }) : t('pluginsPage.pendingUpdated', { name: c.name }))
        : t('pluginsPage.pendingRemoved', { name: c.name }));
    if (!parts.length) return t('pluginsPage.pendingNone');
    const list = parts[0].charAt(0).toLocaleUpperCase(currentLang()) + parts[0].slice(1) + (parts.length > 1 ? ', ' + parts.slice(1).join(', ') : '');
    return t('pluginsPage.pendingList', { list });
  });

  // The catalog and manifests carry no category yet — respect an explicit
  // `category` if a plugin ever declares one, else infer from what it registers
  // and its name. Purely cosmetic (tab grouping + icon tint); a wrong guess only
  // changes which tab a card sits under.
  const CAT_META = {
    notifications: { key: 'pluginsPage.catNotifications', icon: 'bell',   tone: 'var(--accent)' },
    sources:       { key: 'pluginsPage.catSources',       icon: 'globe',  tone: 'var(--cyan)' },
    metadata:      { key: 'pluginsPage.catMetadata',      icon: 'tag',    tone: 'var(--green)' },
    auth:          { key: 'pluginsPage.catAuth',          icon: 'shield', tone: 'var(--amber)' },
    utility:       { key: 'pluginsPage.catUtility',       icon: 'tools',  tone: 'var(--muted)' },
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
    { id: 'all', key: 'pluginsPage.tabAll', icon: 'grid' },
    { id: 'notifications', key: 'pluginsPage.tabNotifications', icon: 'bell' },
    { id: 'sources', key: 'pluginsPage.tabSources', icon: 'globe' },
    { id: 'metadata', key: 'pluginsPage.tabMetadata', icon: 'tag' },
    { id: 'auth', key: 'pluginsPage.tabAuth', icon: 'shield' },
    { id: 'utility', key: 'pluginsPage.tabUtility', icon: 'tools' },
  ];

  const ql = $derived(q.trim().toLowerCase());
  const matchCat = (x) => cat === 'all' || categoryOf(x) === cat;
  const matchQ = (x) => !ql || `${x.name} ${x.description || ''}`.toLowerCase().includes(ql);
  const flt = (x) => matchCat(x) && matchQ(x);

  // Category counts over the whole dataset (installed + not-yet-installed).
  const pool = $derived([...plugins.filter((p) => p.kind !== 'source'), ...catalog.filter((c) => !c.installed)]);
  const catCount = (id) => id === 'all' ? pool.length : pool.filter((x) => categoryOf(x) === id).length;

  // Download sites live in sources/, maintained together rather than one
  // plugin each, so they get their own section instead of crowding the list.
  const bundledSources = $derived(plugins.filter((p) => p.kind === 'source'));
  const sourcesVis = $derived(bundledSources.filter(matchQ));
  const installedVis = $derived(plugins.filter((p) => p.kind !== 'source').filter(flt));
  // Available lists only what ISN'T installed — an installed plugin lives in
  // the Installed section (its available-update, if any, surfaces there).
  const catalogVis = $derived(catalog.filter((c) => !c.installed).filter(flt));
  const isEmpty = $derived(loaded && !installedVis.length && !catalogVis.length && !sourcesVis.length);
  const nRunning = $derived(plugins.filter((p) => p.kind !== 'source' && p.loaded).length);

  // Match an installed plugin to its catalog entry (by name) so an available
  // update can be offered right on the Installed card.
  // Match by the folder id, not the display name: an installed plugin's `name`
  // IS its folder id, which the catalog exposes as `id` (its `name` is the
  // human label and usually differs), so keying on `id` is what lines them up.
  const catalogById = $derived(new Map(catalog.map((c) => [String(c.id).toLowerCase(), c])));
  const updateFor = (p) => { const c = catalogById.get(String(p.name).toLowerCase()); return c?.updateAvailable ? c : null; };

  // Every installed plugin with a newer catalog version, for Update all.
  // Updates run one at a time (each one rewrites the plugins folder) and a
  // failure doesn't stop the rest; like a single update, they apply on restart.
  const pluginUpdates = $derived(plugins.filter((p) => p.kind !== 'source' && !p.superseded).map(updateFor).filter(Boolean));
  let updatingAll = $state(null); // { done, count } while Update all runs
  async function updateAll() {
    const list = pluginUpdates;
    const failed = [];
    updatingAll = { done: 0, count: list.length };
    for (const c of list) {
      busy = { ...busy, [c.id]: true };
      try {
        const r = await apiPost('/api/plugins/install', { id: c.id });
        if (r.error) throw new Error(r.error);
      } catch (e) {
        failed.push(`${c.name}: ${e.message || e}`);
      } finally {
        busy = { ...busy, [c.id]: false };
        updatingAll = { done: updatingAll.done + 1, count: list.length };
      }
    }
    await refresh(); await loadCatalog();
    if (failed.length < list.length) restartRequired = true;
    updatingAll = null;
    if (failed.length) notify(t('pluginsPage.updateAllFailed', { errors: failed.join('; ') }), 'error');
    else notify(t('pluginsPage.updateAllDone', { count: list.length }), 'ok');
  }

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
      // Behind a reverse proxy a restarting app answers 502 (an HTML page),
      // not a dropped connection: only a real status payload means it's back.
      try {
        const s = await apiGetOk('/api/status');
        if (s?.version && (await refresh())) {
          restarting = false;
          notify(t('pluginsPage.restarted'), 'ok');
          return;
        }
      } catch { /* still coming up */ }
      await new Promise((r) => setTimeout(r, 1000));
    }
    restarting = false;
    notify(t('pluginsPage.restartTimeout'), 'error');
  }
</script>

<main id="plugins-page" class="scan-page plugins-page plx">
  <!-- header -->
  <div class="plx__head">
    <h2 class="plx__title">{t('pluginsPage.title')}</h2>
    <span class="plx__summary">{loaded ? (view === 'sources'
      ? t('pluginsPage.sitesInstalledCount', { count: sitesInstalled.length })
      : t('pluginsPage.pluginsSummary', { installed: installedVis.length + (plugins.length - installedVis.length - installedSites.length), running: nRunning })) : ''}</span>
    <div class="plx__views">
      <button class="plx__view" class:is-active={view === 'plugins'} onclick={() => (view = 'plugins')}>
        <Icon name="puzzle" size={15} />{t('pluginsPage.viewPlugins')}
      </button>
      <button class="plx__view" class:is-active={view === 'sources'} onclick={() => (view = 'sources')}>
        <Icon name="download" size={15} />{t('pluginsPage.viewSites')}
        {#if siteUpdates}<span class="plx__view-badge">{siteUpdates}</span>{/if}
      </button>
    </div>
    <div class="plx__search">
      <Icon name="search" size={16} />
      <input placeholder={view === 'sources' ? t('pluginsPage.searchSites') : t('pluginsPage.searchPlugins')} bind:value={q} spellcheck="false" />
    </div>
  </div>

  <!-- restart banner -->
  {#if restartRequired || restarting}
    <div class="plx__banner">
      <Icon name="alert-triangle" size={16} />
      <span class="plx__banner-text">{restarting ? t('pluginsPage.restarting') : pendingText}</span>
      <button id="restart-app-btn" class="plx__banner-btn" disabled={restarting} onclick={restartApp}>
        <span class="plx__banner-ico" class:is-spin={restarting}><Icon name="refresh" size={14} /></span>{restarting ? t('pluginsPage.restartingShort') : t('pluginsPage.restartNow')}</button>
    </div>
  {/if}

  <!-- category tabs (plugins) / content filters (sites) -->
  {#if view === 'sources'}
    <div class="plx__tabs" use:hscroll>
      {#each siteFilters as f (f.id)}
        <button class="plx__tab" class:is-active={srcFilter === f.id} onclick={() => (srcFilter = f.id)}>
          <Icon name={f.id === 'comics' ? 'book' : f.id === 'manga' ? 'book-open' : 'download'} size={15} />{f.label}
          {#if f.count}<span class="plx__tab-count">{f.count}</span>{/if}
        </button>
      {/each}
    </div>
  {:else}
  <div class="plx__tabs" use:hscroll>
    {#each CATS as c (c.id)}
      {@const n = catCount(c.id)}
      <button class="plx__tab" class:is-active={cat === c.id} onclick={() => (cat = c.id)}>
        <Icon name={c.icon} size={15} />{t(c.key)}{#if n}<span class="plx__tab-count">{n}</span>{/if}
      </button>
    {/each}
  </div>
  {/if}

  <!-- body -->
  <div class="plx__scroll">
    <div class="plx__inner">
      {#if loadError}
        <LoadError compact={loaded} error={loadError} onretry={refresh} />
      {/if}
      {#if isEmpty}
        <div class="plx__empty">
          <div class="plx__empty-art"><Icon name="puzzle" size={26} /></div>
          <div class="plx__empty-title">{ql || cat !== 'all' ? t('pluginsPage.noMatchingPlugins') : t('pluginsPage.noPluginsInstalled')}</div>
          <p class="plx__empty-body">{ql || cat !== 'all'
            ? t('pluginsPage.tryDifferent')
            : (catalogError || t('pluginsPage.installHint'))}</p>
        </div>
      {/if}

      {#if view === 'sources'}
        {#if srcCatalogError}
          <div class="plx__note"><Icon name="alert-triangle" size={14} /> {srcCatalogError}</div>
        {/if}
        {#if !sitesVis.length}
          <div class="plx__empty">
            <div class="plx__empty-art"><Icon name="download" size={26} /></div>
            <div class="plx__empty-title">{ql || srcFilter !== 'all' ? t('pluginsPage.noMatchingSites') : t('pluginsPage.noSitesYet')}</div>
            <p class="plx__empty-note">{@html th('pluginsPage.sitesHint')}</p>
          </div>
        {/if}

        {#each [{ key: 'installed', label: t('pluginsPage.sectionInstalled'), rows: sitesInstalled }, { key: 'available', label: t('pluginsPage.sectionAvailable'), rows: sitesAvailable }] as group (group.key)}
          {#if group.rows.length}
            <div class="plx__section">
              <span class="plx__section-name">{group.label}</span>
              <span class="plx__section-count">{group.rows.length}</span>
            </div>
            <div class="plx__sites">
              {#each group.rows as sRow (sRow.id)}
                <div class="plx__site" class:is-failed={!!sRow.error}>
                  <div class="plx__site-ico"><Icon name="download" size={18} /></div>
                  <div class="plx__site-main">
                    <div class="plx__site-title">
                      <span class="plx__name">{sRow.name}</span>
                      {#if sRow.version}<span class="plx__ver">v{sRow.version}</span>{/if}
                      {#if sRow.content}<span class="plx__site-tag">{sRow.content}</span>{/if}
                      {#if sRow.updateAvailable}<span class="plx__site-upd">{t('pluginsPage.updateTo', { version: sRow.catalogVersion })}</span>{/if}
                    </div>
                    {#if sRow.description}<p class="plx__desc">{serverText('plugins', sRow.description)}</p>{/if}
                    {#if sRow.requires === 'flaresolverr'}
                      <p class="plx__site-note"><Icon name="alert-triangle" size={13} /> {t('pluginsPage.needsFlaresolverr')}</p>
                    {:else if sRow.requires === 'browser'}
                      <p class="plx__site-note"><Icon name="alert-triangle" size={13} /> {t('pluginsPage.needsBrowser')}</p>
                    {/if}
                    {#if sRow.error}<div class="plx__err">{t('pluginsPage.loadError', { error: sRow.error })}</div>{/if}
                  </div>
                  <div class="plx__site-actions">
                    {#if sRow.installed}
                      <button class="plx__btn" onclick={configureSite}>{t('pluginsPage.configure')}</button>
                      {#if sRow.updateAvailable}
                        <button class="plx__btn plx__btn--go" disabled={!!busy[sRow.id]} onclick={() => installSite(sRow)}>
                          {busy[sRow.id] ? t('pluginsPage.updating') : t('pluginsPage.update')}
                        </button>
                      {/if}
                      <button class="plx__btn plx__btn--danger" disabled={!!busy[sRow.id]} onclick={() => removeSite(sRow)}>
                        {busy[sRow.id] ? t('pluginsPage.removing') : t('common.remove')}
                      </button>
                    {:else}
                      <button class="plx__btn plx__btn--go" disabled={!!busy[sRow.id]} onclick={() => installSite(sRow)}>
                        {busy[sRow.id] ? t('pluginsPage.installing') : t('pluginsPage.install')}
                      </button>
                    {/if}
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        {/each}
      {/if}

      {#if view === 'plugins'}
      {#if installedVis.length}
        <div class="plx__section"><span class="plx__section-name">{t('pluginsPage.sectionInstalled')}</span><span class="plx__section-count">{t('pluginsPage.shownCount', { count: installedVis.length })}</span>
          {#if pluginUpdates.length || updatingAll}
            <button id="plugins-update-all" class="plx__install plx__install--sm plx__section-action" disabled={!!updatingAll} onclick={updateAll}>{updatingAll
              ? t('pluginsPage.updatingAll', { done: updatingAll.done, count: updatingAll.count })
              : t('pluginsPage.updateAll', { count: pluginUpdates.length })}</button>
          {/if}
        </div>
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
                  <div class="plx__catlabel">{t(cm.key)}</div>
                </div>
                <span class="plx__status plx__status--{st}"><span class="plx__dot"></span>{statusLabel(p)}</span>
              </div>
              {#if p.description}<p class="plx__desc">{serverText('plugins', p.description)}</p>{/if}
              {#if p.superseded}
                <div class="plx__note plx__note--card">{t('pluginsPage.superseded')}</div>
              {/if}
              {#if p.error}<div class="plx__err">{t('pluginsPage.loadError', { error: p.error })}</div>{/if}
              {#if caps.length && !p.error}
                <div class="plx__caps">
                  {#each caps as cap (cap.label)}
                    <span class="plx__cap"><Icon name={cap.icon} size={13} />{cap.label}</span>
                  {/each}
                </div>
              {/if}
              <div class="plx__card-foot">
                {#if !p.superseded}
                <label class="plx__toggle">
                  <span class="switch switch--sm"><input type="checkbox" checked={p.enabled} onchange={() => toggle(p)} /><span class="switch__track"></span></span>
                  <span class="plx__toggle-label">{p.enabled ? t('common.enabled') : t('common.disabled')}</span>
                </label>
                {/if}
                <div class="plx__foot-actions">
                  {#if !p.superseded}
                    {#if upd}
                      <button class="plx__install plx__install--sm" disabled={busy[upd.id] || !!updatingAll} onclick={() => install(upd)}>{busy[upd.id] ? '…' : t('pluginsPage.updateArrow', { version: upd.version })}</button>
                    {/if}
                    {#if p.counts?.settings && !p.error}
                      <button class="plx__configure" onclick={() => navigate('/settings?tab=' + settingsTabFor(p))}>{t('pluginsPage.configure')}</button>
                    {/if}
                  {/if}
                  <button class="plx__uninstall" disabled={busy[p.name]} onclick={() => removeInstalled(p)}>{busy[p.name] ? t('pluginsPage.removing') : t('common.remove')}</button>
                </div>
              </div>
            </div>
          {/each}
        </div>
      {/if}

      {#if catalogVis.length}
        <div class="plx__section plx__section--gap"><span class="plx__section-name">{t('pluginsPage.sectionAvailable')}</span><span class="plx__section-count">{t('pluginsPage.shownCount', { count: catalogVis.length })}</span></div>
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
                    {#if c.updateAvailable}<span class="plx__badge plx__badge--update">{t('pluginsPage.badgeUpdate')}</span>
                    {:else if c.installed}<span class="plx__badge plx__badge--installed">{t('pluginsPage.badgeInstalled')}</span>{/if}
                  </div>
                  <div class="plx__catlabel">{t(cm.key)}</div>
                </div>
              </div>
              {#if c.description}<p class="plx__desc plx__desc--grow">{serverText('plugins', c.description)}</p>{/if}
              <div class="plx__card-actions">
                {#if c.installed}
                  {#if c.updateAvailable}
                    <button class="plx__install" disabled={busy[c.id]} onclick={() => install(c)}>{busy[c.id] ? '…' : t('pluginsPage.updateArrow', { version: c.version })}</button>
                  {/if}
                  <button class="plx__remove" disabled={busy[c.id]} onclick={() => uninstall(c)}>{t('common.remove')}</button>
                {:else}
                  <button class="plx__install" disabled={busy[c.id]} onclick={() => install(c)}>{busy[c.id] ? t('pluginsPage.installing') : t('pluginsPage.install')}</button>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      {/if}
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

  /* The view switch: plugins, or the sites the app downloads from. */
  .plx__views { display: flex; gap: 4px; padding: 3px; border: 1px solid var(--line); border-radius: 10px; background: var(--panel-2); }
  .plx__view { display: inline-flex; align-items: center; gap: 7px; padding: 7px 12px; border: none; border-radius: 8px;
    background: transparent; color: var(--muted); font: 600 12.5px var(--font-body); cursor: pointer; white-space: nowrap; }
  .plx__view:hover { color: var(--text); }
  .plx__view.is-active { background: var(--accent); color: #fff; }
  .plx__view-badge { min-width: 18px; padding: 1px 5px; border-radius: 999px; background: var(--amber, #d9a441); color: #1a1520;
    font: 700 11px var(--font-mono); text-align: center; }

  /* A download site reads as a row: what it is on the left, what you can do on
     the right. Rows suit a list that grows to dozens better than cards do. */
  .plx__sites { display: flex; flex-direction: column; gap: 8px; margin-bottom: 20px; }
  .plx__site { display: flex; align-items: flex-start; gap: 12px; padding: 13px 14px; border: 1px solid var(--line);
    border-radius: 12px; background: var(--panel); }
  .plx__site.is-failed { border-color: color-mix(in srgb, var(--red, #e5484d) 45%, var(--line)); }
  .plx__site-ico { display: grid; place-items: center; width: 34px; height: 34px; flex: none; border-radius: 9px;
    background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent); }
  .plx__site-main { flex: 1; min-width: 0; }
  .plx__site-title { display: flex; align-items: baseline; flex-wrap: wrap; gap: 8px; }
  .plx__site-tag { padding: 1px 7px; border-radius: 999px; background: var(--panel-2); color: var(--muted);
    font: 600 10.5px var(--font-body); text-transform: uppercase; letter-spacing: .04em; }
  .plx__site-upd { padding: 1px 7px; border-radius: 999px; background: color-mix(in srgb, var(--amber, #d9a441) 20%, transparent);
    color: var(--amber, #d9a441); font: 600 11px var(--font-body); }
  .plx__site-note { display: flex; align-items: center; gap: 6px; margin: 6px 0 0; font-size: 12px; color: var(--muted); }
  .plx__site-actions { display: flex; align-items: center; gap: 8px; flex: none; }
  .plx__btn { padding: 7px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel-2);
    color: var(--text); font: 600 12.5px var(--font-body); cursor: pointer; }
  .plx__btn:hover:not(:disabled) { border-color: var(--accent); }
  .plx__btn:disabled { opacity: .55; cursor: default; }
  .plx__btn--go { background: var(--accent); border-color: var(--accent); color: #fff; }
  .plx__btn--danger:hover:not(:disabled) { border-color: var(--red, #e5484d); color: var(--red, #e5484d); }
  .plx__note--card { display: block; margin: 8px 0 0; padding: 9px 11px; font-size: 12.5px; }
  .plx__status--superseded { color: var(--muted); }
  .plx__status--superseded .plx__dot { background: var(--muted); }
  .plx__note { display: flex; align-items: center; gap: 8px; margin: 0 2px 14px; padding: 10px 12px; border-radius: 10px;
    border: 1px solid color-mix(in srgb, var(--amber, #d9a441) 40%, var(--line));
    background: color-mix(in srgb, var(--amber, #d9a441) 10%, transparent); color: var(--text); font-size: 12.5px; }
  .plx__empty-note { margin: 6px 0 0; max-width: 52ch; font-size: 12.5px; color: var(--muted); }

  .plx__section { display: flex; align-items: baseline; gap: 10px; margin: 4px 2px 12px; }
  .plx__sectionnote { margin: -6px 2px 12px; font-size: 12.5px; color: var(--muted); max-width: 70ch; }
  .plx__cfg { font: 600 12.5px var(--font-body); color: var(--accent); text-decoration: none; }
  .plx__cfg:hover { text-decoration: underline; }
  .plx__section--gap { margin-top: 26px; }
  .plx__section-name { font-family: var(--font-display); font-size: 15px; letter-spacing: .04em; text-transform: uppercase; color: #c4bdd4; }
  .plx__section-count { font-size: 12px; color: var(--faint); }
  .plx__section-action { margin-left: auto; align-self: center; }
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
  .plx__uninstall { height: 30px; padding: 0 12px; border: 1px solid var(--line); background: transparent; color: var(--muted); border-radius: 7px; font: 600 12px var(--font-body); cursor: pointer; }
  .plx__uninstall:hover:not(:disabled) { color: var(--red); border-color: color-mix(in srgb, var(--red) 45%, var(--line)); }
  .plx__uninstall:disabled { opacity: .6; cursor: default; }

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
    .plx__site { flex-wrap: wrap; }
    .plx__site-actions { width: 100%; justify-content: flex-end; }
    .plx__views { width: 100%; }
    .plx__view { flex: 1; justify-content: center; }
    .plx__search { display: none; }
  }
</style>
