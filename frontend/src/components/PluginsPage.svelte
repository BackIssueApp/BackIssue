<script>
  // Plugin management: everything installed under plugins/, what each one
  // registered, and per-plugin enable/disable. State changes persist
  // immediately but apply on the next server restart (plugins register
  // routes/jobs/sources at boot and can't be hot-unloaded).
  import { goBack } from '../lib/router.svelte.js';
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

  const COUNT_LABELS = [
    ['sources', 'download source'],
    ['routes', 'API route'],
    ['jobs', 'job'],
    ['assets', 'UI'],
    ['settings', 'settings section'],
    ['startups', 'startup task'],
  ];
  function summary(p) {
    const parts = [];
    for (const [key, label] of COUNT_LABELS) {
      const n = p.counts?.[key] || 0;
      if (!n) continue;
      parts.push(key === 'assets' ? label : `${n} ${label}${n === 1 ? '' : 's'}`);
    }
    return parts.join(' · ');
  }

  const statusOf = (p) => p.error ? 'failed' : p.restartRequired ? 'restart' : p.loaded ? 'running' : 'disabled';

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

<main id="plugins-page" class="scan-page plugins-page">
  <div class="scan-page__bar">
    <button id="plugins-back" class="btn btn--ghost" onclick={goBack}><Icon name="arrow-left" /> Back</button>
    <h2 class="scan-page__title">Plugins</h2>
    <span class="scan-summary muted">{loaded ? `${plugins.length} installed · ${plugins.filter((p) => p.loaded).length} running` : ''}</span>
  </div>

  <div class="plugins-scroll">
    {#if restartRequired || restarting}
      <div class="plugins-banner">
        <span>{restarting ? 'Restarting BackIssue…' : 'Changes saved — restart BackIssue to apply them.'}</span>
        <button id="restart-app-btn" class="btn btn--primary btn--sm" disabled={restarting} onclick={restartApp}>
          {#if restarting}Restarting…{:else}<Icon name="refresh" /> Restart now{/if}</button>
      </div>
    {/if}

    {#if loaded && !plugins.length && !catalog.length}
      <div class="empty">
        <div class="empty__art"><Icon name="puzzle" /></div>
        <div class="empty__title">No plugins installed</div>
        <div class="empty__text">{catalogError || 'Install plugins from the catalog below, or drop a folder with an index.js into plugins/ and restart.'}</div>
      </div>
    {/if}

    {#if plugins.length}<div class="plugins-section">Installed</div>{/if}
    {#each plugins as p (p.name)}
      <div class="plugin-card" class:is-off={!p.enabled} class:is-failed={!!p.error}>
        <div class="plugin-card__head">
          <span class="plugin-card__name">{p.name}</span>
          {#if p.version}<span class="plugin-card__ver">v{p.version}</span>{/if}
          <span class="plugin-status plugin-status--{statusOf(p)}">
            {#if p.error}failed{:else if p.restartRequired}restart to {p.enabled ? 'enable' : 'disable'}{:else if p.loaded}running{:else}disabled{/if}
          </span>
          <label class="switch switch--sm plugin-card__switch" title={p.enabled ? 'Disable (applies after restart)' : 'Enable (applies after restart)'}>
            <input type="checkbox" checked={p.enabled} onchange={() => toggle(p)} />
            <span class="switch__track"></span>
          </label>
        </div>
        {#if p.description}<div class="plugin-card__desc">{p.description}</div>{/if}
        {#if p.error}
          <div class="plugin-card__err">Load error: {p.error}</div>
        {:else if p.loaded && summary(p)}
          <div class="plugin-card__meta">{summary(p)}</div>
        {/if}
      </div>
    {/each}

    {#if catalog.length}
      <div class="plugins-section">Available plugins</div>
      {#each catalog as c (c.id)}
        <div class="plugin-card plugin-card--catalog">
          <div class="plugin-card__head">
            <span class="plugin-card__name">{c.name}</span>
            {#if c.version}<span class="plugin-card__ver">v{c.version}</span>{/if}
            {#if c.installed && !c.updateAvailable}<span class="plugin-status plugin-status--running">installed</span>{/if}
            {#if c.updateAvailable}<span class="plugin-status plugin-status--restart">update</span>{/if}
            <span class="plugin-card__spacer"></span>
            {#if c.installed}
              {#if c.updateAvailable}
                <button class="btn btn--primary btn--sm" disabled={busy[c.id]} onclick={() => install(c)}>{busy[c.id] ? '…' : `Update → v${c.version}`}</button>
              {/if}
              <button class="btn btn--ghost btn--sm" disabled={busy[c.id]} onclick={() => uninstall(c)}>Remove</button>
            {:else}
              <button class="btn btn--primary btn--sm" disabled={busy[c.id]} onclick={() => install(c)}>{busy[c.id] ? 'Installing…' : 'Install'}</button>
            {/if}
          </div>
          {#if c.description}<div class="plugin-card__desc">{c.description}</div>{/if}
        </div>
      {/each}
    {:else if catalogError && plugins.length}
      <div class="plugins-catalog__note muted">{catalogError}</div>
    {/if}
  </div>
</main>
