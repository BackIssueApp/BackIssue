<script>
  // The Library: a poster wall of every volume (grid), or a dense table
  // (list) for power flows. Replaces the old side rail as the main '/' view.
  import { navigate, route, setQuery } from '../lib/router.svelte.js';
  import { rail, railSelect, ops, loadCollection } from '../lib/store.svelte.js';
  import { apiPost } from '../lib/api.js';
  import { notify } from '../lib/toasts.svelte.js';
  import { fmt, humanBytes, windowRange } from '../lib/util.js';
  import Cover from './Cover.svelte';
  import { openAddModal } from './AddModal.svelte';
  import { confirmDialog } from './DialogModal.svelte';
  import { isTrusted } from '../lib/auth.svelte.js';
  import Icon from '../lib/Icon.svelte';

  const FILTERS = [
    { key: 'all', label: 'All' },
    { key: 'incomplete', label: 'Incomplete' },
    { key: 'unmonitored', label: 'Not followed' },
    { key: 'problems', label: 'Problems' },
    { key: 'unmatched', label: 'Unmatched' },
  ];

  // Grid ⊞ / list ≣ — a device preference, not a URL one.
  let view = $state(localStorage.getItem('libraryView') || 'grid');
  function setView(v) { view = v; localStorage.setItem('libraryView', v); }

  function libQuery(filter) {
    const p = new URLSearchParams(route.search);
    if (filter && filter !== 'all') p.set('filter', filter); else p.delete('filter');
    const s = p.toString();
    return s ? '?' + s : '';
  }

  // Carry the library's params (filter/search/sort) onto a volume link so
  // opening a series keeps the active filter when you come Back.
  function libParams() {
    const cur = new URLSearchParams(route.search);
    const p = new URLSearchParams();
    for (const k of ['filter', 'q', 'sort']) { const v = cur.get(k); if (v) p.set(k, v); }
    const s = p.toString();
    return s ? '?' + s : '';
  }

  function pickFilter(key) {
    navigate(location.pathname + libQuery(key), { replace: true });
  }

  function open(s) {
    if (!rail.selecting) return navigate('/volume/' + s.id + libParams());
    if (railSelect.has(s.id)) railSelect.delete(s.id); else railSelect.add(s.id);
  }

  async function toggleMon(s) {
    const monitored = !s.followed;
    s.followed = monitored ? 1 : 0; // optimistic
    const r = await apiPost('/api/collection/' + s.id + '/monitor', { monitored });
    if (r?.error) { s.followed = monitored ? 0 : 1; notify(r.error, 'error'); }
  }

  function toggleSelecting() {
    rail.selecting = !rail.selecting;
    railSelect.clear();
  }

  async function bulk(action) {
    if (!railSelect.size) return notify('Select some series first.', 'info');
    if (action === 'remove' && !(await confirmDialog({
      title: `Remove ${railSelect.size} series?`,
      message: 'They are removed from the collection — their files stay on disk.',
      confirmLabel: 'Remove', danger: true,
    }))) return;
    if (action === 'download-missing' && !(await confirmDialog({
      title: `Download missing issues of ${railSelect.size} series?`,
      message: 'Every missing issue is queued for download.',
      confirmLabel: 'Queue downloads',
    }))) return;
    const r = await apiPost('/api/collection/bulk', { ids: [...railSelect], action });
    if (r.error) return notify(r.error, 'error');
    notify(action === 'download-missing' ? `Queued ${fmt(r.queued)} issue(s).` : `Done — ${fmt(r.done)} series.`, 'ok');
    railSelect.clear();
    loadCollection();
  }

  // --- ComicVine matching (bulk) --- busy state + progress mirror the
  // server's op state (ops store, fed by SSE).
  const cvBusy = $derived(!!ops.cv.running);
  const cvText = $derived(ops.cv.running
    ? fmt(ops.cv.done || 0) + (ops.cv.total ? '/' + fmt(ops.cv.total) : '') + (ops.cv.matched != null ? ' (' + fmt(ops.cv.matched) + ' matched)' : '')
    : 'Match ComicVine');
  let cvTitle = $state('Match owned & followed series to ComicVine');
  async function startCvMatch() {
    if (ops.cv.running) return;
    ops.cv = { running: true, done: 0, total: 0 }; // optimistic until the next SSE tick
    await apiPost('/api/cv/match', {});
  }
  let sawCv = false;
  $effect(() => {
    const st = ops.cv;
    if (st.running) { sawCv = true; return; }
    if (!sawCv) return;
    sawCv = false;
    if (st.error) notify('ComicVine match error: ' + st.error, 'error');
    else if (st.matched != null) {
      cvTitle = st.matched + ' matched, ' + (st.ambiguous || 0) + ' need a manual pick';
      notify(st.matched + ' matched' + (st.ambiguous ? ' — ' + st.ambiguous + ' need a manual pick (see the Unmatched filter)' : '.'), 'ok');
    }
    loadCollection();
  });

  const pct = (s) => (s.total ? Math.min(100, Math.round((s.owned / s.total) * 100)) : 0);

  /* ---- Virtualized posters & rows ----
     Same windowing as the volume page (see SeriesDetail): a big library must
     not render a card per series. Above the threshold, only the rows in view
     (+overscan) mount; spacers keep the scrollbar honest. */
  const VIRTUAL_MIN = 200;
  let scroller = $state(null);   // .librarypage__scroll
  let scrollTop = $state(0);
  let viewH = $state(800);
  let stride = $state(260);      // row height incl. gap, measured
  let cols = $state(1);          // posters per row (1 in list view), measured

  const virtual = $derived(rail.rows.length > VIRTUAL_MIN);
  const range = $derived.by(() => {
    const n = rail.rows.length;
    if (!virtual) return { start: 0, end: n, padTop: 0, padBottom: 0 };
    return windowRange({ n, cols: view === 'grid' ? cols : 1, stride, viewH, scrollTop, listTop: 0, overscan: 6 });
  });

  let raf = 0;
  function onScroll() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; if (scroller) scrollTop = scroller.scrollTop; });
  }
  function measure() {
    if (!scroller) return;
    viewH = scroller.clientHeight || viewH;
    const items = scroller.querySelectorAll(view === 'grid' ? '.poster' : '.series-row');
    if (items.length >= 2) {
      const top0 = items[0].offsetTop;
      let c = 1;
      while (c < items.length && items[c].offsetTop === top0) c++;
      cols = Math.max(1, c);
      const next = items[c] || items[1];
      const d = next.offsetTop - top0;
      if (d > 10) stride = d;
    }
  }
  $effect(() => { void rail.rows; void view; measure(); });
  $effect(() => {
    if (typeof window === 'undefined') return;
    const onResize = () => measure();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  });
  // Filter/search/sort changes swap the row set — snap back to the top.
  $effect(() => {
    void rail.filter; void rail.search; void rail.sort;
    if (scroller && scroller.scrollTop > 0) { scroller.scrollTop = 0; scrollTop = 0; }
  });
</script>

<section class="librarypage">
  <div class="librarypage__bar">
    <span class="librarypage__count">Library <span id="series-count">{rail.loaded ? fmt(rail.rows.length) : ''}</span></span>
    <div class="coll-filters">
      {#each FILTERS as f (f.key)}
        <button class="coll-chip" class:is-active={rail.filter === f.key} onclick={() => pickFilter(f.key)}>{f.label}</button>
      {/each}
    </div>
    <select id="coll-sort" class="coll-sort" title="Sort the collection" value={rail.sort}
      onchange={(e) => setQuery({ sort: e.currentTarget.value === 'title' ? null : e.currentTarget.value })}>
      <option value="title">A–Z</option>
      <option value="added">Recently added</option>
      <option value="missing">Most missing</option>
    </select>
    <div class="viewtoggle" role="group" aria-label="View">
      <button class="viewtoggle__btn" class:is-active={view === 'grid'} title="Poster grid" onclick={() => setView('grid')}><Icon name="grid" /></button>
      <button class="viewtoggle__btn" class:is-active={view === 'list'} title="List" onclick={() => setView('list')}><Icon name="list" /></button>
    </div>
    <span class="librarypage__actions">
      {#if isTrusted()}
        <button id="coll-select-btn" class="btn btn--ghost btn--sm" class:is-active={rail.selecting} title="Select multiple series for bulk actions" onclick={toggleSelecting}><Icon name="check-square" /> Select</button>
        <button id="cvmatch-btn" class="btn btn--ghost btn--sm" title={cvTitle} disabled={cvBusy} onclick={startCvMatch}><Icon name="diamond" /> {cvText}</button>
        <button id="add-series-btn" class="btn btn--primary btn--sm" onclick={() => openAddModal()}><Icon name="plus" /> Add</button>
      {/if}
    </span>
  </div>

  {#if rail.selecting}
    <div id="coll-bulkbar" class="coll-bulkbar">
      <span id="coll-bulk-count" class="muted">{railSelect.size} selected</span>
      <button class="link-btn" onclick={() => bulk('follow')}><Icon name="star" fill /> Follow</button>
      <button class="link-btn" onclick={() => bulk('unfollow')}><Icon name="star" /> Unfollow</button>
      <button class="link-btn" onclick={() => bulk('download-missing')}><Icon name="download" /> Missing</button>
      <button class="link-btn" onclick={() => bulk('remove')}>Remove</button>
    </div>
  {/if}

  <div class="librarypage__scroll" id="series-list" bind:this={scroller} onscroll={onScroll}>
    {#if rail.loaded && !rail.rows.length}
      <div class="empty">
        <div class="empty__art"><Icon name="star" /></div>
        <div class="empty__title">{rail.search ? 'No matches' : 'Nothing here yet'}</div>
        <div class="empty__text">{rail.search ? 'Try a different search or filter.'
          : isTrusted() ? 'Click "+ Add" to add a series from ComicVine, or Import an existing library.'
          : 'Nothing here yet — a trusted user or admin can add series to the library.'}</div>
      </div>
    {:else if view === 'grid'}
      <div class="poster-grid">
        {#if range.padTop > 0}<div class="poster-grid__pad" style="height:{range.padTop}px"></div>{/if}
        {#each rail.rows.slice(range.start, range.end) as s (s.id)}
          <div class="poster" class:is-selected={rail.selecting && railSelect.has(s.id)}
            onclick={() => open(s)} role="button" tabindex="0"
            onkeydown={(e) => { if (e.key === 'Enter') open(s); }}>
            <div class="poster__art">
              <Cover coverUrl={s.matched ? s.cover_url : null} title={s.matched ? s.title : (s.folder || '?')} />
              {#if rail.selecting}
                <span class="poster__check" class:is-on={railSelect.has(s.id)}></span>
              {/if}
              {#if s.followed}<span class="poster__star" title="Followed"><Icon name="star" fill /></span>{/if}
              {#if s.matched}
                <div class="poster__bar"><div class="poster__fill" class:is-done={s.total > 0 && s.missing === 0} style="width:{pct(s)}%"></div></div>
              {/if}
            </div>
            {#if s.matched}
              <div class="poster__title" title={s.title}>{s.title}{#if s.year}<span class="poster__year"> ({s.year})</span>{/if}</div>
              <div class="poster__meta">
                <span class="poster__count">{s.owned}/{s.total}</span>
                {#if s.corrupt > 0}<span class="poster__flag poster__flag--bad" title="{fmt(s.corrupt)} corrupt file(s)">!</span>{/if}
                {#if !s.sourced}<span class="poster__flag" title="No download source yet"><Icon name="no-source" /></span>{/if}
              </div>
            {:else}
              <div class="poster__title poster__title--unmatched" title={s.folder}>{s.folder || 'Unidentified series'}</div>
              <div class="poster__meta"><span class="poster__flag poster__flag--warn" title="Needs a ComicVine match">match…</span>
                {#if s.files}<span class="poster__count">{fmt(s.files)} files</span>{/if}</div>
            {/if}
          </div>
        {/each}
        {#if range.padBottom > 0}<div class="poster-grid__pad" style="height:{range.padBottom}px"></div>{/if}
      </div>
    {:else}
      <div class="series-list">
        <div class="series-head">
          <span></span><span>Title</span><span class="series-col--wide">Progress</span>
          <span class="series-col--wide">Latest issue</span><span class="series-col--wide">Size</span><span></span>
        </div>
        {#if range.padTop > 0}<div style="height:{range.padTop}px"></div>{/if}
        {#each rail.rows.slice(range.start, range.end) as s (s.id)}
          <div class="series-row"
            class:is-selected={rail.selecting && railSelect.has(s.id)}
            onclick={() => open(s)} role="button" tabindex="0"
            onkeydown={(e) => { if (e.key === 'Enter') open(s); }}>
            {#if !s.matched}
              <Cover coverUrl={null} title={s.folder || 'Unidentified series'} />
              <div class="series-row__main">
                <div class="series-row__title series-row__title--unmatched">{s.folder || 'Unidentified series'}</div>
                <div class="coll-meta">
                  <span class="coll-badge coll-badge--nomatch">needs ComicVine match</span>
                  {#if s.files}<span class="coll-count">{fmt(s.files)} files</span>{/if}
                </div>
              </div>
              <span class="series-col--wide"></span>
              <span class="series-row__dim series-col--wide">—</span>
              <span class="series-row__dim series-col--wide">{s.size ? humanBytes(s.size) : '—'}</span>
            {:else}
              <Cover coverUrl={s.cover_url} title={s.title} />
              <div class="series-row__main">
                <div class="series-row__title">{s.title}{#if s.year}<span class="series-row__year"> ({s.year})</span>{/if}</div>
                <div class="coll-meta">
                  {#if s.publisher}<span class="series-row__pub">{s.publisher}</span>{/if}
                  {#if s.active > 0}<span class="coll-badge coll-badge--busy" title="{fmt(s.active)} issue(s) queued or downloading"><Icon name="download-active" /> {fmt(s.active)}</span>{/if}
                  {#if s.missing > 0}<span class="coll-badge coll-badge--miss">{fmt(s.missing)} missing</span>
                  {:else if s.total > 0}<span class="coll-badge coll-badge--ok">complete</span>{/if}
                  {#if s.untagged > 0}<span class="coll-badge">{fmt(s.untagged)} untagged</span>{/if}
                  {#if s.corrupt > 0}<span class="coll-badge coll-badge--warn">{fmt(s.corrupt)} corrupt</span>{/if}
                  {#if !s.sourced}<span class="coll-badge coll-badge--nosrc" title="No download source yet">no source</span>{/if}
                  {#if s.restricted}<span class="coll-badge coll-badge--warn" title="Mature — hidden from roles without “View mature content”"><Icon name="shield" /></span>{/if}
                </div>
              </div>
              <div class="series-row__progress series-col--wide" title="{s.owned} of {s.total} issues on disk">
                <span class="series-row__nums">{s.owned}/{s.total}</span>
                <span class="series-row__bar"><span class:is-done={s.total > 0 && s.missing === 0} style="width:{pct(s)}%"></span></span>
              </div>
              <span class="series-row__dim series-col--wide" title="Newest known issue's cover date">{s.latest || '—'}</span>
              <span class="series-row__dim series-col--wide">{s.size ? humanBytes(s.size) : '—'}</span>
            {/if}
            {#if isTrusted()}
              <button class="coll-mon" class:is-on={s.followed} title={s.followed ? 'Followed — click to unfollow' : 'Not followed — click to follow'} aria-label={s.followed ? 'Unfollow' : 'Follow'} onclick={(e) => { e.stopPropagation(); toggleMon(s); }}><Icon name="star" fill={!!s.followed} /></button>
            {/if}
          </div>
        {/each}
        {#if range.padBottom > 0}<div style="height:{range.padBottom}px"></div>{/if}
      </div>
    {/if}
  </div>
</section>
