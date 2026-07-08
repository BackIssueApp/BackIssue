<script>
  import { untrack } from 'svelte';
  import { goBack, navigate, route, setQuery } from '../lib/router.svelte.js';
  import { apiGet, apiPost } from '../lib/api.js';
  import { subscribe } from '../lib/events.svelte.js';
  import { notify } from '../lib/toasts.svelte.js';
  import { fmt } from '../lib/util.js';
  import { rail } from '../lib/store.svelte.js';
  import Badge from './Badge.svelte';
  import { confirmDialog } from './DialogModal.svelte';
  import { can } from '../lib/auth.svelte.js';
  import Icon from '../lib/Icon.svelte';

  let { active = false } = $props();

  let followed = $state(false);
  let hideUnreleased = $state(false);
  let q = $state('');
  let items = $state([]);
  let total = $state(0);
  let loaded = $state(false);

  async function renderWanted({ append = false } = {}) {
    const offset = append ? items.length : 0;
    const qs = `limit=200&offset=${offset}` + (followed ? '&followed=1' : '') + (hideUnreleased ? '&hideUnreleased=1' : '') + (q ? `&q=${encodeURIComponent(q)}` : '');
    let w;
    try { w = await apiGet('/api/wanted?' + qs); } catch { return; }
    items = append ? items.concat(w.items) : w.items;
    total = w.total;
    loaded = true;
  }

  // Filters live in the URL (?wf=followed&hide=1&find=…) so views are
  // shareable and Back/Forward restore them. The URL is the source of truth:
  // handlers only patch the query; this effect syncs state + refetches.
  $effect(() => {
    if (!active) { items = []; loaded = false; return; }
    const p = new URLSearchParams(route.search);
    untrack(() => {
      followed = p.get('wf') === 'followed';
      hideUnreleased = p.get('hide') === '1';
      if (q !== (p.get('find') || '')) q = p.get('find') || '';
      renderWanted();
    });
    // refresh in place (status counts move when downloads land) unless the
    // user has paged deeper
    return subscribe('status', () => { if (items.length <= 200) renderWanted(); }, 4000);
  });

  let searchTimer;
  function onSearchInput() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => setQuery({ find: q.trim() || null }), 300);
  }

  // Queue everything matching the CURRENT filters (server-capped at 500/pass).
  async function downloadAll() {
    const n = Math.min(total, 500);
    if (!n) return notify('Nothing to download.', 'info');
    if (!(await confirmDialog({
      title: `Queue ${n} issue(s) for download?`,
      message: 'Everything matching the current filters is queued.' + (total > 500 ? ' Capped at 500 per pass — run it again for the rest.' : ''),
      confirmLabel: 'Queue downloads',
    }))) return;
    const r = await apiPost('/api/wanted/download-all', { followed, hideUnreleased, q });
    if (r?.error) return notify(r.error, 'error');
    notify(`Queued ${fmt(r.queued || 0)} issue(s).`, 'ok');
    renderWanted();
  }

  const IN_FLIGHT = ['queued', 'downloading', 'grabbed', 'tagging'];
  async function download(it) {
    it._busy = true;
    await apiPost(`/api/collection/${it.series_id}/download`, { cvIssueIds: [it.cv_issue_id] });
    it.queue_status = 'queued';
    it._busy = false;
  }
</script>

<main id="wanted-page" class="scan-page wanted-page">
  <div class="scan-page__bar">
    <button id="wanted-back" class="btn btn--ghost" onclick={goBack}><Icon name="arrow-left" /> Back</button>
    <h2 class="scan-page__title">Wanted</h2>
    <span id="wanted-summary" class="scan-summary">{fmt(total)} missing issue{total === 1 ? '' : 's'}</span>
    <div class="filter" id="wanted-filter">
      <button class="filter__btn" class:is-active={!followed} onclick={() => setQuery({ wf: null })}>All</button>
      <button class="filter__btn" class:is-active={followed} onclick={() => setQuery({ wf: 'followed' })}>Followed only</button>
      <button class="filter__btn" id="wanted-unreleased" class:is-active={hideUnreleased}
        title="Hides issues whose known cover date is in the future (most cached issues have no date — this only hides what we know)"
        onclick={() => setQuery({ hide: hideUnreleased ? null : '1' })}>Hide unreleased</button>
    </div>
    <input id="wanted-search" type="search" spellcheck="false" placeholder="Filter series…" class="wanted-search" bind:value={q} oninput={onSearchInput} />
    {#if can('downloads.grab')}
      <button id="wanted-dl-all" class="btn btn--ghost" onclick={downloadAll}><Icon name="download" /> Download shown</button>
    {/if}
  </div>
  <div class="wanted-scroll">
    <div id="wanted-list" class="wanted-list">
      {#if loaded && !items.length}
        {#if rail.loaded && !rail.rows.length}
          <!-- An empty library isn't "complete" — teach the first step instead. -->
          <div class="list-note">Nothing tracked yet — add a series from the
            <a class="stat-link" href="/" onclick={(e) => { e.preventDefault(); navigate('/'); }}>Library</a> and its missing issues show up here.</div>
        {:else}
          <div class="list-note">Nothing missing — the collection is complete. 🎉</div>
        {/if}
      {/if}
      {#each items as it, idx (it.cv_issue_id ?? idx)}
        <!-- Group visually by series: show the title row once per run of issues. -->
        {#if idx === 0 || it.series_id !== items[idx - 1].series_id}
          <div class="wanted-series">
            {#if it.series_cover}<img class="wanted-cover" src={it.series_cover} loading="lazy" alt="" />{/if}
            <a class="stat-link" onclick={(e) => { e.preventDefault(); navigate('/volume/' + it.series_id); }} href={'/volume/' + it.series_id}>{it.series_title}</a>
            {#if it.followed}<span class="wanted-star" title="Followed"><Icon name="star" fill /></span>{/if}
          </div>
        {/if}
        <div class="wanted-row">
          <span class="wanted-issue">#{it.issue_number ?? '?'}<span class="hist-num">{it.issue_name ? ` — ${it.issue_name}` : ''}</span></span>
          {#if it.queue_status && IN_FLIGHT.includes(it.queue_status)}
            <Badge status={it.queue_status} />
          {:else if it._busy}
            <button class="btn btn--ghost btn--sm" disabled>Queuing…</button>
          {:else if can('downloads.grab')}
            <button class="btn btn--ghost btn--sm" onclick={() => download(it)}>{#if it.queue_status === 'failed'}<Icon name="refresh" /> Retry{:else}<Icon name="download" /> Download{/if}</button>
          {/if}
        </div>
      {/each}
      <button id="wanted-more" class="btn btn--ghost" hidden={items.length >= total} onclick={() => renderWanted({ append: true })}>Load more</button>
    </div>
  </div>
</main>
