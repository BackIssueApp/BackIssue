<script>
  import { untrack } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import { goBack, navigate, route, setQuery } from '../lib/router.svelte.js';
  import { apiGet, apiPost } from '../lib/api.js';
  import { subscribe } from '../lib/events.svelte.js';
  import { notify } from '../lib/toasts.svelte.js';
  import { fmt } from '../lib/util.js';
  import { rail } from '../lib/store.svelte.js';
  import Badge from './Badge.svelte';
  import Cover from './Cover.svelte';
  import { confirmDialog } from './DialogModal.svelte';
  import { can } from '../lib/auth.svelte.js';
  import Icon from '../lib/Icon.svelte';

  let { active = false } = $props();

  let followed = $state(false);
  let hideUnreleased = $state(false);
  let scope = $state('wanted'); // 'wanted' (what automation fetches) | 'gaps' (every missing issue)
  let sort = $state('series');
  let q = $state('');
  let items = $state([]);
  let total = $state(0);
  let loaded = $state(false);
  let collapsed = $state({}); // series_id → true when the user collapses it
  const gaps = $derived(scope === 'gaps');

  const SORTS = [
    { key: 'series', label: 'Series A–Z' },
    { key: 'newest', label: 'Newest release' },
    { key: 'oldest', label: 'Oldest release' },
    { key: 'most', label: 'Most wanted first' },
    { key: 'fewest', label: 'Fewest wanted first' },
  ];

  async function renderWanted({ append = false } = {}) {
    const offset = append ? items.length : 0;
    const qs = `limit=200&offset=${offset}&scope=${scope}&sort=${sort}` + (followed ? '&followed=1' : '') + (hideUnreleased ? '&hideUnreleased=1' : '') + (q ? `&q=${encodeURIComponent(q)}` : '');
    let w;
    try { w = await apiGet('/api/wanted?' + qs); } catch { return; }
    items = append ? items.concat(w.items) : w.items;
    total = w.total;
    loaded = true;
    if (!append) { selected.clear(); lastToggled = null; }
  }

  // Filters live in the URL (?wf=followed&hide=1&scope=gaps&sort=…&find=…) so
  // views are shareable and Back/Forward restore them. The URL is the source
  // of truth: handlers only patch the query; this effect syncs state + refetches.
  $effect(() => {
    if (!active) { items = []; loaded = false; return; }
    const p = new URLSearchParams(route.search);
    untrack(() => {
      followed = p.get('wf') === 'followed';
      hideUnreleased = p.get('hide') === '1';
      scope = p.get('scope') === 'gaps' ? 'gaps' : 'wanted';
      sort = SORTS.some((s) => s.key === p.get('sort')) ? p.get('sort') : 'series';
      if (q !== (p.get('find') || '')) q = p.get('find') || '';
      renderWanted();
    });
    // refresh in place (status counts move when downloads land) unless the
    // user has paged deeper or is mid-selection
    return subscribe('status', () => { if (items.length <= 200 && !selected.size) renderWanted(); }, 4000);
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
      message: 'Everything matching the current filters is queued.' + (gaps ? ' Gaps that were not wanted become wanted.' : '') + (total > 500 ? ' Capped at 500 per pass — run it again for the rest.' : ''),
      confirmLabel: 'Queue downloads',
    }))) return;
    const r = await apiPost('/api/wanted/download-all', { followed, hideUnreleased, q, scope });
    if (r?.error) return notify(r.error, 'error');
    notify(`Queued ${fmt(r.queued || 0)} issue(s).`, 'ok');
    renderWanted();
  }

  const IN_FLIGHT = ['queued', 'downloading', 'grabbed', 'tagging'];
  async function download(it) {
    it._busy = true;
    await apiPost(`/api/collection/${it.series_id}/download`, { cvIssueIds: [it.cv_issue_id] });
    it.queue_status = 'queued';
    it.wanted = 1; it.why = it.why || 'pick';
    it._busy = false;
  }

  /* ---- Wants: pick / skip, singly or for a selection ---- */
  // Group a set of rows by series and post one request per series. Rows are
  // patched in place: in the wanted view a skipped issue disappears, in the
  // gaps view it stays and flips its flag.
  async function setWants(rows, want) {
    const bySeries = new Map();
    for (const it of rows) {
      if (!bySeries.has(it.series_id)) bySeries.set(it.series_id, []);
      bySeries.get(it.series_id).push(it);
    }
    let changed = 0;
    for (const [sid, list] of bySeries) {
      let r;
      try { r = await apiPost(`/api/collection/${sid}/wanted`, { cvIssueIds: list.map((x) => x.cv_issue_id), want }); }
      catch { notify('Could not update — is the app reachable?', 'error'); return; }
      if (r?.error) { notify(r.error, 'error'); return; }
      changed += r.changed || 0;
      const by = new Map((r.issues || []).map((x) => [x.cv_issue_id, x]));
      for (const it of list) {
        const u = by.get(it.cv_issue_id);
        if (!u) continue;
        it.wanted = u.wanted ? 1 : 0; it.why = u.why; it.reason = u.reason; it.pick = u.pick;
        if (!u.wanted && ['queued', 'failed'].includes(it.queue_status)) it.queue_status = 'pending';
      }
    }
    if (!gaps && !want) {
      const drop = new Set(rows.map((x) => x.cv_issue_id));
      items = items.filter((x) => !drop.has(x.cv_issue_id));
      total = Math.max(0, total - drop.size);
    }
    for (const it of rows) selected.delete(it.cv_issue_id);
    if (rows.length > 1) notify(want ? `Wanting ${fmt(rows.length)} issues.` : `${fmt(rows.length)} issues no longer wanted.`, 'ok');
    void changed;
  }

  /* ---- Selection (checkbox per row, shift-click for ranges) ---- */
  const selected = new SvelteSet();
  let lastToggled = $state(null); // index into `items`
  function toggleRow(it, index, shiftKey) {
    const willCheck = !selected.has(it.cv_issue_id);
    if (shiftKey && lastToggled != null && index !== lastToggled) {
      const [a, b] = [Math.min(lastToggled, index), Math.max(lastToggled, index)];
      for (let k = a; k <= b; k++) { const x = items[k]; if (!x) continue; if (willCheck) selected.add(x.cv_issue_id); else selected.delete(x.cv_issue_id); }
    } else if (willCheck) selected.add(it.cv_issue_id);
    else selected.delete(it.cv_issue_id);
    lastToggled = index;
  }
  function toggleSeries(g) {
    const all = g.issues.every((it) => selected.has(it.cv_issue_id));
    for (const it of g.issues) { if (all) selected.delete(it.cv_issue_id); else selected.add(it.cv_issue_id); }
  }
  const selectedRows = $derived(items.filter((it) => selected.has(it.cv_issue_id)));
  // Flat position of each row, for shift-click ranges (never written onto the rows themselves).
  const indexById = $derived(new Map(items.map((it, i) => [it.cv_issue_id, i])));
  async function downloadSelected() {
    const rows = selectedRows.filter((it) => !IN_FLIGHT.includes(it.queue_status));
    if (!rows.length) return notify('Everything selected is already on its way.', 'info');
    const bySeries = new Map();
    for (const it of rows) { if (!bySeries.has(it.series_id)) bySeries.set(it.series_id, []); bySeries.get(it.series_id).push(it.cv_issue_id); }
    for (const [sid, ids] of bySeries) await apiPost(`/api/collection/${sid}/download`, { cvIssueIds: ids });
    for (const it of rows) { it.queue_status = 'queued'; it.wanted = 1; }
    selected.clear();
    notify(`Queued ${fmt(rows.length)} issue(s).`, 'ok');
  }

  // Group the flat, pre-sorted item list into per-series cards (in order of
  // first appearance, so a date sort surfaces the series with the newest
  // issue first), enriching each with owned/total from the rail store when
  // the series is loaded there (the completion bar is progressive enhancement).
  const groups = $derived.by(() => {
    const out = []; const byId = new Map();
    items.forEach((it) => {
      let g = byId.get(it.series_id);
      if (!g) { g = { id: it.series_id, title: it.series_title, cover: it.series_cover, followed: it.followed, monitor: it.monitor, monitor_from: it.monitor_from, issues: [] }; byId.set(it.series_id, g); out.push(g); }
      g.issues.push(it);
    });
    for (const g of out) {
      const r = rail.rows?.find((x) => x.id === g.id);
      if (r && r.total) { g.owned = r.owned; g.total = r.total; g.pct = Math.round((r.owned / r.total) * 100); g.hasBar = true; }
      else g.hasBar = false;
      g.count = g.issues.length;
    }
    return out;
  });

  const monitorLabel = (g) => g.monitor === 'new' ? `new from #${g.monitor_from ?? '?'}` : g.monitor === 'none' ? 'not monitored' : 'monitored';
  const whyTitle = (it) => it.why === 'pick'
    ? `Picked by hand${it.reason && it.reason !== 'manual' ? ` (${it.reason})` : ''}`
    : it.wanted ? 'Wanted because the series is monitored' : 'Not wanted — a gap the policy leaves alone';

  const stats = $derived.by(() => {
    let inFlight = 0, failed = 0;
    for (const it of items) { if (IN_FLIGHT.includes(it.queue_status)) inFlight++; else if (it.queue_status === 'failed') failed++; }
    const series = new Set(items.map((i) => i.series_id)).size;
    return [
      { label: gaps ? 'Missing' : 'Wanted', value: fmt(total), tone: 'var(--amber)' },
      { label: 'In flight', value: fmt(inFlight), tone: 'var(--cyan)' },
      { label: 'Failed', value: fmt(failed), tone: failed ? 'var(--red)' : 'var(--green)' },
      { label: 'Series', value: fmt(series), tone: 'var(--muted)' },
    ];
  });

  const emptyLibrary = $derived(rail.loaded && !rail.rows.length);
</script>

<main id="wanted-page" class="scan-page wanted-page wx">
  <div class="wx__top">
    <div class="wx__head">
      <button id="wanted-back" class="wx__iconbtn" aria-label="Back" onclick={goBack}><Icon name="arrow-left" size={16} /></button>
      <h2 class="wx__title">Wanted</h2>
      <span id="wanted-summary" class="wx__summary">{fmt(total)} {gaps ? 'missing' : 'wanted'} issue{total === 1 ? '' : 's'}</span>
      <div class="wx__right">
        <div class="wx__find">
          <Icon name="search" size={15} />
          <input id="wanted-search" type="search" spellcheck="false" placeholder="Filter series…" bind:value={q} oninput={onSearchInput} />
        </div>
        {#if can('downloads.grab')}
          <button id="wanted-dl-all" class="wx__dlall" onclick={downloadAll}><Icon name="download" size={15} /> Download shown</button>
        {/if}
      </div>
    </div>

    <div class="wx__stats">
      {#each stats as st (st.label)}
        <div class="wx__stat">
          <div class="wx__stat-lbl"><span class="wx__stat-dot" style="background:{st.tone};"></span>{st.label}</div>
          <div class="wx__stat-val" style="color:{st.tone};">{st.value}</div>
        </div>
      {/each}
    </div>

    <div class="wx__chips">
      <button class="wx__chip" class:is-active={!gaps} title="What download automation goes after — each series' monitoring policy plus your picks" onclick={() => setQuery({ scope: null })}>Wanted</button>
      <button class="wx__chip" class:is-active={gaps} title="Every missing issue of every series in the library, wanted or not" onclick={() => setQuery({ scope: 'gaps' })}>All gaps</button>
      <span class="wx__chips-sep"></span>
      <button class="wx__chip" class:is-active={followed} onclick={() => setQuery({ wf: followed ? null : 'followed' })} title="Series you follow (the ☆ on a series page)"><Icon name="star" size={13} /> Following</button>
      <button id="wanted-unreleased" class="wx__chip wx__chip--hide" class:is-active={hideUnreleased}
        title="Hides issues whose known cover date is in the future (most cached issues have no date — this only hides what we know)"
        onclick={() => setQuery({ hide: hideUnreleased ? null : '1' })}><Icon name="eye-off" size={14} /> Hide unreleased</button>
      <label class="wx__sort" title="Sort order">
        <Icon name="arrow-up-down" size={13} />
        <select value={sort} onchange={(e) => setQuery({ sort: e.currentTarget.value === 'series' ? null : e.currentTarget.value })}>
          {#each SORTS as o (o.key)}<option value={o.key}>{o.label}</option>{/each}
        </select>
      </label>
    </div>

    {#if selected.size}
      <div class="wx__bulk" id="wanted-bulkbar">
        <span class="wx__bulk-count">{fmt(selected.size)} selected</span>
        {#if can('downloads.grab')}
          <button class="wx__bulk-btn" onclick={() => setWants(selectedRows, true)} title="Want the selected issues — automation searches for them"><Icon name="target" size={14} /> Want</button>
          <button class="wx__bulk-btn" onclick={() => setWants(selectedRows, false)} title="Stop wanting the selected issues"><Icon name="ban" size={14} /> Don't want</button>
          <button class="wx__bulk-btn wx__bulk-btn--primary" onclick={downloadSelected}><Icon name="download" size={14} /> Download selected</button>
        {/if}
        <button class="wx__bulk-btn wx__bulk-btn--ghost" onclick={() => selected.clear()}>Clear</button>
      </div>
    {/if}
  </div>

  <div class="wx__scroll">
    <div id="wanted-list" class="wx__inner">
      {#if loaded && !items.length}
        <div class="wx__empty">
          <div class="wx__empty-art"><Icon name="check" size={26} /></div>
          {#if emptyLibrary}
            <div class="wx__empty-title">Nothing tracked yet</div>
            <p class="wx__empty-body">Add a series from the <a href="/" onclick={(e) => { e.preventDefault(); navigate('/'); }}>Library</a> and its missing issues show up here.</p>
          {:else if gaps}
            <div class="wx__empty-title">{q ? 'No series match your filter' : 'Nothing missing'}</div>
            <p class="wx__empty-body">{q ? 'Try a different search, or clear the filters.' : 'Every issue of every series in your library is on disk.'}</p>
          {:else}
            <div class="wx__empty-title">{q ? 'No series match your filter' : 'Nothing wanted'}</div>
            <p class="wx__empty-body">{q ? 'Try a different search, or clear the filters.' : 'Every issue your monitoring policies ask for is in your library. Switch to All gaps to see what else is missing, and pick anything you want by hand.'}</p>
          {/if}
        </div>
      {/if}

      {#each groups as g (g.id)}
        {@const open = !collapsed[g.id]}
        {@const allSel = g.issues.every((it) => selected.has(it.cv_issue_id))}
        <div class="wx__card">
          <div class="wx__series" role="button" tabindex="0"
            onclick={() => { collapsed = { ...collapsed, [g.id]: open }; }}
            onkeydown={(e) => { if (e.key === 'Enter') collapsed = { ...collapsed, [g.id]: open }; }}>
            <input class="wx__check wx__check--series" type="checkbox" checked={allSel} title="Select every issue of this series"
              onclick={(e) => e.stopPropagation()} onchange={() => toggleSeries(g)} />
            <div class="wx__cover"><Cover coverUrl={g.cover} title={g.title || '?'} /></div>
            <div class="wx__series-main">
              <div class="wx__series-title">
                <a href={'/volume/' + g.id} onclick={(e) => { e.stopPropagation(); e.preventDefault(); navigate('/volume/' + g.id); }}>{g.title || '?'}</a>
                {#if g.followed}<span class="wx__star" title="Following"><Icon name="star" fill size={13} /></span>{/if}
                <span class="wx__mon wx__mon--{g.monitor || 'all'}" title="Monitoring policy — change it on the series page">{monitorLabel(g)}</span>
              </div>
              {#if g.hasBar}
                <div class="wx__prog">
                  <span class="wx__track"><span class="wx__fill" class:is-done={g.pct >= 100} style="width:{g.pct}%"></span></span>
                  <span class="wx__prog-num">{fmt(g.owned)}/{fmt(g.total)}</span>
                </div>
              {/if}
            </div>
            <span class="wx__misspill">{fmt(g.count)} {gaps ? 'missing' : 'wanted'}</span>
            <span class="wx__chev" class:is-open={open}><Icon name="chevron-right" size={16} /></span>
          </div>
          {#if open}
            <div class="wx__issues">
              {#each g.issues as it (it.cv_issue_id)}
                <div class="wx__row" class:is-unwanted={gaps && !it.wanted} class:is-selected={selected.has(it.cv_issue_id)}>
                  <input class="wx__check" type="checkbox" checked={selected.has(it.cv_issue_id)}
                    onclick={(e) => toggleRow(it, indexById.get(it.cv_issue_id), e.shiftKey)} />
                  <span class="wx__num">#{it.issue_number ?? '?'}</span>
                  <span class="wx__name">{it.issue_name || '—'}</span>
                  {#if it.why === 'pick'}<span class="wx__why" title={whyTitle(it)}>picked</span>
                  {:else if gaps && !it.wanted}<span class="wx__why wx__why--off" title={whyTitle(it)}>not wanted</span>{/if}
                  {#if it.queue_status && IN_FLIGHT.includes(it.queue_status)}
                    <Badge status={it.queue_status} />
                  {:else if it._busy}
                    <span class="wx__badge-muted">Queuing…</span>
                  {:else if it.queue_status === 'failed' && can('downloads.grab')}
                    <button class="wx__retry" onclick={() => download(it)}><Icon name="refresh" size={13} /> Retry</button>
                  {:else if can('downloads.grab')}
                    <button class="wx__dl" onclick={() => download(it)}><Icon name="download" size={13} /> Download</button>
                  {/if}
                  {#if can('downloads.grab')}
                    {#if it.wanted}
                      <button class="wx__want" title={it.why === 'pick' ? 'Stop wanting this issue' : 'Skip this issue — the policy leaves it alone from now on'} aria-label="Don't want" onclick={() => setWants([it], false)}><Icon name="ban" size={13} /></button>
                    {:else}
                      <button class="wx__want wx__want--on" title="Want just this issue" aria-label="Want" onclick={() => setWants([it], true)}><Icon name="target" size={13} /></button>
                    {/if}
                  {/if}
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {/each}

      <button id="wanted-more" class="wx__more" hidden={items.length >= total} onclick={() => renderWanted({ append: true })}>Load more</button>
    </div>
  </div>
</main>

<style>
  /* Layout (display:flex, column, height:100%) comes from the route reveal
     rule `body.wanted .wanted-page` — the page must NOT set its own display
     here or it overrides the `.scan-page { display:none }` hide and shows on
     every route. */
  .wx { min-height: 0; }
  .wx__top { flex: none; padding: 16px 22px 0; }
  .wx__head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .wx__iconbtn { width: 36px; height: 36px; display: grid; place-items: center; border: 1px solid var(--line); background: transparent; color: var(--muted); border-radius: 8px; cursor: pointer; }
  .wx__iconbtn:hover { color: var(--text); }
  .wx__title { margin: 0; font-family: var(--font-display); font-size: 24px; letter-spacing: .03em; font-weight: 400; }
  .wx__summary { font: 12px var(--font-mono); color: var(--faint); }
  .wx__right { margin-left: auto; display: flex; align-items: center; gap: 10px; }
  .wx__find { position: relative; display: flex; align-items: center; color: var(--faint); }
  .wx__find :global(svg) { position: absolute; left: 11px; pointer-events: none; }
  .wx__find input { height: 36px; width: 190px; max-width: 42vw; padding: 0 12px 0 34px; background: var(--ink); border: 1px solid var(--line); border-radius: 8px; color: var(--text); font: 13px var(--font-body); }
  .wx__find input:focus { outline: none; border-color: var(--accent); }
  .wx__dlall { height: 36px; padding: 0 15px; border: none; background: var(--accent); color: #fff; border-radius: 8px; font: 600 13px var(--font-body); cursor: pointer; display: inline-flex; align-items: center; gap: 7px; white-space: nowrap; }

  .wx__stats { display: flex; gap: 10px; margin-top: 16px; overflow-x: auto; padding-bottom: 2px; scrollbar-width: none; }
  .wx__stats::-webkit-scrollbar { display: none; }
  .wx__stat { flex: none; min-width: 118px; background: rgba(255,255,255,.015); border: 1px solid var(--line); border-radius: 11px; padding: 11px 14px; }
  .wx__stat-lbl { display: flex; align-items: center; gap: 7px; font-size: 10.5px; text-transform: uppercase; letter-spacing: .08em; color: var(--faint); }
  .wx__stat-dot { width: 7px; height: 7px; border-radius: 50%; }
  .wx__stat-val { font: 700 21px var(--font-body); margin-top: 6px; }

  .wx__chips { display: flex; align-items: center; gap: 8px; margin-top: 14px; padding-bottom: 14px; border-bottom: 1px solid var(--line); overflow-x: auto; scrollbar-width: none; }
  .wx__chips::-webkit-scrollbar { display: none; }
  .wx__chip { display: inline-flex; align-items: center; gap: 7px; height: 34px; padding: 0 14px; border-radius: 8px; border: 1px solid var(--line); background: transparent; color: var(--muted); font: 600 12.5px var(--font-body); cursor: pointer; white-space: nowrap; flex: none; }
  .wx__chip.is-active { background: var(--accent); border-color: var(--accent); color: #fff; }
  .wx__chip--hide.is-active { background: rgba(255,194,75,.12); border-color: var(--amber); color: var(--amber); }
  .wx__chips-sep { width: 1px; height: 22px; background: var(--line); flex: none; margin: 0 2px; }
  .wx__sort { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; color: var(--faint); flex: none; }
  .wx__sort select { height: 34px; padding: 0 10px; border-radius: 8px; border: 1px solid var(--line); background: var(--ink); color: var(--muted); font: 600 12.5px var(--font-body); cursor: pointer; }

  .wx__bulk { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 10px 0 12px; border-bottom: 1px solid var(--line); background: rgba(255,45,111,.05); margin: 0 -22px; padding-left: 22px; padding-right: 22px; }
  .wx__bulk-count { font: 600 12.5px var(--font-body); color: var(--text); margin-right: 4px; }
  .wx__bulk-btn { height: 32px; padding: 0 13px; border-radius: 8px; border: 1px solid var(--line); background: transparent; color: var(--muted); font: 600 12.5px var(--font-body); cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }
  .wx__bulk-btn:hover { color: var(--text); border-color: var(--accent); }
  .wx__bulk-btn--primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  .wx__bulk-btn--ghost { margin-left: auto; border-color: transparent; }

  .wx__scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 14px 22px 60px; }
  .wx__inner { max-width: 900px; margin: 0 auto; }

  .wx__card { border: 1px solid var(--line); border-radius: 13px; background: rgba(255,255,255,.012); margin-bottom: 14px; overflow: hidden; }
  .wx__series { display: flex; align-items: center; gap: 13px; padding: 13px 15px; cursor: pointer; }
  .wx__check { width: 15px; height: 15px; accent-color: var(--accent); cursor: pointer; flex: none; margin: 0; }
  .wx__cover :global(.cover) { width: 40px; height: 54px; border-radius: 6px; }
  .wx__series-main { flex: 1; min-width: 0; }
  .wx__series-title { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .wx__series-title a { font-size: 14.5px; font-weight: 600; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .wx__series-title a:hover { color: var(--accent); }
  .wx__star { color: var(--amber); display: flex; flex: none; }
  .wx__mon { font: 10.5px var(--font-mono); padding: 2px 7px; border-radius: 999px; border: 1px solid var(--line); color: var(--faint); white-space: nowrap; flex: none; }
  .wx__mon--all { color: var(--green); border-color: rgba(84,214,132,.35); }
  .wx__mon--new { color: var(--cyan); border-color: rgba(88,205,255,.35); }
  .wx__prog { display: flex; align-items: center; gap: 10px; margin-top: 7px; }
  .wx__track { display: block; flex: 1; max-width: 220px; height: 5px; border-radius: 3px; background: var(--panel-2); overflow: hidden; }
  .wx__fill { display: block; height: 100%; background: var(--accent); }
  .wx__fill.is-done { background: var(--green); }
  .wx__prog-num { font: 11px var(--font-mono); color: var(--faint); white-space: nowrap; }
  .wx__misspill { font: 11px var(--font-mono); color: var(--amber); background: rgba(255,194,75,.1); border: 1px solid rgba(255,194,75,.3); border-radius: 999px; padding: 3px 10px; flex: none; }
  .wx__chev { color: #6f6885; display: flex; flex: none; transition: transform .15s; }
  .wx__chev.is-open { transform: rotate(90deg); }

  .wx__issues { border-top: 1px solid #2a2536; }
  .wx__row { display: flex; align-items: center; gap: 12px; padding: 9px 15px 9px 44px; border-bottom: 1px solid #221e2c; }
  .wx__row:last-child { border-bottom: none; }
  .wx__row:hover { background: rgba(255,255,255,.025); }
  .wx__row.is-selected { background: rgba(255,45,111,.07); }
  .wx__row.is-unwanted .wx__num, .wx__row.is-unwanted .wx__name { opacity: .55; }
  .wx__num { font: 600 13px var(--font-body); flex: none; }
  .wx__name { flex: 1; min-width: 0; font-size: 12.5px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .wx__why { font: 10.5px var(--font-mono); color: var(--accent); border: 1px solid rgba(255,45,111,.35); border-radius: 999px; padding: 2px 7px; flex: none; }
  .wx__why--off { color: var(--faint); border-color: var(--line); }
  .wx__badge-muted { font: 600 11.5px var(--font-body); color: var(--faint); flex: none; }
  .wx__dl, .wx__retry { height: 29px; padding: 0 13px; border-radius: 7px; font: 600 12px var(--font-body); cursor: pointer; display: inline-flex; align-items: center; gap: 5px; flex: none; }
  .wx__dl { border: none; background: var(--accent); color: #fff; opacity: .35; transition: opacity .12s; }
  .wx__row:hover .wx__dl { opacity: 1; }
  .wx__retry { border: 1px solid rgba(255,90,82,.4); background: rgba(255,90,82,.1); color: var(--red); }
  .wx__want { width: 29px; height: 29px; display: grid; place-items: center; border-radius: 7px; border: 1px solid transparent; background: transparent; color: var(--faint); cursor: pointer; flex: none; opacity: .35; transition: opacity .12s, color .12s; }
  .wx__row:hover .wx__want { opacity: 1; }
  .wx__want:hover { color: var(--text); border-color: var(--line); }
  .wx__want--on { opacity: 1; color: var(--accent); }

  .wx__empty { padding: 70px 20px; text-align: center; }
  .wx__empty-art { width: 54px; height: 54px; margin: 0 auto 14px; border-radius: 14px; background: var(--panel-2); display: grid; place-items: center; color: var(--green); }
  .wx__empty-title { font-size: 15px; font-weight: 600; margin-bottom: 6px; }
  .wx__empty-body { font-size: 13px; color: var(--faint); margin: 0 auto; max-width: 400px; line-height: 1.55; }
  .wx__more { display: block; margin: 6px auto 0; height: 38px; padding: 0 20px; border: 1px solid var(--line); background: transparent; color: var(--muted); border-radius: 9px; font: 600 13px var(--font-body); cursor: pointer; }
</style>
