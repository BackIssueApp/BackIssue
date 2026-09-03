<script>
  // Reading lists: personal, ordered, cross-series runs of issues — hand-built
  // (from the volume page's "Add to list") or imported from a ComicVine story
  // arc. Two-pane master-detail; a selected list rides ?list=<id>.
  import { goBack, navigate, route, setQuery } from '../lib/router.svelte.js';
  import { apiGet, apiPost, apiPatch, apiDelete, apiPostText } from '../lib/api.js';
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
  // CBL import: a file of the user's own, or one from the community catalog
  let cblOpen = $state(false);
  let cblBusy = $state(false);
  let cblFiles = $state(null);   // null = not loaded yet
  let cblErr = $state('');
  let cblDir = $state([]);       // folder path within the catalog
  let cblQ = $state('');
  let cblResult = $state(null);  // last import summary (shows what couldn't be matched)
  let cblPage = $state(8);       // how many list cards are shown ("Show more" grows it)
  let cblDrag = $state(false);   // a file is being dragged over the drop zone
  let cblPreview = $state(null); // { name, total, owned, withIds, books, path | xml } — shown before importing
  let cblPreviewBusy = $state(false);
  let cblPrevPage = $state(60);
  let cblPrevFilter = $state('all');   // all | missing | noid | owned
  let cblPrevGroup = $state(true);     // collapse consecutive same-series runs

  const listId = $derived.by(() => Number(new URLSearchParams(route.search).get('list')) || null);
  const arcOpen = $derived(arcResults !== null && !listId);
  const cblShown = $derived(cblOpen && !listId);
  // "[Marvel] (2006-02) Civil War (Official).cbl" → "Civil War (Official)"
  const cblPretty = (p) => p.split('/').pop().replace(/\.cbl$/i, '').replace(/^\[[^\]]*\]\s*/, '').replace(/^\(\d{4}(?:-\d{2})?(?:-\d{2})?\)\s*/, '');
  const CBL_PAGE = 8;
  // Publisher accent for top-level folders and list tiles (theme tokens where
  // one fits; violet is this page's existing arc accent, orange has no token).
  const CBL_TONE = { Marvel: 'var(--red)', DC: 'var(--cyan)', Image: 'var(--green)', 'Dark Horse': 'var(--amber)', Vertigo: '#a78bfa', Valiant: '#ff8f3d' };
  const cblTone = (pub) => CBL_TONE[pub] || 'var(--faint)';
  // "Marvel/Events/Civil War/[Marvel] (2006-02) Civil War (Official).cbl" →
  // publisher from the [..] prefix, date from (YYYY-MM), title via cblPretty,
  // folders by splitting the path. All derived client-side; the API is just paths.
  const cblParse = (p) => {
    const base = p.split('/').pop().replace(/\.cbl$/i, '');
    const segs = p.split('/');
    // Some lists put a year range in the brackets instead of the publisher
    // ("[2007-2009] Secret Invasion …"); a bracket that starts with a year is
    // a date, and the publisher is then the top-level folder.
    const tag = (base.match(/^\[([^\]]*)\]/) || [, ''])[1];
    const tagIsDate = /^\d{4}/.test(tag);
    return {
      path: p, title: cblPretty(base), dir: segs.slice(0, -1),
      publisher: (!tagIsDate && tag) || segs[0] || 'Other',
      date: (base.match(/\((\d{4}(?:-\d{2})?)\)/) || [, ''])[1] || (tagIsDate ? tag : ''),
    };
  };
  const cblAll = $derived((cblFiles || []).map(cblParse));
  const cblSearching = $derived(!!cblQ.trim());
  // Catalog lists already imported: their list rows carry the repo path as `source`.
  const cblImported = $derived(new Set(lists.map((l) => l.source).filter(Boolean)));
  const cblInDir = (c) => cblDir.every((seg, i) => c.dir[i] === seg);
  // Sub-folders at the current level (none while searching — search flattens).
  const cblFolders = $derived.by(() => {
    if (cblSearching) return [];
    const map = new Map();
    for (const c of cblAll) {
      if (!cblInDir(c)) continue;
      const next = c.dir[cblDir.length];
      if (next == null) continue;
      const e = map.get(next) || { name: next, lists: 0, subs: new Set() };
      e.lists++;
      if (c.dir[cblDir.length + 1] != null) e.subs.add(c.dir[cblDir.length + 1]);
      map.set(next, e);
    }
    return [...map.values()].sort((a, b) => b.lists - a.lists).map((e) => ({
      name: e.name, lists: e.lists, subs: e.subs.size,
      tone: cblDir.length === 0 ? cblTone(e.name) : '#a78bfa',
    }));
  });
  // Lists at exactly this level when browsing; anywhere in the tree when searching.
  const cblHits = $derived.by(() => {
    if (cblSearching) {
      const words = cblQ.trim().toLowerCase().split(/\s+/);
      return cblAll.filter((c) => { const hay = (c.title + ' ' + c.dir.join(' ')).toLowerCase(); return words.every((w) => hay.includes(w)); });
    }
    return cblAll.filter((c) => c.dir.length === cblDir.length && cblInDir(c));
  });
  const cblVisible = $derived(cblHits.slice(0, cblPage));
  // Preview figures. `missing` = matched by id but not owned — the number that
  // answers "what will I get?"; `noId` books will be matched by name on import.
  const cblPrevNoId = $derived(cblPreview ? cblPreview.total - cblPreview.withIds : 0);
  const cblPrevMissing = $derived(cblPreview ? Math.max(0, cblPreview.total - cblPreview.owned - cblPrevNoId) : 0);
  const cblPrevFiltered = $derived.by(() => {
    if (!cblPreview) return [];
    const f = cblPrevFilter;
    return cblPreview.books.filter((b) => f === 'all' ? true : f === 'missing' ? (!b.owned && b.hasId) : f === 'noid' ? !b.hasId : b.owned);
  });
  // Group CONSECUTIVE same-series runs only — that's how CBL lists are built,
  // and it never reorders the reading order (each row keeps its number).
  const cblPrevRuns = $derived.by(() => {
    const runs = [];
    for (const b of cblPrevFiltered.slice(0, cblPrevPage)) {
      const key = b.series + '|' + (b.volume || '');
      const last = runs[runs.length - 1];
      if (cblPrevGroup && last && last.key === key) last.books.push(b);
      else runs.push({ key, series: b.series, volume: b.volume, books: [b] });
    }
    return runs.map((r) => ({
      ...r, owned: r.books.filter((b) => b.owned).length,
      range: r.books.length > 1 ? `#${r.books[0].number}–${r.books[r.books.length - 1].number}` : `#${r.books[0].number}`,
    }));
  });
  const cblState = (b) => (b.owned ? 'owned' : b.hasId ? 'missing' : 'byname');

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
  // Publish/unpublish. Gated on lists.share: sharing puts a list in front of
  // every user, so it isn't something any account can do.
  async function toggleShared(l) {
    const next = !l.public;
    const r = await apiPost(`/api/lists/${l.id}/public`, { public: next });
    if (r.error) return notify(r.error, 'error');
    l.public = next;
    notify(next ? 'Shared — every user can see this list.' : 'No longer shared.', 'ok');
    await load();
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
  function toggleArc() {
    cblOpen = false; arcResults = arcResults === null ? [] : null; arcQ = ''; if (arcResults !== null && listId) setQuery({ list: null }); }
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
  function toggleCbl() {
    cblOpen = !cblOpen;
    if (!cblOpen) return;
    arcResults = null;
    if (listId) setQuery({ list: null });
    if (cblFiles === null) loadCatalog();
  }
  async function loadCatalog() {
    cblErr = '';
    const r = await apiGet('/api/lists/cbl-catalog');
    if (r.error) { cblErr = r.error; cblFiles = []; return; }
    cblFiles = r.files || [];
  }
  // Both import paths land here. A clean import opens the new list; one with
  // unmatched books stays on the panel so the skipped issues are visible.
  function cblDone(r) {
    cblBusy = false;
    if (r.error) return notify(r.error, 'error');
    cblResult = r;
    const skipped = r.total - r.imported;
    notify(`Imported "${r.name}" — ${fmt(r.imported)} of ${fmt(r.total)} issues${skipped ? ` (${fmt(skipped)} couldn't be matched)` : ''}.`, skipped ? 'error' : 'ok');
    refresh();
    // Clean import: go straight to the list, and drop the result so the panel
    // comes back fresh (with the drop zone) next time it's opened.
    if (!skipped && !r.truncated) { cblResult = null; cblOpen = false; setQuery({ list: r.id }); }
  }
  function cblGo(dir) { cblDir = dir; cblQ = ''; cblPage = CBL_PAGE; }
  function showPreview(r, src) {
    cblPreviewBusy = false;
    if (r.error) return notify(r.error, 'error');
    cblPreview = { ...r, ...src }; cblPrevPage = 60; cblPrevFilter = 'all'; cblResult = null;
  }
  // A chosen or dropped file is previewed first — its books in order and what
  // you already own — and only imported from the preview's button.
  async function previewCblText(file) {
    if (!file || cblBusy || cblPreviewBusy) return;
    if (file.size > 4 * 1024 * 1024) return notify('That file is over the 4 MB limit.', 'error');
    const xml = await file.text();
    cblPreviewBusy = true;
    showPreview(await apiPostText('/api/lists/cbl-preview', xml, 'application/xml'), { path: null, xml });
  }
  async function previewCatalog(path) {
    if (cblPreviewBusy) return;
    cblPreviewBusy = true;
    showPreview(await apiPost('/api/lists/cbl-preview', { path }), { path, xml: null });
  }
  async function importPreview() {
    const p = cblPreview;
    if (!p || cblBusy) return;
    cblBusy = true; cblResult = null;
    const r = p.path
      ? await apiPost('/api/lists/import-cbl-catalog', { path: p.path })
      : await apiPostText('/api/lists/import-cbl', p.xml, 'application/xml');
    cblPreview = null;
    cblDone(r);
  }
  async function importCblFile(e) {
    const input = e.currentTarget;
    const file = input.files?.[0];
    input.value = '';
    await previewCblText(file);
  }
  // Drop handling is an enhancement on top of the <input type="file"> inside
  // the label, which keeps the keyboard/screen-reader path intact.
  async function cblDrop(e) {
    e.preventDefault(); cblDrag = false;
    await previewCblText(e.dataTransfer?.files?.[0]);
  }
  async function importCatalog(path) {
    cblBusy = true; cblResult = null;
    cblDone(await apiPost('/api/lists/import-cbl-catalog', { path }));
  }
</script>

<section class="scan-page lists-page">
  <div class="listx" class:has-detail={!!listId || arcOpen || cblShown}>
  <!-- RAIL: lists overview -->
  <aside class="listx__rail">
    <div class="listx__rail-head">
      <div class="listx__rail-top">
        <button class="listx__iconbtn" aria-label="Back" onclick={goBack}><Icon name="arrow-left" size={16} /></button>
        <div class="listx__rail-title">Reading lists</div>
        <span class="listx__rail-count">{loaded ? `${lists.length} list${lists.length === 1 ? '' : 's'}` : ''}</span>
      </div>
      <div class="listx__rail-actions">
        <button class="listx__new" title="New list" aria-label="New list" onclick={createList}><Icon name="plus" size={14} /> New</button>
        <button class="listx__arcbtn" class:is-on={arcResults !== null} title="Import a ComicVine story arc" aria-label="Import arc" onclick={toggleArc}><Icon name="diamond" size={14} /> Arc</button>
        <button class="listx__arcbtn" class:is-on={cblOpen} title="Import a CBL reading list" aria-label="Import CBL" onclick={toggleCbl}><Icon name="import" size={14} /> CBL</button>
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
        <button class="listx__card" class:is-active={listId === l.id} onclick={() => { arcResults = null; cblOpen = false; setQuery({ list: l.id }); }}>
          <div class="listx__card-top">
            <span class="listx__card-name">{l.name}</span>
            {#if l.arc_cv_id}<span class="listx__card-arc" title="From a ComicVine story arc"><Icon name="diamond" size={13} /></span>{/if}
            {#if l.source}<span class="listx__card-arc" title="Imported from a CBL reading list"><Icon name="import" size={13} /></span>{/if}
            {#if l.public}<span class="listx__card-arc" title={l.mine ? 'Shared with every user' : `Shared by ${l.owner || 'another user'}`}><Icon name="users" size={13} /></span>{/if}
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
    {:else if cblShown}
      {#if cblPreview}
        {@const noId = cblPrevNoId}
        {@const missing = cblPrevMissing}
        {@const pct = (n) => (cblPreview.total ? (n / cblPreview.total) * 100 : 0).toFixed(2)}
        <div class="listx__scroll listx__prevpane">
          <div class="listx__prev-head">
            <div class="listx__prev-inner">
              <div class="listx__prev-top">
                <button class="listx__prev-back" onclick={() => (cblPreview = null)}><Icon name="arrow-left" size={15} /> Back</button>
                <div class="listx__prev-titles">
                  <div class="listx__prev-tags"><span class="listx__prev-pill">Preview</span><span class="listx__prev-prov">{cblPreview.path ? cblPreview.path.split('/').slice(0, -1).join(' / ') : 'from your file'}</span></div>
                  <div class="listx__prev-name">{cblPreview.name}</div>
                  <div class="listx__prev-sub">Nothing is imported yet — this is read straight from the file.</div>
                </div>
              </div>
              <div class="listx__prev-stats">
                <div class="listx__prev-stat" style="--tone:var(--muted)"><div class="listx__prev-stat-l"><span class="listx__prev-dot"></span>Issues</div><div class="listx__prev-stat-v">{fmt(cblPreview.total)}</div></div>
                <div class="listx__prev-stat" style="--tone:var(--green)"><div class="listx__prev-stat-l"><span class="listx__prev-dot"></span>Already owned</div><div class="listx__prev-stat-v">{fmt(cblPreview.owned)}</div></div>
                <div class="listx__prev-stat" style="--tone:var(--amber)"><div class="listx__prev-stat-l"><span class="listx__prev-dot"></span>Missing</div><div class="listx__prev-stat-v">{fmt(missing)}</div></div>
                <div class="listx__prev-stat" style="--tone:{noId ? '#ff8f3d' : 'var(--green)'}"><div class="listx__prev-stat-l"><span class="listx__prev-dot"></span>No ComicVine id</div><div class="listx__prev-stat-v">{fmt(noId)}</div></div>
              </div>
              <div class="listx__prev-segbar">
                {#if cblPreview.owned}<div class="is-owned" style="width:{pct(cblPreview.owned)}%" title="{cblPreview.owned} already in your library"></div>{/if}
                {#if missing}<div class="is-missing" style="width:{pct(missing)}%" title="{missing} matched but not owned"></div>{/if}
                {#if noId}<div class="is-byname" style="width:{pct(noId)}%" title="{noId} carry no ComicVine id"></div>{/if}
              </div>
              <div class="listx__prev-legend">
                {#if cblPreview.owned}<span style="--tone:var(--green)"><i></i>Owned <b>{fmt(cblPreview.owned)}</b></span>{/if}
                {#if missing}<span style="--tone:var(--amber)"><i></i>Missing <b>{fmt(missing)}</b></span>{/if}
                {#if noId}<span style="--tone:#ff8f3d"><i></i>Matched by name <b>{fmt(noId)}</b></span>{/if}
              </div>
              {#if noId > 0}
                <div class="listx__prev-note"><Icon name="alert-triangle" size={15} /><span>{fmt(noId)} book{noId === 1 ? '' : 's'} carr{noId === 1 ? 'ies' : 'y'} no ComicVine id and will be matched by name — {noId === 1 ? 'that is the one' : 'those are the ones'} most likely to be skipped.</span></div>
              {/if}
              <div class="listx__prev-filters">
                {#each [['all', 'All', cblPreview.total], ['missing', 'Missing', missing], ['noid', 'No id', noId], ['owned', 'Owned', cblPreview.owned]] as [id, label, count] (id)}
                  <button class="listx__prev-filter" class:is-on={cblPrevFilter === id} onclick={() => { cblPrevFilter = id; cblPrevPage = 60; }}>{label}<span>{fmt(count)}</span></button>
                {/each}
                <button class="listx__prev-group" class:is-on={cblPrevGroup} onclick={() => (cblPrevGroup = !cblPrevGroup)}><Icon name="layers" size={13} /> Group by series</button>
              </div>
            </div>
          </div>
          <div class="listx__prev-body">
            {#if !cblPrevFiltered.length}
              <div class="listx__arc-empty">{cblPrevFilter === 'noid' ? 'Every book carries a ComicVine id.' : cblPrevFilter === 'missing' ? 'You already own every matched book.' : 'Nothing to show.'}</div>
            {/if}
            {#each cblPrevRuns as r, ri (ri)}
              {#if cblPrevGroup}
                <div class="listx__prev-run">
                  <span class="listx__prev-run-series">{r.series}</span>
                  {#if r.volume}<span class="listx__prev-run-vol">({r.volume})</span>{/if}
                  <span class="listx__prev-run-own" class:is-all={r.owned === r.books.length} class:is-some={r.owned > 0 && r.owned < r.books.length}>{r.owned}/{r.books.length} owned</span>
                  <span class="listx__prev-run-line"></span>
                  <span class="listx__prev-run-range">{r.range}</span>
                </div>
              {/if}
              {#each r.books as b (b.n)}
                {@const st = cblState(b)}
                <div class="listx__prev-row" data-st={st}>
                  <span class="listx__prev-n">{b.n}</span>
                  <span class="listx__prev-rdot"></span>
                  <span class="listx__prev-rname">{#if !cblPrevGroup}<span class="listx__prev-rseries">{b.series} </span>{/if}<b>#{b.number}</b>{#if b.volume}<span class="listx__prev-rvol"> ({b.volume})</span>{/if}</span>
                  <span class="listx__prev-badge">{st === 'owned' ? 'Owned' : st === 'missing' ? 'Missing' : 'by name'}</span>
                </div>
              {/each}
            {/each}
            {#if cblPrevFiltered.length > cblPrevPage}
              <button class="listx__cbl-more" onclick={() => (cblPrevPage += 120)}>Show more ({fmt(cblPrevFiltered.length - cblPrevPage)} more)</button>
            {/if}
            {#if cblPreview.truncated}<div class="listx__prev-trunc">This list is very long — previewing the first 3,000 of {fmt(cblPreview.total)} books. The import has the same cap.</div>{/if}
          </div>
          <div class="listx__prev-foot">
            <div class="listx__prev-inner listx__prev-foot-row">
              <span class="listx__prev-outcome">Imports in reading order · {fmt(cblPreview.withIds)} book{cblPreview.withIds === 1 ? '' : 's'} match by id{noId ? `, ${fmt(noId)} by name` : ''} · {fmt(cblPreview.owned)} already owned</span>
              <button class="listx__prev-cancel" onclick={() => (cblPreview = null)}>Cancel</button>
              <button class="listx__prev-import" disabled={cblBusy} onclick={importPreview}><Icon name="import" size={15} /> {cblBusy ? 'Importing…' : 'Import this list'}</button>
            </div>
          </div>
        </div>
      {:else}
      <div class="listx__scroll">
        <div class="listx__cbl">
          <div class="listx__cbl-head">
            <span class="listx__cbl-ico"><Icon name="import" size={19} /></span>
            <div>
              <div class="listx__arc-title">Import a CBL reading list</div>
              <p class="listx__cbl-sub">CBL is a widely used reading-list format. Bring in a file of your own, or pick from the community's 1,700+ curated lists — whole events, character runs and alternate universes, in reading order. Issues you don't own stay in place, so you can download what's missing.</p>
            </div>
          </div>

          {#if cblResult}
            {@const skipped = cblResult.total - cblResult.imported}
            <div class="listx__cbl-result" class:is-clean={!skipped}>
              <div class="listx__cbl-result-row">
                <span class="listx__cbl-result-ico"><Icon name={skipped ? 'alert-triangle' : 'check'} size={17} /></span>
                <div class="listx__cbl-result-text">
                  <div class="listx__cbl-result-title">Imported “{cblResult.name}”</div>
                  <div class="listx__cbl-result-sub">{fmt(cblResult.imported)} of {fmt(cblResult.total)} issues in reading order</div>
                </div>
                <button class="listx__cbl-ghost" onclick={() => (cblResult = null)}>Dismiss</button>
                <button class="listx__cbl-primary" onclick={() => { cblOpen = false; setQuery({ list: cblResult.id }); }}>Open list</button>
              </div>
              <div class="listx__cbl-tiles">
                <div class="listx__cbl-tile is-ok"><div class="listx__cbl-tile-n">{fmt(cblResult.imported)}</div><div class="listx__cbl-tile-l">Matched</div></div>
                <div class="listx__cbl-tile" class:is-warn={skipped > 0}><div class="listx__cbl-tile-n">{fmt(skipped)}</div><div class="listx__cbl-tile-l">Couldn't match</div></div>
              </div>
              {#if cblResult.unmatched?.length}
                <div class="listx__cbl-unmatched">
                  <div class="listx__cbl-unmatched-head"><Icon name="alert-triangle" size={15} /><span>Not found on ComicVine — these stay out of the list</span></div>
                  {#each cblResult.unmatched as u}
                    <div class="listx__cbl-unmatched-row"><span class="listx__cbl-unmatched-label">{u.series} #{u.number}{u.volume ? ` (${u.volume})` : ''}</span><span class="listx__cbl-unmatched-why">{u.reason || 'no match'}</span></div>
                  {/each}
                </div>
              {/if}
              {#if cblResult.truncated}<div class="listx__cbl-trunc">This list is very long — the first 3,000 books were imported.</div>{/if}
            </div>
          {:else}
            <label class="listx__cbl-drop" class:is-busy={cblBusy || cblPreviewBusy} class:is-drag={cblDrag}
              ondragover={(e) => { e.preventDefault(); if (!cblBusy) cblDrag = true; }}
              ondragleave={() => (cblDrag = false)} ondrop={cblDrop}>
              <span class="listx__cbl-drop-ico"><Icon name="upload" size={20} /></span>
              <span class="listx__cbl-drop-text">
                <span class="listx__cbl-drop-title">{cblBusy ? 'Importing your list…' : cblPreviewBusy ? 'Reading your list…' : 'Choose a .cbl file'}</span>
                <span class="listx__cbl-drop-sub">{cblBusy ? 'Matching each book on ComicVine' : 'Or drop one here — .cbl and .xml, up to 4 MB. You’ll see its books before anything is imported.'}</span>
              </span>
              {#if cblBusy || cblPreviewBusy}<span class="listx__cbl-drop-busy">{cblBusy ? 'Importing…' : 'Reading…'}</span>{/if}
              <input type="file" accept=".cbl,.xml,text/xml,application/xml" disabled={cblBusy || cblPreviewBusy} onchange={importCblFile} />
            </label>
          {/if}

          <div class="listx__cbl-cathead">
            <span class="listx__cbl-cattitle">Community lists</span>
            {#if cblFiles?.length}<span class="listx__cbl-catcount">{fmt(cblFiles.length)} lists</span>{/if}
            <a class="listx__cbl-catsrc" href="https://github.com/DieselTech/CBL-ReadingLists" target="_blank" rel="noreferrer">DieselTech/CBL-ReadingLists <Icon name="external-link" size={11} /></a>
          </div>
          <div class="listx__arc-field listx__cbl-filter">
            <Icon name="search" size={15} />
            <input placeholder="Filter every list, e.g. Civil War" bind:value={cblQ} oninput={() => (cblPage = CBL_PAGE)} spellcheck="false" />
          </div>
          <div class="listx__cbl-crumbs">
            <button class="listx__cbl-crumb" class:is-cur={!cblDir.length && !cblSearching} onclick={() => cblGo([])}>All publishers</button>
            {#each cblDir as seg, i}
              <span class="listx__cbl-sep"><Icon name="chevron-right" size={14} /></span>
              <button class="listx__cbl-crumb" class:is-cur={i === cblDir.length - 1 && !cblSearching} onclick={() => cblGo(cblDir.slice(0, i + 1))}>{seg}</button>
            {/each}
            {#if cblSearching}<span class="listx__cbl-searching">searching all folders</span>{/if}
          </div>

          {#if cblFiles === null}
            <div class="listx__arc-empty">Loading the catalog…</div>
          {:else if cblErr}
            <div class="listx__cbl-error"><Icon name="alert-triangle" size={15} /><span>{cblErr}</span><button class="listx__cbl-ghost" onclick={loadCatalog}>Try again</button></div>
          {:else}
            {#if cblFolders.length}
              <div class="listx__cbl-folders">
                {#each cblFolders as f (f.name)}
                  <button class="listx__cbl-folder" onclick={() => cblGo([...cblDir, f.name])}>
                    <span class="listx__cbl-folder-ico" style="--tone:{f.tone}"><Icon name="folder" size={16} /></span>
                    <span class="listx__cbl-folder-text"><span class="listx__cbl-folder-name">{f.name}</span><span class="listx__cbl-folder-meta">{fmt(f.lists)} list{f.lists === 1 ? '' : 's'}{f.subs ? ` · ${fmt(f.subs)} folder${f.subs === 1 ? '' : 's'}` : ''}</span></span>
                    <Icon name="chevron-right" size={14} />
                  </button>
                {/each}
              </div>
            {/if}
            {#if !cblFolders.length && !cblHits.length}
              <div class="listx__arc-empty">{cblSearching ? `No lists match “${cblQ}”.` : 'This folder has no reading lists.'}</div>
            {/if}
            <div class="listx__cbl-cards">
              {#each cblVisible as c (c.path)}
                {@const done = cblImported.has(c.path)}
                <div class="listx__cbl-card">
                  <span class="listx__cbl-pub" style="--tone:{cblTone(c.publisher)}">{c.publisher.slice(0, 2).toUpperCase()}</span>
                  <div class="listx__cbl-card-text">
                    <div class="listx__cbl-card-title">{c.title}</div>
                    <div class="listx__cbl-card-meta"><span>{c.publisher}</span>{#if c.date}<span class="listx__cbl-dot">·</span><span>{c.date}</span>{/if}{#if c.dir.length > 1}<span class="listx__cbl-dot">·</span><span class="listx__cbl-crumbtxt">{c.dir.slice(1).join(' / ')}</span>{/if}</div>
                  </div>
                  {#if done}<span class="listx__cbl-done">Imported</span>{/if}
                  <button class="listx__cbl-ghost" disabled={cblPreviewBusy || cblBusy} onclick={() => previewCatalog(c.path)}>Preview</button>
                  <button class="listx__cbl-import" class:is-again={done} disabled={cblBusy} onclick={() => importCatalog(c.path)}>{done ? 'Re-import' : 'Import'}</button>
                </div>
              {/each}
            </div>
            {#if cblHits.length > cblVisible.length}
              <button class="listx__cbl-more" onclick={() => (cblPage += CBL_PAGE)}>Show more ({fmt(cblHits.length - cblVisible.length)} more)</button>
            {/if}
          {/if}
        </div>
      </div>
      {/if}
    {:else if det}
      <div class="listx__dhead">
        <button class="listx__iconbtn listx__back" aria-label="Lists" onclick={() => setQuery({ list: null })}><Icon name="arrow-left" size={16} /></button>
        <div class="listx__dtitle-wrap">
          <div class="listx__dtitle-row">
            <span class="listx__dtitle">{det.name}</span>
            {#if isTrusted() && det.mine !== false}<button class="listx__edit" title="Rename list" onclick={() => renameList(det)}><Icon name="edit" size={15} /></button>{/if}
          </div>
          <div class="listx__dsummary">{ownedCount}/{rows.length} owned{det.arc_cv_id ? ' · from a ComicVine arc' : det.source ? ' · from a CBL reading list' : ''}{det.mine === false ? ` · shared by ${det.owner || 'another user'}` : ''}{det.public && det.mine !== false ? ' · shared with everyone' : ''}</div>
        </div>
        <div class="listx__dactions">
          {#if missing.length && can('downloads.grab')}
            <button class="listx__dl" onclick={downloadMissing}><Icon name="download" size={15} /> Download missing ({fmt(missing.length)})</button>
          {/if}
          {#if det.mine !== false && can('lists.share')}
            <button class="listx__share" onclick={() => toggleShared(det)}
              title={det.public ? 'Stop sharing this list' : 'Let every user see this list'}>
              <Icon name="users" size={15} /> {det.public ? 'Shared' : 'Share'}
            </button>
          {/if}
          {#if det.mine !== false}<button class="listx__del" onclick={() => deleteList(det)}>Delete</button>{/if}
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
  /* Three compact actions (New · Arc · CBL) — short labels so they sit on one
     row in the 300px rail; the open panel's button takes the accent tint. */
  .listx__rail-actions { display: flex; gap: 6px; margin-top: 11px; flex-wrap: wrap; }
  .listx__new, .listx__arcbtn { height: 32px; padding: 0 11px; border: 1px solid var(--line); background: transparent; border-radius: 7px; font: 600 12px var(--font-body); cursor: pointer; display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
  .listx__new { color: var(--text); }
  .listx__arcbtn { color: var(--muted); }
  .listx__new:hover, .listx__arcbtn:hover { color: var(--text); border-color: #4a4266; }
  .listx__arcbtn.is-on { border-color: var(--accent); background: rgba(255,45,111,.1); color: var(--accent); }
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
  .listx__share { display: inline-flex; align-items: center; gap: 6px; height: 36px; padding: 0 13px; border: 1px solid var(--line); background: transparent; color: var(--faint); border-radius: 8px; font: 600 12.5px var(--font-body); cursor: pointer; }
  .listx__share:hover { color: var(--text); border-color: var(--accent); }
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


  .listx__cbl { max-width: 760px; margin: 0 auto; padding: 22px 24px 60px; }
  .listx__cbl-head { display: flex; align-items: flex-start; gap: 13px; margin-bottom: 8px; }
  .listx__cbl-ico { width: 36px; height: 36px; border-radius: 9px; flex: none; display: grid; place-items: center; background: rgba(167,139,250,.15); color: #a78bfa; }
  .listx__cbl-sub { font-size: 13px; color: var(--muted); margin: 6px 0 0; line-height: 1.6; }
  .listx__cbl-result { border: 1px solid rgba(255,194,75,.4); background: rgba(255,194,75,.05); border-radius: 13px; padding: 16px 18px; margin-top: 18px; }
  .listx__cbl-result.is-clean { border-color: rgba(95,211,138,.4); background: rgba(95,211,138,.05); }
  .listx__cbl-result-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .listx__cbl-result-ico { width: 34px; height: 34px; border-radius: 9px; flex: none; display: grid; place-items: center; color: var(--amber); background: rgba(255,194,75,.13); }
  .is-clean .listx__cbl-result-ico { color: var(--green); background: rgba(95,211,138,.13); }
  .listx__cbl-result-text { flex: 1; min-width: 160px; }
  .listx__cbl-result-title { font-size: 14.5px; font-weight: 600; }
  .listx__cbl-result-sub { font-size: 12.5px; color: var(--muted); margin-top: 3px; }
  .listx__cbl-primary { height: 36px; padding: 0 16px; border: none; background: var(--accent); color: #fff; border-radius: 8px; font: 600 12.5px var(--font-body); cursor: pointer; flex: none; }
  .listx__cbl-ghost { height: 32px; padding: 0 13px; border: 1px solid var(--line); background: var(--panel-2); color: var(--text); border-radius: 7px; font: 600 12px var(--font-body); cursor: pointer; flex: none; }
  .listx__cbl-tiles { display: flex; gap: 10px; margin-top: 14px; }
  .listx__cbl-tile { flex: 1; padding: 11px 13px; background: rgba(255,255,255,.02); border: 1px solid var(--line); border-radius: 10px; }
  .listx__cbl-tile-n { font: 700 19px var(--font-body); color: var(--green); }
  .listx__cbl-tile.is-ok { background: rgba(95,211,138,.07); border-color: rgba(95,211,138,.3); }
  .listx__cbl-tile.is-warn { background: rgba(255,194,75,.07); border-color: rgba(255,194,75,.3); }
  .listx__cbl-tile.is-warn .listx__cbl-tile-n { color: var(--amber); }
  .listx__cbl-tile-l { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--faint); margin-top: 3px; }
  .listx__cbl-unmatched { margin-top: 14px; border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
  .listx__cbl-unmatched-head { display: flex; align-items: center; gap: 9px; padding: 10px 13px; background: rgba(255,255,255,.02); border-bottom: 1px solid var(--line); font-size: 12.5px; color: var(--muted); }
  .listx__cbl-unmatched-head :global(svg) { color: var(--amber); flex: none; }
  .listx__cbl-unmatched-row { display: flex; align-items: center; gap: 10px; padding: 8px 13px; border-bottom: 1px solid var(--line); }
  .listx__cbl-unmatched-row:last-child { border-bottom: 0; }
  .listx__cbl-unmatched-label { flex: 1; min-width: 0; font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .listx__cbl-unmatched-why { font: 11px var(--font-mono); color: var(--faint); flex: none; }
  .listx__cbl-trunc { margin-top: 11px; font-size: 12px; color: var(--amber); }
  .listx__cbl-drop { display: flex; align-items: center; gap: 14px; margin-top: 18px; padding: 18px; border: 1px dashed #4a4266; border-radius: 13px; background: rgba(255,255,255,.012); cursor: pointer; transition: border-color .12s, background .12s; }
  .listx__cbl-drop:hover, .listx__cbl-drop.is-drag { border-color: var(--accent); background: rgba(255,45,111,.05); }
  .listx__cbl-drop.is-busy { border-color: var(--accent); cursor: progress; }
  .listx__cbl-drop input { display: none; }
  .listx__cbl-drop-ico { width: 44px; height: 44px; border-radius: 12px; display: grid; place-items: center; background: var(--panel-2); color: #a78bfa; flex: none; }
  .listx__cbl-drop-text { flex: 1; min-width: 0; }
  .listx__cbl-drop-title { display: block; font-size: 14px; font-weight: 600; }
  .listx__cbl-drop-sub { display: block; font-size: 12.5px; color: var(--faint); margin-top: 3px; }
  .listx__cbl-drop-busy { font: 12px var(--font-mono); color: var(--accent); flex: none; }
  .listx__cbl-cathead { display: flex; align-items: baseline; gap: 10px; margin: 26px 0 12px; flex-wrap: wrap; }
  .listx__cbl-cattitle { font-family: var(--font-display); font-size: 16px; letter-spacing: .03em; }
  .listx__cbl-catcount { font: 11.5px var(--font-mono); color: var(--faint); }
  .listx__cbl-catsrc { margin-left: auto; font-size: 11.5px; color: var(--faint); text-decoration: none; display: inline-flex; align-items: center; gap: 5px; }
  .listx__cbl-catsrc:hover { color: var(--text); }
  .listx__cbl-filter { margin-bottom: 10px; }
  .listx__cbl-filter input { height: 40px; border-radius: 9px; }
  .listx__cbl-crumbs { display: flex; align-items: center; gap: 3px; overflow-x: auto; scrollbar-width: none; padding-bottom: 12px; border-bottom: 1px solid var(--line); margin-bottom: 14px; }
  .listx__cbl-crumb { height: 30px; padding: 0 10px; border: none; border-radius: 7px; background: transparent; color: var(--muted); font: 600 12.5px var(--font-body); cursor: pointer; white-space: nowrap; flex: none; }
  .listx__cbl-crumb:hover { color: var(--text); }
  .listx__cbl-crumb.is-cur { background: var(--panel-2); color: var(--text); }
  .listx__cbl-sep { color: #4a4458; flex: none; display: flex; }
  .listx__cbl-searching { margin-left: auto; font: 11px var(--font-mono); color: var(--faint); flex: none; }
  .listx__cbl-error { padding: 16px; border: 1px solid rgba(255,194,75,.3); background: rgba(255,194,75,.06); border-radius: 11px; display: flex; align-items: center; gap: 11px; font-size: 12.5px; color: var(--amber); }
  .listx__cbl-error span { flex: 1; }
  .listx__cbl-folders { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 12px; }
  .listx__cbl-folder { display: flex; align-items: center; gap: 11px; padding: 11px 13px; text-align: left; background: rgba(255,255,255,.012); border: 1px solid var(--line); border-radius: 11px; cursor: pointer; color: var(--text); font: 13.5px var(--font-body); transition: background .12s, border-color .12s; }
  .listx__cbl-folder:hover { border-color: #4a4266; background: rgba(255,255,255,.03); }
  .listx__cbl-folder > :global(svg) { color: var(--faint); flex: none; }
  .listx__cbl-folder-ico { width: 32px; height: 32px; border-radius: 8px; flex: none; display: grid; place-items: center; color: var(--tone); background: color-mix(in srgb, var(--tone) 11%, transparent); border: 1px solid color-mix(in srgb, var(--tone) 27%, transparent); }
  .listx__cbl-folder-text { flex: 1; min-width: 0; }
  .listx__cbl-folder-name { display: block; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .listx__cbl-folder-meta { display: block; font: 11px var(--font-mono); color: var(--faint); margin-top: 3px; }
  .listx__cbl-cards { display: flex; flex-direction: column; gap: 8px; }
  .listx__cbl-card { display: flex; align-items: center; gap: 13px; padding: 12px 14px; background: rgba(255,255,255,.012); border: 1px solid var(--line); border-radius: 11px; transition: background .12s, border-color .12s; }
  .listx__cbl-card:hover { border-color: #4a4266; background: rgba(255,255,255,.03); }
  .listx__cbl-card:hover .listx__cbl-import { opacity: 1; }
  .listx__cbl-pub { width: 34px; height: 34px; border-radius: 8px; flex: none; display: grid; place-items: center; font: 700 11px var(--font-mono); color: var(--tone); background: color-mix(in srgb, var(--tone) 11%, transparent); border: 1px solid color-mix(in srgb, var(--tone) 27%, transparent); }
  .listx__cbl-card-text { flex: 1; min-width: 0; }
  .listx__cbl-card-title { font-size: 13.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .listx__cbl-card-meta { display: flex; align-items: center; gap: 8px; margin-top: 4px; font: 11px var(--font-mono); color: var(--faint); flex-wrap: wrap; }
  .listx__cbl-dot, .listx__cbl-crumbtxt { color: #6f6885; }
  .listx__cbl-done { font: 600 10px var(--font-body); text-transform: uppercase; letter-spacing: .04em; color: var(--green); border: 1px solid rgba(95,211,138,.4); border-radius: 5px; padding: 3px 8px; flex: none; }
  .listx__cbl-import { opacity: .45; height: 32px; padding: 0 14px; border: none; background: var(--accent); color: #fff; border-radius: 7px; font: 600 12px var(--font-body); cursor: pointer; flex: none; transition: opacity .12s; }
  .listx__cbl-import.is-again { opacity: 1; border: 1px solid var(--line); background: transparent; color: var(--muted); }
  .listx__cbl-import:disabled { cursor: progress; }
  .listx__cbl-more { display: block; margin: 14px auto 0; height: 38px; padding: 0 20px; border: 1px solid var(--line); background: transparent; color: var(--muted); border-radius: 9px; font: 600 13px var(--font-body); cursor: pointer; }
  .listx__cbl-card .listx__cbl-ghost { opacity: .7; }
  .listx__cbl-card:hover .listx__cbl-ghost { opacity: 1; }
  /* ---- CBL preview: sticky header + rows + sticky action bar ---- */
  .listx__prevpane { display: flex; flex-direction: column; min-height: 100%; }
  .listx__prev-head { position: sticky; top: 0; z-index: 2; background: var(--ink); border-bottom: 1px solid var(--line); }
  .listx__prev-inner { max-width: 820px; margin: 0 auto; padding: 16px 24px 0; box-sizing: border-box; width: 100%; }
  .listx__prev-top { display: flex; align-items: flex-start; gap: 12px; }
  .listx__prev-back { height: 34px; padding: 0 12px; border: 1px solid var(--line); background: transparent; color: var(--muted); border-radius: 8px; font: 600 12.5px var(--font-body); cursor: pointer; display: inline-flex; align-items: center; gap: 6px; flex: none; }
  .listx__prev-back:hover { color: var(--text); }
  .listx__prev-titles { flex: 1; min-width: 0; }
  .listx__prev-tags { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; }
  .listx__prev-pill { font: 600 10px var(--font-body); text-transform: uppercase; letter-spacing: .06em; color: #a78bfa; border: 1px solid rgba(167,139,250,.4); border-radius: 5px; padding: 2px 8px; }
  .listx__prev-prov { font: 11px var(--font-mono); color: var(--faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .listx__prev-name { font-family: var(--font-display); font-size: 22px; letter-spacing: .02em; margin-top: 7px; line-height: 1.15; }
  .listx__prev-sub { font-size: 12.5px; color: var(--faint); margin-top: 4px; }
  .listx__prev-stats { display: flex; gap: 9px; margin-top: 15px; overflow-x: auto; scrollbar-width: none; padding-bottom: 2px; }
  .listx__prev-stat { flex: none; min-width: 116px; background: rgba(255,255,255,.015); border: 1px solid var(--line); border-radius: 11px; padding: 10px 13px; }
  .listx__prev-stat-l { display: flex; align-items: center; gap: 6px; font-size: 10px; text-transform: uppercase; letter-spacing: .08em; color: var(--faint); white-space: nowrap; }
  .listx__prev-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--tone); flex: none; }
  .listx__prev-stat-v { font: 700 20px var(--font-body); margin-top: 5px; color: var(--tone); }
  .listx__prev-segbar { display: flex; height: 9px; border-radius: 20px; overflow: hidden; background: var(--panel-2); margin-top: 13px; }
  .listx__prev-segbar .is-owned { background: var(--green); }
  .listx__prev-segbar .is-missing { background: var(--amber); }
  .listx__prev-segbar .is-byname { background: #ff8f3d; }
  .listx__prev-legend { display: flex; gap: 15px; margin-top: 8px; flex-wrap: wrap; font-size: 11.5px; color: var(--faint); }
  .listx__prev-legend span { display: inline-flex; align-items: center; gap: 6px; }
  .listx__prev-legend i { width: 8px; height: 8px; border-radius: 2px; background: var(--tone); }
  .listx__prev-legend b { color: var(--text); }
  .listx__prev-note { display: flex; gap: 10px; align-items: flex-start; margin-top: 13px; padding: 11px 13px; border: 1px solid rgba(255,194,75,.32); background: rgba(255,194,75,.06); border-radius: 10px; font-size: 12.5px; color: #e8d9b4; line-height: 1.5; }
  .listx__prev-note :global(svg) { color: var(--amber); flex: none; margin-top: 1px; }
  .listx__prev-filters { display: flex; gap: 7px; margin-top: 14px; padding-bottom: 12px; overflow-x: auto; scrollbar-width: none; }
  .listx__prev-filter, .listx__prev-group { display: inline-flex; align-items: center; gap: 7px; height: 31px; padding: 0 12px; border-radius: 8px; border: 1px solid var(--line); background: transparent; color: var(--muted); font: 600 12px var(--font-body); cursor: pointer; white-space: nowrap; flex: none; }
  .listx__prev-filter span { font: 600 10.5px var(--font-mono); color: #6f6885; }
  .listx__prev-filter.is-on { border-color: var(--accent); background: var(--accent); color: #fff; }
  .listx__prev-filter.is-on span { color: rgba(255,255,255,.85); }
  .listx__prev-group { margin-left: auto; }
  .listx__prev-group.is-on { border-color: #a78bfa; background: rgba(167,139,250,.12); color: #a78bfa; }
  .listx__prev-body { flex: 1; max-width: 820px; width: 100%; margin: 0 auto; padding: 14px 24px 24px; box-sizing: border-box; }
  .listx__prev-run { display: flex; align-items: center; gap: 10px; padding: 14px 2px 8px; }
  .listx__prev-run-series { font-size: 12.5px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .listx__prev-run-vol, .listx__prev-run-own { font: 11px var(--font-mono); color: #6f6885; flex: none; }
  .listx__prev-run-own.is-all { color: var(--green); }
  .listx__prev-run-own.is-some { color: var(--amber); }
  .listx__prev-run-line { flex: 1; height: 1px; background: var(--line); }
  .listx__prev-run-range { font: 11px var(--font-mono); color: #4a4458; flex: none; }
  .listx__prev-row { display: flex; align-items: center; gap: 11px; padding: 8px 12px; border-bottom: 1px solid var(--line); --tone: var(--amber); }
  .listx__prev-row:hover { background: rgba(255,255,255,.03); }
  .listx__prev-row[data-st="owned"] { --tone: var(--green); }
  .listx__prev-row[data-st="byname"] { --tone: #ff8f3d; }
  .listx__prev-row:not([data-st="owned"]) { opacity: .9; }
  .listx__prev-n { width: 34px; font: 600 11px var(--font-mono); color: #6f6885; flex: none; text-align: right; }
  .listx__prev-rdot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--tone); }
  .listx__prev-rname { flex: 1; min-width: 0; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .listx__prev-rseries { color: #c3bcd4; margin-right: .35em; }   /* spacing via CSS: inline whitespace is collapsed */
  .listx__prev-rvol { color: #6f6885; font-weight: 400; margin-left: .35em; }
  .listx__prev-badge { font: 600 10px var(--font-body); text-transform: uppercase; letter-spacing: .04em; color: var(--tone); border: 1px solid color-mix(in srgb, var(--tone) 33%, transparent); background: color-mix(in srgb, var(--tone) 9%, transparent); border-radius: 5px; padding: 2px 7px; flex: none; }
  .listx__prev-trunc { margin-top: 14px; padding: 11px 13px; border: 1px solid var(--line); border-radius: 10px; font-size: 12px; color: var(--faint); text-align: center; }
  .listx__prev-foot { position: sticky; bottom: 0; z-index: 2; border-top: 1px solid var(--line); background: var(--panel); box-shadow: 0 -10px 28px rgba(0,0,0,.35); }
  .listx__prev-foot-row { display: flex; align-items: center; gap: 13px; flex-wrap: wrap; padding: 12px 24px; }
  .listx__prev-outcome { flex: 1; min-width: 200px; font-size: 12.5px; color: var(--muted); line-height: 1.5; }
  .listx__prev-cancel { height: 40px; padding: 0 15px; border: 1px solid var(--line); background: transparent; color: var(--muted); border-radius: 9px; font: 600 12.5px var(--font-body); cursor: pointer; }
  .listx__prev-import { height: 40px; padding: 0 20px; border: none; background: var(--accent); color: #fff; border-radius: 9px; font: 600 13px var(--font-body); cursor: pointer; display: inline-flex; align-items: center; gap: 8px; }
  @media (max-width: 900px) { .listx__cbl-folders { grid-template-columns: 1fr; } }

  @media (max-width: 820px) {
    .listx { display: block; }
    .listx__rail { height: 100%; border-right: none; }
    .listx__detail { display: none; height: 100%; }
    .listx.has-detail .listx__rail { display: none; }
    .listx.has-detail .listx__detail { display: flex; }
    .listx__back { display: grid; }
  }
</style>
