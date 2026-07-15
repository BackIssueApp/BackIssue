<script>
  import Icon from '../lib/Icon.svelte';
  import { untrack } from 'svelte';
  import { goBack, navigate, route, setQuery } from '../lib/router.svelte.js';
  import { apiGet, apiPost, apiDelete } from '../lib/api.js';
  import { subscribe } from '../lib/events.svelte.js';
  import { fmt } from '../lib/util.js';

  let { active = false } = $props();

  let filter = $state('all');
  let items = $state([]);
  let total = $state(0);
  let sources = $state([]);
  let loaded = $state(false);

  async function renderHistory({ append = false } = {}) {
    const offset = append ? items.length : 0;
    if (filter === 'failed') {
      // Failed downloads — durable (the queue clears; this record doesn't).
      let h;
      try { h = await apiGet(`/api/history/failed?limit=200&offset=${offset}`); } catch { return; }
      if (h.error) return;
      items = append ? items.concat(h.rows) : h.rows;
      total = h.total;
      loaded = true;
      return;
    }
    if (filter === 'blacklist') {
      // Blacklisted releases — failed usenet posts skipped on future searches.
      let h;
      try { h = await apiGet(`/api/blacklist?limit=200&offset=${offset}`); } catch { return; }
      if (h.error) return;
      items = append ? items.concat(h.rows) : h.rows;
      total = h.total;
      loaded = true;
      return;
    }
    const qs = `limit=200&offset=${offset}` + (filter !== 'all' ? `&source=${encodeURIComponent(filter)}` : '');
    let h;
    try { h = await apiGet('/api/history?' + qs); } catch { return; }
    if (h.error) return;
    items = append ? items.concat(h.items) : h.items;
    total = h.total;
    // Source filter chips — derived from the data, so any source (incl. plugins) shows.
    sources = h.sources || [];
    loaded = true;
  }

  // The source filter lives in the URL (?src=usenet) — shareable + Back/Forward.
  $effect(() => {
    if (!active) { items = []; loaded = false; return; }
    const p = new URLSearchParams(route.search);
    untrack(() => {
      filter = p.get('src') || 'all';
      renderHistory();
    });
    // imports landing move the status counts — refresh on that signal
    return subscribe('status', () => { if (items.length <= 200) renderHistory(); }, 3000);
  });

  const when = (ts) => new Date(Number(ts));

  // Un-blacklist one release — it becomes eligible for auto-grab again.
  async function removeBlacklisted(id) {
    try { await apiDelete('/api/blacklist/' + id); } catch { return; }
    items = items.filter((it) => it.id !== id);
    total = Math.max(0, total - 1);
  }
  async function clearBlacklist() {
    if (!items.length) return;
    try { await apiPost('/api/blacklist/clear', {}); } catch { return; }
    items = []; total = 0;
  }
</script>

<main id="history-page" class="scan-page history-page">
  <div class="scan-page__bar">
    <button id="history-back" class="btn btn--ghost" onclick={goBack}><Icon name="arrow-left" /> Back</button>
    <h2 class="scan-page__title">History</h2>
    <span id="history-summary" class="scan-summary">{fmt(total)} {filter === 'failed' ? 'failure' : filter === 'blacklist' ? 'blocked release' : 'import'}{total === 1 ? '' : 's'}</span>
    <div class="filter" id="history-filter">
      {#each ['all', ...sources] as s (s)}
        <button class="filter__btn" class:is-active={filter === s} onclick={() => setQuery({ src: s === 'all' ? null : s })}>{s === 'all' ? 'All' : s}</button>
      {/each}
      <button class="filter__btn" class:is-active={filter === 'failed'} onclick={() => setQuery({ src: 'failed' })}>Failed</button>
      <button class="filter__btn" class:is-active={filter === 'blacklist'} onclick={() => setQuery({ src: 'blacklist' })}>Blocklist</button>
    </div>
    {#if filter === 'blacklist' && items.length}
      <button id="blacklist-clear" class="btn btn--ghost btn--sm" onclick={clearBlacklist}>Clear all</button>
    {/if}
  </div>
  <div class="history-scroll">
    <div id="history-list" class="history-list">
      {#if loaded && !items.length}
        <div class="list-note">{filter === 'failed' ? 'No failed downloads on record.' : filter === 'blacklist' ? 'No blocked releases — failed usenet downloads land here so retries skip them.' : 'Nothing imported yet — this fills in as downloads land.'}</div>
      {/if}
      {#each items as it, i (it.id ?? i)}
        {@const ts = filter === 'failed' ? new Date(String(it.grabbed_at).replace(' ', 'T') + 'Z')
          : filter === 'blacklist' ? new Date(String(it.created_at).replace(' ', 'T') + 'Z') : when(it.ts)}
        <div class="hist-row" title={it.path || undefined}>
          <span class="hist-when" title={ts.toLocaleString()}>{ts.toLocaleDateString()} {ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
          <span class="hist-what">
            {#if it.series_id}
              <a class="stat-link" href={'/volume/' + it.series_id} onclick={(e) => { e.preventDefault(); navigate('/volume/' + it.series_id); }}>{it.series_title || it.title || '?'}</a>
            {:else}{it.series_title || it.title || it.title_norm || '?'}{/if}
            <span class="hist-num">{it.issue_number != null && it.issue_number !== '' ? ` #${it.issue_number}` : ''}</span>
            {#if filter === 'blacklist' && it.title && it.title !== it.series_title}<span class="scan-muted">{it.title}</span>{/if}
            {#if filter === 'failed' && it.error}<span class="queue-item__err">{it.error}</span>{/if}
            {#if filter === 'blacklist' && it.reason}<span class="queue-item__err">{it.reason}</span>{/if}</span>
          {#if filter === 'blacklist'}
            <button class="btn btn--ghost btn--sm" title="Remove from blocklist — allow auto-grab again" onclick={() => removeBlacklisted(it.id)}>Remove</button>
          {/if}
          <span class="hist-src hist-src--{it.source || 'unknown'}">{it.source || '?'}</span>
        </div>
      {/each}
      <button id="history-more" class="btn btn--ghost" hidden={items.length >= total} onclick={() => renderHistory({ append: true })}>Load more</button>
    </div>
  </div>
</main>
