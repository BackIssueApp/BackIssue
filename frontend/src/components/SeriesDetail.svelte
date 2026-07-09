<script>
  import { goBack, navigate } from '../lib/router.svelte.js';
  import { detail, detailSelected, flags, ops, loadCollection, reloadDetail, clearDetail, issueState, downloadCvIssues, redownloadCvIssues, redownloadIssues, watchDetailSweep } from '../lib/store.svelte.js';
  import { issueActions, seriesActions, issueActionsTick, issueCoverUrl } from '../lib/plugins.svelte.js';
  import { isTrusted, can } from '../lib/auth.svelte.js';
  import { apiGet, apiPost } from '../lib/api.js';
  import { notify } from '../lib/toasts.svelte.js';
  import { fmt, humanBytes, issueMatchesFilter, windowRange } from '../lib/util.js';

  // List-view file columns come from the issue's best readable copy.
  const bestFile = (i) => (i.files || []).find((f) => f.valid) || null;
  const fileExt = (f) => (String(f?.name || '').match(/\.(\w+)$/)?.[1] || '').toUpperCase();
  import Cover from './Cover.svelte';
  import Badge from './Badge.svelte';
  import Icon from '../lib/Icon.svelte';
  import { openCvPicker } from './CvPickerModal.svelte';
  import { openEditMetadata } from './EditMetadataModal.svelte';
  import { openIssueInfo } from './IssueModal.svelte';
  import { openPackSearch } from './PackSearchModal.svelte';
  import { confirmDialog, choiceDialog, inputDialog } from './DialogModal.svelte';

  const s = $derived(detail.series);
  const det = $derived(detail.det);
  const isCv = $derived(!!det && det.source === 'cv' && Array.isArray(det.issues));

  // Rename this series' files to the configured folder/file pattern. Dry-runs
  // first to show the count, then executes on confirm.
  let refileBusy = $state(false);
  async function refileFiles() {
    const sid = detail.series?.id, title = detail.series?.title || 'this series';
    if (!sid) return;
    let plan;
    try { plan = (await apiPost(`/api/collection/${sid}/refile`, { dryRun: true })).plan || []; }
    catch (e) { return notify('Could not plan the rename: ' + (e?.message || e), 'error'); }
    const moves = plan.filter((p) => p.status === 'move').length;
    const collisions = plan.filter((p) => p.status === 'skip:collision').length;
    if (!moves) return notify(collisions ? `Nothing to do — ${collisions} file(s) would collide.` : 'Files already match the pattern.', 'info');
    if (!(await confirmDialog({
      title: `Rename ${moves} file${moves === 1 ? '' : 's'}?`,
      message: `Files for "${title}" are moved/renamed to match your folder and file patterns${collisions ? ` (${collisions} would collide and are skipped)` : ''}.`,
      confirmLabel: 'Rename files',
    }))) return;
    refileBusy = true;
    let r;
    try { r = await apiPost(`/api/collection/${sid}/refile`, {}); }
    catch (e) { r = { error: String(e?.message || e) }; }
    refileBusy = false;
    if (r.error) return notify(r.error, 'error');
    notify(`Renamed ${r.moved} file${r.moved === 1 ? '' : 's'}${r.skipped ? `, ${r.skipped} skipped` : ''}.`, 'ok');
    reloadDetail();
  }
  const isUnmatched = $derived(!!det && det.source === 'unmatched');
  const issues = $derived(isCv ? det.issues : []);
  const missingIds = $derived(issues.filter((i) => !i.owned).map((i) => i.cv_issue_id));

  const issueCountLabel = $derived(
    isCv && det.cv ? `${fmt(det.cv.issue_count)} issues`
    : isUnmatched ? (det.files && det.files.length ? `${fmt(det.files.length)} files` : 'unmatched')
    : s ? `${s.issue_count} issues` : '');

  /* ---- Series blurb (CV deck, else the description flattened to text) ---- */
  let descOpen = $state(false);
  const seriesBlurb = $derived.by(() => {
    const raw = det?.cv?.deck || det?.cv?.description || '';
    const text = String(raw).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    return text || null;
  });
  $effect(() => { void s?.id; descOpen = false; }); // collapse on series change

  /* ---- Overflow ("⋯") menu for secondary/destructive header actions ---- */
  let moreOpen = $state(false);
  $effect(() => {
    if (!moreOpen || typeof window === 'undefined') return;
    const close = () => { moreOpen = false; };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('click', close); window.removeEventListener('keydown', onKey); };
  });

  /* ---- Issue filter + find + view ---- */
  let currentFilter = $state('all');
  let findText = $state('');
  // Cover grid ⊞ / dense list ≣ — a device preference.
  let issueView = $state(localStorage.getItem('issueView') || 'grid');
  function setIssueView(v) { issueView = v; localStorage.setItem('issueView', v); }
  const gridMode = $derived(issueView === 'grid');
  const FILTERS = ['all', 'missing', 'saved', 'corrupt', 'untagged', 'failed'];
  const FILTER_LABELS = { all: 'All', missing: 'Missing', saved: 'Saved', corrupt: 'Corrupt', untagged: 'Untagged', failed: 'Failed' };

  // "find #" box: match against the row's text (number + title) — invaluable on
  // 2,000-issue series.
  function rowHidden(i) {
    const state = issueState(i);
    if (!issueMatchesFilter(state, currentFilter)) return true;
    const find = findText.trim().toLowerCase();
    if (find === '') return false;
    return !`${i.number || '—'} ${i.title || ''}`.toLowerCase().includes(find);
  }

  // Reset the filter/find/selection when a different series opens.
  let lastSeriesId = null;
  $effect(() => {
    const id = s?.id ?? null;
    if (id !== lastSeriesId) {
      lastSeriesId = id; currentFilter = 'all'; findText = ''; lastToggled = null;
      if (scroller) scroller.scrollTop = 0;
    }
  });

  /* ---- Virtualized rows & cards ----
     Big series (2,000+ issues, e.g. 2000AD) must not render thousands of DOM
     nodes — that froze the browser, worst on iPad. BOTH the list and the cover
     grid are windowed against the .detail scroll container once they pass the
     threshold; smaller sets render in full. The grid measures its columns-per-
     row so it can window whole rows and pad the skipped ones with full-width
     spacers. */
  const VIRTUAL_MIN = 200;
  const OVERSCAN = 6;            // extra rows above & below the viewport
  let scroller = $state(null);   // <section class="detail"> — the scroll container
  let listEl = $state(null);     // #issues-list
  let scrollTop = $state(0);
  let viewH = $state(800);
  let stride = $state(42);       // row / card-row height incl. gap, measured
  let cols = $state(1);          // cards per row (1 in list mode), measured

  const visibleIssues = $derived(isCv ? issues.filter((i) => !rowHidden(i)) : []);
  const virtual = $derived(visibleIssues.length > VIRTUAL_MIN);
  const range = $derived.by(() => {
    const n = visibleIssues.length;
    if (!virtual) return { start: 0, end: n, padTop: 0, padBottom: 0 };
    // Distance from the top of the scroll content to the list's first row.
    const listTop = (listEl && scroller)
      ? listEl.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scrollTop
      : 0;
    return windowRange({
      n, cols: gridMode ? cols : 1, stride, viewH, scrollTop, listTop, overscan: OVERSCAN,
    });
  });

  let raf = 0;
  function onScroll() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; if (scroller) scrollTop = scroller.scrollTop; });
  }
  function measure() {
    if (scroller) viewH = scroller.clientHeight || viewH;
    const items = listEl?.querySelectorAll(gridMode ? '.icard' : '.issue');
    if (items && items.length >= 2) {
      // Columns = how many items share the first item's top; row stride = the
      // vertical gap to the first item on the next row.
      const top0 = items[0].offsetTop;
      let c = 1;
      while (c < items.length && items[c].offsetTop === top0) c++;
      cols = Math.max(1, c);
      const next = items[c] || items[1];
      const d = next.offsetTop - top0;
      if (d > 10) stride = d;
    }
  }
  $effect(() => { void visibleIssues; void listEl; void gridMode; measure(); });
  // Columns/row-height change with viewport width — re-measure on resize.
  $effect(() => {
    if (typeof window === 'undefined') return;
    const onResize = () => measure();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  });

  /* ---- Selection + summary ---- */
  const rowDisabled = (i) => (i.owned && !i.corrupt) || issueState(i) === 'done';
  let lastToggled = $state(null); // index into visibleIssues, for shift-click ranges
  $effect(() => {
    void currentFilter; void findText;
    lastToggled = null; // indices shifted
    // A shorter filtered list can leave the scroll stranded in empty space.
    if (scroller && scroller.scrollTop > 0) scroller.scrollTop = 0;
  });
  function toggleIssue(i, index = null, shiftKey = false) {
    if (rowDisabled(i)) return;
    const willCheck = !detailSelected.has(i.cv_issue_id);
    if (shiftKey && lastToggled != null && index != null && index !== lastToggled) {
      // Shift-click: set the whole range to the clicked row's new state.
      const [a, b] = [Math.min(lastToggled, index), Math.max(lastToggled, index)];
      for (let k = a; k <= b; k++) {
        const it = visibleIssues[k];
        if (!it || rowDisabled(it)) continue;
        if (willCheck) detailSelected.add(it.cv_issue_id); else detailSelected.delete(it.cv_issue_id);
      }
    } else if (willCheck) detailSelected.add(i.cv_issue_id);
    else detailSelected.delete(i.cv_issue_id);
    lastToggled = index;
  }
  // Scoped to the VISIBLE rows: with "Corrupt" filtered, "Select all" means
  // those corrupt issues — not every issue in the series.
  function selectAll(checked) {
    for (const i of visibleIssues) {
      if (rowDisabled(i)) continue;
      if (checked) detailSelected.add(i.cv_issue_id); else detailSelected.delete(i.cv_issue_id);
    }
  }
  const counts = $derived.by(() => {
    const c = { owned: 0, corrupt: 0, untagged: 0, missing: 0 };
    for (const i of issues) {
      const st = issueState(i);
      if (st === 'done' || st === 'untagged') c.owned++;
      if (st === 'corrupt') c.corrupt++;
      if (st === 'untagged') c.untagged++;
      if (!['done', 'untagged', 'corrupt'].includes(st)) c.missing++;
    }
    return c;
  });
  const summary = $derived.by(() => {
    if (isUnmatched) return fmt((det.files || []).length) + ((det.files || []).length === 1 ? ' file' : ' files');
    if (!isCv) return '';
    let out = `${fmt(issues.length)} issues · ${fmt(counts.owned)} owned`;
    if (counts.missing) out += ` · ${fmt(counts.missing)} missing`;
    if (counts.corrupt) out += ` · ⚠ ${fmt(counts.corrupt)} corrupt`;
    if (counts.untagged) out += ` · ${fmt(counts.untagged)} untagged`;
    return out;
  });

  /* ---- Header actions ---- */
  let refreshBusy = $state(false);
  // Refresh pulls the volume's metadata + issue list from ComicVine.
  async function refreshSeries() {
    if (!s) return;
    refreshBusy = true;
    // The action lives in a menu that closes on click — feedback must come
    // from toasts, not the (now hidden) menu-item label.
    notify('Refreshing metadata…', 'info');
    try {
      const r = await apiPost(`/api/collection/${s.id}/refresh`);
      if (r.error) { notify('Refresh failed: ' + r.error, 'error'); return; }
      await loadCollection();
      await reloadDetail(); // re-render with the fresh ComicVine data
      if (r.detailSweep) watchDetailSweep(); // covers/titles fill in live as the sweep caches them
      notify(`Series metadata refreshed${r.detailSweep ? ' — issue details are updating in the background (see Jobs)' : ''}.`, 'ok');
    } catch {
      notify('Refresh failed — is the app reachable?', 'error');
    } finally {
      setTimeout(() => { refreshBusy = false; }, 1200);
    }
  }

  async function toggleFollow() {
    if (!s) return;
    const monitored = !s.followed;
    try {
      const r = await apiPost(`/api/collection/${s.id}/monitor`, { monitored });
      if (r?.error) return notify(r.error, 'error'); // star stays truthful
    } catch { return notify('Could not update — is the app reachable?', 'error'); }
    detail.series.followed = monitored ? 1 : 0;
    loadCollection();
  }

  async function toggleRestricted() {
    if (!det?.series) return;
    const restricted = !det.series.restricted;
    const r = await apiPost(`/api/collection/${s.id}/restricted`, { restricted });
    if (r.error) return notify(r.error, 'error');
    detail.det.series.restricted = r.restricted;
    notify(r.restricted ? 'Marked mature — hidden from roles without “View mature content”.' : 'Mature flag removed.', 'ok');
    loadCollection();
  }

  async function deleteSeries() {
    if (!s) return;
    const name = s.title || 'this series';
    // Keeping files is the safe default; deleting them is its own explicit button.
    const choice = await choiceDialog({
      title: 'Remove ' + name + '?',
      message: 'Removing takes it out of your collection. Its files can stay on disk, or be deleted with it.',
      buttons: [
        { label: 'Remove, keep files', value: 'keep' },
        { label: 'Remove + delete files', value: 'delete', danger: true },
      ],
    });
    if (!choice) return;
    const deleteFiles = choice === 'delete';
    const r = await apiPost('/api/collection/' + s.id + '/delete', { deleteFiles });
    if (r.error) { notify('Remove failed: ' + r.error, 'error'); return; }
    if (deleteFiles) notify('Removed. Deleted ' + fmt(r.deletedFiles || 0) + ' file(s).', 'ok');
    clearDetail();
    navigate('/');
    loadCollection();
  }

  async function redownloadAll() {
    // Poll-able rows only (in-flight/corrupt) — owned+intact issues keep their file.
    const ids = issues.filter((i) => !(i.owned && !i.corrupt)).map((i) => Number(i.id)).filter((n) => Number.isFinite(n) && n > 0);
    if (!ids.length) return;
    const ok = await confirmDialog({
      title: 'Re-download ' + ids.length + ' issues?',
      message: `Every non-owned issue of "${s?.title}" is re-fetched — existing partial/corrupt files are replaced.`,
      confirmLabel: 'Re-download', danger: true,
    });
    if (ok) redownloadIssues(ids);
  }

  // Add the selection (or, with nothing checked, the whole series) to a
  // reading list — an existing one or a fresh one named on the spot.
  async function addToList() {
    let ids = [...detailSelected];
    if (!ids.length) ids = issues.map((i) => i.cv_issue_id).filter(Boolean);
    if (!ids.length) return;
    const r = await apiGet('/api/lists');
    if (r.error) return notify(r.error, 'error');
    const buttons = (r.lists || []).map((l) => ({ label: `${l.name} (${l.items})`, value: l.id }));
    buttons.push({ label: '+ New list…', value: 'new' });
    const scope = detailSelected.size ? `${ids.length} selected issue(s)` : `all ${ids.length} issues`;
    const choice = await choiceDialog({ title: 'Add to reading list', message: `Adding ${scope} of “${s?.title}”.`, buttons });
    if (!choice) return;
    let listId = choice;
    if (choice === 'new') {
      const name = await inputDialog({ title: 'New reading list', value: s?.title || '', confirmLabel: 'Create' });
      if (!name) return;
      const c = await apiPost('/api/lists', { name });
      if (c.error) return notify(c.error, 'error');
      listId = c.id;
    }
    const res = await apiPost(`/api/lists/${listId}/items`, { cvIssueIds: ids });
    if (res.error) return notify(res.error, 'error');
    notify(res.added ? `Added ${fmt(res.added)} issue(s) to the list.` : 'Already on that list.', 'ok');
  }

  /* ---- Location row (scan / tag / cleanup / path / aliases) ---- */
  const untaggedOwned = $derived((det?.issues || []).filter((i) => i.owned && i.untagged).length);

  // Scan/Tag busy state + progress derive from the server's op state (mirrored
  // over SSE in the ops store) — so a scan started here still shows progress
  // after navigating away and back, and can't be double-started.
  const scanBusy = $derived(!!ops.scan.running);
  const scanMine = $derived(!!ops.scan.running && s && Number(ops.scan.seriesId) === s.id);
  const scanText = $derived(scanMine ? 'Scanning ' + fmt(ops.scan.done || 0) + (ops.scan.total ? '/' + fmt(ops.scan.total) : '') + '…' : 'Scanning elsewhere…');
  async function scanFolder() {
    if (!s || ops.scan.running) return;
    ops.scan = { running: true, seriesId: s.id, done: 0, total: 0 }; // optimistic until the next SSE tick
    try { await apiPost('/api/collection/' + s.id + '/scan'); }
    catch { notify('Scan failed', 'error'); ops.scan = { running: false }; }
  }
  // When the op for the OPEN series finishes, refresh + surface errors.
  let sawScan = false;
  $effect(() => {
    const st = ops.scan;
    if (st.running) { sawScan = sawScan || (s && Number(st.seriesId) === s.id); return; }
    if (!sawScan) return;
    sawScan = false;
    if (st.error) notify('Scan error: ' + st.error, 'error');
    else notify(`Folder scan complete${st.pruned ? ` — ${fmt(st.pruned)} stale file(s) pruned` : ''}.`, 'ok');
    loadCollection();
    if (detail.series && Number(st.seriesId) === detail.series.id) reloadDetail();
  });

  const tagBusy = $derived(!!ops.tag.running);
  const tagMine = $derived(!!ops.tag.running && s && Number(ops.tag.seriesId) === s.id);
  const tagText = $derived(tagMine ? 'Tagging ' + fmt(ops.tag.done || 0) + '/' + fmt(ops.tag.total || 0) + '…' : 'Tagging elsewhere…');
  async function tagFiles() {
    if (!s || ops.tag.running) return;
    ops.tag = { running: true, seriesId: s.id, done: 0, total: 0 };
    // When some issues are untagged, tag ONLY those; when all are tagged, the
    // button re-tags everything (a deliberate refresh).
    try { await apiPost('/api/collection/' + s.id + '/tag', { onlyUntagged: untaggedOwned > 0 }); }
    catch { notify('Tagging failed', 'error'); ops.tag = { running: false }; }
  }
  let sawTag = false;
  $effect(() => {
    const st = ops.tag;
    if (st.running) { sawTag = sawTag || (s && Number(st.seriesId) === s.id); return; }
    if (!sawTag) return;
    sawTag = false;
    if (st.error) notify('Tagging error: ' + st.error, 'error');
    else if (st.total) notify('Tagged ' + fmt(st.tagged || 0) + ' of ' + fmt(st.total) + ' file(s)' + (st.problems ? ' — ' + fmt(st.problems) + ' problem(s), see Tag log' : '') + '.', 'ok');
    if (detail.series && Number(st.seriesId) === detail.series.id) reloadDetail();
  });

  let cleanupBusy = $state(false);
  async function cleanupDuplicates() {
    if (!s) return;
    // Deletes files from disk — never without an explicit confirmation.
    const n = det?.superseded || 0;
    if (!(await confirmDialog({
      title: `Delete ${fmt(n)} duplicate file${n === 1 ? '' : 's'}?`,
      message: 'These are corrupt copies already replaced by a good copy of the same issue. The files are deleted from disk.',
      confirmLabel: 'Delete duplicates', danger: true,
    }))) return;
    cleanupBusy = true;
    try {
      const r = await apiPost('/api/collection/' + s.id + '/cleanup');
      if (r.error) notify('Cleanup failed: ' + r.error, 'error');
      else notify(`Deleted ${fmt(r.removed || 0)} duplicate file(s).`, 'ok');
      await reloadDetail(); // re-render
      loadCollection(); // refresh sidebar counts
    } catch { notify('Cleanup failed', 'error'); }
    cleanupBusy = false;
  }

  // On-disk file count for closeness ranking in the CV picker: files attached to
  // CV issues (matched view) or the raw folder files (unmatched view).
  const pickerFileCount = $derived(det
    ? (det.issues || []).reduce((n, i) => n + ((i.files && i.files.length) || 0), 0) + ((det.files && det.files.length) || 0)
    : 0);

  const cvUrl = $derived(det?.cv
    ? (det.cv.site_detail_url || ('https://comicvine.gamespot.com/volume/4050-' + det.cv.comicvine_id + '/'))
    : '');

  const corruptReason = (i) => (i.files || []).map((f) => f.error).find(Boolean);
</script>

<svelte:window onresize={measure} />

<section class="detail" bind:this={scroller} onscroll={onScroll}>
  {#if !s}
    <div id="detail-empty" class="empty">
      <div class="empty__art"><Icon name="star" fill /></div>
      <div class="empty__title">Pick a series</div>
      <div class="empty__text">Choose a title on the left to see its issues, or catalog the site to build your library.</div>
    </div>
  {:else}
    <div id="detail-body">
      <button id="detail-back" class="btn btn--ghost detail-back" onclick={goBack}><Icon name="arrow-left" /> Library</button>
      <header class="series-header">
        <Cover coverUrl={s.cover_url} title={s.title} />
        <div class="series-meta">
          <h2 id="series-title">{s.title}</h2>
          <div class="series-tags">
            <span class="tag" id="series-pub">{s.publisher || 'Unknown publisher'}{det?.cv?.metron_imprint ? ` · ${det.cv.metron_imprint}` : ''}</span>
            <span class="tag tag--mono" id="series-issuecount">{issueCountLabel}</span>
            {#if det?.cv?.metron_series_type && !/single issue|ongoing/i.test(det.cv.metron_series_type)}
              <span class="tag" title="Series type (from enriched metadata)">{det.cv.metron_series_type}</span>
            {/if}
            {#if det?.cv?.metron_genres?.length}
              <span class="tag" title="Genres (from enriched metadata)">{det.cv.metron_genres.slice(0, 3).join(' · ')}</span>
            {/if}
          </div>
          <div class="series-cv" id="series-cv">
            {#if det?.cv}
              <a class="cv-chip" href={cvUrl} target="_blank" rel="noreferrer" title="Open on ComicVine"><Icon name="diamond" /> {det.cv.name || 'ComicVine'}
                {#if det.cv.start_year}<span class="cv-year">({det.cv.start_year}{det.cv.metron_year_end && det.cv.metron_year_end !== det.cv.start_year ? `–${det.cv.metron_year_end}` : ''})</span>{/if} <Icon name="external-link" /></a>
              <span class="cv-total">{fmt(det.cv.count_of_issues || det.cv.issue_count || 0)} issues on ComicVine{det.series?.cv_locked ? ' · pinned' : ''}</span>
              {#if det.cv.metron_status && det.cv.metron_status !== 'Ongoing'}
                <span class="tag" title="Publication status (from enriched metadata)">{det.cv.metron_status}</span>
              {/if}
              {#if det.cv.metron_rating}
                <span class="tag" class:tag--warn={['Mature','Explicit','Adult'].includes(det.cv.metron_rating)} title="Content rating (from enriched metadata)">{det.cv.metron_rating}</span>
              {/if}
            {:else if det}
              <span class="cv-none">No ComicVine match</span>
              {#if isTrusted()}<button class="link-btn cv-fix" onclick={() => openCvPicker(s.id, s.title, null, { files: pickerFileCount })}>Match…</button>{/if}
            {/if}
          </div>
          {#if seriesBlurb}
            <p class="series-desc" class:is-open={descOpen} title={descOpen ? undefined : 'Click to expand'}
              onclick={() => { descOpen = !descOpen; }} role="button" tabindex="0"
              onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); descOpen = !descOpen; } }}>{seriesBlurb}</p>
          {/if}
          <!-- Disk location lives in Edit metadata; scan/tag progress and
               completion report via toasts (same pattern as Refresh metadata). -->
          <div class="series-actions">
            {#if isUnmatched}
              {#if isTrusted()}
                <button id="download-series" class="btn btn--primary" onclick={() => openCvPicker(s.id, (det.series && det.series.folder) || s.title, null, { files: pickerFileCount })}>Match to ComicVine</button>
              {/if}
            {:else if can('downloads.grab')}
              {#if isCv}
                <button id="download-series" class="btn btn--primary" disabled={!missingIds.length} onclick={() => downloadCvIssues(missingIds)}>
                  {missingIds.length ? `Download missing (${fmt(missingIds.length)})` : 'Download missing'}</button>
              {:else}
                <button id="download-series" class="btn btn--primary" disabled>Download missing</button>
              {/if}
            {/if}
            {#if can('downloads.grab')}
              <button id="download" class="btn btn--secondary" disabled={detailSelected.size === 0}
                onclick={() => { downloadCvIssues([...detailSelected]); detailSelected.clear(); }}>
                {detailSelected.size ? `Download selected (${detailSelected.size})` : 'Download selected'}</button>
            {/if}
            {#if isCv}
              <button id="add-to-list" class="btn btn--ghost" title="Add these issues to a reading list" onclick={addToList}><Icon name="menu" /> Add to list{detailSelected.size ? ` (${detailSelected.size})` : ''}</button>
            {/if}
            {#each seriesActions as a (a.id + ':' + issueActionsTick.n)}
              {#if !a.when || a.when(s, issues)}
                <button class="btn btn--ghost" title={typeof a.title === 'function' ? a.title(s, issues) : a.title}
                  onclick={() => a.run(s, issues)}>{@html typeof a.label === 'function' ? a.label(s, issues) : a.label}</button>
              {/if}
            {/each}
            {#if isTrusted()}
              <button id="follow-btn" class="btn btn--ghost" class:is-following={!!s.followed} onclick={toggleFollow}>{#if s.followed}<Icon name="star" fill /> Following{:else}<Icon name="star" /> Follow{/if}</button>
            {/if}
            <!-- Secondary/destructive actions live in one overflow menu — the
                 header stays scannable, and Remove is visually separated. -->
            {#if !isUnmatched && (isTrusted() || can('downloads.grab'))}
              <div class="series-more">
                <button id="series-more-btn" class="btn btn--ghost" aria-label="More actions" aria-haspopup="menu" aria-expanded={moreOpen}
                  onclick={(e) => { e.stopPropagation(); moreOpen = !moreOpen; }}>⋯</button>
                {#if moreOpen}
                  <div class="series-more__menu" role="menu">
                    {#if isTrusted()}
                      <button class="menu__item" role="menuitem" disabled={refreshBusy} title="Re-pull metadata + issues from ComicVine"
                        onclick={() => { moreOpen = false; refreshSeries(); }}><Icon name="refresh" /> {refreshBusy ? 'Refreshing…' : 'Refresh metadata'}</button>
                      {#if isCv}
                        <button class="menu__item" role="menuitem" title="Hand-edit this series' metadata, location, and alt names — edits survive refreshes"
                          onclick={() => { moreOpen = false; openEditMetadata(s.id, det?.cv, det?.series, det?.location); }}><Icon name="edit" /> Edit metadata…</button>
                      {/if}
                      <button class="menu__item" role="menuitem" title="Pick a different ComicVine match for this series"
                        onclick={() => { moreOpen = false; openCvPicker(s.id, s.title, null, { files: pickerFileCount }); }}><Icon name="diamond" /> Fix match…</button>
                      <button class="menu__item" role="menuitem" disabled={scanBusy} title="Scan this series' folder for owned issues"
                        onclick={() => { moreOpen = false; notify('Scanning folder…', 'info'); scanFolder(); }}><Icon name="search" /> {scanBusy ? scanText : 'Scan folder'}</button>
                      {#if isCv}
                        <button class="menu__item" role="menuitem" disabled={refileBusy} title="Move/rename this series' files to match the configured folder & file patterns"
                          onclick={() => { moreOpen = false; refileFiles(); }}><Icon name="edit" /> {refileBusy ? 'Renaming…' : 'Rename files'}</button>
                      {/if}
                      {#if det?.cv}
                        <button class="menu__item" role="menuitem" disabled={tagBusy} title="Write ComicVine metadata into every owned file"
                          onclick={() => { moreOpen = false; notify('Tagging files…', 'info'); tagFiles(); }}><Icon name="tag" /> {tagBusy ? tagText : (untaggedOwned ? `Tag ${fmt(untaggedOwned)} untagged` : 'Tag files')}</button>
                      {/if}
                      {#if det?.superseded}
                        <button class="menu__item" role="menuitem" disabled={cleanupBusy} title="Delete old/corrupt files already replaced by a good copy"
                          onclick={() => { moreOpen = false; cleanupDuplicates(); }}><Icon name="trash" /> {cleanupBusy ? 'Removing…' : `Remove ${fmt(det.superseded)} duplicate${det.superseded === 1 ? '' : 's'}`}</button>
                      {/if}
                    {/if}
                    {#if can('downloads.grab')}
                      <button id="redownload-series" class="menu__item" role="menuitem" title="Re-queue every missing, failed, and corrupt issue"
                        onclick={() => { moreOpen = false; redownloadAll(); }}><Icon name="rotate-ccw" /> Retry missing &amp; corrupt</button>
                      {#if flags.anySource}
                        <button id="torrent-pack-btn" class="menu__item" role="menuitem" title="Search all sources for multi-issue packs of this series"
                          onclick={() => { moreOpen = false; openPackSearch(); }}><Icon name="arrow-up-down" /> Search packs</button>
                      {/if}
                    {/if}
                    {#if isTrusted()}
                      <button id="restrict-btn" class="menu__item" role="menuitem" title="Hide this series from roles without the “View mature content” permission"
                        onclick={() => { moreOpen = false; toggleRestricted(); }}><Icon name="shield" /> {det?.series?.restricted ? 'Remove mature flag' : 'Mark mature'}</button>
                      <div class="series-more__sep" role="separator"></div>
                      <button id="delete-series" class="menu__item menu__item--danger" role="menuitem"
                        onclick={() => { moreOpen = false; deleteSeries(); }}><Icon name="trash" /> Remove from library…</button>
                    {/if}
                  </div>
                {/if}
              </div>
            {/if}
          </div>
        </div>
      </header>

      <div class="issues">
        <div class="issues__head">
          <label class="checkall"><input type="checkbox" id="select-all" checked={isCv && visibleIssues.some((i) => !rowDisabled(i)) && visibleIssues.filter((i) => !rowDisabled(i)).every((i) => detailSelected.has(i.cv_issue_id))} onchange={(e) => selectAll(e.currentTarget.checked)} /> <span>Select all</span></label>
          <div class="filter" id="filter">
            {#each FILTERS as f (f)}
              <button class="filter__btn" class:is-active={currentFilter === f} onclick={() => { currentFilter = f; }}>{FILTER_LABELS[f]}</button>
            {/each}
          </div>
          <input id="issue-find" type="search" class="issue-find" placeholder="find #…" title="Filter issues by number or title" bind:value={findText} />
          <div class="viewtoggle" role="group" aria-label="Issue view">
            <button class="viewtoggle__btn" class:is-active={gridMode} title="Cover grid" onclick={() => setIssueView('grid')}><Icon name="grid" /></button>
            <button class="viewtoggle__btn" class:is-active={!gridMode} title="List" onclick={() => setIssueView('list')}><Icon name="list" /></button>
          </div>
          <span id="issues-summary" class="muted">{summary}</span>
        </div>
        <div id="issues-list" class="issues-list" bind:this={listEl}>
          {#if detail.failed}
            <div class="list-note">Could not load this series — is the app running? Try again.</div>
          {:else if !det && s}
            <div class="list-note">Loading issues…</div>
          {:else if isUnmatched}
            <!-- A comic with no ComicVine match: no issue list (sources are download-only) —
                 show the files on disk and a prompt to match. -->
            <div class="unmatched-note">Not matched to ComicVine yet. Match this series to see its issue list and track it — download sources only supply files.</div>
            <div class="unmatched-files">
              {#if (det.files || []).length}
                <div class="unmatched-files__head">{fmt(det.files.length)} file{det.files.length === 1 ? '' : 's'} on disk</div>
                {#each det.files as f (f.path)}
                  <div class="unmatched-file" class:is-bad={!f.valid} title={f.path}>{f.name}</div>
                {/each}
              {:else}
                <div class="unmatched-files__head scan-muted">No files scanned yet — set the Location, then Scan folder.</div>
              {/if}
            </div>
          {:else if isCv && gridMode}
            <!-- Cover grid: each issue is a card; owned covers come from a
                 plugin provider (reader page-0 thumbs) or ComicVine art. -->
            <div class="issue-grid">
              {#if range.padTop > 0}<div class="issue-grid__pad" style="height:{range.padTop}px"></div>{/if}
              {#each visibleIssues.slice(range.start, range.end) as i, vi (i.cv_issue_id ?? i.id ?? i.number)}
                {@const state = issueState(i)}
                {@const cover = issueCoverUrl(i)}
                <div class="icard"
                  class:is-corrupt={i.corrupt} class:is-checked={detailSelected.has(i.cv_issue_id)}
                  title={i.corrupt && corruptReason(i) ? 'Corrupt: ' + corruptReason(i) : (i.title || '')}>
                  <div class="icard__art" onclick={() => openIssueInfo(i.cv_issue_id, i.number)} role="button" tabindex="0"
                    onkeydown={(e) => { if (e.key === 'Enter') openIssueInfo(i.cv_issue_id, i.number); }}>
                    <div class="icard__ph">#{i.number ?? '?'}</div>
                    {#if cover}<img loading="lazy" alt="" referrerpolicy="no-referrer" src={cover}
                      onerror={(e) => e.currentTarget.remove()} />{/if}
                    {#if !rowDisabled(i)}
                      <input class="icard__check" type="checkbox" checked={detailSelected.has(i.cv_issue_id)}
                        onclick={(e) => { e.stopPropagation(); toggleIssue(i, range.start + vi, e.shiftKey); }} />
                    {/if}
                    <span class="icard__state icard__state--{state}" title={state}></span>
                    <div class="icard__actions" onclick={(e) => e.stopPropagation()}>
                      {#each issueActions as a (a.id + ':' + issueActionsTick.n)}
                        {#if !a.when || a.when(i)}
                          <button class="icard__btn" title={typeof a.title === 'function' ? a.title(i) : a.title}
                            onclick={() => a.run(i, detail.series)}>{@html typeof a.icon === 'function' ? a.icon(i) : a.icon}</button>
                        {/if}
                      {/each}
                      {#if can('downloads.grab')}
                        {#if i.corrupt}
                          <button class="icard__btn icard__btn--warn" title="File is corrupt — re-download" onclick={() => redownloadCvIssues([i.cv_issue_id])}><Icon name="refresh" /></button>
                        {:else if !i.owned}
                          <button class="icard__btn" title="Download this issue" onclick={() => downloadCvIssues([i.cv_issue_id])}><Icon name="download" /></button>
                        {/if}
                      {/if}
                    </div>
                  </div>
                  <div class="icard__label">
                    <span class="icard__num">#{i.number ?? '—'}</span>
                    {#if i.title && i.title !== '#' + (i.number ?? '?')}
                      <span class="icard__title">{i.title}</span>
                    {/if}
                  </div>
                </div>
              {/each}
              {#if range.padBottom > 0}<div class="issue-grid__pad" style="height:{range.padBottom}px"></div>{/if}
            </div>
            {#if !visibleIssues.length && issues.length}
              <div class="list-note">Nothing matches this filter.</div>
            {/if}
          {:else if isCv}
            {#if range.padTop > 0}<div style="height:{range.padTop}px"></div>{/if}
            {#each visibleIssues.slice(range.start, range.end) as i, vi (i.cv_issue_id ?? i.id ?? i.number)}
              {@const state = issueState(i)}
              {@const bf = bestFile(i)}
              <div class="issue"
                class:is-owned={i.owned} class:is-corrupt={i.corrupt}
                title={i.corrupt && corruptReason(i) ? 'Corrupt: ' + corruptReason(i) : undefined}
                onclick={(e) => toggleIssue(i, range.start + vi, e.shiftKey)} role="button" tabindex="0"
                onkeydown={(e) => { if (e.key === 'Enter') toggleIssue(i, range.start + vi, e.shiftKey); }}>
                <input type="checkbox" value={i.cv_issue_id ?? ''} disabled={rowDisabled(i)}
                  checked={detailSelected.has(i.cv_issue_id)}
                  onclick={(e) => e.stopPropagation()}
                  onchange={() => toggleIssue(i, range.start + vi)} />
                <span class="issue__num">{i.number || '—'}</span>
                <button class="issue__title" title="Issue details" onclick={(e) => { e.stopPropagation(); openIssueInfo(i.cv_issue_id, i.number); }}>{i.title}</button>
                <span class="issue__col issue__col--date" title="Cover date">{i.cover_date || ''}</span>
                <span class="issue__col issue__col--pages" title="Pages">{bf?.page_count ? fmt(bf.page_count) + 'p' : ''}</span>
                <span class="issue__col issue__col--size" title={bf ? bf.name : ''}>{bf?.size ? humanBytes(bf.size) : ''}</span>
                {#if bf}<span class="issue__fmt" class:issue__fmt--untagged={!bf.has_metadata} title={bf.has_metadata ? 'Tagged with ComicVine metadata' : 'No ComicInfo tags yet'}>{fileExt(bf)}</span>
                {:else}<span class="issue__fmt issue__fmt--none"></span>{/if}
                <Badge status={state} />
                {#each issueActions as a (a.id + ':' + issueActionsTick.n)}
                  {#if !a.when || a.when(i)}
                    <button class="issue__dl" title={typeof a.title === 'function' ? a.title(i) : a.title} onclick={(e) => { e.stopPropagation(); a.run(i, detail.series); }}>{@html typeof a.icon === 'function' ? a.icon(i) : a.icon}</button>
                  {/if}
                {/each}
                {#if i.corrupt && can('downloads.grab')}
                  <button class="issue__dl issue__dl--warn" title="File is corrupt — re-download" onclick={(e) => { e.stopPropagation(); redownloadCvIssues([i.cv_issue_id]); }}><Icon name="refresh" /></button>
                {:else if i.owned}
                  <button class="issue__dl" title={i.untagged ? 'Owned — no ComicVine tags yet (use “Tag files”)' : 'Owned'} disabled><Icon name="check" /></button>
                {:else if !i.corrupt && can('downloads.grab')}
                  <button class="issue__dl" title="Download this issue" onclick={(e) => { e.stopPropagation(); downloadCvIssues([i.cv_issue_id]); }}><Icon name="download" /></button>
                {/if}
              </div>
            {/each}
            {#if range.padBottom > 0}<div style="height:{range.padBottom}px"></div>{/if}
            {#if !visibleIssues.length && issues.length}
              <div class="list-note">Nothing matches this filter.</div>
            {/if}
          {:else}
            <div class="loading">Loading issues…</div>
          {/if}
        </div>
      </div>
    </div>
  {/if}
</section>
