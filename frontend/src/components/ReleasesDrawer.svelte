<script>
  import { SvelteSet } from 'svelte/reactivity';
  import { navigate } from '../lib/router.svelte.js';
  import { apiGet, apiPost } from '../lib/api.js';
  import { pollInterval } from '../lib/poll.js';
  import { subscribe } from '../lib/events.svelte.js';
  import { loadCollection } from '../lib/store.svelte.js';
  import { notify } from '../lib/toasts.svelte.js';
  import { fmt, weekOfYear, shiftWeek } from '../lib/util.js';
  import Badge from './Badge.svelte';
  import { can, isTrusted } from '../lib/auth.svelte.js';
  import Icon from '../lib/Icon.svelte';

  let { active = false } = $props();

  let st = $state({ running: false });
  let filter = $state('all'); // 'all' | 'mine'
  let timer = null;

  // Releases queued from this drawer, keyed seriesId#number — shows a live
  // "queued" badge, and survives the ownership refetches below.
  const queued = new SvelteSet();
  const relKey = (m) => `${m.seriesId}#${m.number}`;

  async function pollReleases() {
    let next;
    try { next = await apiGet('/api/releases'); } catch { return; }
    st = next;
    if (!next.running) {
      stopPolling();
      if (!next.error) loadCollection();
    }
  }
  function startPolling() {
    stopPolling();
    timer = pollInterval(pollReleases, 900);
    pollReleases();
  }
  function stopPolling() { if (timer) { clearInterval(timer); timer = null; } }

  // Re-pull ownership when downloads land (status counts move on import) — a
  // release grabbed here flips queued → owned without a manual refresh.
  async function refreshOwnership() {
    if (st.running) return;
    let cur;
    try { cur = await apiGet('/api/releases'); } catch { return; }
    if (!cur.running && cur.releases) {
      st = cur;
      for (const m of cur.releases) if (m.owned) queued.delete(relKey(m));
    }
  }

  $effect(() => {
    if (!active) return;
    (async () => {
      let cur;
      try { cur = await apiGet('/api/releases'); } catch { cur = { running: true }; }
      if (!cur.running && !cur.releases) await apiPost('/api/releases/check'); // first open → run it
      st = cur.running || cur.releases ? cur : { running: true };
      startPolling();
    })();
    const un = subscribe('status', refreshOwnership);
    return () => { stopPolling(); un(); };
  });

  // Check a specific week (or the provider's default — this week — with no body).
  async function checkWeek(target) {
    await apiPost('/api/releases/check', target || {});
    st = { running: true };
    startPolling();
  }
  const refresh = () => checkWeek(st.week ? { week: st.week, year: st.year } : null);

  const nowWeek = $derived(weekOfYear(new Date()));
  const onThisWeek = $derived(!st.week || (st.week === nowWeek.week && st.year === nowWeek.year));
  function step(delta) {
    if (!st.week || st.running) return;
    const t = shiftWeek(st.week, st.year, delta);
    checkWeek(t);
  }

  const all = $derived(st.releases || []);
  const mineCount = $derived(all.filter((r) => r.tracked).length);
  const items = $derived(filter === 'mine' ? all.filter((r) => r.tracked) : all);
  const statusText = $derived.by(() => {
    if (st.running) return onThisWeek ? 'Checking this week…' : 'Checking…';
    if (st.error) return 'Error: ' + st.error;
    const when = st.checkedAt ? ' · checked ' + new Date(st.checkedAt).toLocaleString() : '';
    return st.week ? `Week ${st.week}, ${st.year} · ${fmt(all.length)} releases · ${fmt(mineCount)} in your collection${when}` : '';
  });

  async function downloadRelease(m) {
    const r = await apiPost('/api/releases/download', { seriesId: m.seriesId, number: m.number });
    if (r.error) { notify(r.error, 'error'); return false; }
    queued.add(relKey(m));
    notify(`Queued ${m.series} #${m.number}`, 'ok');
    return true;
  }

  async function addRelease(m) {
    m._adding = true;
    try {
      const r = await apiPost('/api/collection/add-cv', { comicvineId: m.cvId });
      if (r?.error) { notify('Add failed: ' + r.error, 'error'); m._adding = false; return; }
      m._added = true;
      loadCollection();
    } catch { notify('Add failed — is the app reachable?', 'error'); m._adding = false; }
  }
</script>

{#if active}
  <section id="releases-drawer" class="page">
    <div class="page__inner">
      <div class="page__head">
        <h3>{onThisWeek ? "This week's releases" : st.week ? `Releases — week ${st.week}, ${st.year}` : 'Releases'}</h3>
      </div>
      <div class="drawer__controls">
        <button class="btn btn--ghost btn--sm" title="Previous week" disabled={!st.week || st.running} onclick={() => step(-1)}><Icon name="chevron-left" /></button>
        <button class="btn btn--ghost btn--sm" title="Next week" disabled={!st.week || st.running} onclick={() => step(1)}><Icon name="chevron-right" /></button>
        {#if !onThisWeek}
          <button class="btn btn--ghost btn--sm" disabled={st.running} onclick={() => checkWeek(null)}>This week</button>
        {/if}
        <span id="releases-status" class="muted">{statusText}</span>
        <button id="releases-refresh" class="btn btn--ghost" onclick={refresh}>Refresh</button>
      </div>
      <div class="releases-filters" id="releases-filters">
        <button class="filter__btn" class:is-active={filter === 'all'} onclick={() => { filter = 'all'; }}>All</button>
        <button class="filter__btn" class:is-active={filter === 'mine'} onclick={() => { filter = 'mine'; }}>In collection</button>
      </div>
      <div id="releases-list" class="queue-list">
        {#if st.running}
          <!-- checking… -->
        {:else if st.error}
          <div class="queue-empty">Could not reach the release provider.</div>
        {:else if !items.length}
          <div class="queue-empty">{filter === 'mine' ? 'Nothing from your tracked series ships this week.' : 'No releases found for this week.'}</div>
        {:else}
          {#each items as m, i (i)}
            <div class="queue-item" class:release--tracked={m.tracked}
              style={m.tracked ? 'cursor:pointer' : ''}
              onclick={() => { if (m.tracked) navigate('/volume/' + m.seriesId); }} role="button" tabindex="0"
              onkeydown={(e) => { if (e.key === 'Enter' && m.tracked) navigate('/volume/' + m.seriesId); }}>
              <div class="queue-item__main">
                <div class="queue-item__series">{m.series} #{m.number ?? '?'}
                  {#if m.tracked}<span class="coll-badge coll-badge--cv" title="In your collection">tracked</span>{/if}</div>
                <div class="queue-item__title">{m.publisher || ''}{m.shipdate ? ' · ' + m.shipdate : ''}</div>
              </div>
              {#if m.tracked}
                <span>
                  {#if m.owned}<span class="badge badge--done"><span class="dot"></span>owned</span>
                  {:else if queued.has(relKey(m))}<Badge status="queued" />
                  {:else}<span class="badge badge--queued"><span class="dot"></span>missing</span>
                    {#if m.isNew}<span class="coll-badge coll-badge--cv">new</span>{/if}{/if}
                </span>
                {#if !m.owned && !queued.has(relKey(m)) && can('downloads.grab')}
                  <!-- Close the loop: download the missing release right here. -->
                  <button class="btn btn--ghost btn--sm" title="Download this issue" disabled={m._busy}
                    onclick={async (e) => { e.stopPropagation(); m._busy = true; if (!(await downloadRelease(m))) m._busy = false; }}><Icon name="download" /></button>
                {/if}
              {:else if m.cvId && isTrusted()}
                <button class="btn btn--ghost btn--sm" disabled={m._adding}
                  onclick={(e) => { e.stopPropagation(); addRelease(m); }}>{#if m._added}Added{:else if m._adding}Adding…{:else}<Icon name="plus" /> Add{/if}</button>
              {/if}
            </div>
          {/each}
        {/if}
      </div>
    </div>
  </section>
{/if}
