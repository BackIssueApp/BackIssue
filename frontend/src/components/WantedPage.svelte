<script>
  import { untrack } from 'svelte';
  import { goBack, navigate, route, setQuery } from '../lib/router.svelte.js';
  import { apiGet, apiPost } from '../lib/api.js';
  import { subscribe } from '../lib/events.svelte.js';
  import { notify } from '../lib/toasts.svelte.js';
  import { fmt, initials } from '../lib/util.js';
  import { rail } from '../lib/store.svelte.js';
  import Badge from './Badge.svelte';
  import Cover from './Cover.svelte';
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
  let collapsed = $state({}); // series_id → true when the user collapses it

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

  // Group the flat, pre-sorted item list into per-series cards, enriching each
  // with owned/total from the rail store when the series is loaded there (the
  // completion bar is progressive enhancement — the missing count is primary).
  const groups = $derived.by(() => {
    const out = []; const byId = new Map();
    for (const it of items) {
      let g = byId.get(it.series_id);
      if (!g) { g = { id: it.series_id, title: it.series_title, cover: it.series_cover, followed: it.followed, issues: [] }; byId.set(it.series_id, g); out.push(g); }
      g.issues.push(it);
    }
    for (const g of out) {
      const r = rail.rows?.find((x) => x.id === g.id);
      if (r && r.total) { g.owned = r.owned; g.total = r.total; g.pct = Math.round((r.owned / r.total) * 100); g.missing = r.missing; g.hasBar = true; }
      else { g.missing = g.issues.length; g.hasBar = false; }
    }
    return out;
  });

  const stats = $derived.by(() => {
    let inFlight = 0, failed = 0;
    for (const it of items) { if (IN_FLIGHT.includes(it.queue_status)) inFlight++; else if (it.queue_status === 'failed') failed++; }
    const series = new Set(items.map((i) => i.series_id)).size;
    return [
      { label: 'Missing', value: fmt(total), tone: 'var(--amber)' },
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
      <span id="wanted-summary" class="wx__summary">{fmt(total)} missing issue{total === 1 ? '' : 's'}</span>
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
      <button class="wx__chip" class:is-active={!followed} onclick={() => setQuery({ wf: null })}>All series</button>
      <button class="wx__chip" class:is-active={followed} onclick={() => setQuery({ wf: 'followed' })} title="Series you follow (the ☆ on a series page)">Following</button>
      <button id="wanted-unreleased" class="wx__chip wx__chip--hide" class:is-active={hideUnreleased}
        title="Hides issues whose known cover date is in the future (most cached issues have no date — this only hides what we know)"
        onclick={() => setQuery({ hide: hideUnreleased ? null : '1' })}><Icon name="eye-off" size={14} /> Hide unreleased</button>
    </div>
  </div>

  <div class="wx__scroll">
    <div id="wanted-list" class="wx__inner">
      {#if loaded && !items.length}
        <div class="wx__empty">
          <div class="wx__empty-art"><Icon name="check" size={26} /></div>
          {#if emptyLibrary}
            <div class="wx__empty-title">Nothing tracked yet</div>
            <p class="wx__empty-body">Add a series from the <a href="/" onclick={(e) => { e.preventDefault(); navigate('/'); }}>Library</a> and its missing issues show up here.</p>
          {:else}
            <div class="wx__empty-title">{q ? 'No series match your filter' : 'Nothing missing'}</div>
            <p class="wx__empty-body">{q ? 'Try a different search, or clear the filters.' : 'Every issue of every tracked series is in your library. New releases show up here automatically.'}</p>
          {/if}
        </div>
      {/if}

      {#each groups as g (g.id)}
        {@const open = !collapsed[g.id]}
        <div class="wx__card">
          <div class="wx__series" role="button" tabindex="0"
            onclick={() => { collapsed = { ...collapsed, [g.id]: open }; }}
            onkeydown={(e) => { if (e.key === 'Enter') collapsed = { ...collapsed, [g.id]: open }; }}>
            <div class="wx__cover"><Cover coverUrl={g.cover} title={g.title || '?'} /></div>
            <div class="wx__series-main">
              <div class="wx__series-title">
                <a href={'/volume/' + g.id} onclick={(e) => { e.stopPropagation(); e.preventDefault(); navigate('/volume/' + g.id); }}>{g.title || '?'}</a>
                {#if g.followed}<span class="wx__star" title="Following"><Icon name="star" fill size={13} /></span>{/if}
              </div>
              {#if g.hasBar}
                <div class="wx__prog">
                  <span class="wx__track"><span class="wx__fill" class:is-done={g.pct >= 100} style="width:{g.pct}%"></span></span>
                  <span class="wx__prog-num">{fmt(g.owned)}/{fmt(g.total)}</span>
                </div>
              {/if}
            </div>
            <span class="wx__misspill">{fmt(g.missing)} missing</span>
            <span class="wx__chev" class:is-open={open}><Icon name="chevron-right" size={16} /></span>
          </div>
          {#if open}
            <div class="wx__issues">
              {#each g.issues as it (it.cv_issue_id)}
                <div class="wx__row">
                  <span class="wx__num">#{it.issue_number ?? '?'}</span>
                  <span class="wx__name">{it.issue_name || '—'}</span>
                  {#if it.queue_status && IN_FLIGHT.includes(it.queue_status)}
                    <Badge status={it.queue_status} />
                  {:else if it._busy}
                    <span class="wx__badge-muted">Queuing…</span>
                  {:else if it.queue_status === 'failed' && can('downloads.grab')}
                    <button class="wx__retry" onclick={() => download(it)}><Icon name="refresh" size={13} /> Retry</button>
                  {:else if can('downloads.grab')}
                    <button class="wx__dl" onclick={() => download(it)}><Icon name="download" size={13} /> Download</button>
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

  .wx__chips { display: flex; gap: 8px; margin-top: 14px; padding-bottom: 14px; border-bottom: 1px solid var(--line); overflow-x: auto; scrollbar-width: none; }
  .wx__chips::-webkit-scrollbar { display: none; }
  .wx__chip { display: inline-flex; align-items: center; gap: 7px; height: 34px; padding: 0 14px; border-radius: 8px; border: 1px solid var(--line); background: transparent; color: var(--muted); font: 600 12.5px var(--font-body); cursor: pointer; white-space: nowrap; flex: none; }
  .wx__chip.is-active { background: var(--accent); border-color: var(--accent); color: #fff; }
  .wx__chip--hide.is-active { background: rgba(255,194,75,.12); border-color: var(--amber); color: var(--amber); }

  .wx__scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 14px 22px 60px; }
  .wx__inner { max-width: 900px; margin: 0 auto; }

  .wx__card { border: 1px solid var(--line); border-radius: 13px; background: rgba(255,255,255,.012); margin-bottom: 14px; overflow: hidden; }
  .wx__series { display: flex; align-items: center; gap: 13px; padding: 13px 15px; cursor: pointer; }
  .wx__cover :global(.cover) { width: 40px; height: 54px; border-radius: 6px; }
  .wx__series-main { flex: 1; min-width: 0; }
  .wx__series-title { display: flex; align-items: center; gap: 8px; }
  .wx__series-title a { font-size: 14.5px; font-weight: 600; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .wx__series-title a:hover { color: var(--accent); }
  .wx__star { color: var(--amber); display: flex; flex: none; }
  .wx__prog { display: flex; align-items: center; gap: 10px; margin-top: 7px; }
  .wx__track { display: block; flex: 1; max-width: 220px; height: 5px; border-radius: 3px; background: var(--panel-2); overflow: hidden; }
  .wx__fill { display: block; height: 100%; background: var(--accent); }
  .wx__fill.is-done { background: var(--green); }
  .wx__prog-num { font: 11px var(--font-mono); color: var(--faint); white-space: nowrap; }
  .wx__misspill { font: 11px var(--font-mono); color: var(--amber); background: rgba(255,194,75,.1); border: 1px solid rgba(255,194,75,.3); border-radius: 999px; padding: 3px 10px; flex: none; }
  .wx__chev { color: #6f6885; display: flex; flex: none; transition: transform .15s; }
  .wx__chev.is-open { transform: rotate(90deg); }

  .wx__issues { border-top: 1px solid #2a2536; }
  .wx__row { display: flex; align-items: center; gap: 12px; padding: 9px 15px 9px 60px; border-bottom: 1px solid #221e2c; }
  .wx__row:last-child { border-bottom: none; }
  .wx__row:hover { background: rgba(255,255,255,.025); }
  .wx__num { font: 600 13px var(--font-body); flex: none; }
  .wx__name { flex: 1; min-width: 0; font-size: 12.5px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .wx__badge-muted { font: 600 11.5px var(--font-body); color: var(--faint); flex: none; }
  .wx__dl, .wx__retry { height: 29px; padding: 0 13px; border-radius: 7px; font: 600 12px var(--font-body); cursor: pointer; display: inline-flex; align-items: center; gap: 5px; flex: none; }
  .wx__dl { border: none; background: var(--accent); color: #fff; opacity: .35; transition: opacity .12s; }
  .wx__row:hover .wx__dl { opacity: 1; }
  .wx__retry { border: 1px solid rgba(255,90,82,.4); background: rgba(255,90,82,.1); color: var(--red); }

  .wx__empty { padding: 70px 20px; text-align: center; }
  .wx__empty-art { width: 54px; height: 54px; margin: 0 auto 14px; border-radius: 14px; background: var(--panel-2); display: grid; place-items: center; color: var(--green); }
  .wx__empty-title { font-size: 15px; font-weight: 600; margin-bottom: 6px; }
  .wx__empty-body { font-size: 13px; color: var(--faint); margin: 0 auto; max-width: 360px; line-height: 1.55; }
  .wx__more { display: block; margin: 6px auto 0; height: 38px; padding: 0 20px; border: 1px solid var(--line); background: transparent; color: var(--muted); border-radius: 9px; font: 600 13px var(--font-body); cursor: pointer; }
</style>
