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
  let findText = $state(''); // client-side filter over the loaded page

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

  const isFailed = $derived(filter === 'failed');
  const isBlock = $derived(filter === 'blacklist');
  const modeNoun = $derived(isFailed ? 'failure' : isBlock ? 'blocked release' : 'import');

  const srcColor = (s) => s === 'usenet' ? 'var(--green)' : s === 'torrent' ? 'var(--cyan)' : s === 'web' ? 'var(--accent)' : '#6f6885';

  // Per-mode timestamp parsing (epoch ts for imports; UTC strings otherwise).
  function tsOf(it) {
    if (isFailed) return new Date(String(it.grabbed_at).replace(' ', 'T') + 'Z');
    if (isBlock) return new Date(String(it.created_at).replace(' ', 'T') + 'Z');
    return new Date(Number(it.ts));
  }

  const filtered = $derived.by(() => {
    const q = findText.trim().toLowerCase();
    if (!q) return items;
    return items.filter((it) => `${it.series_title || it.title || ''} ${it.title || ''} ${it.reason || ''} ${it.error || ''}`.toLowerCase().includes(q));
  });

  function dayLabel(d) {
    const now = new Date();
    if (d.toDateString() === now.toDateString()) return 'Today';
    const y = new Date(now); y.setDate(now.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return 'Yesterday';
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  }
  // Group the loaded rows by calendar day, preserving order.
  const days = $derived.by(() => {
    const groups = []; let cur = null;
    for (const it of filtered) {
      const d = tsOf(it); const label = dayLabel(d);
      if (!cur || cur.label !== label) { cur = { label, rows: [] }; groups.push(cur); }
      cur.rows.push({ it, ts: d });
    }
    return groups;
  });

  // Mode-aware stat tiles.
  const stats = $derived.by(() => {
    const srcCounts = {};
    for (const it of items) { const k = it.source || 'unknown'; srcCounts[k] = (srcCounts[k] || 0) + 1; }
    const bySrc = Object.entries(srcCounts).map(([k, n]) => ({ label: k, value: fmt(n), tone: srcColor(k) }));
    if (isFailed) return [{ label: 'Failures', value: fmt(total), tone: 'var(--red)' }, ...bySrc];
    if (isBlock) return [{ label: 'Blocked', value: fmt(total), tone: 'var(--amber)' }];
    return [{ label: 'Imports', value: fmt(total), tone: 'var(--green)' }, ...bySrc];
  });

  const empty = $derived(
    isFailed ? { icon: 'alert-triangle', title: 'No failed downloads', body: 'Downloads that error out are recorded here — the record persists even after the queue clears.' }
    : isBlock ? { icon: 'ban', title: 'Nothing blocked', body: 'Failed usenet releases land here so future searches skip them. Remove one to make it eligible again.' }
    : { icon: 'clock', title: 'Nothing imported yet', body: 'This fills in as downloads land. Imports handled by the background monitor are tracked here.' });
</script>

<main id="history-page" class="scan-page history-page histx">
  <div class="histx__top">
    <div class="histx__head">
      <button id="history-back" class="histx__iconbtn" aria-label="Back" onclick={goBack}><Icon name="arrow-left" size={16} /></button>
      <h2 class="histx__title">History</h2>
      <span id="history-summary" class="histx__summary">{fmt(total)} {modeNoun}{total === 1 ? '' : 's'}</span>
      <div class="histx__right">
        <div class="histx__find">
          <Icon name="search" size={15} />
          <input placeholder="Filter…" bind:value={findText} spellcheck="false" />
        </div>
        {#if isBlock && items.length}
          <button id="blacklist-clear" class="histx__clear" onclick={clearBlacklist}>Clear all</button>
        {/if}
      </div>
    </div>

    <div class="histx__stats">
      {#each stats as st (st.label)}
        <div class="histx__stat">
          <div class="histx__stat-lbl"><span class="histx__stat-dot" style="background:{st.tone};"></span>{st.label}</div>
          <div class="histx__stat-val">{st.value}</div>
        </div>
      {/each}
    </div>

    <div class="histx__chips">
      {#each ['all', ...sources] as sc (sc)}
        <button class="histx__chip" class:is-active={filter === sc} onclick={() => setQuery({ src: sc === 'all' ? null : sc })}>
          {#if sc !== 'all' && filter !== sc}<span class="histx__chip-dot" style="background:{srcColor(sc)};"></span>{/if}{sc === 'all' ? 'All' : sc}
        </button>
      {/each}
      <div class="histx__divider"></div>
      <button class="histx__chip histx__chip--fail" class:is-active={isFailed} onclick={() => setQuery({ src: 'failed' })}><Icon name="alert-triangle" size={14} /> Failed</button>
      <button class="histx__chip histx__chip--block" class:is-active={isBlock} onclick={() => setQuery({ src: 'blacklist' })}><Icon name="ban" size={14} /> Blocklist</button>
    </div>
  </div>

  <div class="histx__scroll">
    <div id="history-list" class="histx__inner">
      {#if loaded && !filtered.length}
        <div class="histx__empty">
          <div class="histx__empty-art"><Icon name={empty.icon} size={26} /></div>
          <div class="histx__empty-title">{empty.title}</div>
          <p class="histx__empty-body">{empty.body}</p>
        </div>
      {/if}

      {#each days as d (d.label)}
        <div class="histx__day">{d.label}</div>
        {#each d.rows as { it, ts } (it.id ?? (it.series_id + '' + ts.getTime()))}
          {@const tone = isFailed ? 'var(--red)' : isBlock ? 'var(--amber)' : 'var(--green)'}
          <div class="histx__row" title={it.path || ts.toLocaleString()}>
            <span class="histx__ico" style="color:{tone}; background:color-mix(in srgb, {tone} 12%, transparent);">
              <Icon name={isFailed ? 'close' : isBlock ? 'ban' : 'check'} size={15} />
            </span>
            <div class="histx__main">
              <div class="histx__line">
                {#if it.series_id}
                  <a class="histx__link" href={'/volume/' + it.series_id} onclick={(e) => { e.preventDefault(); navigate('/volume/' + it.series_id); }}>{it.series_title || it.title || '?'}</a>
                {:else}<span class="histx__t">{it.series_title || it.title || it.title_norm || '?'}</span>{/if}
                <span class="histx__num">{it.issue_number != null && it.issue_number !== '' ? ` #${it.issue_number}` : ''}</span>
              </div>
              {#if isFailed && it.error}<div class="histx__detail histx__detail--err">{it.error}</div>
              {:else if isBlock && it.title && it.title !== it.series_title}<div class="histx__detail histx__detail--mono">{it.title}{#if it.reason} · {it.reason}{/if}</div>
              {:else if isBlock && it.reason}<div class="histx__detail">{it.reason}</div>{/if}
            </div>
            <span class="histx__time" title={ts.toLocaleString()}>{ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            {#if isBlock}
              <button class="histx__remove" title="Remove from blocklist — allow auto-grab again" onclick={() => removeBlacklisted(it.id)}>Remove</button>
            {/if}
            <span class="histx__src" style="color:{srcColor(it.source)}; border-color:color-mix(in srgb, {srcColor(it.source)} 45%, transparent); background:color-mix(in srgb, {srcColor(it.source)} 12%, transparent);">{it.source || '?'}</span>
          </div>
        {/each}
      {/each}

      <button id="history-more" class="histx__more" hidden={items.length >= total} onclick={() => renderHistory({ append: true })}>Load more</button>
    </div>
  </div>
</main>

<style>
  .histx { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .histx__top { flex: none; padding: 16px 22px 0; }
  .histx__head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .histx__iconbtn { width: 36px; height: 36px; display: grid; place-items: center; border: 1px solid var(--line); background: transparent; color: var(--muted); border-radius: 8px; cursor: pointer; }
  .histx__iconbtn:hover { color: var(--text); }
  .histx__title { margin: 0; font-family: var(--font-display); font-size: 24px; letter-spacing: .03em; font-weight: 400; }
  .histx__summary { font: 12px var(--font-mono); color: var(--faint); }
  .histx__right { margin-left: auto; display: flex; align-items: center; gap: 10px; }
  .histx__find { position: relative; display: flex; align-items: center; color: var(--faint); }
  .histx__find :global(svg) { position: absolute; left: 11px; pointer-events: none; }
  .histx__find input { height: 36px; width: 170px; max-width: 40vw; padding: 0 12px 0 34px; background: var(--ink); border: 1px solid var(--line); border-radius: 8px; color: var(--text); font: 13px var(--font-body); }
  .histx__find input:focus { outline: none; border-color: var(--accent); }
  .histx__clear { height: 36px; padding: 0 14px; border: 1px solid rgba(255,90,82,.4); background: rgba(255,90,82,.08); color: var(--red); border-radius: 8px; font: 600 12.5px var(--font-body); cursor: pointer; }

  .histx__stats { display: flex; gap: 10px; margin-top: 16px; overflow-x: auto; padding-bottom: 2px; scrollbar-width: none; }
  .histx__stats::-webkit-scrollbar { display: none; }
  .histx__stat { flex: none; min-width: 120px; background: rgba(255,255,255,.015); border: 1px solid var(--line); border-radius: 11px; padding: 11px 14px; }
  .histx__stat-lbl { display: flex; align-items: center; gap: 7px; font-size: 10.5px; text-transform: uppercase; letter-spacing: .08em; color: var(--faint); }
  .histx__stat-dot { width: 7px; height: 7px; border-radius: 50%; }
  .histx__stat-val { font: 700 21px var(--font-body); margin-top: 6px; }

  .histx__chips { display: flex; gap: 8px; margin-top: 14px; padding-bottom: 14px; border-bottom: 1px solid var(--line); overflow-x: auto; align-items: center; scrollbar-width: none; }
  .histx__chips::-webkit-scrollbar { display: none; }
  .histx__chip { display: inline-flex; align-items: center; gap: 7px; height: 34px; padding: 0 14px; border-radius: 8px; border: 1px solid var(--line); background: transparent; color: var(--muted); font: 600 12.5px var(--font-body); cursor: pointer; white-space: nowrap; flex: none; text-transform: capitalize; }
  .histx__chip.is-active { background: var(--accent); border-color: var(--accent); color: #fff; }
  .histx__chip-dot { width: 7px; height: 7px; border-radius: 50%; }
  .histx__divider { width: 1px; height: 22px; background: var(--line); flex: none; margin: 0 2px; }
  .histx__chip--fail.is-active { background: rgba(255,90,82,.12); border-color: var(--red); color: var(--red); }
  .histx__chip--block.is-active { background: rgba(255,194,75,.12); border-color: var(--amber); color: var(--amber); }

  .histx__scroll { flex: 1; overflow-y: auto; padding: 6px 22px 60px; }
  .histx__inner { max-width: 900px; margin: 0 auto; }
  .histx__day { position: sticky; top: 0; z-index: 2; background: var(--ink); padding: 14px 2px 8px; font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: #6f6885; }
  .histx__row { display: flex; align-items: center; gap: 13px; padding: 10px 12px; border-radius: 9px; }
  .histx__row:hover { background: rgba(255,255,255,.025); }
  .histx__ico { width: 28px; height: 28px; border-radius: 8px; flex: none; display: grid; place-items: center; }
  .histx__main { flex: 1; min-width: 0; }
  .histx__line { font-size: 13.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .histx__link { font-weight: 600; color: var(--text); }
  .histx__link:hover { color: var(--accent); }
  .histx__t { font-weight: 600; }
  .histx__num { color: var(--faint); font-weight: 500; }
  .histx__detail { font-size: 11.5px; color: var(--faint); margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .histx__detail--err { color: var(--red); }
  .histx__detail--mono { font-family: var(--font-mono); }
  .histx__time { font: 11px var(--font-mono); color: #6f6885; flex: none; }
  .histx__remove { opacity: .4; height: 28px; padding: 0 11px; border: 1px solid var(--line); background: transparent; color: var(--muted); border-radius: 7px; font: 600 11.5px var(--font-body); cursor: pointer; flex: none; transition: opacity .12s; }
  .histx__row:hover .histx__remove { opacity: 1; }
  .histx__remove:hover { color: var(--text); }
  .histx__src { font: 600 10px var(--font-body); text-transform: uppercase; letter-spacing: .04em; border: 1px solid; border-radius: 5px; padding: 2px 7px; flex: none; }

  .histx__empty { padding: 70px 20px; text-align: center; }
  .histx__empty-art { width: 52px; height: 52px; margin: 0 auto 14px; border-radius: 14px; background: var(--panel-2); display: grid; place-items: center; color: #6f6885; }
  .histx__empty-title { font-size: 14.5px; font-weight: 600; margin-bottom: 6px; }
  .histx__empty-body { font-size: 13px; color: var(--faint); margin: 0 auto; max-width: 380px; line-height: 1.55; }
  .histx__more { display: block; margin: 14px auto 0; height: 38px; padding: 0 20px; border: 1px solid var(--line); background: transparent; color: var(--muted); border-radius: 9px; font: 600 13px var(--font-body); cursor: pointer; }
</style>
