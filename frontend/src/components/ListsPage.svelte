<script>
  // Reading lists: personal, ordered, cross-series runs of issues — hand-built
  // (from the volume page's "Add to list") or imported from a ComicVine story
  // arc. Two-pane master-detail; a selected list rides ?list=<id>.
  import { goBack, navigate, route, setQuery } from '../lib/router.svelte.js';
  import { apiGet, apiPost, apiPatch, apiDelete } from '../lib/api.js';
  import { notify } from '../lib/toasts.svelte.js';
  import { confirmDialog, inputDialog } from './DialogModal.svelte';
  import { issueActions, issueActionsTick, issueCoverProviders } from '../lib/plugins.svelte.js';
  import { can, isTrusted } from '../lib/auth.svelte.js';
  import { fmt } from '../lib/util.js';
  import Cover from './Cover.svelte';
  import Icon from '../lib/Icon.svelte';

  let { active = false } = $props();
  let lists = $state([]);
  let det = $state(null);
  let loaded = $state(false);
  // arc import
  let arcQ = $state('');
  let arcResults = $state(null); // null = closed panel, [] = searched + empty
  let arcBusy = $state(false);

  const listId = $derived.by(() => Number(new URLSearchParams(route.search).get('list')) || null);
  const arcOpen = $derived(arcResults !== null && !listId);

  async function refresh() {
    try {
      const r = await apiGet('/api/lists');
      if (!r.error) { lists = r.lists || []; loaded = true; }
      if (listId) {
        const d = await apiGet('/api/lists/' + listId);
        det = d.error ? null : d;
      } else det = null;
    } catch { /* keep last */ }
  }
  $effect(() => { if (active) { void listId; refresh(); } });

  // Rows in the shape plugin issue-actions expect ({owned, corrupt,
  // cv_issue_id, number}) so the reader's ▶/✓ buttons and covers just work.
  const rows = $derived((det?.items || []).map((it) => ({
    ...it,
    number: it.issue_number,
    owned: !!it.owned,
    corrupt: !!it.corrupt,
  })));
  const ownedCount = $derived(rows.filter((r) => r.owned).length);
  const detPct = $derived(rows.length ? Math.round((ownedCount / rows.length) * 100) : 0);
  const missing = $derived(rows.filter((r) => !r.owned && r.series_id));
  const coverOf = (i) => {
    for (const fn of issueCoverProviders) { const u = fn(i); if (u) return u; }
    return i.image_url || null;
  };

  async function createList() {
    const name = await inputDialog({ title: 'New reading list', placeholder: 'e.g. Sunday backlog', confirmLabel: 'Create' });
    if (!name) return;
    const r = await apiPost('/api/lists', { name });
    if (r.error) return notify(r.error, 'error');
    setQuery({ list: r.id });
    refresh();
  }
  async function renameList(l) {
    const name = await inputDialog({ title: 'Rename list', value: l.name, confirmLabel: 'Rename' });
    if (!name || name === l.name) return;
    const r = await apiPatch('/api/lists/' + l.id, { name });
    if (r.error) return notify(r.error, 'error');
    refresh();
  }
  async function deleteList(l) {
    if (!(await confirmDialog({
      title: `Delete "${l.name}"?`,
      message: 'The list is removed — your comics and read history are untouched.',
      confirmLabel: 'Delete', danger: true,
    }))) return;
    const r = await apiDelete('/api/lists/' + l.id);
    if (r.error) return notify(r.error, 'error');
    if (listId === l.id) setQuery({ list: null });
    refresh();
  }

  async function removeItem(it) {
    const r = await apiDelete(`/api/lists/${det.id}/items/${it.cv_issue_id}`);
    if (r?.error) return notify(r.error, 'error');
    refresh();
  }
  async function move(idx, dir) {
    const order = rows.map((r) => r.cv_issue_id);
    const [x] = order.splice(idx, 1);
    order.splice(idx + dir, 0, x);
    const r = await apiPatch('/api/lists/' + det.id, { order });
    if (r.error) return notify(r.error, 'error');
    refresh();
  }

  // Add the item's volume to the library (arc imports reference series we
  // may not track yet). Server-side this is a library.manage mutation — the
  // button only renders for roles that hold it.
  let addingSeries = $state(0); // cv_series_id in flight
  async function addSeries(it) {
    addingSeries = it.cv_series_id;
    const r = await apiPost('/api/collection/add-cv', { comicvineId: it.cv_series_id });
    addingSeries = 0;
    if (r.error) return notify(r.error, 'error');
    notify(`Added "${it.series_title || 'series'}" to the library.`, 'ok');
    refresh(); // every item of that series resolves its series_id now
  }

  async function downloadItem(it) {
    const r = await apiPost(`/api/collection/${it.series_id}/download`, { cvIssueIds: [it.cv_issue_id] });
    if (r.error) return notify(r.error, 'error');
    notify(`Queued ${it.series_title || ''} #${it.issue_number ?? '?'}`, 'ok');
  }
  async function downloadMissing() {
    const bySeries = new Map();
    for (const it of missing) {
      if (!bySeries.has(it.series_id)) bySeries.set(it.series_id, []);
      bySeries.get(it.series_id).push(it.cv_issue_id);
    }
    for (const [sid, ids] of bySeries) await apiPost(`/api/collection/${sid}/download`, { cvIssueIds: ids });
    notify(`Queued ${fmt(missing.length)} issue(s) from ${bySeries.size} series.`, 'ok');
  }

  // ---- story-arc import ----
  function toggleArc() { arcResults = arcResults === null ? [] : null; arcQ = ''; if (arcResults !== null && listId) setQuery({ list: null }); }
  async function searchArcs() {
    if (!arcQ.trim()) return;
    arcBusy = true;
    const r = await apiGet('/api/cv/arcs?q=' + encodeURIComponent(arcQ.trim()));
    arcBusy = false;
    if (r.error) return notify(r.error, 'error');
    arcResults = r.arcs || [];
  }
  async function importArc(a) {
    arcBusy = true;
    const r = await apiPost('/api/lists/import-arc', { arcId: a.id });
    arcBusy = false;
    if (r.error) return notify(r.error, 'error');
    notify(`Imported "${a.name}" — ${fmt(r.issues)} issues in cover-date order.`, 'ok');
    arcResults = null; arcQ = '';
    setQuery({ list: r.id });
    refresh();
  }
</script>

<section class="scan-page lists-page">
  <div class="listx" class:has-detail={!!listId || arcOpen}>
  <!-- RAIL: lists overview -->
  <aside class="listx__rail">
    <div class="listx__rail-head">
      <div class="listx__rail-top">
        <button class="listx__iconbtn" aria-label="Back" onclick={goBack}><Icon name="arrow-left" size={16} /></button>
        <div class="listx__rail-title">Reading lists</div>
        <span class="listx__rail-count">{loaded ? `${lists.length} list${lists.length === 1 ? '' : 's'}` : ''}</span>
      </div>
      <div class="listx__rail-actions">
        <button class="listx__new" onclick={createList}><Icon name="plus" size={14} /> New list</button>
        <button class="listx__arcbtn" class:is-on={arcResults !== null} onclick={toggleArc}><Icon name="diamond" size={14} /> Import arc</button>
      </div>
    </div>
    <div class="listx__rail-scroll">
      {#if loaded && !lists.length}
        <div class="listx__rail-empty">
          <div class="listx__rail-empty-art"><Icon name="list" size={22} /></div>
          <div>No reading lists yet. Create one, add issues from any series page, or import a ComicVine story arc.</div>
        </div>
      {/if}
      {#each lists as l (l.id)}
        {@const pct = l.items ? Math.round((l.owned / l.items) * 100) : 0}
        <button class="listx__card" class:is-active={listId === l.id} onclick={() => { arcResults = null; setQuery({ list: l.id }); }}>
          <div class="listx__card-top">
            <span class="listx__card-name">{l.name}</span>
            {#if l.arc_cv_id}<span class="listx__card-arc" title="From a ComicVine story arc"><Icon name="diamond" size={13} /></span>{/if}
          </div>
          <div class="listx__card-prog">
            <span class="listx__card-track"><span class="listx__card-fill" class:is-done={pct >= 100} style="width:{pct}%"></span></span>
            <span class="listx__card-num">{fmt(l.owned)}/{fmt(l.items)}</span>
          </div>
        </button>
      {/each}
    </div>
  </aside>

  <!-- DETAIL -->
  <div class="listx__detail">
    {#if arcOpen}
      <div class="listx__scroll">
        <div class="listx__arc">
          <div class="listx__arc-head"><span class="listx__arc-ico"><Icon name="diamond" size={16} /></span><div class="listx__arc-title">Import a story arc</div></div>
          <p class="listx__arc-sub">Search ComicVine for a story arc — its issues import as a new list in cover-date order.</p>
          <form class="listx__arc-form" onsubmit={(e) => { e.preventDefault(); searchArcs(); }}>
            <div class="listx__arc-field">
              <Icon name="search" size={15} />
              <input placeholder="e.g. Infinity Gauntlet" bind:value={arcQ} spellcheck="false" />
            </div>
            <button class="listx__arc-go" disabled={arcBusy}>{arcBusy ? 'Working…' : 'Search'}</button>
          </form>
          {#each arcResults as a (a.id)}
            <div class="listx__arc-hit">
              <div class="listx__arc-cover"><Cover coverUrl={a.image_url} title={a.name || '?'} /></div>
              <div class="listx__arc-info">
                <div class="listx__arc-name">{a.name}</div>
                <div class="listx__arc-meta">{[a.publisher, a.issues ? `${fmt(a.issues)} issues` : null].filter(Boolean).join(' · ')}</div>
                {#if a.deck}<div class="listx__arc-deck">{a.deck}</div>{/if}
              </div>
              <button class="listx__arc-import" disabled={arcBusy} onclick={() => importArc(a)}>Import</button>
            </div>
          {/each}
          {#if arcResults.length === 0 && arcQ.trim()}<div class="listx__arc-empty">No arcs found for “{arcQ}”.</div>{/if}
        </div>
      </div>
    {:else if det}
      <div class="listx__dhead">
        <button class="listx__iconbtn listx__back" aria-label="Lists" onclick={() => setQuery({ list: null })}><Icon name="arrow-left" size={16} /></button>
        <div class="listx__dtitle-wrap">
          <div class="listx__dtitle-row">
            <span class="listx__dtitle">{det.name}</span>
            {#if isTrusted()}<button class="listx__edit" title="Rename list" onclick={() => renameList(det)}><Icon name="edit" size={15} /></button>{/if}
          </div>
          <div class="listx__dsummary">{ownedCount}/{rows.length} owned{det.arc_cv_id ? ' · from a ComicVine arc' : ''}</div>
        </div>
        <div class="listx__dactions">
          {#if missing.length && can('downloads.grab')}
            <button class="listx__dl" onclick={downloadMissing}><Icon name="download" size={15} /> Download missing ({fmt(missing.length)})</button>
          {/if}
          <button class="listx__del" onclick={() => deleteList(det)}>Delete</button>
        </div>
      </div>
      <div class="listx__dbar"><span class="listx__dbar-track"><span class="listx__dbar-fill" class:is-done={detPct >= 100} style="width:{detPct}%"></span></span><span class="listx__dbar-num">{detPct}% read</span></div>
      <div class="listx__scroll">
        <div class="listx__items">
          {#if !rows.length}
            <div class="listx__d-empty">
              <div class="listx__d-empty-art"><Icon name="list" size={22} /></div>
              <div>This list is empty — add issues from any series page (“Add to list”).</div>
            </div>
          {/if}
          {#each rows as it, idx (it.cv_issue_id)}
            {@const st = it.owned ? 'owned' : it.series_id ? 'missing' : 'notlib'}
            <div class="listx__item">
              <span class="listx__pos">{idx + 1}</span>
              <div class="listx__cover"><Cover coverUrl={coverOf(it)} title={it.series_title || '?'} /></div>
              <div class="listx__imain">
                {#if it.series_id}
                  <a class="listx__iseries" href={'/volume/' + it.series_id} onclick={(e) => { e.preventDefault(); navigate('/volume/' + it.series_id); }}>{it.series_title || 'Unknown series'} <span class="listx__inum">#{it.issue_number ?? '?'}</span></a>
                {:else}<span class="listx__iseries">{it.series_title || 'Unknown series'} <span class="listx__inum">#{it.issue_number ?? '?'}</span></span>{/if}
                <div class="listx__isub">{[it.title, it.cover_date].filter(Boolean).join(' · ')}</div>
              </div>
              <span class="listx__badge listx__badge--{st}">{st === 'owned' ? 'Owned' : st === 'missing' ? 'Missing' : 'Not in library'}</span>
              <div class="listx__iact">
                {#each issueActions as a (a.id + ':' + issueActionsTick.n)}
                  {#if !a.when || a.when(it)}
                    <button class="listx__ibtn" title={typeof a.title === 'function' ? a.title(it) : a.title} onclick={() => a.run(it, null)}>{@html typeof a.icon === 'function' ? a.icon(it) : a.icon}</button>
                  {/if}
                {/each}
                {#if !it.owned && it.series_id && can('downloads.grab')}
                  <button class="listx__ibtn" title="Download this issue" onclick={() => downloadItem(it)}><Icon name="download" size={14} /></button>
                {:else if !it.series_id && it.cv_series_id && isTrusted()}
                  <button class="listx__addbtn" disabled={addingSeries === it.cv_series_id} title="Add this series to the library so its issues can be downloaded" onclick={() => addSeries(it)}>{addingSeries === it.cv_series_id ? 'Adding…' : '+ Add series'}</button>
                {/if}
                <button class="listx__ibtn" title="Move up" disabled={idx === 0} onclick={() => move(idx, -1)}><Icon name="arrow-up" size={14} /></button>
                <button class="listx__ibtn" title="Move down" disabled={idx === rows.length - 1} onclick={() => move(idx, 1)}><Icon name="arrow-down" size={14} /></button>
                <button class="listx__ibtn" title="Remove from list" onclick={() => removeItem(it)}><Icon name="close" size={14} /></button>
              </div>
            </div>
          {/each}
        </div>
      </div>
    {:else}
      <div class="listx__placeholder">
        <div class="listx__ph-art"><Icon name="list" size={26} /></div>
        <div class="listx__ph-title">Pick a list</div>
        <p class="listx__ph-body">Select a reading list on the left, or create a new one to start collecting issues into an ordered run.</p>
      </div>
    {/if}
  </div>
  </div>
</section>

<style>
  .listx { display: grid; grid-template-columns: 300px 1fr; flex: 1; min-height: 0; }
  .listx__rail { border-right: 1px solid var(--line); display: flex; flex-direction: column; min-height: 0; }
  .listx__rail-head { flex: none; padding: 16px 16px 12px; }
  .listx__rail-top { display: flex; align-items: center; gap: 11px; }
  .listx__iconbtn { width: 34px; height: 34px; display: grid; place-items: center; border: 1px solid var(--line); background: transparent; color: var(--muted); border-radius: 8px; cursor: pointer; flex: none; }
  .listx__iconbtn:hover { color: var(--text); }
  .listx__rail-title { font-family: var(--font-display); font-size: 21px; letter-spacing: .03em; }
  .listx__rail-count { margin-left: auto; font: 11px var(--font-mono); color: var(--faint); }
  .listx__rail-actions { display: flex; gap: 8px; margin-top: 13px; }
  .listx__new { flex: 1; height: 36px; border: none; background: var(--accent); color: #fff; border-radius: 8px; font: 600 12.5px var(--font-body); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
  .listx__arcbtn { height: 36px; padding: 0 13px; border: 1px solid var(--line); background: transparent; color: var(--muted); border-radius: 8px; font: 600 12.5px var(--font-body); cursor: pointer; display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
  .listx__arcbtn.is-on { border-color: #a78bfa; background: rgba(167,139,250,.12); color: #a78bfa; }
  .listx__rail-scroll { flex: 1; overflow-y: auto; padding: 4px 12px 30px; }
  .listx__rail-empty { padding: 40px 16px; text-align: center; color: var(--faint); font-size: 13px; line-height: 1.55; }
  .listx__rail-empty-art { width: 46px; height: 46px; margin: 0 auto 12px; border-radius: 12px; background: var(--panel-2); display: grid; place-items: center; color: #6f6885; }
  .listx__card { display: block; width: 100%; text-align: left; border: 1px solid var(--line); background: rgba(255,255,255,.012); border-radius: 11px; padding: 12px 13px; margin-bottom: 9px; cursor: pointer; }
  .listx__card:hover { border-color: #4a4266; }
  .listx__card.is-active { border-color: var(--accent); background: rgba(255,45,111,.08); }
  .listx__card-top { display: flex; align-items: center; gap: 9px; }
  .listx__card-name { flex: 1; min-width: 0; font-size: 14px; font-weight: 600; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .listx__card-arc { color: #a78bfa; display: flex; flex: none; }
  .listx__card-prog { display: flex; align-items: center; gap: 9px; margin-top: 9px; }
  .listx__card-track { display: block; flex: 1; height: 5px; border-radius: 3px; background: var(--panel-2); overflow: hidden; }
  .listx__card-fill { display: block; height: 100%; background: var(--accent); }
  .listx__card-fill.is-done { background: var(--green); }
  .listx__card-num { font: 10.5px var(--font-mono); color: var(--faint); white-space: nowrap; }

  .listx__detail { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; }
  .listx__scroll { flex: 1; overflow-y: auto; }
  .listx__dhead { flex: none; display: flex; align-items: center; gap: 12px; padding: 16px 24px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
  .listx__back { display: none; }
  .listx__dtitle-wrap { min-width: 0; }
  .listx__dtitle-row { display: flex; align-items: center; gap: 9px; }
  .listx__dtitle { font-family: var(--font-display); font-size: 21px; letter-spacing: .03em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .listx__edit { width: 28px; height: 28px; display: grid; place-items: center; background: none; border: none; color: #6f6885; cursor: pointer; }
  .listx__edit:hover { color: var(--text); }
  .listx__dsummary { font: 11.5px var(--font-mono); color: var(--faint); margin-top: 3px; }
  .listx__dactions { margin-left: auto; display: flex; gap: 9px; }
  .listx__dl { height: 36px; padding: 0 15px; border: none; background: var(--accent); color: #fff; border-radius: 8px; font: 600 12.5px var(--font-body); cursor: pointer; display: inline-flex; align-items: center; gap: 7px; white-space: nowrap; }
  .listx__del { height: 36px; padding: 0 13px; border: 1px solid rgba(255,90,82,.35); background: transparent; color: var(--red); border-radius: 8px; font: 600 12.5px var(--font-body); cursor: pointer; }
  .listx__dbar { flex: none; padding: 14px 24px; border-bottom: 1px solid #221e2c; display: flex; align-items: center; gap: 14px; }
  .listx__dbar-track { display: block; flex: 1; height: 6px; border-radius: 3px; background: var(--panel-2); overflow: hidden; }
  .listx__dbar-fill { display: block; height: 100%; background: var(--accent); }
  .listx__dbar-fill.is-done { background: var(--green); }
  .listx__dbar-num { font: 12px var(--font-mono); color: var(--muted); }

  .listx__items { max-width: 820px; margin: 0 auto; padding: 10px 16px 60px; }
  .listx__item { display: flex; align-items: center; gap: 13px; padding: 9px 12px; border-radius: 10px; }
  .listx__item:hover { background: rgba(255,255,255,.025); }
  .listx__item:hover .listx__iact { opacity: 1; }
  .listx__pos { width: 22px; text-align: center; font: 12px var(--font-mono); color: #6f6885; flex: none; }
  .listx__cover :global(.cover) { width: 32px; height: 44px; border-radius: 5px; }
  .listx__imain { flex: 1; min-width: 0; }
  .listx__iseries { display: block; font-size: 13.5px; font-weight: 600; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  a.listx__iseries:hover { color: var(--accent); }
  .listx__inum { color: var(--faint); font-weight: 500; }
  .listx__isub { font-size: 11.5px; color: var(--faint); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .listx__badge { font: 600 10px var(--font-body); text-transform: uppercase; letter-spacing: .04em; border: 1px solid; border-radius: 5px; padding: 3px 8px; flex: none; }
  .listx__badge--owned { color: var(--green); border-color: rgba(95,211,138,.4); background: rgba(95,211,138,.1); }
  .listx__badge--missing { color: var(--amber); border-color: rgba(255,194,75,.4); background: rgba(255,194,75,.1); }
  .listx__badge--notlib { color: var(--muted); border-color: var(--line); background: rgba(255,255,255,.04); }
  .listx__iact { display: flex; gap: 4px; opacity: .4; transition: opacity .12s; flex: none; align-items: center; }
  .listx__ibtn { width: 28px; height: 28px; display: grid; place-items: center; border: 1px solid var(--line); background: transparent; color: var(--muted); border-radius: 7px; cursor: pointer; }
  .listx__ibtn:hover:not(:disabled) { color: var(--text); }
  .listx__ibtn:disabled { color: #4a4458; cursor: default; }
  .listx__ibtn :global(svg) { display: block; }
  .listx__addbtn { height: 28px; padding: 0 11px; border: 1px solid var(--line); background: var(--panel-2); color: var(--text); border-radius: 7px; font: 600 11.5px var(--font-body); cursor: pointer; white-space: nowrap; }

  .listx__d-empty, .listx__placeholder { text-align: center; color: var(--faint); }
  .listx__d-empty { padding: 60px 20px; font-size: 13px; }
  .listx__d-empty-art { width: 46px; height: 46px; margin: 0 auto 12px; border-radius: 12px; background: var(--panel-2); display: grid; place-items: center; color: #6f6885; }
  .listx__placeholder { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 40px; }
  .listx__ph-art { width: 54px; height: 54px; margin: 0 auto 14px; border-radius: 14px; background: var(--panel-2); display: grid; place-items: center; color: #6f6885; }
  .listx__ph-title { font-size: 15px; font-weight: 600; color: var(--text); margin-bottom: 6px; }
  .listx__ph-body { font-size: 13px; line-height: 1.55; margin: 0; max-width: 320px; }

  /* arc import panel */
  .listx__arc { max-width: 640px; margin: 0 auto; padding: 22px 26px 60px; }
  .listx__arc-head { display: flex; align-items: center; gap: 11px; margin-bottom: 6px; }
  .listx__arc-ico { width: 32px; height: 32px; border-radius: 9px; background: rgba(167,139,250,.15); color: #a78bfa; display: grid; place-items: center; }
  .listx__arc-title { font-family: var(--font-display); font-size: 20px; letter-spacing: .03em; }
  .listx__arc-sub { font-size: 13px; color: var(--faint); margin: 0 0 18px; line-height: 1.55; }
  .listx__arc-form { display: flex; gap: 8px; margin-bottom: 18px; }
  .listx__arc-field { position: relative; flex: 1; display: flex; align-items: center; color: var(--faint); }
  .listx__arc-field :global(svg) { position: absolute; left: 12px; pointer-events: none; }
  .listx__arc-field input { width: 100%; height: 42px; padding: 0 14px 0 38px; background: var(--ink); border: 1px solid var(--line); border-radius: 10px; color: var(--text); font: 14px var(--font-body); }
  .listx__arc-field input:focus { outline: none; border-color: var(--accent); }
  .listx__arc-go { height: 42px; padding: 0 20px; border: none; background: var(--accent); color: #fff; border-radius: 10px; font: 600 13px var(--font-body); cursor: pointer; }
  .listx__arc-hit { display: flex; align-items: center; gap: 14px; padding: 12px; border: 1px solid var(--line); border-radius: 11px; background: rgba(255,255,255,.012); margin-bottom: 10px; }
  .listx__arc-cover :global(.cover) { width: 44px; height: 60px; border-radius: 7px; }
  .listx__arc-info { flex: 1; min-width: 0; }
  .listx__arc-name { font-size: 14px; font-weight: 600; }
  .listx__arc-meta { font-size: 12px; color: var(--faint); margin-top: 3px; }
  .listx__arc-deck { font-size: 12px; color: var(--faint); margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .listx__arc-import { height: 34px; padding: 0 15px; border: 1px solid var(--line); background: var(--panel-2); color: var(--text); border-radius: 8px; font: 600 12.5px var(--font-body); cursor: pointer; flex: none; }
  .listx__arc-empty { padding: 34px; text-align: center; color: var(--faint); font-size: 13px; }

  @media (max-width: 820px) {
    .listx { display: block; }
    .listx__rail { height: 100%; border-right: none; }
    .listx__detail { display: none; height: 100%; }
    .listx.has-detail .listx__rail { display: none; }
    .listx.has-detail .listx__detail { display: flex; }
    .listx__back { display: grid; }
  }
</style>
