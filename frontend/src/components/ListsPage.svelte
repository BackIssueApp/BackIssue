<script>
  // Reading lists: personal, ordered, cross-series runs of issues — hand-built
  // (from the volume page's "Add to list") or imported from a ComicVine story
  // arc. Overview at /lists; a selected list rides ?list=<id>.
  import { goBack, navigate, route, setQuery } from '../lib/router.svelte.js';
  import { apiGet, apiPost, apiPatch, apiDelete } from '../lib/api.js';
  import { notify } from '../lib/toasts.svelte.js';
  import { confirmDialog, inputDialog } from './DialogModal.svelte';
  import { issueActions, issueActionsTick, issueCoverProviders } from '../lib/plugins.svelte.js';
  import { can, isTrusted } from '../lib/auth.svelte.js';
  import { fmt } from '../lib/util.js';
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

<main id="lists-page" class="scan-page lists-page">
  <div class="scan-page__bar">
    {#if det}
      <button class="btn btn--ghost" onclick={() => setQuery({ list: null })}><Icon name="arrow-left" /> Lists</button>
      <h2 class="scan-page__title">{det.name}</h2>
      <span class="scan-summary muted">{rows.filter((r) => r.owned).length}/{rows.length} owned{det.arc_cv_id ? ' · from a ComicVine arc' : ''}</span>
      {#if missing.length && can('downloads.grab')}
        <button class="btn btn--ghost" onclick={downloadMissing}><Icon name="download" /> Download missing ({fmt(missing.length)})</button>
      {/if}
    {:else}
      <button class="btn btn--ghost" onclick={goBack}><Icon name="arrow-left" /> Back</button>
      <h2 class="scan-page__title">Reading lists</h2>
      <span class="scan-summary muted">{loaded ? `${lists.length} list${lists.length === 1 ? '' : 's'}` : ''}</span>
      <button class="btn btn--primary btn--sm" onclick={createList}>+ New list</button>
      <button class="btn btn--ghost btn--sm" onclick={() => { arcResults = arcResults === null ? [] : null; }}><Icon name="diamond" /> Import story arc</button>
    {/if}
  </div>

  <div class="lists-scroll">
    {#if !det && arcResults !== null}
      <div class="arc-import">
        <form class="arc-import__form" onsubmit={(e) => { e.preventDefault(); searchArcs(); }}>
          <input type="search" placeholder="Search ComicVine story arcs… (e.g. Infinity Gauntlet)" bind:value={arcQ} />
          <button class="btn btn--primary btn--sm" disabled={arcBusy}>{arcBusy ? 'Working…' : 'Search'}</button>
        </form>
        {#each arcResults as a (a.id)}
          <div class="arc-hit">
            {#if a.image_url}<img src={a.image_url} alt="" loading="lazy" referrerpolicy="no-referrer" />{/if}
            <div class="arc-hit__info">
              <b>{a.name}</b>
              <small class="muted">{[a.publisher, a.issues ? `${fmt(a.issues)} issues` : null].filter(Boolean).join(' · ')}</small>
              {#if a.deck}<small class="muted">{a.deck}</small>{/if}
            </div>
            <button class="btn btn--ghost btn--sm" disabled={arcBusy} onclick={() => importArc(a)}>Import</button>
          </div>
        {/each}
      </div>
    {/if}

    {#if det}
      {#if !rows.length}
        <div class="list-note">This list is empty — add issues from any series page ("<Icon name="menu" /> Add to list").</div>
      {/if}
      {#each rows as it, idx (it.cv_issue_id)}
        <div class="listitem" class:is-owned={it.owned}>
          <span class="listitem__pos muted">{idx + 1}</span>
          <div class="listitem__cover">
            {#if coverOf(it)}<img src={coverOf(it)} alt="" loading="lazy" referrerpolicy="no-referrer" />{/if}
          </div>
          <div class="listitem__main">
            {#if it.series_id}
              <a class="listitem__series" href={'/volume/' + it.series_id}
                 onclick={(e) => { e.preventDefault(); navigate('/volume/' + it.series_id); }}>{it.series_title || 'Unknown series'}</a>
            {:else}
              <span class="listitem__series">{it.series_title || 'Unknown series'}</span>
            {/if}
            <span class="listitem__issue">#{it.issue_number ?? '?'}{it.title ? ` — ${it.title}` : ''}</span>
            <small class="muted">{it.cover_date || ''}</small>
          </div>
          <span class="listitem__state">
            {#if it.owned}<span class="badge badge--done"><span class="dot"></span>owned</span>
            {:else if it.series_id}<span class="badge badge--queued"><span class="dot"></span>missing</span>
            {:else}<span class="badge"><span class="dot"></span>not in library</span>{/if}
          </span>
          {#each issueActions as a (a.id + ':' + issueActionsTick.n)}
            {#if !a.when || a.when(it)}
              <button class="listitem__btn" title={typeof a.title === 'function' ? a.title(it) : a.title}
                onclick={() => a.run(it, null)}>{@html typeof a.icon === 'function' ? a.icon(it) : a.icon}</button>
            {/if}
          {/each}
          {#if !it.owned && it.series_id && can('downloads.grab')}
            <button class="listitem__btn" title="Download this issue" onclick={() => downloadItem(it)}><Icon name="download" /></button>
          {:else if !it.series_id && it.cv_series_id && isTrusted()}
            <button class="btn btn--ghost btn--sm" disabled={addingSeries === it.cv_series_id}
              title="Add this series to the library so its issues can be downloaded"
              onclick={() => addSeries(it)}>{addingSeries === it.cv_series_id ? 'Adding…' : '+ Add series'}</button>
          {/if}
          <span class="listitem__order">
            <button class="listitem__btn" title="Move up" disabled={idx === 0} onclick={() => move(idx, -1)}><Icon name="arrow-up" /></button>
            <button class="listitem__btn" title="Move down" disabled={idx === rows.length - 1} onclick={() => move(idx, 1)}><Icon name="arrow-down" /></button>
          </span>
          <button class="listitem__btn listitem__btn--danger" title="Remove from list" onclick={() => removeItem(it)}><Icon name="close" /></button>
        </div>
      {/each}
    {:else}
      {#if loaded && !lists.length && arcResults === null}
        <div class="list-note">No reading lists yet. Build one from any series page ("<Icon name="menu" /> Add to list"), or import a ComicVine story arc.</div>
      {/if}
      {#each lists as l (l.id)}
        <div class="listcard" role="button" tabindex="0"
          onclick={() => setQuery({ list: l.id })}
          onkeydown={(e) => { if (e.key === 'Enter') setQuery({ list: l.id }); }}>
          <div class="listcard__main">
            <b>{l.name}</b>
            <small class="muted">{fmt(l.items)} issue{l.items === 1 ? '' : 's'} · {fmt(l.owned)} owned{l.arc_cv_id ? ' · ComicVine arc' : ''}</small>
          </div>
          <div class="listcard__bar"><span style="width:{l.items ? Math.round((l.owned / l.items) * 100) : 0}%"></span></div>
          <button class="btn btn--ghost btn--sm" onclick={(e) => { e.stopPropagation(); renameList(l); }}>Rename</button>
          <button class="btn btn--ghost btn--sm btn--danger" onclick={(e) => { e.stopPropagation(); deleteList(l); }}>Delete</button>
        </div>
      {/each}
    {/if}
  </div>
</main>
