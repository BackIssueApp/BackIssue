// Shared app state: the collection rail, the open series detail, the
// source-enabled flags, and the long-running library ops (scan/tag/match).
// Components render this; actions here mutate it.
import { SvelteSet } from 'svelte/reactivity';
import { apiGet, apiGetOk, apiPost, errorText } from './api.js';
import { subscribe } from './events.svelte.js';
import { notify } from './toasts.svelte.js';
import { t } from './i18n.svelte.js';
import { latestGuard } from './util.js';

// rows holds the LOADED prefix of the collection (an infinite-scroll window that
// grows as the user scrolls). total is the full count for the active filter — the
// grid shows it and keeps loading pages until rows.length reaches it. counts are
// the filter-independent chip badges (fetched once, with page 1).
// The Library's sort is a preference, not part of a given view: picking one
// should still be true tomorrow. It lives in the URL while you are browsing
// (so Back, reload and a shared link all behave), and here for when you arrive
// without one — coming in from the sidebar, or opening the app fresh.
const SORTS = ['title', 'added', 'missing'];
export function librarySort() {
  try {
    const v = localStorage.getItem('librarySort');
    return SORTS.includes(v) ? v : 'title';
  } catch { return 'title'; }   // private mode / storage disabled
}
export function setLibrarySort(v) {
  try {
    if (SORTS.includes(v)) localStorage.setItem('librarySort', v);
  } catch { /* the URL still carries it for this visit */ }
}

// error: why the last load failed ('' when it worked) — the page shows it
// instead of an empty library, and keeps any rows it already had.
export const rail = $state({ rows: [], counts: {}, buckets: {}, total: 0, filter: 'all', sort: 'title', search: '', library: null, facet: '', collections: false, selecting: false, loaded: false, loadingMore: false, error: '' });
// Rows per network page — a few hundred keeps each response a few hundred KB.
const COLLECTION_PAGE = 200;
// Shell chrome state (mobile sidebar overlay).
export const ui = $state({ sidebarOpen: false });
// Multi-select on the rail (series ids) — only meaningful while rail.selecting.
export const railSelect = new SvelteSet();

export const detail = $state({ series: null, det: null, failed: false });
// Placeholder title while a series has no name yet (unmatched row, failed
// load). A sentinel, not display copy: render it through seriesTitle(), which
// swaps in the reader's wording.
export const PLACEHOLDER_TITLE = 'Comic';
export const seriesTitle = (s) => (s?.title === PLACEHOLDER_TITLE ? t('store.untitledSeries') : (s?.title || ''));
// CV issue ids checked in the open series' issue list.
export const detailSelected = new SvelteSet();

export const flags = $state({ usenetEnabled: false, torrentEnabled: false, anySource: false, needsOnboarding: false });

// Long-running library operations, mirrored from server state via SSE — the
// scan/tag/match buttons derive busy/progress from here, so they survive
// navigation, refresh, even a second browser. Each entry is the server's
// state object ({ running, seriesId?, done, total, error, … }).
export const ops = $state({ scan: { running: false }, tag: { running: false }, cv: { running: false } });

const OP_ENDPOINTS = { scan: '/api/scan-folder', tag: '/api/tag-files', cv: '/api/cv' };
async function refreshOp(key) {
  try { ops[key] = await apiGetOk(OP_ENDPOINTS[key]); } catch { /* keep last */ }
}

// Start a long-running op (scan/tag/match). The button shows it running at
// once (optimistic until the next SSE tick); a refused or failed request
// rolls that back and says why, rather than leaving the button spinning.
// failKey is the catalog key for the toast ({error} is filled in).
export async function startOp(key, url, body, { failKey, ...state } = {}) {
  if (ops[key].running) return false;
  ops[key] = { running: true, done: 0, total: 0, ...state };
  let r;
  try { r = await apiPost(url, body); } catch (e) { r = { error: errorText(e) }; }
  if (!r?.error) return true;
  ops[key] = { running: false };
  notify(t(failKey, { error: r.error }), 'error');
  refreshOp(key); // the server may in fact be running one (a 409 "already running")
  return false;
}

// Rename one series' files to the configured folder/file pattern: dry-run
// first to show the count and any collisions, then execute on confirm.
// confirm is the dialog (passed in: the store has no UI of its own). Resolves
// the result ({ moved, skipped }) or null when nothing ran.
export async function refileSeries(id, title, confirm, onBusy = () => {}) {
  let plan;
  try {
    const r = await apiPost(`/api/collection/${id}/refile`, { dryRun: true });
    if (r?.error) throw new Error(r.error);
    plan = r?.plan || [];
  } catch (e) { notify(t('store.planRenameFailed', { error: e?.message || errorText(e) }), 'error'); return null; }
  const moves = plan.filter((p) => p.status === 'move').length;
  const collisions = plan.filter((p) => p.status === 'skip:collision').length;
  if (!moves) {
    notify(collisions ? t('store.nothingToDoCollide', { count: collisions }) : t('store.filesMatchPattern'), 'info');
    return null;
  }
  if (!(await confirm({
    title: t('store.renameTitle', { count: moves }),
    message: t('store.renameMessage', { title: title || t('store.thisSeries'), collisions: collisions ? t('store.renameCollisions', { count: collisions }) : '' }),
    confirmLabel: t('store.renameFiles'),
  }))) return null;
  onBusy(true);
  let r;
  try { r = await apiPost(`/api/collection/${id}/refile`, {}); } catch (e) { r = { error: errorText(e) }; }
  onBusy(false);
  if (r?.error) { notify(r.error, 'error'); return null; }
  notify(t('store.renamed', { count: r.moved, skipped: r.skipped ? t('store.renamedSkipped', { count: r.skipped }) : '' }), 'ok');
  return r;
}

// Attach a file to one of the series' issues, or clear a hand assignment
// (cvIssueId null); the choice sticks through rescans. True when it worked;
// failures are toasted, success toasts okMsg.
export async function assignFileToIssue(seriesId, path, cvIssueId, okMsg = t('store.fileAssigned')) {
  let r;
  try { r = await apiPost(`/api/collection/${seriesId}/assign-file`, { path, cvIssueId }); } catch (e) { r = { error: errorText(e) }; }
  if (r?.error) { notify(r.error, 'error'); return false; }
  notify(okMsg, 'ok');
  return true;
}
// One issue as an option in an "assign to issue" picker.
export function issueChoice(i) {
  const label = `#${i.number}${i.title && i.title !== '#' + i.number ? ' · ' + i.title : ''}`;
  return i.owned ? t('store.choiceOwned', { label }) : label;
}
export function startOpsTracking() {
  for (const key of Object.keys(OP_ENDPOINTS)) refreshOp(key);
  subscribe('scanFolder', () => refreshOp('scan'), 4000);
  subscribe('tagFiles', () => refreshOp('tag'), 4000);
  subscribe('cv', () => refreshOp('cv'), 4000);
}

export async function loadFlags() {
  try {
    const s = await apiGet('/api/settings');
    // Settings are admin-only: a viewer gets {error} here — never treat that
    // as "unconfigured" (it made viewers see the first-run onboarding wizard).
    if (!s.error) {
      flags.usenetEnabled = !!s.usenetEnabled;
      flags.torrentEnabled = !!s.torrentEnabled;
      // First run: never onboarded and no ComicVine key yet → offer the wizard.
      // Strict === false: a partial/odd payload (e.g. mid-restart) must never
      // read as "unconfigured" and flash the wizard at a configured install.
      flags.needsOnboarding = s.onboardingDone === false && !String(s.comicvineKeys || '').trim();
    }
  } catch { /* offline */ }
  // Any enabled source (incl. plugins) → the issue "Search sources" button.
  try { flags.anySource = ((await apiGetOk('/api/sources')).sources || []).length > 0; } catch { /* offline: keep last */ }
}

function collectionScope() {
  return 'filter=' + rail.filter + '&sort=' + rail.sort
    + '&search=' + encodeURIComponent(rail.search) + (rail.library ? '&library=' + rail.library : '')
    + (rail.facet ? '&facet=' + encodeURIComponent(rail.facet) : '')
    + (rail.collections ? '&collections=1' : '');
}

// Load (or reload) the FIRST page of the collection — the server filters, sorts
// and searches in SQL and returns just this page plus the total and the fused,
// filter-independent chip counts. Called on every filter/sort/search/library
// change (it resets the infinite-scroll window to the top). A failure keeps
// the last good list and badges and sets rail.error, so the page can say the
// load failed rather than show an empty library.
let loadSeq = 0; // discards stale responses when the scope changes mid-flight
export async function loadCollection() {
  rail.loadingMore = false; // cancel any in-flight append's effect from re-appending onto the old set
  const seq = ++loadSeq;
  const scope = collectionScope();
  // The chip counts ride a PARALLEL request: at 300k+ series the count pass is
  // ~3× the page query itself, so it must never block the first paint of the
  // grid. Until it lands, total falls back to the page size — loadMore resumes
  // once the real total arrives.
  const countsReq = apiGetOk('/api/collection/counts?' + scope).catch(() => null);
  // A-Z rail offsets, preloaded in parallel so a letter click needs no round
  // trip. Scope-dependent (filter/search/library), so refetched with each load.
  const bucketsReq = apiGetOk('/api/collection/jump?' + scope).then((b) => b || {}).catch(() => null);
  try {
    const r = await apiGetOk('/api/collection?counts=0&offset=0&limit=' + COLLECTION_PAGE + '&' + scope);
    if (seq !== loadSeq) return;
    rail.rows = r.rows || [];
    rail.total = r.total ?? rail.rows.length;
    rail.loaded = true;
    rail.error = '';
  } catch (e) {
    if (seq !== loadSeq) return;
    rail.error = errorText(e); // keep the last good list
  }
  const c = await countsReq;
  if (c && seq === loadSeq) {
    rail.counts = c;
    // counts are filter-independent tallies, so the active chip's tally IS the
    // filtered total (counts.all when no chip is active).
    if (typeof c[rail.filter] === 'number') rail.total = c[rail.filter];
  }
  const b = await bucketsReq;
  if (b && seq === loadSeq) rail.buckets = b;
}

// Fetch the next page and APPEND it — the infinite-scroll grid calls this as the
// user nears the end of what's loaded. Skips the chip-count pass (counts=0) since
// they don't change between pages, and self-throttles to one request in flight.
export async function loadMoreCollection() {
  if (rail.loadingMore || !rail.loaded) return;
  if (rail.rows.length >= rail.total) return; // everything for this filter is loaded
  rail.loadingMore = true;
  const offset = rail.rows.length;
  const seq = loadSeq, scope = collectionScope();
  try {
    const r = await apiGetOk('/api/collection?counts=0&offset=' + offset + '&limit=' + COLLECTION_PAGE + '&' + scope);
    // Guard against a filter/sort/search change that landed while this was in
    // flight: a reload (loadSeq) or a new scope means these rows belong to a
    // list that is no longer on screen, even when the tail length matches.
    if (seq !== loadSeq || scope !== collectionScope()) return;
    if (r.rows?.length && rail.rows.length === offset) rail.rows = [...rail.rows, ...r.rows];
  } catch { /* keep what we have */ } finally { if (seq === loadSeq) rail.loadingMore = false; }
}

// Offset (row index) of the first series whose title starts with `letter`, in
// the current filter/search/library scope — the server counts it in SQL so the
// A-Z rail can scroll straight there. '#' is handled by the caller as 0.
export async function collectionJumpOffset(letter) {
  try {
    const r = await apiGet('/api/collection/jump?letter=' + encodeURIComponent(letter) + '&' + collectionScope());
    return Math.max(0, Number(r?.offset) || 0);
  } catch { return 0; }
}

// Load pages until the loaded prefix reaches row `n` — the A-Z jump needs a
// contiguous prefix up to the target, since the grid virtualizes a prefix from
// row 0. Fetches the missing pages (500 rows each) in parallel, in bounded
// waves, so a far jump is one round-trip's wait instead of several in series.
// Aborts cleanly if the scope changes mid-run.
export async function loadUpTo(n) {
  if (!rail.loaded) return;
  const PAGE = 500;
  const WAVE = 8; // concurrent requests per wave — fast without flooding the server
  const scope = collectionScope();
  const target = Math.min(n + 1, rail.total);
  const start = rail.rows.length;
  if (start >= target) return;
  const offsets = [];
  for (let o = start; o < target; o += PAGE) offsets.push(o);
  rail.loadingMore = true;
  try {
    for (let i = 0; i < offsets.length; i += WAVE) {
      const batch = offsets.slice(i, i + WAVE);
      const pages = await Promise.all(batch.map((o) =>
        apiGet('/api/collection?counts=0&offset=' + o + '&limit=' + PAGE + '&' + scope)
          .then((r) => r?.rows || null).catch(() => null)));
      // A scope change (filter/sort/search) or a failed page → stop; keep the
      // contiguous prefix we have rather than splicing a gap into it.
      if (scope !== collectionScope() || pages.some((p) => p === null)) return;
      const merged = pages.flat();
      if (!merged.length) return;
      // Only append if our tail still lines up with this wave's first offset.
      if (rail.rows.length !== batch[0]) return;
      rail.rows = [...rail.rows, ...merged];
    }
  } finally { rail.loadingMore = false; }
}

// Open a series by id: fetch the authoritative detail and derive the header
// info from it (works for matched, unmatched, and error states). Only the
// latest open lands: switching series while a big one is still loading must
// not paint the slow one's issues under the new one's URL.
const openSeq = latestGuard();
export async function openVolume(id) {
  const isLatest = openSeq();
  const sameSeries = detail.series && detail.series.id === Number(id);
  // Paint the header IMMEDIATELY from the library row we already hold — on a
  // slow device the fetch+parse of a big issue list takes a beat, and showing
  // the cover/title first makes the transition feel instant. The issue list
  // streams in when the fetch below lands (det=null renders as loading).
  if (!sameSeries) {
    const row = (rail.rows || []).find((r) => r.id === Number(id));
    detail.det = null;
    detail.failed = false;
    detail.series = {
      id: Number(id),
      title: row ? (row.title || row.folder || PLACEHOLDER_TITLE) : '',
      cover_url: row?.cover_url || null,
      publisher: row?.publisher || null,
      issue_count: row?.total || 0,
      followed: row?.followed || 0,
      // Library type up front: a plugin-owned type (e.g. ebook) swaps the
      // issue area for its plugin view without first flashing comic chrome.
      type: row?.type || null,
    };
    detailSelected.clear();
  }
  let det = null;
  try { det = await apiGet('/api/collection/' + id); } catch (e) { det = { error: String(e?.message || e || t('store.requestFailed')) }; }
  if (!isLatest()) return;
  if (!det || det.error) {
    const reason = String(det?.error || t('store.noResponse'));
    // A failed RE-load of the page already showing keeps what it shows (a
    // poll during a server restart must not blank a working page).
    if (sameSeries && detail.det && !/not found|404/i.test(reason)) return;
    detail.series = { id: Number(id), title: PLACEHOLDER_TITLE }; detail.det = null; detail.failed = true;
    detail.notFound = /not found|404/i.test(reason); // a missing series reads differently from a dead server
    detail.failReason = reason;
    return;
  }
  detail.notFound = false; detail.failReason = '';
  const cv = det.cv, sr = det.series || {};
  detail.series = {
    id: Number(id),
    title: sr.title || (cv && cv.name) || PLACEHOLDER_TITLE,
    cover_url: sr.cover_url,
    publisher: sr.publisher,
    issue_count: cv ? cv.issue_count : (det.issues ? det.issues.length : 0),
    followed: sr.followed,
    type: sr.type || null,
  };
  detail.det = det;
  detail.failed = false;
  // A reload of the SAME series keeps the user's working selection (a mid-pick
  // re-download shouldn't wipe 30 hand-checked boxes) — just prune ids that
  // are no longer downloadable. A different series starts clean.
  if (!sameSeries) detailSelected.clear();
  else {
    const selectable = new Set((det.issues || [])
      .filter((i) => !((i.owned && !i.corrupt) || issueState(i) === 'done'))
      .map((i) => i.cv_issue_id));
    for (const cvid of [...detailSelected]) if (!selectable.has(cvid)) detailSelected.delete(cvid);
  }
}

export function clearDetail() {
  detail.series = null;
  detail.det = null;
  detail.failed = false;
  detailSelected.clear();
}

export async function reloadDetail() { if (detail.series) await openVolume(detail.series.id); }

// The display state of an issue row, most-important-first: a corrupt file
// (present but unreadable), an owned-but-untagged file, an owned+tagged file,
// else the download status.
export function issueState(i) {
  return i.corrupt ? 'corrupt' : (i.owned && i.untagged) ? 'untagged' : i.owned ? 'done' : (i.status || 'pending');
}

// Surgical metadata patch: when an issue's full detail lands (the issue modal
// fetch caches it server-side), update the open series' matching row so the
// cover and title appear immediately — no page refresh.
export function patchIssueMeta(cvIssueId, meta) {
  const i = detail.det?.issues?.find((x) => x.cv_issue_id === cvIssueId);
  if (!i || !meta || meta.error) return;
  if (meta.image_url && meta.image_url !== i.image_url) i.image_url = meta.image_url;
  if (meta.name) i.title = meta.name;
  i.has_detail = true;
}

// Watch a background "Refresh issue details" sweep: reload the open series
// periodically so covers/titles fill in as the sweep caches them, stopping when
// every issue has detail, progress stalls (sweep halted/failed), the user
// navigates away, or a safety cap is hit.
// Each tick schedules the next only once its reload has landed: a reload of
// a 2,000-issue series can outlast the interval, and overlapping ones pile up.
let sweepTimer = null;
export function watchDetailSweep() {
  if (sweepTimer) return;
  const seriesId = detail.series?.id;
  if (!seriesId) return;
  let lastMissing = Infinity;
  let stalls = 0;
  let ticks = 0;
  const tick = async () => {
    const stop = () => { sweepTimer = null; };
    if (!detail.series || detail.series.id !== seriesId) return stop();
    if (++ticks > 200) return stop(); // safety cap ≈ 13 min
    await reloadDetail();
    const missing = (detail.det?.issues || []).filter((i) => !i.has_detail).length;
    if (missing === 0) return stop();
    if (missing >= lastMissing) { if (++stalls >= 5) return stop(); } // no progress → sweep ended
    else stalls = 0;
    lastMissing = missing;
    sweepTimer = setTimeout(tick, 4000);
  };
  sweepTimer = setTimeout(tick, 4000);
}

// Patch statuses in place during downloads without losing the user's checkboxes.
export async function refreshIssueStatuses() {
  if (!detail.series || !detail.det?.issues) return;
  const seriesId = detail.series.id;
  let issues;
  try { issues = await apiGetOk(`/api/series/${seriesId}/issues`); } catch { return; }
  if (!Array.isArray(issues) || detail.series?.id !== seriesId || !detail.det?.issues) return;
  const byId = new Map(issues.map((i) => [String(i.id), i]));
  for (const i of detail.det.issues) {
    const u = i.id != null ? byId.get(String(i.id)) : null;
    if (!u || i.status === u.status) continue;
    i.status = u.status;
    if (u.status === 'done') detailSelected.delete(i.cv_issue_id);
  }
}

// Queue ComicVine issues of the current series; the server creates the queue
// rows and the worker resolves a download source per issue. The single most
// common click in the app — its failure must never be a silent no-op.
export async function downloadCvIssues(cvIssueIds) {
  const ids = (cvIssueIds || []).map(Number).filter((n) => Number.isFinite(n));
  if (!ids.length || !detail.series) return;
  try {
    const r = await apiPost(`/api/collection/${detail.series.id}/download`, { cvIssueIds: ids });
    if (r?.error) return notify(t('store.downloadFailed', { error: r.error }), 'error');
  } catch { return notify(t('store.downloadFailedUnreachable'), 'error'); }
  refreshIssueStatuses();
}

// Re-download: delete the (corrupt) file(s) for these CV issues server-side,
// then grab a fresh copy.
export async function redownloadCvIssues(cvIssueIds) {
  const ids = (cvIssueIds || []).map(Number).filter((n) => Number.isFinite(n));
  if (!ids.length || !detail.series) return;
  try {
    const r = await apiPost(`/api/collection/${detail.series.id}/redownload`, { cvIssueIds: ids });
    if (r?.error) return notify(t('store.redownloadFailed', { error: r.error }), 'error');
  } catch { return notify(t('store.redownloadFailedUnreachable'), 'error'); }
  reloadDetail(); // full re-render (owned→queued transition)
}

// Re-download by source issue id: deletes the existing files server-side and
// re-fetches in place.
export async function redownloadIssues(issueIds) {
  if (!issueIds.length) return;
  try {
    const r = await apiPost('/api/redownload', { issueIds });
    if (r?.error) return notify(t('store.redownloadFailed', { error: r.error }), 'error');
  } catch { return notify(t('store.redownloadFailedUnreachable'), 'error'); }
  refreshIssueStatuses();
}
