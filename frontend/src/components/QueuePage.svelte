<script>
  // The download queue as a FULL PAGE (was a slim drawer): stat strip, state
  // filters, and per-row failure reasons — same /api/queue data, same actions.
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
  let filter = $state('all'); // all | active | queued | failed

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

  /* ---- Stats + filters ---- */
  const ACTIVE_SET = new Set(['downloading', 'grabbed', 'tagging', 'done', 'sent', 'importing']);
  const items = $derived(q?.items || []);
  const packs = $derived(q?.packs || []);
  const counts = $derived.by(() => {
    const c = { all: items.length + packs.length, active: packs.length, queued: 0, failed: 0 };
    for (const it of items) {
      if (it.status === 'failed') c.failed++;
      else if (it.status === 'queued') c.queued++;
      else if (ACTIVE_SET.has(it.status)) c.active++;
    }
    return c;
  });
  const downSpeed = $derived.by(() => {
    let bps = 0;
    for (const it of items) bps += it.live?.bps || 0;
    for (const pk of packs) bps += pk.live?.bps || 0;
    return bps;
  });
  const FILTERS = [
    { key: 'all', label: 'All' },
    { key: 'active', label: 'Active' },
    { key: 'queued', label: 'Queued' },
    { key: 'failed', label: 'Failed' },
  ];
  const inFilter = (it) => filter === 'all'
    || (filter === 'failed' && it.status === 'failed')
    || (filter === 'queued' && it.status === 'queued')
    || (filter === 'active' && ACTIVE_SET.has(it.status));
  const visibleItems = $derived(items.filter(inFilter));
  const visiblePacks = $derived(filter === 'all' || filter === 'active' ? packs : []);
  const EMPTY = {
    all: { title: 'Queue is empty', body: 'New downloads appear here as you add series or issues. Active downloads keep running even while paused items wait.' },
    active: { title: 'Nothing downloading', body: 'No active downloads right now. Queued items start automatically as slots free up.' },
    queued: { title: 'Nothing queued', body: 'Everything queued has started or finished.' },
    failed: { title: 'No failures', body: 'Nothing has failed — every download completed or is still in progress.' },
  };

  // The row's cover cell shows the issue number when the title carries one.
  const rowNum = (it) => (String(it.title || '').match(/#\s*([\d.½-]+)/) || [])[1] || null;

  /* ---- Actions (same endpoints + gates as the old drawer) ---- */
  async function togglePause() {
    const cur = await apiGet('/api/queue');
    await apiPost(cur.paused ? '/api/queue/resume' : '/api/queue/pause');
    renderQueue();
  }
  async function clearQueued() {
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

{#snippet liveBar(live, rowStatus)}
  {#if live}
    {@const info = liveInfo(live)}
    {@const green = rowStatus === 'tagging' || rowStatus === 'done' || live.phase === 'tagging' || live.phase === 'done'}
    <div class="qx__live">
      <div class="qx__track">
        {#if info.indeterminate}
          <div class="qx__fill qx__fill--indet" class:qx__fill--green={green}></div>
        {:else}
          <div class="qx__fill" class:qx__fill--green={green} style="width:{info.pct}%"></div>
        {/if}
      </div>
      <span class="qx__livemeta">{#if info.torrent}<Icon name="arrow-up-down" size={13} /> {/if}<b>{info.label}</b>{info.meta ? ` · ${info.meta}` : ''}</span>
    </div>
  {/if}
{/snippet}

{#if active}
  <section id="queue-drawer" class="page qx">
    <!-- Header band -->
    <div class="qx__band qx__head">
      <h3 class="qx__title">Download queue</h3>
      {#if q?.paused}<span class="qx__paused"><Icon name="pause" size={13} /> Paused</span>{/if}
      {#if isTrusted()}
        <div class="qx__actions">
          <button id="queue-pause" class="qx__pausebtn" class:is-paused={q?.paused} onclick={togglePause}>
            <Icon name={q?.paused ? 'play' : 'pause'} size={14} /> {q?.paused ? 'Resume' : 'Pause'}</button>
          {#if status.counts.failed > 0}
            <button id="retry-failed" class="btn btn--ghost" onclick={retryFailed}><Icon name="refresh" size={14} /> Retry failed</button>
          {/if}
          <button id="queue-clear" class="btn btn--ghost" onclick={clearQueued}>Clear queued</button>
        </div>
      {/if}
    </div>

    <!-- Stat strip band -->
    <div class="qx__band qx__stats">
      <div class="qx__stat"><span class="qx__statchip qx__tone--cyan"><Icon name="zap" size={16} /></span>
        <div><div class="qx__statvalue">{fmt(counts.active)}</div><div class="qx__statlabel">Active</div></div></div>
      <div class="qx__stat"><span class="qx__statchip"><Icon name="clock" size={16} /></span>
        <div><div class="qx__statvalue">{fmt(counts.queued)}</div><div class="qx__statlabel">Queued</div></div></div>
      <div class="qx__stat"><span class="qx__statchip" class:qx__tone--red={counts.failed > 0}><Icon name="alert-triangle" size={16} /></span>
        <div><div class="qx__statvalue" class:qx__value--red={counts.failed > 0}>{fmt(counts.failed)}</div><div class="qx__statlabel">Failed</div></div></div>
      <div class="qx__stat"><span class="qx__statchip qx__tone--green"><Icon name="speed" size={16} /></span>
        <div><div class="qx__statvalue">{downSpeed ? humanBytes(downSpeed) + '/s' : '—'}</div><div class="qx__statlabel">Down speed</div></div></div>
    </div>

    <!-- Filter band -->
    <div class="qx__band qx__filters">
      {#each FILTERS as f (f.key)}
        {@const n = f.key === 'all' ? counts.all : counts[f.key]}
        <button class="qx__tab" class:is-active={filter === f.key} onclick={() => { filter = f.key; }}>
          {f.label}{#if n}<span class="qx__tabcount">{fmt(n)}</span>{/if}</button>
      {/each}
      {#if counts.failed > 0 && isTrusted()}
        <button id="clear-failed" class="qx__clearfailed" onclick={clearFailed}>Clear failed</button>
      {/if}
    </div>

    <!-- Scrolling list -->
    <div class="qx__scroll">
      <div class="qx__list">
        {#if q && !visibleItems.length && !visiblePacks.length}
          <div class="qx__empty">
            <span class="qx__emptychip"><Icon name="download" size={20} /></span>
            <b>{EMPTY[filter].title}</b>
            <p>{EMPTY[filter].body}</p>
          </div>
        {/if}
        <!-- Pack downloads first (0-day / per-series) — big, and easy to miss. -->
        {#each visiblePacks as pk (pk.id)}
          <div class="qx__row">
            <div class="qx__cover qx__cover--pack"><Icon name="package" size={17} /></div>
            <div class="qx__main">
              <div class="qx__toprow">
                <span class="qx__packbadge">Pack</span>
                <span class="qx__series" role="button" tabindex="0" style={pk.series_id ? '' : 'cursor:default'}
                  onclick={() => { if (pk.series_id) navigate('/volume/' + pk.series_id); }}
                  onkeydown={(e) => { if (e.key === 'Enter' && pk.series_id) navigate('/volume/' + pk.series_id); }}>{pk.series_title || 'Collection pack'}</span>
              </div>
              <div class="qx__release">{pk.title || ''}</div>
              {@render liveBar(pk.live ? { ...pk.live, source: pk.source } : null, 'downloading')}
            </div>
            <div class="qx__end">
              <Badge status={pk.live ? 'downloading' : 'sent'} />
              {#if can('downloads.grab')}
                <button class="qx__act" title="Cancel — removes the download from the client" onclick={() => cancelGrab(pk.id)}><Icon name="close" size={15} /></button>
              {/if}
            </div>
          </div>
        {/each}
        {#each visibleItems as it (it.id)}
          <div class="qx__row" class:qx__row--failed={it.status === 'failed'}>
            <div class="qx__cover">{#if rowNum(it)}<span class="qx__num">#{rowNum(it)}</span>{:else}<Icon name="download" size={16} />{/if}</div>
            <div class="qx__main">
              <div class="qx__toprow">
                <span class="qx__series" role="button" tabindex="0" style={it.series_id ? '' : 'cursor:default'}
                  onclick={() => { if (it.series_id) navigate('/volume/' + it.series_id); }}
                  onkeydown={(e) => { if (e.key === 'Enter' && it.series_id) navigate('/volume/' + it.series_id); }}>{it.series_title}</span>
              </div>
              <div class="qx__release">{it.title}</div>
              {#if it.status === 'failed' && it.error}
                <!-- The answer to "why did it fail?" belongs on the row itself. -->
                <div class="qx__err">{it.error}</div>
              {/if}
              {@render liveBar(it.live, it.status)}
            </div>
            <div class="qx__end">
              <Badge status={it.status} />
              {#if it.status === 'queued' && can('downloads.grab')}
                <button class="qx__act" title="Remove from queue" onclick={() => cancelQueued(it.id)}><Icon name="close" size={15} /></button>
              {:else if it.status === 'failed' && can('downloads.grab')}
                <button class="qx__act" title="Retry this download" onclick={() => retryOne(it.id)}><Icon name="refresh" size={15} /></button>
              {:else if it.grab_id && ['grabbed', 'downloading'].includes(it.status) && can('downloads.grab')}
                <!-- in-flight: cancel on the client too -->
                <button class="qx__act" title="Cancel — removes the download from the client" onclick={() => cancelGrab(it.grab_id)}><Icon name="close" size={15} /></button>
              {/if}
            </div>
          </div>
        {/each}
      </div>
    </div>
  </section>
{/if}
