// Shared app state: the collection rail, the open series detail, the
// source-enabled flags, and the long-running library ops (scan/tag/match).
// Components render this; actions here mutate it.
import { SvelteSet } from 'svelte/reactivity';
import { apiGet, apiPost } from './api.js';
import { subscribe } from './events.svelte.js';
import { notify } from './toasts.svelte.js';

export const rail = $state({ rows: [], filter: 'all', sort: 'title', search: '', library: null, selecting: false, loaded: false });
// Shell chrome state (mobile sidebar overlay).
export const ui = $state({ sidebarOpen: false });
// Multi-select on the rail (series ids) — only meaningful while rail.selecting.
export const railSelect = new SvelteSet();

export const detail = $state({ series: null, det: null, failed: false });
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
  try { ops[key] = await apiGet(OP_ENDPOINTS[key]); } catch { /* keep last */ }
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
      flags.needsOnboarding = !s.onboardingDone && !String(s.comicvineKeys || '').trim();
    }
  } catch { /* offline */ }
  // Any enabled source (incl. plugins) → the issue "Search sources" button.
  try { flags.anySource = ((await apiGet('/api/sources')).sources || []).length > 0; } catch { /* offline */ }
}

export async function loadCollection() {
  try {
    rail.rows = await apiGet('/api/collection?filter=' + rail.filter + '&search=' + encodeURIComponent(rail.search) + '&sort=' + rail.sort + (rail.library ? '&library=' + rail.library : ''));
    rail.loaded = true;
  } catch { /* keep the last good list */ }
}

// Open a series by id: fetch the ComicVine-authoritative detail and derive the
// header info from it (works for matched, unmatched, and error states).
export async function openVolume(id) {
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
      title: row ? (row.title || row.folder || 'Comic') : '',
      cover_url: row?.cover_url || null,
      publisher: row?.publisher || null,
      issue_count: row?.total || 0,
      followed: row?.followed || 0,
    };
    detailSelected.clear();
  }
  let det = null;
  try { det = await apiGet('/api/collection/' + id); } catch { /* render error state */ }
  if (!det || det.error) { detail.series = { id: Number(id), title: 'Comic' }; detail.det = null; detail.failed = true; return; }
  const cv = det.cv, sr = det.series || {};
  detail.series = {
    id: Number(id),
    title: sr.title || (cv && cv.name) || 'Comic',
    cover_url: sr.cover_url,
    publisher: sr.publisher,
    issue_count: cv ? cv.issue_count : (det.issues ? det.issues.length : 0),
    followed: sr.followed,
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
let sweepTimer = null;
export function watchDetailSweep() {
  if (sweepTimer) return;
  const seriesId = detail.series?.id;
  if (!seriesId) return;
  let lastMissing = Infinity;
  let stalls = 0;
  let ticks = 0;
  sweepTimer = setInterval(async () => {
    const stop = () => { clearInterval(sweepTimer); sweepTimer = null; };
    if (!detail.series || detail.series.id !== seriesId) return stop();
    if (++ticks > 200) return stop(); // safety cap ≈ 13 min
    await reloadDetail();
    const missing = (detail.det?.issues || []).filter((i) => !i.has_detail).length;
    if (missing === 0) return stop();
    if (missing >= lastMissing) { if (++stalls >= 5) return stop(); } // no progress → sweep ended
    else stalls = 0;
    lastMissing = missing;
  }, 4000);
}

// Patch statuses in place during downloads without losing the user's checkboxes.
export async function refreshIssueStatuses() {
  if (!detail.series || !detail.det?.issues) return;
  let issues;
  try { issues = await apiGet(`/api/series/${detail.series.id}/issues`); } catch { return; }
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
    if (r?.error) return notify('Download failed to queue: ' + r.error, 'error');
  } catch { return notify('Download failed to queue — is the app reachable?', 'error'); }
  refreshIssueStatuses();
}

// Re-download: delete the (corrupt) file(s) for these CV issues server-side,
// then grab a fresh copy.
export async function redownloadCvIssues(cvIssueIds) {
  const ids = (cvIssueIds || []).map(Number).filter((n) => Number.isFinite(n));
  if (!ids.length || !detail.series) return;
  try {
    const r = await apiPost(`/api/collection/${detail.series.id}/redownload`, { cvIssueIds: ids });
    if (r?.error) return notify('Re-download failed: ' + r.error, 'error');
  } catch { return notify('Re-download failed — is the app reachable?', 'error'); }
  reloadDetail(); // full re-render (owned→queued transition)
}

// Re-download by source issue id: deletes the existing files server-side and
// re-fetches in place.
export async function redownloadIssues(issueIds) {
  if (!issueIds.length) return;
  try {
    const r = await apiPost('/api/redownload', { issueIds });
    if (r?.error) return notify('Re-download failed: ' + r.error, 'error');
  } catch { return notify('Re-download failed — is the app reachable?', 'error'); }
  refreshIssueStatuses();
}
