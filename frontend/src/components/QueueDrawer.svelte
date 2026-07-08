<script>
  import { navigate } from '../lib/router.svelte.js';
  import { apiGet, apiPost } from '../lib/api.js';
  import { subscribe } from '../lib/events.svelte.js';
  import { status } from '../lib/status.svelte.js';
  import { detail, refreshIssueStatuses } from '../lib/store.svelte.js';
  import { fmt, humanBytes } from '../lib/util.js';
  import Badge from './Badge.svelte';
  import { confirmDialog } from './DialogModal.svelte';
  import { notify } from '../lib/toasts.svelte.js';
  import { can, isTrusted } from '../lib/auth.svelte.js';
  import Icon from '../lib/Icon.svelte';

  let { active = false } = $props();

  let q = $state(null);

  async function renderQueue() {
    try { q = await apiGet('/api/queue'); } catch { /* keep last */ }
  }

  $effect(() => {
    if (!active) return;
    renderQueue();
    return subscribe('queue', renderQueue, 1000);
  });

  // Per-row live progress. Works for both immediate downloads (page/byte
  // stream, from state.queue.live) and deferred grabs (percent + seeders,
  // from the download monitor). Returns { pct, label, meta } for the bar.
  const PHASE = { searching: 'Searching', starting: 'Starting', grabbed: 'Sent', queued: 'Queued', downloading: 'Downloading', done: 'Importing', tagging: 'Tagging', saving: 'Saving' };
  // Phases with no measurable progress yet — show a label + a pulsing bar,
  // never a misleading "0%".
  const INDETERMINATE = new Set(['searching', 'starting', 'grabbed', 'queued']);
  function liveInfo(live) {
    const bytes = live.unit === 'bytes';
    const hasPages = (live.pages || 0) > 0;
    const pct = hasPages ? Math.round(((live.page || 0) / live.pages) * 100)
      : (live.progress != null ? Math.round(live.progress) : 0);
    const label = PHASE[live.phase] || (bytes ? 'Downloading' : 'Saving');
    const indeterminate = INDETERMINATE.has(live.phase) && !hasPages && live.progress == null;
    let meta = '';
    if (indeterminate) {
      meta = live.phase === 'searching' ? 'looking for a source…' : '';
    } else if (bytes) {
      const size = hasPages ? `${humanBytes(live.page || 0)} / ${humanBytes(live.pages)}` : humanBytes(live.page || 0);
      meta = size + (live.bps ? ` · ${humanBytes(live.bps)}/s` : '') + (hasPages ? ` · ${pct}%` : '');
    } else if (hasPages) {
      meta = `page ${fmt(live.page || 0)} / ${fmt(live.pages)}`;
    } else {
      meta = `${pct}%${(live.seeders != null && live.seeders >= 0) ? ` · ${fmt(live.seeders)} seeders` : ''}`;
    }
    return { pct, label, meta, indeterminate, torrent: live.source === 'torrent' };
  }

  async function togglePause() {
    const cur = await apiGet('/api/queue');
    await apiPost(cur.paused ? '/api/queue/resume' : '/api/queue/pause');
    renderQueue();
  }
  async function clearQueued() {
    // Empties the whole queue — same confirmation bar as cancelling one item.
    const n = status.counts.queued || 0;
    if (!(await confirmDialog({
      title: `Clear ${fmt(n)} queued download${n === 1 ? '' : 's'}?`,
      message: 'Everything waiting in the queue is removed. Active downloads keep going.',
      confirmLabel: 'Clear queue', danger: true,
    }))) return;
    const r = await apiPost('/api/queue/clear');
    if (r?.error) notify(r.error, 'error');
    else notify(`Cleared ${fmt(r?.cleared ?? n)} queued download(s).`, 'ok');
    renderQueue();
  }
  async function retryFailed() {
    const r = await apiPost('/api/retry-failed');
    if (r?.error) return notify(r.error, 'error');
    notify(`Retrying ${fmt(r?.requeued || 0)} failed download(s).`, 'ok');
    renderQueue();
    if (detail.series) refreshIssueStatuses();
  }
  async function clearFailed() {
    const r = await apiPost('/api/clear-failed');
    if (r?.error) return notify(r.error, 'error');
    notify(`Cleared ${fmt(r?.cleared || 0)} failed item(s).`, 'ok');
    renderQueue();
    if (detail.series) refreshIssueStatuses();
  }
  async function cancelGrab(grabId) {
    if (!(await confirmDialog({
      title: 'Cancel this download?',
      message: 'It is also removed from the download client.',
      confirmLabel: 'Cancel download', danger: true,
    }))) return;
    const r = await apiPost(`/api/grabs/${grabId}/cancel`);
    if (r?.error) return notify(r.error, 'error');
    notify('Download cancelled — removed from the client.', 'ok');
    renderQueue();
  }
  async function retryOne(id) {
    const r = await apiPost(`/api/queue/retry/${id}`);
    if (r?.error) notify(r.error, 'error');
    renderQueue();
    if (detail.series) refreshIssueStatuses();
  }
  async function cancelQueued(id) {
    await apiPost(`/api/queue/cancel/${id}`);
    renderQueue();
  }
</script>

{#snippet liveBar(live)}
  {#if live}
    {@const info = liveInfo(live)}
    <div class="queue-item__live">
      <div class="queue-item__track" class:is-indeterminate={info.indeterminate}>
        <div class="queue-item__fill" style="width:{info.indeterminate ? 100 : info.pct}%"></div>
      </div>
      <span class="queue-item__livemeta">{#if info.torrent}<Icon name="arrow-up-down" /> {/if}<b>{info.label}</b>{info.meta ? ` · ${info.meta}` : ''}</span>
    </div>
  {/if}
{/snippet}

{#if active}
  <section id="queue-drawer" class="page">
    <div class="page__inner">
      <div class="page__head">
        <h3>Download queue</h3>
      </div>
      {#if isTrusted()}
        <div class="drawer__controls">
          <button id="queue-pause" class="btn btn--ghost" onclick={togglePause}>{q?.paused ? 'Resume' : 'Pause'}</button>
          <button id="queue-clear" class="btn btn--ghost" onclick={clearQueued}>Clear queued</button>
          {#if status.counts.failed > 0}
            <button id="retry-failed" class="btn btn--ghost" onclick={retryFailed}>Retry failed ({fmt(status.counts.failed)})</button>
            <button id="clear-failed" class="btn btn--ghost" onclick={clearFailed}>Clear failed ({fmt(status.counts.failed)})</button>
          {/if}
        </div>
      {/if}
      <div id="queue-list" class="queue-list">
        {#if q && !q.items.length && !(q.packs || []).length}
          <div class="queue-empty">Queue is empty.</div>
        {/if}
        <!-- Pack downloads first (0-day / per-series) — big, and easy to miss. -->
        {#each q?.packs || [] as pk (pk.id)}
          <div class="queue-item queue-item--pack">
            <div class="queue-item__main">
              <div class="queue-item__series" style={pk.series_id ? 'cursor:pointer' : ''}
                onclick={() => { if (pk.series_id) navigate('/volume/' + pk.series_id); }} role="button" tabindex="0"
                onkeydown={(e) => { if (e.key === 'Enter' && pk.series_id) navigate('/volume/' + pk.series_id); }}><Icon name="package" /> {pk.series_title || 'Collection pack'}</div>
              <div class="queue-item__title">{pk.title || ''}</div>
              {@render liveBar(pk.live ? { ...pk.live, source: pk.source } : null)}
            </div>
            <span>
              {#if pk.live}<span class="badge badge--downloading"><span class="dot"></span>downloading</span>
              {:else}<span class="badge badge--queued"><span class="dot"></span>sent</span>{/if}
            </span>
            {#if can('downloads.grab')}
              <button class="queue-item__x" title="Cancel — removes the download from the client" onclick={() => cancelGrab(pk.id)}><Icon name="close" /></button>
            {/if}
          </div>
        {/each}
        {#each q?.items || [] as it (it.id)}
          <div class="queue-item">
            <div class="queue-item__main">
              <div class="queue-item__series" style={it.series_id ? 'cursor:pointer' : ''}
                onclick={() => { if (it.series_id) navigate('/volume/' + it.series_id); }} role="button" tabindex="0"
                onkeydown={(e) => { if (e.key === 'Enter' && it.series_id) navigate('/volume/' + it.series_id); }}>{it.series_title}</div>
              <div class="queue-item__title">{it.title}</div>
              {#if it.status === 'failed' && it.error}
                <!-- The answer to "why did it fail?" belongs on the row itself. -->
                <div class="queue-item__err">{it.error}</div>
              {/if}
              {@render liveBar(it.live)}
            </div>
            <Badge status={it.status} />
            {#if it.status === 'queued' && can('downloads.grab')}
              <button class="queue-item__x" title="Remove from queue" onclick={() => cancelQueued(it.id)}><Icon name="close" /></button>
            {:else if it.status === 'failed' && can('downloads.grab')}
              <button class="queue-item__x" title="Retry this download" onclick={() => retryOne(it.id)}><Icon name="refresh" /></button>
            {:else if it.grab_id && ['grabbed', 'downloading'].includes(it.status) && can('downloads.grab')}
              <!-- in-flight: cancel on the client too -->
              <button class="queue-item__x" title="Cancel — removes the download from the client" onclick={() => cancelGrab(it.grab_id)}><Icon name="close" /></button>
            {:else}
              <span></span>
            {/if}
          </div>
        {/each}
      </div>
    </div>
  </section>
{/if}
