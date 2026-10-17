<script>
  import { goBack, navigate } from '../lib/router.svelte.js';
  import { detail, detailSelected, flags, ops, loadCollection, reloadDetail, clearDetail, issueState, downloadCvIssues, redownloadCvIssues, redownloadIssues, watchDetailSweep, refreshIssueStatuses } from '../lib/store.svelte.js';
  import { plugins, issueActions, seriesActions, issueActionsTick, issueCoverUrl, seriesViews, renderSeriesView } from '../lib/plugins.svelte.js';
  import { contextMenu, openContextMenu } from './ContextMenu.svelte';
  import { isTrusted, can } from '../lib/auth.svelte.js';
  import { apiGet, apiPost } from '../lib/api.js';
  import { notify } from '../lib/toasts.svelte.js';
  import { fmt, humanBytes, issueMatchesFilter, windowRange, fmtDay } from '../lib/util.js';

  // List-view file columns come from the issue's best readable copy.
  const bestFile = (i) => (i.files || []).find((f) => f.valid) || null;
  const fileExt = (f) => (String(f?.name || '').match(/\.(\w+)$/)?.[1] || '').toUpperCase();
  import Cover from './Cover.svelte';
  import Badge from './Badge.svelte';
  import Icon from '../lib/Icon.svelte';
  import { status } from '../lib/status.svelte.js';
  import { openCvPicker } from './CvPickerModal.svelte';
  import { openEditMetadata } from './EditMetadataModal.svelte';
  import { openIssueInfo } from './IssueModal.svelte';
  import { openPackSearch } from './PackSearchModal.svelte';
  import { confirmDialog, choiceDialog, inputDialog } from './DialogModal.svelte';
  import { pickList } from '../lib/lists.js';
  import { t, th } from '../lib/i18n.svelte.js';

  const s = $derived(detail.series);
  const det = $derived(detail.det);
  const isCv = $derived(!!det && det.source === 'cv' && Array.isArray(det.issues));
  let showAllUnlinked = $state(false);
  // "Assign to issue" on an unmatched file: the issue picked per file path,
  // sent with the file so the choice sticks through rescans.
  let assignPick = $state({});
  async function assignFile(f) {
    const cvIssueId = Number(assignPick[f.path]);
    if (!cvIssueId) return;
    const r = await apiPost(`/api/collection/${s.id}/assign-file`, { path: f.path, cvIssueId }).catch((e) => ({ error: String(e) }));
    if (r?.error) return notify(r.error, 'error');
    notify(t('seriesDetail.fileAssigned'), 'ok');
    delete assignPick[f.path];
    reloadDetail();
  }
  const issueChoice = (i) => {
    const label = `#${i.number}${i.title && i.title !== '#' + i.number ? ' · ' + i.title : ''}`;
    return i.owned ? t('seriesDetail.choiceOwned', { label }) : label;
  };
  // Unlinked files whose number is beyond anything this volume has: the
  // strongest sign the series is matched to the WRONG ComicVine volume.
  const unlinkedBeyond = $derived.by(() => {
    if (!isCv || !(det.unlinkedFiles || []).length) return 0;
    const max = Math.max(0, ...det.issues.map((i) => parseFloat(i.number)).filter(Number.isFinite));
    return det.unlinkedFiles.filter((f) => Number.isFinite(parseFloat(f.number)) && parseFloat(f.number) > max).length;
  });
  // Unlinked files whose number sits INSIDE the volume's range but which the
  // volume simply doesn't list — ComicVine splits a retitled run into two
  // volumes (e.g. #1–36 under the old title, #37+ under the new one), so those
  // issues belong to a sibling volume, not this one.
  const unlinkedAbsent = $derived.by(() => {
    if (!isCv || !(det.unlinkedFiles || []).length) return 0;
    const have = new Set(det.issues.map((i) => String(parseFloat(i.number))));
    const max = Math.max(0, ...det.issues.map((i) => parseFloat(i.number)).filter(Number.isFinite));
    return det.unlinkedFiles.filter((f) => { const n = parseFloat(f.number); return Number.isFinite(n) && n <= max && !have.has(String(n)); }).length;
  });
  // Self-described series (plugin library types, e.g. Books): the hero/header
  // renders here like any series, but the issue area belongs to the plugin
  // that owns the type (registerSeriesView) — comic vocabulary (filter chips,
  // issue grid, selection) makes no sense for them.
  const isLocal = $derived(!!det && det.source === 'local' && Array.isArray(det.issues));
  const hasIssues = $derived(isCv || isLocal);

  /* ---- Plugin-owned issue area ----
     The plugin that registered this series' library type replaces the chips +
     issue list + selection with its own view; hero and ⋯ menu stay core.
     Comic/manga series never have a registered view, so they're unaffected. */
  const pluginView = $derived(seriesViews[det?.series?.type ?? s?.type] || null);
  let viewHost = $state(null);
  $effect(() => {
    const host = viewHost, view = pluginView;
    if (!host || !view || !det) return;
    // Re-render when the series data refreshes or a plugin bumps the actions
    // tick (e.g. reading progress changed) — the same signal the rows use.
    void issueActionsTick.n;
    void issues;
    // det.series is the full detail payload (year, type, description, …) —
    // richer than the header-paint row the hero uses.
    renderSeriesView(view, host, { series: det.series, issues, refresh: reloadDetail });
    // Clear between renders and on unmount — plugin listeners die with their nodes.
    return () => host.replaceChildren();
  });

  // Rename this series' files to the configured folder/file pattern. Dry-runs
  // first to show the count, then executes on confirm.
  let refileBusy = $state(false);
  async function refileFiles() {
    const sid = detail.series?.id, title = detail.series?.title || t('seriesDetail.thisSeries');
    if (!sid) return;
    let plan;
    try { plan = (await apiPost(`/api/collection/${sid}/refile`, { dryRun: true })).plan || []; }
    catch (e) { return notify(t('seriesDetail.planRenameFailed', { error: e?.message || e }), 'error'); }
    const moves = plan.filter((p) => p.status === 'move').length;
    const collisions = plan.filter((p) => p.status === 'skip:collision').length;
    if (!moves) return notify(collisions ? t('seriesDetail.nothingToDoCollide', { count: collisions }) : t('seriesDetail.filesMatchPattern'), 'info');
    if (!(await confirmDialog({
      title: t('seriesDetail.renameTitle', { count: moves }),
      message: t('seriesDetail.renameMessage', { title, collisions: collisions ? t('seriesDetail.renameCollisions', { count: collisions }) : '' }),
      confirmLabel: t('seriesDetail.renameFiles'),
    }))) return;
    refileBusy = true;
    let r;
    try { r = await apiPost(`/api/collection/${sid}/refile`, {}); }
    catch (e) { r = { error: String(e?.message || e) }; }
    refileBusy = false;
    if (r.error) return notify(r.error, 'error');
    notify(t('seriesDetail.renamed', { count: r.moved, skipped: r.skipped ? t('seriesDetail.renamedSkipped', { count: r.skipped }) : '' }), 'ok');
    reloadDetail();
  }
  const isUnmatched = $derived(!!det && det.source === 'unmatched');
  const issues = $derived(hasIssues ? det.issues : []);
  const missingIds = $derived(issues.filter((i) => !i.owned).map((i) => i.cv_issue_id));
  const wantedCount = $derived(issues.filter((i) => i.wanted).length);
  // What ships next, from the weekly release list (this week + next).
  const nextShip = $derived.by(() => {
    const list = (det?.upcoming || []).filter((u) => !u.owned && !u.collected && u.shipdate).sort((a, b) => String(a.shipdate).localeCompare(String(b.shipdate)));
    return list[0] || null;
  });

  const issueCountLabel = $derived(
    isCv && det.cv ? t('seriesDetail.nIssuesLabel', { n: fmt(det.cv.issue_count) })
    : isLocal ? t('seriesDetail.nItems', { count: det.issues.length, n: fmt(det.issues.length) })
    : isUnmatched ? (det.files && det.files.length ? t('seriesDetail.nFilesLabel', { n: fmt(det.files.length) }) : t('seriesDetail.unmatched'))
    : s ? t('seriesDetail.nIssuesLabel', { n: s.issue_count }) : '');

  /* ---- Series blurb (CV deck/description, else a local description) ---- */
  let descOpen = $state(false);
  const seriesBlurb = $derived.by(() => {
    const raw = det?.cv?.deck || det?.cv?.description || det?.series?.description || '';
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
  const FILTERS = ['all', 'missing', 'wanted', 'saved', 'corrupt', 'untagged', 'failed'];
  // Catalog keys, resolved at render time.
  const FILTER_LABELS = { all: 'common.all', missing: 'seriesDetail.filterMissing', wanted: 'seriesDetail.filterWanted', saved: 'seriesDetail.filterSaved', corrupt: 'seriesDetail.filterCorrupt', untagged: 'seriesDetail.filterUntagged', failed: 'seriesDetail.filterFailed' };

  // "find #" box: match against the row's text (number + title) — invaluable on
  // 2,000-issue series.
  function rowHidden(i) {
    const state = issueState(i);
    // "Wanted" is a decision, not a file state — it lives beside the state filters.
    if (currentFilter === 'wanted' ? !i.wanted : !issueMatchesFilter(state, currentFilter)) return true;
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

  const visibleIssues = $derived(hasIssues ? issues.filter((i) => !rowHidden(i)) : []);
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
  // Selection is universal — owned issues are selectable too (read status,
  // reading lists). Downloads filter to what's actually downloadable instead.
  // Selection is keyed by ComicVine issue id (every CV row has one; plugin-
  // owned series never reach this list).
  const downloadable = (i) => !(i.owned && !i.corrupt) && issueState(i) !== 'done';
  let lastToggled = $state(null); // index into visibleIssues, for shift-click ranges
  $effect(() => {
    void currentFilter; void findText;
    lastToggled = null; // indices shifted
    // A shorter filtered list can leave the scroll stranded in empty space.
    if (scroller && scroller.scrollTop > 0) scroller.scrollTop = 0;
  });
  function toggleIssue(i, index = null, shiftKey = false) {
    const willCheck = !detailSelected.has(i.cv_issue_id);
    if (shiftKey && lastToggled != null && index != null && index !== lastToggled) {
      // Shift-click: set the whole range to the clicked row's new state.
      const [a, b] = [Math.min(lastToggled, index), Math.max(lastToggled, index)];
      for (let k = a; k <= b; k++) {
        const it = visibleIssues[k];
        if (!it) continue;
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
    if (isUnmatched) return t('seriesDetail.summaryFiles', { count: (det.files || []).length, n: fmt((det.files || []).length) });
    if (!isCv) return '';
    let out = t('seriesDetail.summaryBase', { issues: fmt(issues.length), owned: fmt(counts.owned) });
    if (counts.missing) out += t('seriesDetail.summaryMissing', { n: fmt(counts.missing) });
    if (counts.corrupt) out += t('seriesDetail.summaryCorrupt', { n: fmt(counts.corrupt) });
    if (counts.untagged) out += t('seriesDetail.summaryUntagged', { n: fmt(counts.untagged) });
    return out;
  });

  // Hero completion overview: a per-state breakdown of the issue list for the
  // segmented progress bar + legend. Derived from issueState, same source of
  // truth as the badges and filters.
  const IN_FLIGHT = ['downloading', 'queued', 'grabbed', 'tagging', 'sent'];
  const hero = $derived.by(() => {
    const c = { saved: 0, untagged: 0, downloading: 0, failed: 0, corrupt: 0, missing: 0 };
    for (const i of issues) {
      const st = issueState(i);
      if (st === 'done') c.saved++;
      else if (st === 'untagged') c.untagged++;
      else if (st === 'corrupt') c.corrupt++;
      else if (st === 'failed') c.failed++;
      else if (IN_FLIGHT.includes(st)) c.downloading++;
      else c.missing++;
    }
    const total = issues.length;
    const owned = c.saved + c.untagged;
    return { ...c, total, owned, pct: total ? Math.round((owned / total) * 100) : 0,
      ownedW: total ? (owned / total) * 100 : 0, dlW: total ? (c.downloading / total) * 100 : 0 };
  });
  // Live per-filter counts for the issue filter tabs.
  const filterCounts = $derived.by(() => {
    const c = {};
    for (const f of FILTERS) c[f] = f === 'wanted' ? issues.filter((i) => i.wanted).length : issues.filter((i) => issueMatchesFilter(issueState(i), f)).length;
    return c;
  });

  /* ---- Header actions ---- */
  let refreshBusy = $state(false);
  // Refresh pulls the volume's metadata + issue list from ComicVine.
  async function refreshSeries() {
    if (!s) return;
    refreshBusy = true;
    // The action lives in a menu that closes on click — feedback must come
    // from toasts, not the (now hidden) menu-item label.
    notify(t('seriesDetail.refreshing'), 'info');
    try {
      const r = await apiPost(`/api/collection/${s.id}/refresh`);
      if (r.error) { notify(t('seriesDetail.refreshFailed', { error: r.error }), 'error'); return; }
      await loadCollection();
      await reloadDetail(); // re-render with the fresh metadata
      if (r.detailSweep) watchDetailSweep(); // covers/titles fill in live as the sweep caches them
      notify(t('seriesDetail.refreshed', { sweep: r.detailSweep ? t('seriesDetail.refreshedSweep') : '' }), 'ok');
    } catch {
      notify(t('seriesDetail.refreshUnreachable'), 'error');
    } finally {
      setTimeout(() => { refreshBusy = false; }, 1200);
    }
  }

  async function toggleFollow() {
    if (!s) return;
    const follow = !s.followed;
    try {
      const r = await apiPost(`/api/collection/${s.id}/follow`, { follow });
      if (r?.error) return notify(r.error, 'error'); // star stays truthful
    } catch { return notify(t('seriesDetail.updateUnreachable'), 'error'); }
    detail.series.followed = follow ? 1 : 0; // personal follow, not the monitor flag
    loadCollection();
  }

  // Monitoring policy — what download automation fetches for this series:
  // every missing issue, only new issues from a number onward, or nothing.
  // Library-manage roles set it from the ⋯ menu; personal follows never touch
  // it. Per-issue picks (below) override it either way.
  const monitorKey = $derived(det?.series?.monitor || (s?.monitored ? 'all' : 'none'));
  const monitorText = $derived(monitorKey === 'new' ? t('seriesDetail.monitoringNewFrom', { n: det?.series?.monitor_from ?? '?' })
    : monitorKey === 'all' ? t('seriesDetail.monitoringAll') : t('seriesDetail.notMonitored'));
  async function setMonitorPolicy(monitor) {
    if (!s) return;
    let from = null;
    if (monitor === 'new') {
      const newest = Math.max(0, ...issues.map((i) => parseFloat(i.number)).filter(Number.isFinite));
      const v = await inputDialog({
        title: t('seriesDetail.monitorNewTitle'),
        message: t('seriesDetail.monitorNewMessage'),
        value: String(det?.series?.monitor_from ?? newest), placeholder: t('seriesDetail.issueNumberPlaceholder'), confirmLabel: t('seriesDetail.monitor'),
      });
      if (v == null) return;
      from = String(v).trim().replace(/^#/, '');
      if (from === '' || !Number.isFinite(Number(from))) return notify(t('seriesDetail.enterIssueNumber'), 'error');
    }
    let clearPicks = false;
    const picked = det?.picks?.want || 0;
    if (monitor === 'none' && picked > 0) {
      const c = await choiceDialog({
        title: t('seriesDetail.stopMonitoringTitle'),
        message: t('seriesDetail.stopMonitoringMessage', { count: picked, n: fmt(picked) }),
        buttons: [{ label: t('seriesDetail.keepPicks'), value: 'keep' }, { label: t('seriesDetail.forgetPicksToo'), value: 'clear', danger: true }],
      });
      if (!c) return;
      clearPicks = c === 'clear';
    }
    try {
      const r = await apiPost(`/api/collection/${s.id}/monitor`, { monitor, from, clearPicks });
      if (r?.error) return notify(r.error, 'error');
      detail.series.monitored = r.monitored;
    } catch { return notify(t('seriesDetail.updateUnreachable'), 'error'); }
    notify(monitor === 'all' ? t('seriesDetail.monitoringEvery') : monitor === 'new' ? t('seriesDetail.monitoringNewFromDone', { n: from }) : t('seriesDetail.monitoringOff'), 'ok');
    reloadDetail();
    loadCollection();
  }
  async function forgetPicks() {
    if (!s) return;
    const n = (det?.picks?.want || 0) + (det?.picks?.skip || 0);
    if (!(await confirmDialog({ title: t('seriesDetail.forgetPicksTitle', { count: n, n: fmt(n) }), message: t('seriesDetail.forgetPicksMessage'), confirmLabel: t('seriesDetail.forgetPicks') }))) return;
    const r = await apiPost(`/api/collection/${s.id}/monitor`, { monitor: monitorKey, from: det?.series?.monitor_from ?? null, clearPicks: true });
    if (r?.error) return notify(r.error, 'error');
    reloadDetail();
  }

  // Per-issue wants: pick an issue the policy doesn't want, or skip one it
  // does. The server stores only the exception and answers with each issue's
  // resulting state, which is patched straight into the open rows.
  // Right-click menu for one issue. Built fresh on open so it reflects the
  // row's current state, and it deliberately mirrors the buttons already on the
  // row — the menu is a faster way to reach them, not a second set of actions.
  // Plugin actions come first because that is where Mark as read/unread lives.
  function issueMenuItems(i) {
    void issueActionsTick.n;   // rebuild when a plugin flips an issue's state
    const val = (v) => (typeof v === 'function' ? v(i) : v);
    const items = [];
    for (const a of issueActions) {
      if (a.when && !a.when(i)) continue;
      const label = val(a.title);
      if (!label) continue;
      items.push({ id: 'plugin:' + a.id, label, iconHtml: val(a.icon), run: () => a.run(i, detail.series) });
    }
    if (items.length) items.push('sep');
    items.push({ id: 'info', label: t('seriesDetail.issueDetails'), icon: 'info', run: () => openIssueInfo(i.cv_issue_id, i.number) });
    if (can('downloads.grab')) {
      if (i.corrupt) {
        items.push({ id: 'redl', label: t('seriesDetail.redownloadCorrupt'), icon: 'refresh', run: () => redownloadCvIssues([i.cv_issue_id]) });
      } else if (!i.owned) {
        items.push({ id: 'dl', label: t('seriesDetail.downloadThisIssue'), icon: 'download', run: () => downloadCvIssues([i.cv_issue_id]) });
      } else {
        items.push({ id: 'redl', label: t('seriesDetail.downloadAgain'), icon: 'refresh', run: () => redownloadCvIssues([i.cv_issue_id]) });
      }
      if (!i.owned && !i.corrupt) {
        items.push(i.wanted
          ? { id: 'want', label: t('seriesDetail.dontWant'), icon: 'target', run: () => setWants([i.cv_issue_id], false) }
          : { id: 'want', label: t('seriesDetail.wantThis'), icon: 'target', run: () => setWants([i.cv_issue_id], true) });
      }
    }
    return items;
  }

  async function setWants(cvIssueIds, want) {
    if (!s || !cvIssueIds.length) return;
    let r;
    try { r = await apiPost(`/api/collection/${s.id}/wanted`, { cvIssueIds, want }); }
    catch { return notify(t('seriesDetail.updateUnreachable'), 'error'); }
    if (r?.error) return notify(r.error, 'error');
    const by = new Map((r.issues || []).map((x) => [x.cv_issue_id, x]));
    for (const i of det.issues) {
      const u = by.get(i.cv_issue_id);
      if (u) { i.wanted = u.wanted; i.why = u.why; i.pick = u.pick; i.pick_reason = u.reason; }
    }
    if (det.picks) { det.picks.want = det.issues.filter((i) => i.pick === 'want').length; det.picks.skip = det.issues.filter((i) => i.pick === 'skip').length; }
    refreshIssueStatuses(); // an unwanted queued/failed row comes back parked
    if (cvIssueIds.length > 1) notify(want ? t('seriesDetail.wantingN', { n: fmt(cvIssueIds.length) }) : t('seriesDetail.noLongerWanted', { n: fmt(cvIssueIds.length) }), 'ok');
  }
  const wantTitle = (i) => i.wanted
    ? (i.why === 'pick' ? t('seriesDetail.wantedPicked', { reason: i.pick_reason && i.pick_reason !== 'manual' ? t('seriesDetail.wantedReason', { reason: i.pick_reason }) : '' }) : t('seriesDetail.wantedMonitored'))
    : (i.pick === 'skip' ? t('seriesDetail.skippedClick') : t('seriesDetail.notWantedClick'));

  // Move the series into an explicit library (or back to the default). The
  // library's type comes along — its members behave like the library says.
  async function moveToLibrary(libraryId) {
    const r = await apiPost(`/api/collection/${s.id}/library`, { libraryId });
    if (r.error) return notify(r.error, 'error');
    detail.det.series.library_id = libraryId;
    const lib = (status.libraries || []).find((l) => l.id === libraryId);
    if (lib) detail.det.series.type = lib.type;
    notify(lib ? t('seriesDetail.movedTo', { library: lib.name }) : t('seriesDetail.movedToDefault'), 'ok');
    loadCollection();
  }

  // Cycle the library type: comic → manga → comic. (Magazine joins the cycle
  // when magazine support lands — the API already accepts it.)
  async function toggleType() {
    if (!det?.series) return;
    const type = (det.series.type || 'comic') === 'manga' ? 'comic' : 'manga';
    const r = await apiPost(`/api/collection/${s.id}/type`, { type });
    if (r.error) return notify(r.error, 'error');
    detail.det.series.type = type;
    notify(type === 'manga' ? t('seriesDetail.markedManga') : t('seriesDetail.markedComic'), 'ok');
    loadCollection();
  }

  async function toggleRestricted() {
    if (!det?.series) return;
    const restricted = !det.series.restricted;
    const r = await apiPost(`/api/collection/${s.id}/restricted`, { restricted });
    if (r.error) return notify(r.error, 'error');
    detail.det.series.restricted = r.restricted;
    notify(r.restricted ? t('seriesDetail.markedMature') : t('seriesDetail.matureRemoved'), 'ok');
    loadCollection();
  }

  async function deleteSeries() {
    if (!s) return;
    const name = s.title || t('seriesDetail.thisSeries');
    // Keeping files is the safe default; deleting them is its own explicit button.
    const choice = await choiceDialog({
      title: t('seriesDetail.removeTitle', { name }),
      message: t('seriesDetail.removeMessage'),
      buttons: [
        { label: t('seriesDetail.removeKeepFiles'), value: 'keep' },
        { label: t('seriesDetail.removeDeleteFiles'), value: 'delete', danger: true },
      ],
    });
    if (!choice) return;
    const deleteFiles = choice === 'delete';
    const r = await apiPost('/api/collection/' + s.id + '/delete', { deleteFiles });
    if (r.error) { notify(t('seriesDetail.removeFailed', { error: r.error }), 'error'); return; }
    if (deleteFiles) notify(t('seriesDetail.removedDeleted', { count: r.deletedFiles || 0, n: fmt(r.deletedFiles || 0) }), 'ok');
    clearDetail();
    navigate('/');
    loadCollection();
  }

  async function redownloadAll() {
    // Poll-able rows only (in-flight/corrupt) — owned+intact issues keep their file.
    const ids = issues.filter((i) => !(i.owned && !i.corrupt)).map((i) => Number(i.id)).filter((n) => Number.isFinite(n) && n > 0);
    if (!ids.length) return;
    const ok = await confirmDialog({
      title: t('seriesDetail.redownloadTitle', { n: ids.length }),
      message: t('seriesDetail.redownloadMessage', { title: s?.title }),
      confirmLabel: t('seriesDetail.redownload'), danger: true,
    });
    if (ok) redownloadIssues(ids);
  }

  // Add the selection (or, with nothing checked, the whole series) to a
  // reading list — an existing one or a fresh one named on the spot.
  async function addToList() {
    let ids = [...detailSelected];
    if (!ids.length) ids = issues.map((i) => i.cv_issue_id).filter(Boolean);
    if (!ids.length) return;
    const scope = detailSelected.size ? t('seriesDetail.scopeSelected', { count: ids.length, n: fmt(ids.length) }) : t('seriesDetail.scopeAll', { n: fmt(ids.length) });
    const listId = await pickList({ message: t('seriesDetail.addingToList', { scope, title: s?.title }), newName: s?.title || '' });
    if (!listId) return;
    const res = await apiPost(`/api/lists/${listId}/items`, { cvIssueIds: ids });
    if (res.error) return notify(res.error, 'error');
    notify(res.added ? t('seriesDetail.addedToList', { count: res.added, n: fmt(res.added) }) : t('seriesDetail.alreadyOnList'), 'ok');
  }

  /* ---- Location row (scan / tag / cleanup / path / aliases) ---- */
  const untaggedOwned = $derived((det?.issues || []).filter((i) => i.owned && i.untagged).length);

  // Scan/Tag busy state + progress derive from the server's op state (mirrored
  // over SSE in the ops store) — so a scan started here still shows progress
  // after navigating away and back, and can't be double-started.
  const scanBusy = $derived(!!ops.scan.running);
  const scanMine = $derived(!!ops.scan.running && s && Number(ops.scan.seriesId) === s.id);
  const scanText = $derived(scanMine ? t('seriesDetail.scanning', { progress: fmt(ops.scan.done || 0) + (ops.scan.total ? '/' + fmt(ops.scan.total) : '') }) : t('seriesDetail.scanningElsewhere'));
  async function scanFolder() {
    if (!s || ops.scan.running) return;
    ops.scan = { running: true, seriesId: s.id, done: 0, total: 0 }; // optimistic until the next SSE tick
    try { await apiPost('/api/collection/' + s.id + '/scan'); }
    catch { notify(t('seriesDetail.scanFailed'), 'error'); ops.scan = { running: false }; }
  }
  // When the op for the OPEN series finishes, refresh + surface errors.
  let sawScan = false;
  $effect(() => {
    const st = ops.scan;
    if (st.running) { sawScan = sawScan || (s && Number(st.seriesId) === s.id); return; }
    if (!sawScan) return;
    sawScan = false;
    if (st.error) notify(t('seriesDetail.scanError', { error: st.error }), 'error');
    else notify(t('seriesDetail.scanComplete', { pruned: st.pruned ? t('seriesDetail.scanPruned', { count: st.pruned, n: fmt(st.pruned) }) : '' }), 'ok');
    loadCollection();
    if (detail.series && Number(st.seriesId) === detail.series.id) reloadDetail();
  });

  const tagBusy = $derived(!!ops.tag.running);
  const tagMine = $derived(!!ops.tag.running && s && Number(ops.tag.seriesId) === s.id);
  const tagText = $derived(tagMine ? t('seriesDetail.tagging', { progress: fmt(ops.tag.done || 0) + '/' + fmt(ops.tag.total || 0) }) : t('seriesDetail.taggingElsewhere'));
  async function tagFiles() {
    if (!s || ops.tag.running) return;
    ops.tag = { running: true, seriesId: s.id, done: 0, total: 0 };
    // When some issues are untagged, tag ONLY those; when all are tagged, the
    // button re-tags everything (a deliberate refresh).
    try { await apiPost('/api/collection/' + s.id + '/tag', { onlyUntagged: untaggedOwned > 0 }); }
    catch { notify(t('seriesDetail.taggingFailed'), 'error'); ops.tag = { running: false }; }
  }
  let sawTag = false;
  $effect(() => {
    const st = ops.tag;
    if (st.running) { sawTag = sawTag || (s && Number(st.seriesId) === s.id); return; }
    if (!sawTag) return;
    sawTag = false;
    if (st.error) notify(t('seriesDetail.taggingError', { error: st.error }), 'error');
    else if (st.total) notify(t('seriesDetail.tagged', { tagged: fmt(st.tagged || 0), total: fmt(st.total), problems: st.problems ? t('seriesDetail.taggedProblems', { count: st.problems, n: fmt(st.problems) }) : '' }), 'ok');
    if (detail.series && Number(st.seriesId) === detail.series.id) reloadDetail();
  });

  let cleanupBusy = $state(false);
  async function cleanupDuplicates() {
    if (!s) return;
    // Deletes files from disk — never without an explicit confirmation.
    const n = (det?.superseded || 0) + (det?.duplicates || 0);
    const parts = [];
    if (det?.superseded) parts.push(t('seriesDetail.dupSuperseded', { count: det.superseded, n: fmt(det.superseded) }));
    if (det?.duplicates) parts.push(t('seriesDetail.dupExtra', { count: det.duplicates, n: fmt(det.duplicates) }));
    if (!(await confirmDialog({
      title: t('seriesDetail.deleteDupTitle', { count: n, n: fmt(n) }),
      message: t('seriesDetail.deleteDupMessage', { parts: parts.join('; ') }),
      confirmLabel: t('seriesDetail.deleteDuplicates'), danger: true,
    }))) return;
    cleanupBusy = true;
    try {
      const r = await apiPost('/api/collection/' + s.id + '/cleanup');
      if (r.error) notify(t('seriesDetail.cleanupFailed', { error: r.error }), 'error');
      else notify(t('seriesDetail.deletedDuplicates', { count: r.removed || 0, n: fmt(r.removed || 0) }), 'ok');
      await reloadDetail(); // re-render
      loadCollection(); // refresh sidebar counts
    } catch { notify(t('seriesDetail.cleanupFailedPlain'), 'error'); }
    cleanupBusy = false;
  }

  // On-disk file count for closeness ranking in the CV picker: files attached to
  // CV issues (matched view) or the raw folder files (unmatched view).
    // Every file on disk for this series: linked to an issue, or not (an
  // unlinked file is the usual reason someone is re-matching in the first
  // place — leaving those out ranked the WRONG volume first).
  const pickerFileCount = $derived(!det ? 0
    : (det.issues || []).reduce((n, i) => n + ((i.files && i.files.length) || 0), 0)
      + (isCv ? (det.unlinkedFiles || []).length : ((det.files && det.files.length) || 0)));

  const cvUrl = $derived(det?.cv
    ? (det.cv.site_detail_url || ((det.cv.meta_source || 'comicvine') === 'comicvine' ? 'https://comicvine.gamespot.com/volume/4050-' + (det.cv.meta_ref || det.cv.comicvine_id) + '/' : null))
    : '');

  const corruptReason = (i) => (i.files || []).map((f) => f.error).find(Boolean);
</script>

<svelte:window onresize={measure} />

<section class="detail" bind:this={scroller} onscroll={onScroll}>
  {#if detail.failed}
    <!-- A deleted, mistyped or restricted series id: say so, instead of a
         header full of placeholders and a "is the app running?" note. -->
    <div class="nopage">
      <div class="nopage__card">
        <div class="nopage__art"><Icon name={detail.notFound ? 'search' : 'alert-triangle'} size={24} /></div>
        <div class="nopage__title">{detail.notFound ? t('seriesDetail.notInLibraryTitle') : t('seriesDetail.loadFailedTitle')}</div>
        <div class="nopage__text">{detail.notFound ? t('seriesDetail.notInLibraryText') : t('seriesDetail.loadFailedText')}</div>
        {#if !detail.notFound}<div class="nopage__code">{detail.failReason || ''}</div>{/if}
        <div class="nopage__actions"><button class="btn" onclick={goBack}><Icon name="arrow-left" size={14} /> {t('seriesDetail.backToLibrary')}</button></div>
      </div>
    </div>
  {:else if !s}
    <div id="detail-empty" class="empty">
      <div class="empty__art"><Icon name="star" fill /></div>
      <div class="empty__title">{t('seriesDetail.pickSeries')}</div>
      <div class="empty__text">{t('seriesDetail.pickSeriesText')}</div>
    </div>
  {:else}
    <div id="detail-body">
      <button id="detail-back" class="btn btn--ghost detail-back" onclick={goBack}><Icon name="arrow-left" /> {t('common.library')}</button>
      <header class="series-header">
        <Cover coverUrl={s.cover_url} title={s.title} />
        <div class="series-meta">
          <h2 id="series-title">{s.title}</h2>
          <div class="series-tags">
            <span class="tag" id="series-pub">{s.publisher || t('seriesDetail.unknownPublisher')}{det?.cv?.metron_imprint ? ` · ${det.cv.metron_imprint}` : ''}</span>
            <span class="tag tag--mono" id="series-issuecount">{issueCountLabel}</span>
            {#if isCv && nextShip}
              <span class="tag" id="series-next" title={t('seriesDetail.nextShipTitle')}><Icon name="calendar" size={12} /> {t('seriesDetail.nextShip', { number: nextShip.number, date: fmtDay(nextShip.shipdate) })}</span>
            {/if}
            {#if isCv}
              <span class="tag mon-tag mon-tag--{monitorKey}" id="series-monitor" title={t('seriesDetail.monitorTagTitle')}>
                <Icon name={monitorKey === 'none' ? 'pause' : monitorKey === 'new' ? 'zap' : 'target'} size={12} /> {monitorText}
              </span>
            {/if}
            {#if det?.cv?.metron_series_type && !/single issue|ongoing/i.test(det.cv.metron_series_type)}
              <span class="tag" title={t('seriesDetail.seriesTypeTitle')}>{det.cv.metron_series_type}</span>
            {/if}
            {#if det?.cv?.metron_genres?.length}
              <span class="tag" title={t('seriesDetail.genresTitle')}>{det.cv.metron_genres.slice(0, 3).join(' · ')}</span>
            {/if}
          </div>
          <div class="series-cv" id="series-cv">
            {#if det?.cv}
              <a class="cv-chip" href={cvUrl} target="_blank" rel="noreferrer" title={t('seriesDetail.openSourcePage')}><Icon name="diamond" /> {det.cv.name || t('seriesDetail.sourcePage')}
                {#if det.cv.start_year}<span class="cv-year">({det.cv.start_year}{det.cv.metron_year_end && det.cv.metron_year_end !== det.cv.start_year ? `–${det.cv.metron_year_end}` : ''})</span>{/if} {#if cvUrl}<Icon name="external-link" />{/if}</a>
              <span class="cv-total">{t('seriesDetail.issuesKnown', { n: fmt(det.cv.count_of_issues || det.cv.issue_count || 0) })}{det.series?.cv_locked ? t('seriesDetail.pinned') : ''}</span>
              {#if det.cv.metron_status && det.cv.metron_status !== 'Ongoing'}
                <span class="tag" title={t('seriesDetail.pubStatusTitle')}>{det.cv.metron_status}</span>
              {/if}
              {#if det.cv.metron_rating}
                <span class="tag" class:tag--warn={['Mature','Explicit','Adult'].includes(det.cv.metron_rating)} title={t('seriesDetail.ratingTitle')}>{det.cv.metron_rating}</span>
              {/if}
            {:else if det && det.source === 'unmatched'}
              <span class="cv-none">{t('seriesDetail.noMatch')}</span>
              {#if isTrusted()}<button class="link-btn cv-fix" onclick={() => openCvPicker(s.id, s.title, null, { files: pickerFileCount })}>{t('seriesDetail.matchLink')}</button>{/if}
            {/if}
          </div>
          {#if seriesBlurb}
            <p class="series-desc" class:is-open={descOpen} title={descOpen ? undefined : t('seriesDetail.clickToExpand')}
              onclick={() => { descOpen = !descOpen; }} role="button" tabindex="0"
              onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); descOpen = !descOpen; } }}>{seriesBlurb}</p>
          {/if}
          {#if isCv && hero.total}
            <!-- Completion overview: a segmented bar (owned vs. in-flight) + a
                 per-state legend, so series health reads at a glance without
                 filtering to discover it. -->
            <div class="sx-comp">
              <div class="sx-comp__top">
                <span class="sx-comp__owned">{t('seriesDetail.ownedOf', { owned: fmt(hero.owned), total: fmt(hero.total) })}</span>
                <span class="sx-comp__pct" class:is-done={hero.owned >= hero.total}>{hero.pct}%</span>
              </div>
              <div class="sx-comp__bar">
                <div class="sx-comp__seg sx-comp__seg--owned" style="width:{hero.ownedW}%"></div>
                <div class="sx-comp__seg sx-comp__seg--dl" style="width:{hero.dlW}%"></div>
              </div>
              <div class="sx-comp__legend">
                {#if hero.saved}<span class="sx-comp__leg sx-comp__leg--saved">{t('seriesDetail.legSaved', { n: fmt(hero.saved) })}</span>{/if}
                {#if hero.downloading}<span class="sx-comp__leg sx-comp__leg--dl">{t('seriesDetail.legDownloading', { n: fmt(hero.downloading) })}</span>{/if}
                {#if hero.missing}<span class="sx-comp__leg sx-comp__leg--miss">{t('seriesDetail.legMissing', { n: fmt(hero.missing) })}</span>{/if}
                {#if wantedCount}<span class="sx-comp__leg sx-comp__leg--wanted" title={t('seriesDetail.legWantedTitle')}>{t('seriesDetail.legWanted', { n: fmt(wantedCount) })}</span>{/if}
                {#if hero.corrupt}<span class="sx-comp__leg sx-comp__leg--bad">{t('seriesDetail.legCorrupt', { n: fmt(hero.corrupt) })}</span>{/if}
                {#if hero.failed}<span class="sx-comp__leg sx-comp__leg--bad">{t('seriesDetail.legFailed', { n: fmt(hero.failed) })}</span>{/if}
                {#if hero.untagged}<span class="sx-comp__leg sx-comp__leg--untagged">{t('seriesDetail.legUntagged', { n: fmt(hero.untagged) })}</span>{/if}
              </div>
            </div>
          {/if}
          <!-- Disk location lives in Edit metadata; scan/tag progress and
               completion report via toasts (same pattern as Refresh metadata). -->
          <div class="series-actions">
            {#if isUnmatched}
              {#if isTrusted()}
                <button id="download-series" class="btn btn--primary" onclick={() => openCvPicker(s.id, (det.series && det.series.folder) || s.title, null, { files: pickerFileCount })}>{t('seriesDetail.matchSeries')}</button>
              {/if}
            {:else if !isLocal && can('downloads.grab')}
              {#if isCv}
                <button id="download-series" class="btn btn--primary" disabled={!missingIds.length} onclick={() => downloadCvIssues(missingIds)}>
                  {missingIds.length ? t('seriesDetail.downloadMissingN', { n: fmt(missingIds.length) }) : t('seriesDetail.downloadMissing')}</button>
              {:else}
                <button id="download-series" class="btn btn--primary" disabled>{t('seriesDetail.downloadMissing')}</button>
              {/if}
            {/if}
            {#if !isLocal && can('downloads.grab')}
              <!-- Selection now includes owned issues (read status, lists) — the
                   download acts on the downloadable subset only. -->
              {@const dlIds = issues.filter((i) => detailSelected.has(i.cv_issue_id) && downloadable(i)).map((i) => i.cv_issue_id)}
              <button id="download" class="btn btn--secondary" disabled={dlIds.length === 0}
                title={detailSelected.size && !dlIds.length ? t('seriesDetail.allSelectedDownloaded') : ''}
                onclick={() => { downloadCvIssues(dlIds); detailSelected.clear(); }}>
                {dlIds.length ? t('seriesDetail.downloadSelectedN', { n: dlIds.length }) : t('seriesDetail.downloadSelected')}</button>
            {/if}
            {#if isCv}
              <button id="add-to-list" class="btn btn--ghost" title={t('seriesDetail.addToListTitle')} onclick={addToList}><Icon name="menu" /> {t('seriesDetail.addToList')}{detailSelected.size ? ` (${detailSelected.size})` : ''}</button>
            {/if}
            {#each seriesActions as a (a.id + ':' + issueActionsTick.n)}
              {#if !a.when || a.when(s, issues)}
                <button class="btn btn--ghost" title={typeof a.title === 'function' ? a.title(s, issues) : a.title}
                  onclick={() => a.run(s, issues)}>{@html typeof a.label === 'function' ? a.label(s, issues) : a.label}</button>
              {/if}
            {/each}
            {#if isTrusted()}
              <button id="follow-btn" class="btn btn--ghost" class:is-following={!!s.followed} onclick={toggleFollow}>{#if s.followed}<Icon name="star" fill /> {t('seriesDetail.following')}{:else}<Icon name="star" /> {t('seriesDetail.follow')}{/if}</button>
            {/if}
            <!-- Secondary/destructive actions live in one overflow menu — the
                 header stays scannable, and Remove is visually separated. -->
            {#if !isUnmatched && (isTrusted() || can('downloads.grab'))}
              <div class="series-more">
                <button id="series-more-btn" class="btn btn--ghost" aria-label={t('seriesDetail.moreActions')} aria-haspopup="menu" aria-expanded={moreOpen}
                  onclick={(e) => { e.stopPropagation(); moreOpen = !moreOpen; }}>⋯</button>
                {#if moreOpen}
                  <div class="series-more__menu" role="menu">
                    {#if !isLocal && can('library.manage')}
                      <div class="menu__label">{t('seriesDetail.monitoring')}</div>
                      <button class="menu__item" class:is-current={monitorKey === 'all'} role="menuitemradio" aria-checked={monitorKey === 'all'} title={t('seriesDetail.monAllTitle')}
                        onclick={() => { moreOpen = false; if (monitorKey !== 'all') setMonitorPolicy('all'); }}><Icon name={monitorKey === 'all' ? 'check' : 'target'} /> {t('seriesDetail.monAll')}</button>
                      <button class="menu__item" class:is-current={monitorKey === 'new'} role="menuitemradio" aria-checked={monitorKey === 'new'} title={t('seriesDetail.monNewTitle')}
                        onclick={() => { moreOpen = false; setMonitorPolicy('new'); }}><Icon name={monitorKey === 'new' ? 'check' : 'zap'} /> {t('seriesDetail.monNew')}</button>
                      <button class="menu__item" class:is-current={monitorKey === 'none'} role="menuitemradio" aria-checked={monitorKey === 'none'} title={t('seriesDetail.monNoneTitle')}
                        onclick={() => { moreOpen = false; if (monitorKey !== 'none') setMonitorPolicy('none'); }}><Icon name={monitorKey === 'none' ? 'check' : 'pause'} /> {t('seriesDetail.monOff')}</button>
                      {#if det?.picks && (det.picks.want || det.picks.skip)}
                        {@const pn = det.picks.want + det.picks.skip}
                        <button class="menu__item" role="menuitem" title={t('seriesDetail.forgetPickedTitle')}
                          onclick={() => { moreOpen = false; forgetPicks(); }}><Icon name="rotate-ccw" /> {t('seriesDetail.forgetPicked', { count: pn, n: fmt(pn) })}</button>
                      {/if}
                      <div class="series-more__sep" role="separator"></div>
                    {/if}
                    {#if isTrusted()}
                      {#if !isLocal}
                        <button class="menu__item" role="menuitem" disabled={refreshBusy} title={t('seriesDetail.refreshTitle')}
                          onclick={() => { moreOpen = false; refreshSeries(); }}><Icon name="refresh" /> {refreshBusy ? t('seriesDetail.refreshingShort') : t('seriesDetail.refreshMetadata')}</button>
                      {/if}
                      {#if isCv}
                        <button class="menu__item" role="menuitem" title={t('seriesDetail.editMetadataTitle')}
                          onclick={() => { moreOpen = false; openEditMetadata(s.id, det?.cv, det?.series, det?.location); }}><Icon name="edit" /> {t('seriesDetail.editMetadata')}</button>
                      {/if}
                      {#if !isLocal}
                        <button class="menu__item" role="menuitem" title={t('seriesDetail.fixMatchTitle')}
                          onclick={() => { moreOpen = false; openCvPicker(s.id, s.title, null, { files: pickerFileCount }); }}><Icon name="diamond" /> {t('seriesDetail.fixMatch')}</button>
                        <button class="menu__item" role="menuitem" disabled={scanBusy} title={t('seriesDetail.scanFolderTitle')}
                          onclick={() => { moreOpen = false; notify(t('seriesDetail.scanningFolder'), 'info'); scanFolder(); }}><Icon name="search" /> {scanBusy ? scanText : t('seriesDetail.scanFolder')}</button>
                      {/if}
                      {#if isCv}
                        <button class="menu__item" role="menuitem" disabled={refileBusy} title={t('seriesDetail.renameTitleMenu')}
                          onclick={() => { moreOpen = false; refileFiles(); }}><Icon name="edit" /> {refileBusy ? t('seriesDetail.renaming') : t('seriesDetail.renameFiles')}</button>
                      {/if}
                      {#if det?.cv}
                        <button class="menu__item" role="menuitem" disabled={tagBusy} title={t('seriesDetail.tagFilesTitle')}
                          onclick={() => { moreOpen = false; notify(t('seriesDetail.taggingFiles'), 'info'); tagFiles(); }}><Icon name="tag" /> {tagBusy ? tagText : (untaggedOwned ? t('seriesDetail.tagUntagged', { n: fmt(untaggedOwned) }) : t('seriesDetail.tagFiles'))}</button>
                      {/if}
                      {#if det?.superseded || det?.duplicates}
                        {@const dupN = (det.superseded || 0) + (det.duplicates || 0)}
                        <button class="menu__item" role="menuitem" disabled={cleanupBusy} title={t('seriesDetail.cleanupTitle')}
                          onclick={() => { moreOpen = false; cleanupDuplicates(); }}><Icon name="trash" /> {cleanupBusy ? t('seriesDetail.removing') : t('seriesDetail.removeDuplicates', { count: dupN, n: fmt(dupN) })}</button>
                      {/if}
                    {/if}
                    {#if !isLocal && can('downloads.grab')}
                      <button id="redownload-series" class="menu__item" role="menuitem" title={t('seriesDetail.retryTitle')}
                        onclick={() => { moreOpen = false; redownloadAll(); }}><Icon name="rotate-ccw" /> {t('seriesDetail.retryMissing')}</button>
                      {#if flags.anySource}
                        <button id="torrent-pack-btn" class="menu__item" role="menuitem" title={t('seriesDetail.searchPacksTitle')}
                          onclick={() => { moreOpen = false; openPackSearch(); }}><Icon name="arrow-up-down" /> {t('seriesDetail.searchPacks')}</button>
                      {/if}
                    {/if}
                    {#if isTrusted()}
                      {#if isLocal}
                        <!-- A self-described series belongs to its plugin library; core
                             moves/typing would orphan it from its own scanner. -->
                      {:else if (status.libraries || []).length}
                        <!-- Explicit libraries exist → move between them (the type rides along). -->
                        {#each status.libraries.filter((l) => l.id !== det?.series?.library_id) as lib (lib.id)}
                          <button class="menu__item" role="menuitem" title={t('seriesDetail.moveToLibraryTitle', { name: lib.name })}
                            onclick={() => { moreOpen = false; moveToLibrary(lib.id); }}><Icon name="book" /> {t('seriesDetail.moveToLibrary', { name: lib.name })}</button>
                        {/each}
                      {:else}
                        <button id="series-type-btn" class="menu__item" role="menuitem" title={t('seriesDetail.typeTitle')}
                          onclick={() => { moreOpen = false; toggleType(); }}><Icon name="book" /> {(det?.series?.type || 'comic') === 'manga' ? t('seriesDetail.markAsComic') : t('seriesDetail.markAsManga')}</button>
                      {/if}
                      <button id="restrict-btn" class="menu__item" role="menuitem" title={t('seriesDetail.restrictTitle')}
                        onclick={() => { moreOpen = false; toggleRestricted(); }}><Icon name="shield" /> {det?.series?.restricted ? t('seriesDetail.removeMatureFlag') : t('seriesDetail.markMature')}</button>
                      <div class="series-more__sep" role="separator"></div>
                      <button id="delete-series" class="menu__item menu__item--danger" role="menuitem"
                        onclick={() => { moreOpen = false; deleteSeries(); }}><Icon name="trash" /> {t('seriesDetail.removeFromLibrary')}</button>
                    {/if}
                  </div>
                {/if}
              </div>
            {/if}
          </div>
        </div>
      </header>

      <div class="issues">
        {#if !pluginView && !isLocal}
          <div class="issues__head">
            <label class="checkall"><input type="checkbox" id="select-all" checked={visibleIssues.length > 0 && visibleIssues.every((i) => detailSelected.has(i.cv_issue_id))} onchange={(e) => selectAll(e.currentTarget.checked)} /> <span>{t('seriesDetail.selectAll')}</span></label>
            {#if isCv && detailSelected.size && can('downloads.grab')}
              {@const selIds = issues.filter((i) => detailSelected.has(i.cv_issue_id) && !i.owned).map((i) => i.cv_issue_id)}
              <!-- Selection-scoped want/unwant: picks for the selected gaps. -->
              <button class="filter__btn wantbtn" disabled={!selIds.length} title={t('seriesDetail.wantSelectedTitle')} onclick={() => setWants(selIds, true)}><Icon name="target" size={13} /> {t('seriesDetail.want')}{selIds.length ? ` (${fmt(selIds.length)})` : ''}</button>
              <button class="filter__btn wantbtn" disabled={!selIds.length} title={t('seriesDetail.unwantSelectedTitle')} onclick={() => setWants(selIds, false)}><Icon name="ban" size={13} /> {t('seriesDetail.unwant')}</button>
            {/if}
            <div class="filter" id="filter">
              {#each FILTERS as f (f)}
                {@const n = filterCounts[f]}
                <button class="filter__btn" class:is-active={currentFilter === f} onclick={() => { currentFilter = f; }}>{t(FILTER_LABELS[f])}{#if n}<span class="filter__count">{fmt(n)}</span>{/if}</button>
              {/each}
            </div>
            <input id="issue-find" type="search" class="issue-find" placeholder={t('seriesDetail.findPlaceholder')} title={t('seriesDetail.findTitle')} bind:value={findText} />
            <div class="viewtoggle" role="group" aria-label={t('seriesDetail.issueView')}>
              <button class="viewtoggle__btn" class:is-active={gridMode} title={t('seriesDetail.coverGrid')} onclick={() => setIssueView('grid')}><Icon name="grid" /></button>
              <button class="viewtoggle__btn" class:is-active={!gridMode} title={t('seriesDetail.listView')} onclick={() => setIssueView('list')}><Icon name="list" /></button>
            </div>
            <span id="issues-summary" class="muted">{summary}</span>
          </div>
        {/if}
        <div id="issues-list" class="issues-list" bind:this={listEl}>
          {#if detail.failed}
            <div class="list-note">{t('seriesDetail.loadFailedNote')}</div>
          {:else if !det && s}
            <div class="list-note">{t('seriesDetail.loadingIssues')}</div>
          {:else if pluginView}
            <!-- The plugin that owns this library type draws the issue area
                 (registerSeriesView) into this container — see the $effect. -->
            <div class="plugin-series-view" bind:this={viewHost}></div>
          {:else if isLocal}
            <!-- A plugin-owned type with no registered view: its client script
                 is still loading, or failed to load. The comic layout would be
                 nonsense here, so say so quietly instead. -->
            <div class="list-note">{plugins.ready ? t('seriesDetail.pluginViewMissing') : t('common.loading')}</div>
          {:else if isUnmatched}
            <!-- A comic with no ComicVine match: no issue list (sources are download-only) —
                 show the files on disk and a prompt to match. -->
            <div class="unmatched-note">{t('seriesDetail.unmatchedNote')}</div>
            <div class="unmatched-files">
              {#if (det.files || []).length}
                <div class="unmatched-files__head">{t('seriesDetail.filesOnDisk', { count: det.files.length, n: fmt(det.files.length) })}</div>
                {#each det.files as f (f.path)}
                  <div class="unmatched-file" class:is-bad={!f.valid} title={f.path}>{f.name}</div>
                {/each}
              {:else}
                <div class="unmatched-files__head scan-muted">{t('seriesDetail.noFilesScanned')}</div>
              {/if}
            </div>
          {:else if isCv && gridMode}
            <!-- Cover grid: each issue is a card; owned covers come from a
                 plugin provider (reader page-0 thumbs) or ComicVine art. -->
            <div class="issue-grid">
              {#if range.padTop > 0}<div class="issue-grid__pad" style="height:{range.padTop}px"></div>{/if}
              {#each visibleIssues.slice(range.start, range.end) as i, vi (i.cv_issue_id)}
                {@const state = issueState(i)}
                {@const cover = issueCoverUrl(i)}
                <div class="icard"
                  class:is-corrupt={i.corrupt} class:is-checked={detailSelected.has(i.cv_issue_id)} class:is-wanted={i.wanted && !i.owned}
                  use:contextMenu={() => issueMenuItems(i)}
                  title={i.corrupt && corruptReason(i) ? t('seriesDetail.corruptPrefix', { reason: corruptReason(i) }) : (i.title || '')}>
                  <div class="icard__art" onclick={() => openIssueInfo(i.cv_issue_id, i.number)} role="button" tabindex="0"
                    onkeydown={(e) => { if (e.key === 'Enter') openIssueInfo(i.cv_issue_id, i.number); }}>
                    <div class="icard__ph">#{i.number ?? '?'}</div>
                    {#if cover}<img loading="lazy" alt="" referrerpolicy="no-referrer" src={cover}
                      onerror={(e) => e.currentTarget.remove()} />{/if}
                    <input class="icard__check" type="checkbox" checked={detailSelected.has(i.cv_issue_id)}
                      onclick={(e) => { e.stopPropagation(); toggleIssue(i, range.start + vi, e.shiftKey); }} />
                    <span class="icard__state icard__state--{state}" title={state}></span>
                    <button class="icard__more" title={t('seriesDetail.actions')} aria-label={t('seriesDetail.actionsForIssue', { number: i.number ?? '' })}
                      onclick={(e) => { e.stopPropagation(); openContextMenu(e, issueMenuItems(i)); }}><Icon name="more-horizontal" size={15} /></button>
                    <div class="icard__actions" onclick={(e) => e.stopPropagation()}>
                      {#each issueActions as a (a.id + ':' + issueActionsTick.n)}
                        {#if !a.when || a.when(i)}
                          <button class="icard__btn" title={typeof a.title === 'function' ? a.title(i) : a.title}
                            onclick={() => a.run(i, detail.series)}>{@html typeof a.icon === 'function' ? a.icon(i) : a.icon}</button>
                        {/if}
                      {/each}
                      {#if can('downloads.grab')}
                        {#if !i.owned && !i.corrupt}
                          <button class="icard__btn icard__btn--want" class:is-on={i.wanted} title={wantTitle(i)} onclick={() => setWants([i.cv_issue_id], !i.wanted)}><Icon name="target" /></button>
                        {/if}
                        {#if i.corrupt}
                          <button class="icard__btn icard__btn--warn" title={t('seriesDetail.corruptRedownload')} onclick={() => redownloadCvIssues([i.cv_issue_id])}><Icon name="refresh" /></button>
                        {:else if !i.owned}
                          <button class="icard__btn" title={t('seriesDetail.downloadThisIssue')} onclick={() => downloadCvIssues([i.cv_issue_id])}><Icon name="download" /></button>
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
              <div class="list-note">{t('seriesDetail.nothingMatchesFilter')}</div>
            {/if}
          {:else if isCv}
            {#if range.padTop > 0}<div style="height:{range.padTop}px"></div>{/if}
            {#each visibleIssues.slice(range.start, range.end) as i, vi (i.cv_issue_id)}
              {@const state = issueState(i)}
              {@const bf = bestFile(i)}
              <div class="issue"
                class:is-owned={i.owned} class:is-corrupt={i.corrupt}
                use:contextMenu={() => issueMenuItems(i)}
                title={i.corrupt && corruptReason(i) ? t('seriesDetail.corruptPrefix', { reason: corruptReason(i) }) : undefined}
                onclick={(e) => toggleIssue(i, range.start + vi, e.shiftKey)} role="button" tabindex="0"
                onkeydown={(e) => { if (e.key === 'Enter') toggleIssue(i, range.start + vi, e.shiftKey); }}>
                <input type="checkbox" value={i.cv_issue_id}
                  checked={detailSelected.has(i.cv_issue_id)}
                  onclick={(e) => e.stopPropagation()}
                  onchange={() => toggleIssue(i, range.start + vi)} />
                <span class="issue__num">{i.number || '—'}</span>
                <button class="issue__title" title={t('seriesDetail.issueDetailsTitle')} onclick={(e) => { e.stopPropagation(); openIssueInfo(i.cv_issue_id, i.number); }}>{i.title}</button>
                <span class="issue__col issue__col--date" title={t('seriesDetail.coverDate')}>{i.cover_date || ''}</span>
                <span class="issue__col issue__col--pages" title={t('seriesDetail.pages')}>{bf?.page_count ? fmt(bf.page_count) + 'p' : ''}</span>
                <span class="issue__col issue__col--size" title={bf ? bf.name : ''}>{bf?.size ? humanBytes(bf.size) : ''}</span>
                {#if bf}<span class="issue__fmt" class:issue__fmt--untagged={!bf.has_metadata} title={bf.has_metadata ? t('seriesDetail.taggedWithMetadata') : t('seriesDetail.noTagsYet')}>{fileExt(bf)}</span>
                {:else}<span class="issue__fmt issue__fmt--none"></span>{/if}
                <Badge status={state} />
                {#each issueActions as a (a.id + ':' + issueActionsTick.n)}
                  {#if !a.when || a.when(i)}
                    <button class="issue__dl" title={typeof a.title === 'function' ? a.title(i) : a.title} onclick={(e) => { e.stopPropagation(); a.run(i, detail.series); }}>{@html typeof a.icon === 'function' ? a.icon(i) : a.icon}</button>
                  {/if}
                {/each}
                <button class="issue__dl issue__more" title={t('seriesDetail.actions')} aria-label={t('seriesDetail.actionsForIssue', { number: i.number ?? '' })}
                  onclick={(e) => { e.stopPropagation(); openContextMenu(e, issueMenuItems(i)); }}><Icon name="more-horizontal" /></button>
                {#if !i.owned && !i.corrupt && can('downloads.grab')}
                  <button class="issue__dl issue__want" class:is-on={i.wanted} title={wantTitle(i)} onclick={(e) => { e.stopPropagation(); setWants([i.cv_issue_id], !i.wanted); }}><Icon name="target" /></button>
                {/if}
                {#if i.corrupt && can('downloads.grab')}
                  <button class="issue__dl issue__dl--warn" title={t('seriesDetail.corruptRedownload')} onclick={(e) => { e.stopPropagation(); redownloadCvIssues([i.cv_issue_id]); }}><Icon name="refresh" /></button>
                {:else if i.owned}
                  <button class="issue__dl" title={i.untagged ? t('seriesDetail.ownedNoTags') : t('seriesDetail.owned')} disabled><Icon name="check" /></button>
                {:else if !i.corrupt && can('downloads.grab')}
                  <button class="issue__dl" title={t('seriesDetail.downloadThisIssue')} onclick={(e) => { e.stopPropagation(); downloadCvIssues([i.cv_issue_id]); }}><Icon name="download" /></button>
                {/if}
              </div>
            {/each}
            {#if range.padBottom > 0}<div style="height:{range.padBottom}px"></div>{/if}
            {#if !visibleIssues.length && issues.length}
              <div class="list-note">{t('seriesDetail.nothingMatchesFilter')}</div>
            {/if}
          {:else}
            <div class="loading">{t('seriesDetail.loadingIssues')}</div>
          {/if}
        </div>
        {#if isCv && (det.unlinkedFiles || []).length}
          {@const n = det.unlinkedFiles.length}
          <!-- Files in this series' folder that match no ComicVine issue. Without
               this, such a file is invisible and its issue simply reads "missing". -->
          <div class="unlinked">
            <div class="unlinked__head"><Icon name="alert-triangle" size={14} /> {t('seriesDetail.unlinkedHead', { count: n, n: fmt(n) })}</div>
            <div class="unlinked__note">{@html th('seriesDetail.unlinkedNote', { assign: isTrusted() || can('library.manage') ? t('seriesDetail.unlinkedAssign') : '' })}</div>
            {#if unlinkedBeyond}
              <div class="unlinked__hint">{@html th('seriesDetail.unlinkedBeyond', { count: unlinkedBeyond, n: fmt(unlinkedBeyond), issues: t('common.nIssues', { count: det.issues.length }) })}</div>
            {/if}
            {#if unlinkedAbsent}
              <div class="unlinked__hint">{@html th('seriesDetail.unlinkedAbsent', { count: unlinkedAbsent, n: fmt(unlinkedAbsent) })}</div>
            {/if}
            {#each (showAllUnlinked ? det.unlinkedFiles : det.unlinkedFiles.slice(0, 40)) as f (f.path)}
              <div class="unlinked__file" class:is-bad={!f.valid} title={f.path}>
                <span class="unlinked__name">{f.name}</span>
                <span class="unlinked__num">{f.number ? t('seriesDetail.readAs', { number: f.number, tag: f.fromTag ? t('seriesDetail.fromTag') : '' }) : t('seriesDetail.noIssueNumber')}</span>
                {#if isTrusted() || can('library.manage')}
                  <select class="unlinked__pick" aria-label={t('seriesDetail.assignAria', { name: f.name })} bind:value={assignPick[f.path]}>
                    <option value="">{t('seriesDetail.assignTo')}</option>
                    {#each det.issues as i (i.cv_issue_id)}<option value={i.cv_issue_id}>{issueChoice(i)}</option>{/each}
                  </select>
                  <button class="unlinked__assign" disabled={!assignPick[f.path]} onclick={() => assignFile(f)}>{t('seriesDetail.assign')}</button>
                {/if}
              </div>
            {/each}
            {#if !showAllUnlinked && n > 40}
              <button class="unlinked__more" onclick={() => (showAllUnlinked = true)}>{t('seriesDetail.showAll', { n: fmt(n) })}</button>
            {/if}
          </div>
        {/if}
      </div>
    </div>
  {/if}
</section>

<style>
  /* Completion overview in the hero: segmented bar + per-state legend. */
  .sx-comp { max-width: 600px; margin: 4px 0 16px; }
  .sx-comp__top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
  .sx-comp__owned { font: 600 12.5px var(--font-body); color: var(--text); }
  .sx-comp__pct { font: 600 12.5px var(--font-mono); color: var(--muted); }
  .sx-comp__pct.is-done { color: var(--green); }
  .sx-comp__bar { height: 8px; border-radius: 8px; background: var(--ink); overflow: hidden; display: flex; }
  .sx-comp__seg { height: 100%; }
  .sx-comp__seg--owned { background: var(--green); }
  .sx-comp__seg--dl { background: var(--cyan); }
  .sx-comp__legend { display: flex; flex-wrap: wrap; gap: 14px; margin-top: 9px; font-size: 11.5px; }
  .sx-comp__leg { display: inline-flex; align-items: center; gap: 6px; }
  .sx-comp__leg::before { content: '●'; font-size: 9px; }
  .sx-comp__leg--saved { color: var(--green); }
  .sx-comp__leg--dl { color: var(--cyan); }
  .sx-comp__leg--miss { color: var(--amber); }
  .sx-comp__leg--bad { color: var(--red); }
  .sx-comp__leg--untagged { color: var(--muted); }
  .sx-comp__leg--wanted { color: var(--accent); }

  /* Monitoring policy tag in the header + the ⋯ menu section. */
  .mon-tag { display: inline-flex; align-items: center; gap: 5px; }
  .mon-tag--all { color: var(--green); }
  .mon-tag--new { color: var(--cyan); }
  .mon-tag--none { color: var(--faint); }
  .menu__label { padding: 6px 12px 2px; font: 600 10.5px var(--font-body); letter-spacing: .08em; text-transform: uppercase; color: var(--faint); }
  :global(.series-more__menu .menu__item.is-current) { color: var(--accent); }

  /* Want toggles: a wanted issue shows its target even when the row isn't hovered. */
  .issue__want.is-on { opacity: 1; color: var(--accent); }
  .issue__want.is-on:hover { color: #fff; background: var(--accent); }
  :global(.icard__btn--want.is-on) { color: var(--accent); }
  /* A wanted (unowned) card carries a small target mark at rest, so the grid
     reads the same as the list without hovering. */
  :global(.icard.is-wanted .icard__art::before) { content: ''; position: absolute; left: 7px; bottom: 7px; width: 9px; height: 9px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 2px rgba(12,10,18,.8); z-index: 2; pointer-events: none; }
  .wantbtn { display: inline-flex; align-items: center; gap: 5px; }

  /* Count badge on the issue filter tabs. */
  .filter__count { margin-left: 6px; font: 600 10px var(--font-mono); background: var(--panel-2); color: var(--faint); border-radius: 999px; padding: 1px 6px; }
  :global(.filter__btn.is-active) .filter__count { background: rgba(255,255,255,.2); color: #fff; }
</style>
