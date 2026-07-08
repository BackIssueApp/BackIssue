<script>
  import Icon from '../lib/Icon.svelte';
  import { untrack } from 'svelte';
  import { goBack, route, setQuery } from '../lib/router.svelte.js';
  import { apiGet, apiPost } from '../lib/api.js';
  import { subscribe } from '../lib/events.svelte.js';
  import { notify } from '../lib/toasts.svelte.js';
  import { fmt } from '../lib/util.js';

  let { active = false } = $props();

  let filter = $state('all');
  let category = $state('all');
  let data = $state(null);
  let findText = $state(''); // free-text filter, client-side

  const shownLogs = $derived.by(() => {
    const logs = data?.logs || [];
    const q = findText.trim().toLowerCase();
    return q ? logs.filter((e) => `${e.message} ${e.category || ''}`.toLowerCase().includes(q)) : logs;
  });
  // Diagnosing yesterday's failure needs dates, not just times — insert a
  // separator row whenever the calendar day changes between entries.
  const dayOf = (ts) => new Date(ts).toDateString();

  async function renderLogs() {
    try { data = await apiGet(`/api/logs?level=${filter}&category=${encodeURIComponent(category)}`); } catch { /* keep last */ }
  }

  // Level + category live in the URL (?level=error&cat=download) — shareable.
  $effect(() => {
    if (!active) return;
    const p = new URLSearchParams(route.search);
    untrack(() => {
      filter = p.get('level') || 'all';
      category = p.get('cat') || 'all';
      renderLogs();
    });
    return subscribe('logs', renderLogs, 2000);
  });

  // Keep the category dropdown in sync with categories seen so far.
  const cats = $derived(data?.categories || []);
  $effect(() => { if (category !== 'all' && cats.length && !cats.includes(category)) setQuery({ cat: null }); });

  const counts = $derived(data?.counts || {});

  async function clearLogs() {
    const r = await apiPost('/api/logs/clear');
    if (r?.error) return notify(r.error, 'error');
    notify('Logs cleared.', 'ok');
    renderLogs();
  }
</script>

<main id="logs-page" class="scan-page logs-page">
  <div class="scan-page__bar">
    <button id="logs-back" class="btn btn--ghost" onclick={goBack}><Icon name="arrow-left" /> Back</button>
    <h2 class="scan-page__title">Logs</h2>
    <span id="logs-summary" class="scan-summary">{fmt(counts.error || 0)} errors · {fmt(counts.warn || 0)} warnings · {fmt(counts.info || 0)} info</span>
    <div class="filter" id="logs-filter">
      {#each [['all', 'All'], ['error', 'Errors'], ['warn', 'Warnings'], ['info', 'Info']] as [key, label] (key)}
        <button class="filter__btn" class:is-active={filter === key} onclick={() => setQuery({ level: key === 'all' ? null : key })}>{label}</button>
      {/each}
    </div>
    <select id="logs-category" class="logs-cat" value={category} onchange={(e) => setQuery({ cat: e.currentTarget.value === 'all' ? null : e.currentTarget.value })}>
      <option value="all">All categories</option>
      {#each cats as cat (cat)}<option value={cat}>{cat}</option>{/each}
    </select>
    <input type="search" class="issue-find" placeholder="filter…" title="Filter log messages" bind:value={findText} />
    <span class="settings-spacer"></span>
    <button id="logs-clear" class="btn btn--ghost" onclick={clearLogs}>Clear</button>
  </div>
  <div class="logs-scroll">
    <div id="logs-list" class="logs-list">
      {#if data && !data.logs.length}
        <div class="list-note">Nothing logged yet. Warnings and errors show up here as they happen.</div>
      {:else if data && !shownLogs.length}
        <div class="list-note">Nothing matches “{findText}”.</div>
      {/if}
      {#each shownLogs as e, i (i)}
        {#if i === 0 || dayOf(e.ts) !== dayOf(shownLogs[i - 1].ts)}
          <div class="log-day">{new Date(e.ts).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</div>
        {/if}
        <div class="log-row log--{e.level}">
          <span class="log-time">{new Date(e.ts).toLocaleTimeString()}</span>
          <span class="log-level">{e.level}</span>
          <span class="log-msg">{e.message}</span>
        </div>
      {/each}
    </div>
  </div>
</main>
