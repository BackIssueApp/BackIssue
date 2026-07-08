import { openDb, clearIssuesForRedownload } from './db.js';
import { runQueue, reconcileDownloading } from './downloader.js';
import { processPack } from './pack.js';
import { createApp } from './server.js';
import config from './config.js';
import { loadSettings, currentSettings, saveSettings } from './settings.js';
import { loadPlugins, registeredStartups, registeredRoutes, registeredJobs, registeredClientAssets } from './plugins.js';
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import fss from 'node:fs';
import nodePath from 'node:path';
import { indexFolderForSeries, reconcileLibrary, removeSupersededFiles } from './library.js';
import { resolveSeriesDir, parseRootFolders } from './paths.js';
import { refileLibrary } from './refile.js';
import { initRssTables, unseenItems, markSeen, buildWantedIndex, matchFeedItems } from './rsswatch.js';
import { findComicFiles, groupSeries } from './scanner.js';
import { extractYear } from './matcher.js';
import { poolWithResource } from './pool.js';
import { makeCvClient, cvKey } from './cv.js';
import { tagFileFromCv, ensureCvIssueDetail } from './metatagger.js';
import { fetchWeeklyReleases, matchReleases } from './releases.js';
import { startJob, listJobs, clearFinishedJobs, attachJobsDb } from './jobs.js';
import { createScheduler } from './scheduler.js';
import { createDownloadMonitor } from './downloadmonitor.js';
import { tagAllUntagged, convertAllCbr, removeAllDuplicates, verifyLibrary, relinkAllCv, scanEntireLibrary, backupDatabase, renameAllFiles } from './tools.js';
import { collectionStats } from './stats.js';
import { installConsoleCapture, attachLogDb, listLogs, clearLogs, logInfo, logWarn, logError, logCounts, logCategories } from './logstore.js';
import { runCvMatch as runCvMatchLib, cacheAndLink, addSeriesFromCv, refreshCvVolume, refreshAllIssueDetails, rankCandidates } from './cvmatch.js';
import { getSeriesById, seriesCollectionDetail, untrackSeries, getCvIssue, upsertSeries, setSeriesPath,
  ensureCvIssueRow, recordGrab, getGrab, setGrabStatus, setIssueStatus, setSeriesAliases, seriesSearchNames,
  clearImportCandidates, upsertImportCandidate, listImportCandidates, getImportCandidate, setImportCandidateMatch, setImportCandidateStatus, readyImportCandidates, listWantedIssues, queueIssues, getCvSeries } from './db.js';
import { parseIndexers, searchNewznab } from './newznab.js';
import { makeNzbClient } from './nzbclients.js';
import { parseIndexers as parseTorznab, searchTorznab } from './torznab.js';
import { makeTorrentClient } from './torrentclients.js';
import { torrent as torrentSource } from './sources/torrent.js';
import { orderedSources } from './sources/index.js';
import { pickZeroDayGrab } from './zeroday.js';
import { validateCron } from './cron.js';
import { notify as notifyRaw } from './notifications.js';

installConsoleCapture(); // mirror console.warn/error into the Logs page buffer
// Load plugins BEFORE settings so plugin-registered config fields (e.g. a private
// source's credentials) survive validation of the saved settings.json.
await loadPlugins();
loadSettings(); // merge persisted settings over config defaults before anything runs

const db = openDb(config.dbPath);
attachLogDb(db); // persist logs (and flush anything captured before the db opened)
attachJobsDb(db); // persist job runs (and fail any left 'running' by a crashed session)
// Capture HARD crashes (OOM, native/WASM aborts) that bypass the JS handlers —
// Node writes a diagnostic report file we can point at. Uncaught JS exceptions
// are handled below (logged inline), so exclude those from the report noise.
const reportsDir = nodePath.join(nodePath.dirname(config.dbPath), 'reports');
try {
  fss.mkdirSync(reportsDir, { recursive: true });
  if (process.report) {
    process.report.directory = reportsDir;
    process.report.reportOnFatalError = true;   // OOM, native crashes
    process.report.reportOnUncaughtException = false; // handled + logged below
  }
} catch { /* older node / no perms */ }

// If the previous session's last marker was a start (not a clean shutdown), it
// crashed hard or was force-killed without a chance to log a reason — surface
// that on the Logs page so silent restarts are no longer invisible. Point at any
// crash report written since.
try {
  const last = db.prepare("SELECT message, ts FROM logs WHERE category='app' ORDER BY id DESC LIMIT 1").get();
  if (last && /^BackIssue started/.test(last.message)) {
    const reports = fss.existsSync(reportsDir) ? fss.readdirSync(reportsDir).filter((f) => f.endsWith('.json')) : [];
    const hint = reports.length ? ` A crash report was written to reports/ (${reports[reports.length - 1]}).` : ' No inline reason was captured (likely out of memory or a native/browser crash).';
    logWarn(`Previous session did not shut down cleanly — it crashed or was force-killed (last seen ${new Date(Number(last.ts)).toLocaleString()}).${hint}`, 'app');
  }
} catch { /* ignore */ }

// A visible marker for every (re)start, and handlers so a crash that would
// otherwise vanish silently leaves a reason in the Logs page. Installed right
// after the log DB is attached so even an early-boot failure is recorded.
logInfo(`BackIssue started (pid ${process.pid}, node ${process.version})`, 'app');
process.on('uncaughtException', (err) => {
  try { logError(`Uncaught exception — app is stopping: ${err?.stack || err}`, 'app'); } catch { /* ignore */ }
  console.error('Uncaught exception:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  try { logError(`Unhandled promise rejection: ${reason?.stack || reason}`, 'app'); } catch { /* ignore */ }
  console.error('Unhandled rejection:', reason);
});
process.on('warning', (w) => { if (/memory|heap/i.test(w?.message || '')) { try { logWarn(`Process warning: ${w.message}`, 'app'); } catch { /* ignore */ } } });
// Recover issues left in 'downloading' by a previous crash/force-close so they
// don't sit stuck on the "saving" badge until the next queue run.
reconcileDownloading(db);
initRssTables(db);
// Per-volume is now the ownership model: attribute any orphaned files, CV-link
// matched series, and drop index rows for comics you don't track.
try { const rec = reconcileLibrary(db); if (rec.attributed || rec.pruned) console.log(`Library reconcile: attributed ${rec.attributed}, pruned ${rec.pruned} untracked file rows.`); } catch (e) { console.warn('reconcile failed', e?.message || e); }

const state = { crawl: { running: false }, queue: { running: false }, follow: { running: false }, updates: { running: false }, cv: { running: false }, scanFolder: { running: false }, tagFiles: { running: false }, releases: { running: false }, import: { running: false }, tools: { running: false }, refile: { running: false } };

// Library-wide maintenance tools (the Tools page). Each runs as a job with progress.
const TOOLS = {
  'scan-library': { label: 'Scan entire library', desc: 'Walk your root folders and index every comic file — finds files not yet in the library and drops ones deleted from disk.', run: (op) => scanEntireLibrary(db, parseRootFolders(config.rootFolders), op) },
  'tag-untagged': { label: 'Tag all untagged files', desc: 'Write ComicVine metadata into every owned file that has none (converts .cbr as needed).', needsCv: true, run: (op) => tagAllUntagged(db, cvClient(), op) },
  'convert-cbr': { label: 'Convert all CBR → CBZ', desc: 'Repack every .cbr as a .cbz so it can be tagged and read consistently.', run: (op) => convertAllCbr(db, op) },
  'remove-duplicates': { label: 'Remove duplicate files', desc: 'Delete old/corrupt copies that a good copy of the same issue has already replaced.', run: (op) => removeAllDuplicates(db, op) },
  'verify': { label: 'Verify archives', desc: 'Deep-check every comic file for corruption and prune ones missing from disk.', run: (op, opts) => verifyLibrary(db, op, opts) },
  'relink-cv': { label: 'Re-link to ComicVine', desc: 'Re-map owned files to ComicVine issues for every matched comic (fixes owned/missing counts).', run: (op) => relinkAllCv(db, op) },
  'rename-files': { label: 'Rename files to pattern', desc: 'Rename every CV-linked file to your file pattern (same folder — no moves) so imported scene-named files match downloaded ones. Collisions are skipped.', run: (op) => renameAllFiles(db, op) },
  'backup-db': { label: 'Back up database', desc: 'Snapshot the catalog database into backups/ next to it (keeps the newest 5). Safe while the app is in use. Restore: stop the app and copy a snapshot over catalog.db.', run: (op) => backupDatabase(db, config.dbPath, op) },
};
const summarizeTool = (r) => Object.entries(r || {}).map(([k, v]) => `${v} ${k.replace(/([A-Z])/g, ' $1').toLowerCase()}`).join(', ');
function runTool(tool, opts = {}) {
  if (state.tools.running) return { busy: true };
  const t = TOOLS[tool];
  if (!t) return { error: 'unknown tool' };
  if (t.needsCv) { try { cvClient(); } catch (e) { return { error: 'ComicVine keys required for this tool' }; } }
  state.tools = { running: true, tool, done: 0, total: 0 };
  const job = startJob('tool', t.label);
  (async () => {
    try {
      const r = await t.run((p) => { state.tools = { running: true, tool, ...p }; job.progress(p); }, opts);
      state.tools = { running: false, tool, result: r, ranAt: new Date().toISOString() };
      logInfo(`${t.label}: ${summarizeTool(r)}`, 'tools');
      job.finish(r);
    } catch (e) { state.tools = { running: false, tool, error: String(e?.message || e) }; logError(`${t.label} failed: ${e?.message || e}`, 'tools'); job.fail(e); }
  })();
  return { started: true };
}
const countCorrupt = () => { try { return db.prepare('SELECT COUNT(*) c FROM library_files WHERE valid=0').get().c; } catch { return 0; } };
const toolsState = () => ({ ...state.tools, corruptCount: countCorrupt(), catalog: Object.entries(TOOLS).map(([id, t]) => ({ id, label: t.label, desc: t.desc })) });

// --- Reorganize library (move+rename to the configured patterns) ---
// A background job: 40k files on a NAS takes minutes and must not block requests.
function runLibraryRefile() {
  if (state.refile.running) return { busy: true };
  state.refile = { running: true, done: 0, total: 0 };
  const job = startJob('refile', 'Reorganize library');
  (async () => {
    try {
      const r = await refileLibrary(db, (p) => { state.refile = { running: true, ...p }; job.progress(p); });
      state.refile = { running: false, result: r, ranAt: new Date().toISOString() };
      logInfo(`Reorganize library: moved ${r.moved}, ${r.unchanged} already matched, ${r.skipped} skipped${r.errors.length ? `, ${r.errors.length} error(s)` : ''}`, 'tools');
      job.finish({ moved: r.moved, unchanged: r.unchanged, skipped: r.skipped, errors: r.errors.length });
    } catch (e) {
      state.refile = { running: false, error: String(e?.message || e) };
      logError(`Reorganize library failed: ${e?.message || e}`, 'tools');
      job.fail(e);
    }
  })();
  return { started: true };
}
const refileState = () => ({ ...state.refile });

// --- ComicVine metadata matching ---
function cvClient() { return makeCvClient(config); }

// The app-level CV match sweep (job/progress wrapper around cvmatch.js's runCvMatch).
async function runCvMatchSweep() {
  if (state.cv.running) return;
  let client;
  try { client = cvClient(); } catch (e) { state.cv = { running: false, error: String(e?.message || e) }; return; }
  state.cv = { running: true, done: 0, total: 0, matched: 0, ambiguous: 0 };
  const job = startJob('cv-match', 'Match ComicVine');
  try {
    const r = await runCvMatchLib(db, client, {
      concurrency: config.cvConcurrency || 3,
      onProgress: (p) => { state.cv = { running: true, ...p }; job.progress({ done: p.done, total: p.total, message: `${p.matched || 0} matched` }); },
    });
    state.cv = { running: false, ...r };
    logInfo(`ComicVine match complete: ${r.matched} matched, ${r.ambiguous} ambiguous`, 'cv');
    job.finish({ matched: r.matched, ambiguous: r.ambiguous, relinked: r.relinked });
  } catch (e) { state.cv = { running: false, error: String(e?.message || e) }; job.fail(e); }
}

async function cvSearch(q) {
  return cvClient().search(q);
}

// Look up one ComicVine volume by id (for pasting a CV URL/id into the match
// picker). Returns the picker-card shape without the heavy issue list.
async function cvVolumeInfo(comicvineId) {
  const { issues, ...v } = await cvClient().volume(comicvineId);
  return { ...v, issue_count: issues.length };
}

// Full info for one ComicVine issue (fetching + caching its detail on demand),
// plus the owned file(s) on disk. Powers the issue info panel.
async function cvIssueInfo(cvIssueId) {
  let issue = getCvIssue(db, cvIssueId);
  if (!issue) return null;
  // Fetch when detail is missing — or when enrichment is on and this row has
  // never been enrichment-checked (rows cached before cvEnrich fill in once).
  if (!issue.has_detail || (config.cvEnrich && !issue.metron_checked)) {
    try { issue = await ensureCvIssueDetail(db, cvClient(), cvIssueId); }
    catch (e) { console.warn('cv issue detail fetch failed', cvIssueId, e?.message || e); }
  }
  const files = db.prepare('SELECT path, name, valid, has_metadata, error FROM library_files WHERE cv_issue_id=?').all(cvIssueId);
  let credits = [];
  try { credits = issue.credits ? JSON.parse(issue.credits) : []; } catch { /* ignore */ }
  const owned = files.some((f) => f.valid);
  const parse = (v) => { try { return v ? JSON.parse(v) : null; } catch { return null; } };
  return {
    cv_issue_id: issue.comicvine_id,
    number: issue.issue_number,
    name: issue.name,
    cover_date: issue.cover_date,
    store_date: issue.store_date,
    description: issue.description,
    image_url: issue.image_url,
    credits,
    site_detail_url: issue.site_detail_url,
    // Full CV credit arrays (fetched with the detail; capped client-side).
    character_credits: parse(issue.character_credits),
    team_credits: parse(issue.team_credits),
    story_arc_credits: parse(issue.story_arc_credits),
    // Metron enrichment extras (null when unchecked or not on Metron).
    metron_price: issue.metron_price || null,
    metron_upc: issue.metron_upc || null,
    metron_isbn: issue.metron_isbn || null,
    metron_foc_date: issue.metron_foc_date || null,
    metron_rating: issue.metron_rating || null,
    metron_story_titles: parse(issue.metron_story_titles),
    metron_reprints: parse(issue.metron_reprints),
    metron_variants: parse(issue.metron_variants),
    user_fields: parse(issue.user_fields) || [],
    owned,
    corrupt: files.length > 0 && !owned,
    files,
  };
}

// Add a comic to the collection from a ComicVine volume.
async function addFromCv(comicvineId) {
  const r = await addSeriesFromCv(db, cvClient(), comicvineId);
  logInfo(`Added from ComicVine: ${r.title || 'volume ' + comicvineId} (${r.outcome})`, 'collection');
  return r;
}

// Scan just this comic's folder on disk, attributing its files to the comic and
// linking them to CV issues — the per-volume replacement for a global index.
async function scanSeriesFolder(seriesId) {
  if (state.scanFolder.running) return { busy: true };
  const series = getSeriesById(db, seriesId);
  if (!series) return { error: 'not found' };
  const dir = resolveSeriesDir(db, series);
  state.scanFolder = { running: true, seriesId, dir, done: 0, total: 0 };
  const job = startJob('scan-folder', `Scan folder · ${series.title || dir}`);
  indexFolderForSeries({
    db, dir, seriesId, cvId: series.cv_id,
    onProgress: (p) => { state.scanFolder = { running: true, seriesId, dir, done: p.done, total: p.total }; job.progress({ done: p.done, total: p.total }); },
  }).then((r) => { state.scanFolder = { running: false, seriesId, dir, error: r?.error || undefined, pruned: r?.pruned }; if (r?.error) { job.fail(new Error(r.error)); } else { logInfo(`Scanned folder for ${series.title || dir}: ${r?.total || 0} file(s)${r?.pruned ? ', ' + r.pruned + ' pruned' : ''}`, 'library'); job.finish({ files: r?.total, pruned: r?.pruned }); } })
    .catch((e) => { state.scanFolder = { running: false, seriesId, dir, error: String(e?.message || e) }; job.fail(e); });
  return { started: true, dir };
}

// (Re)write the authoritative ComicVine ComicInfo.xml into every owned file of
// a comic — the native replacement for a ComicTagger pass.
async function tagSeriesFiles(seriesId, { onlyUntagged = false } = {}) {
  if (state.tagFiles.running) return { busy: true };
  const series = getSeriesById(db, seriesId);
  const where = onlyUntagged ? 'series_id=? AND valid=1 AND has_metadata=0' : 'series_id=? AND valid=1';
  const files = db.prepare(`SELECT path FROM library_files WHERE ${where}`).all(seriesId).map((r) => r.path);
  state.tagFiles = { running: true, seriesId, done: 0, total: files.length, tagged: 0, problems: 0 };
  const job = startJob('tag-files', `Tag files · ${series?.title || seriesId}`);
  job.progress({ total: files.length });
  (async () => {
    let client;
    try { client = cvClient(); } catch (e) { state.tagFiles = { running: false, seriesId, error: String(e?.message || e) }; job.fail(e); return; }
    let rateLimited = false;
    for (const p of files) {
      try {
        const r = await tagFileFromCv(db, client, p);
        if (r.outcome === 'tagged') state.tagFiles.tagged++;
        else state.tagFiles.problems++;
      } catch (e) {
        // All ComicVine keys are throttled — stop rather than churn the rest.
        if (e?.rateLimited) { rateLimited = true; break; }
        state.tagFiles.problems++;
      }
      state.tagFiles.done++;
      job.progress({ done: state.tagFiles.done, message: `${state.tagFiles.tagged} tagged` });
    }
    state.tagFiles.running = false;
    if (rateLimited) logWarn(`Tagging for ${series?.title || seriesId} stopped — ComicVine rate limit reached; run it again later to finish.`, 'tag');
    logInfo(`Tagged ${state.tagFiles.tagged} file(s)${state.tagFiles.problems ? ', ' + state.tagFiles.problems + ' problem(s)' : ''} for ${series?.title || seriesId}`, 'tag');
    job.finish({ tagged: state.tagFiles.tagged, problems: state.tagFiles.problems });
  })();
  return { started: true, total: files.length };
}

// ---- Library import -----------------------------------------------------
const cleanVolumeName = (folder) => String(folder).replace(/\(\s*(?:19|20)\d{2}[^)]*\)\s*$/, '').replace(/\s+/g, ' ').trim() || folder;

// A folder is already managed if a series is pinned to it, or its files are
// linked to a followed/CV series — those aren't import candidates.
function folderIsManaged(dir) {
  if (db.prepare('SELECT 1 FROM series WHERE path=?').get(dir)) return true;
  return !!db.prepare(`SELECT 1 FROM library_files lf JOIN series s ON s.id=lf.series_id
    WHERE lf.dir=? AND (s.followed=1 OR s.cv_id IS NOT NULL) LIMIT 1`).get(dir);
}

// Scan the root folders for comic volumes not yet in the collection and propose a
// ComicVine match for each (auto-accept high confidence; flag the rest).
// Default is INCREMENTAL: folders that already have a candidate row keep their
// review state (confirm/skip/manual match) and aren't re-searched — only new
// folders are processed. fresh:true clears the list and redoes everything.
async function runImportScan({ fresh = false } = {}) {
  if (state.import.running) return { busy: true };
  const roots = parseRootFolders(config.rootFolders);
  if (!roots.length) return { error: 'No root folders configured (Settings → Library).' };
  state.import = { running: true, phase: 'scanning', done: 0, total: 0 };
  const job = startJob('import-scan', fresh ? 'Scan library for import (full)' : 'Scan library for new volumes');
  (async () => {
    try {
      let files = [];
      for (const r of roots) files = files.concat(await findComicFiles(r));
      let groups = groupSeries(files).filter((g) => !folderIsManaged(g.dir));
      if (fresh) {
        clearImportCandidates(db);
      } else {
        // Skip folders whose candidate carries state worth keeping: a user
        // decision (ready/skipped/imported) or a solid proposed match. Rows still
        // in 'review' with a weak result (none/error/low) are RE-ATTEMPTED — the
        // earlier miss may have been a transient CV failure or a search-depth
        // limit, and no user decision is lost by retrying.
        const keep = new Set(db.prepare(
          "SELECT folder FROM import_candidates WHERE status<>'review' OR confidence IN ('medium','high','manual')"
        ).all().map((r) => r.folder));
        groups = groups.filter((g) => !keep.has(g.dir));
      }
      state.import.total = groups.length;
      job.progress({ total: groups.length });
      const client = cvClient();
      let done = 0;
      await poolWithResource(groups, config.cvConcurrency || 3, () => null, async (g) => {
        const name = cleanVolumeName(g.seriesName);
        const year = extractYear(g.seriesName);
        let cand = null, confidence = 'none';
        // A bulk scan fires hundreds of CV searches — transient failures (rate
        // limits) are expected. Retry with backoff; only after all attempts fail
        // mark the row 'error' so a failed search is never mistaken for a real
        // "ComicVine has no such volume".
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const results = await client.search(name);
            const { best } = rankCandidates({ title: name, year, publisher: g.publisher }, results);
            if (best) { cand = best.cand; confidence = best.confidence; }
            break;
          } catch (e) {
            if (attempt === 3) { confidence = 'error'; console.warn('import scan: CV search failed for', name, e?.message || e); }
            else await new Promise((r) => setTimeout(r, 1500 * attempt));
          }
        }
        upsertImportCandidate(db, {
          folder: g.dir, name, year, publisher: g.publisher, file_count: g.present.size,
          cv_id: cand?.id ?? null, cv_name: cand?.name ?? null, cv_year: cand?.start_year ?? null, cv_image: cand?.image_url ?? null,
          confidence, status: confidence === 'high' ? 'ready' : 'review',
        });
        state.import.done = ++done;
        job.progress({ done, total: groups.length, message: `${done}/${groups.length}` });
      }, () => {});
      state.import = { running: false, phase: 'reviewing', done, total: groups.length, scannedAt: new Date().toISOString() };
      logInfo(`Library scan complete: ${groups.length} new volume(s) found${fresh ? ' (full rescan)' : ''}`, 'import');
      job.finish({ found: groups.length });
    } catch (e) { state.import = { running: false, error: String(e?.message || e) }; job.fail(e); }
  })();
  return { started: true };
}

// Import the confirmed candidates: matched → a CV series; unmatched → a local
// series. Files are indexed in place (the folder becomes the comic's location).
async function runImport() {
  if (state.import.running) return { busy: true };
  const ready = readyImportCandidates(db);
  if (!ready.length) return { error: 'nothing to import' };
  state.import = { running: true, phase: 'importing', done: 0, total: ready.length, imported: 0 };
  const job = startJob('import-run', 'Import library');
  (async () => {
    let client; try { client = cvClient(); } catch { /* unmatched-only import still works */ }
    let done = 0, imported = 0;
    for (const c of ready) {
      try {
        let seriesId;
        if (c.cv_id && client) {
          seriesId = (await addSeriesFromCv(db, client, c.cv_id)).seriesId;
        } else {
          seriesId = upsertSeries(db, { title: c.name || 'Unknown', url: 'local:' + c.folder, publisher: c.publisher || null });
          if (c.year) db.prepare('UPDATE series SET year=? WHERE id=?').run(c.year, seriesId);
        }
        setSeriesPath(db, seriesId, c.folder);
        await indexFolderForSeries({ db, dir: c.folder, seriesId, cvId: c.cv_id || null });
        setImportCandidateStatus(db, c.id, 'imported');
        imported++;
      } catch (e) { console.warn('import failed', c.folder, e?.message || e); }
      state.import = { running: true, phase: 'importing', done: ++done, total: ready.length, imported };
      job.progress({ done, total: ready.length, message: `${imported} imported` });
    }
    state.import = { running: false, phase: 'done', done, total: ready.length, imported };
    logInfo(`Import complete: ${imported} volume(s) added to the collection`, 'import');
    job.finish({ imported });
  })();
  return { started: true };
}

const importState = () => ({ ...state.import, candidates: listImportCandidates(db) });
function matchImportCandidate(id, m) { setImportCandidateMatch(db, id, m); return getImportCandidate(db, id); }
function confirmImportCandidate(id) { setImportCandidateStatus(db, id, 'ready'); return getImportCandidate(db, id); }
function skipImportCandidate(id) { setImportCandidateStatus(db, id, 'skipped'); return getImportCandidate(db, id); }

// Remove duplicate/superseded files (an old corrupt copy left beside a good one).
async function cleanupSeriesFiles(seriesId) {
  const removed = await removeSupersededFiles(db, seriesId);
  if (removed) logInfo(`Removed ${removed} duplicate/superseded file(s) from ${getSeriesById(db, seriesId)?.title || 'series ' + seriesId}`, 'library');
  return { removed, detail: seriesCollectionDetail(db, seriesId) };
}

// Check this week's new releases and cross-reference them against tracked
// comics by ComicVine id; new issues get cached (shown as missing).
let lastNotifiedReleaseWeek = null; // dedupe the weekly release-day notification
async function checkReleases({ week, year } = {}) {
  if (state.releases.running) return { busy: true };
  state.releases = { running: true };
  const job = startJob('releases', "Check this week's releases");
  (async () => {
    try {
      const { week: wk, year: yr, releases } = await fetchWeeklyReleases({ week, year });
      const r = matchReleases(db, releases);
      state.releases = { running: false, week: wk, year: yr, checkedAt: new Date().toISOString(), ...r };
      logInfo(`This week's releases: ${r.total} total, ${r.hits} in your collection, ${r.added} new`, 'releases');
      // Release-day heads-up for followed series — once per week (the check
      // runs twice daily; dedupe on the week key so it doesn't repeat).
      const wkKey = `${yr}-${wk}`;
      if (r.hits > 0 && lastNotifiedReleaseWeek !== wkKey) {
        lastNotifiedReleaseWeek = wkKey;
        notifyRaw(db, { type: 'release.week', category: 'release', level: 'info',
          title: 'New releases this week', body: `${r.hits} issue(s) from series you follow ship this week.`, url: '/releases' });
      }
      job.finish({ releases: r.total, inCollection: r.hits, newIssues: r.added });
    } catch (e) { state.releases = { running: false, error: String(e?.message || e), checkedAt: new Date().toISOString() }; job.fail(e); }
  })();
  return { started: true };
}

// Background task scheduler — each task has a cron pattern + an enabled toggle
// (both live in config, editable on the Jobs page); last-run times persist in
// the DB so restarts don't re-fire tasks.
const SCHEDULE_KEYS = {
  releases: { cron: 'releaseCheckCron', enabled: 'releaseCheckEnabled' },
  'cv-match': { cron: 'cvMatchCron', enabled: 'cvMatchEnabled' },
  'zero-day': { cron: 'zeroDayCron', enabled: 'zeroDayEnabled' },
  'wanted-search': { cron: 'wantedSearchCron', enabled: 'wantedSearchEnabled' },
  'recent-search': { cron: 'recentSearchCron', enabled: 'recentSearchEnabled' },
  'rss-watch': { cron: 'rssWatchCron', enabled: 'rssWatchEnabled' },
  'db-backup': { cron: 'backupCron', enabled: 'backupEnabled' },
};
const scheduler = createScheduler({ db });
const schedGetters = (key) => ({ cron: () => config[SCHEDULE_KEYS[key].cron], enabled: () => !!config[SCHEDULE_KEYS[key].enabled] });
scheduler.register({ key: 'releases', label: "Check this week's releases", ...schedGetters('releases'), run: () => checkReleases() });
scheduler.register({ key: 'cv-match', label: 'Match ComicVine (owned + followed)', ...schedGetters('cv-match'), run: () => runCvMatchSweep() });
scheduler.register({ key: 'zero-day', label: 'Grab weekly 0-Day pack (torrent)', ...schedGetters('zero-day'), run: () => runZeroDayGrab() });
scheduler.register({ key: 'wanted-search', label: 'Search wanted issues (backfill)', ...schedGetters('wanted-search'), run: () => runWantedSearch() });
scheduler.register({ key: 'recent-search', label: 'Search new releases', ...schedGetters('recent-search'), run: () => runRecentSearch() });
scheduler.register({ key: 'rss-watch', label: 'Watch indexer RSS for releases', ...schedGetters('rss-watch'), run: () => runRssWatch() });
// Scheduled backups reuse the backup-db tool (same job tracking + keep-newest-5
// rotation). If another tool happens to be running, this tick is skipped and
// the next scheduled run catches up.
scheduler.register({ key: 'db-backup', label: 'Back up database', ...schedGetters('db-backup'), run: () => runTool('backup-db') });
// Plugin-contributed schedulable jobs (e.g. a catalog crawl). Plugins still
// declare their legacy '<x>Hours' key; the '<x>Cron'/'<x>Enabled' twins drive it.
// Each run receives a context so a plugin job can queue work without importing
// core internals: db is the live core connection; startDownloads kicks the
// download queue if idle (the same guard the built-in jobs use).
const pluginJobCtx = () => ({
  db,
  startDownloads: () => {
    if (!state.queue.running) Promise.resolve(runDownloads()).catch((e) => { state.queue.error = String(e); });
  },
});
for (const job of registeredJobs()) {
  const base = String(job.scheduleKey).replace(/Hours$/, ''); // 'crawlHours' → 'crawl'
  SCHEDULE_KEYS[job.id] = { cron: base + 'Cron', enabled: base + 'Enabled' };
  scheduler.register({ key: job.id, label: job.label, ...schedGetters(job.id), run: () => job.run(pluginJobCtx()) });
}

function setScheduleCron(key, { cron, enabled } = {}) {
  const keys = SCHEDULE_KEYS[key];
  if (!keys) return { error: 'unknown task' };
  const patch = {};
  if (cron != null) {
    const expr = String(cron).trim();
    if (expr) {
      const bad = validateCron(expr);
      if (bad) return { error: `invalid pattern: ${bad}` };
    }
    patch[keys.cron] = expr;
  }
  if (enabled != null) patch[keys.enabled] = !!enabled;
  saveSettings(patch);
  return { key, cron: config[keys.cron], enabled: !!config[keys.enabled] };
}

// Refresh a comic's metadata + issue list from ComicVine.
async function refreshVolume(seriesId) {
  const series = getSeriesById(db, seriesId);
  if (!series) return { error: 'not found' };
  if (!series.cv_id) return { error: 'not matched to ComicVine' };
  try {
    const r = await refreshCvVolume(db, cvClient(), seriesId);
    // Deep half: every issue's full detail (summary, credits, enrichment),
    // one request each — far too slow for this HTTP response on big series,
    // so it sweeps as a background job with progress on the Jobs page.
    const title = getCvSeries(db, series.cv_id)?.name || series.title || `series ${seriesId}`;
    const job = startJob('refresh-details', `Refresh issue details · ${title}`);
    refreshAllIssueDetails(db, cvClient(), series.cv_id, {
      onProgress: (p) => job.progress({ done: p.done, total: p.total }),
    })
      .then((res) => {
        if (res.halted) job.fail(new Error(`halted after ${res.done}/${res.total}: ${res.halted}`));
        else { logInfo(`Refreshed issue details for ${title}: ${res.done - res.failed}/${res.total}`, 'collection'); job.finish({ updated: res.done - res.failed, failed: res.failed }); }
      })
      .catch((e) => job.fail(e));
    return { ...r, detailSweep: true, detail: seriesCollectionDetail(db, seriesId) };
  } catch (e) { return { error: String(e?.message || e) }; }
}

// Remove a comic from the collection. By default only the app's entry/index is
// removed; with deleteFiles, its files and (now-empty) folders are deleted too.
async function deleteComic(seriesId, { deleteFiles = false } = {}) {
  const series = getSeriesById(db, seriesId);
  if (!series) return { error: 'not found' };
  const fileRows = db.prepare('SELECT path, dir FROM library_files WHERE series_id=?').all(seriesId);
  untrackSeries(db, seriesId); // drop the index + remove from collection (never touches disk)
  let filesDeleted = 0, dirsRemoved = 0;
  if (deleteFiles) {
    for (const f of fileRows) { try { await fsp.rm(f.path, { force: true }); filesDeleted++; } catch { /* ignore */ } }
    const dirs = [...new Set(fileRows.map((f) => f.dir).filter(Boolean))];
    for (const d of dirs) {
      if (String(d).split(/[\\/]/).filter(Boolean).length < 3) continue; // guard: never rm a share/drive root
      try { await fsp.rm(d, { recursive: true, force: true }); dirsRemoved++; } catch { /* leftovers stay */ }
    }
  }
  logInfo(`Removed from collection: ${series.title || 'series ' + seriesId}${deleteFiles ? ` (${filesDeleted} file(s) deleted)` : ''}`, 'collection');
  return { deleted: true, deletedFiles: filesDeleted, dirsRemoved };
}

// Manually pin a series to a specific CV volume (locks it against auto-rematch).
async function cvSetManual(seriesId, comicvineId) {
  const v = await cacheAndLink(db, cvClient(), seriesId, comicvineId, { locked: 1 });
  return { series: getSeriesById(db, seriesId), cv: v };
}

// Set a volume's alternative search names (for indexers that name it differently).
function setAliases(seriesId, aliases) {
  setSeriesAliases(db, Number(seriesId), aliases);
  return { detail: seriesCollectionDetail(db, Number(seriesId)), searchNames: seriesSearchNames(db, Number(seriesId)) };
}

// Manual usenet search: run the configured Newznab indexers and return the raw
// releases (no auto-scoring) so the user can pick one. With a free-text `query`
// it searches exactly that; with `seriesId` (+ number) it searches under EVERY
// known name for the volume (title + CV/user aliases) and merges the results, so
// an indexer that names it differently is still found.
async function usenetSearch({ query, seriesId, number } = {}) {
  const indexers = parseIndexers(config.newznabIndexers);
  if (!indexers.length) return { error: 'No Newznab indexers configured (Settings → Download sources → Usenet).' };
  const q = String(query || '').trim();
  let queries;
  if (q) queries = [q];
  else if (seriesId) {
    const token = /^\d+$/.test(String(number ?? '')) ? String(number).padStart(3, '0') : '';
    queries = seriesSearchNames(db, Number(seriesId)).map((n) => [n, token].filter(Boolean).join(' ').trim()).filter(Boolean);
  }
  if (!queries || !queries.length) return { error: 'Enter something to search for.' };
  try {
    const byUrl = new Map();
    for (const qq of queries) {
      for (const r of await searchNewznab(indexers, qq, {})) if (r.nzbUrl && !byUrl.has(r.nzbUrl)) byUrl.set(r.nzbUrl, r);
    }
    return { results: [...byUrl.values()].sort((a, b) => b.size - a.size), searched: queries };
  } catch (e) { return { error: String(e?.message || e) }; }
}

// Manually grab a specific usenet release for a CV issue: create/reuse the queue
// row, hand the chosen NZB to the client, and record the grab so the background
// monitor imports it when it finishes (same path as an auto-grab).
async function usenetGrab({ seriesId, cvIssueId, number, name, nzbUrl, releaseTitle }) {
  if (!nzbUrl) return { error: 'no release selected' };
  const issueId = ensureCvIssueRow(db, { seriesId: Number(seriesId), cvIssueId: Number(cvIssueId), number, title: name });
  try {
    const client = makeNzbClient(config, {});
    const downloadId = await client.add(nzbUrl, { name: releaseTitle, category: config.nzbCategory });
    recordGrab(db, { issueId, source: 'usenet', client: config.nzbClient, downloadId, category: config.nzbCategory, title: releaseTitle });
    setIssueStatus(db, issueId, 'grabbed');
    logInfo(`Grabbed via usenet (manual): ${releaseTitle}`, 'usenet');
    return { grabbed: true };
  } catch (e) {
    setIssueStatus(db, issueId, 'failed', { error: String(e?.message || e) });
    return { error: String(e?.message || e) };
  }
}

// Scheduled backfill: queue the next batch of wanted (missing) issues of
// FOLLOWED series for download. Skips anything already moving or previously
// failed (use Retry Failed for those), so every run makes forward progress
// without hammering the indexers.
async function runWantedSearch() {
  const job = startJob('wanted-search', 'Search wanted issues');
  const batch = Math.max(1, Number(config.wantedSearchBatch) || 25);
  const { items, total } = listWantedIssues(db, { followedOnly: true, hideUnreleased: true, limit: 500 });
  const ids = [];
  for (const it of items) {
    if (ids.length >= batch) break;
    if (it.queue_status) continue; // queued/downloading/failed/… — leave it be
    ids.push(ensureCvIssueRow(db, { seriesId: it.series_id, cvIssueId: it.cv_issue_id, number: it.issue_number, title: it.issue_name }));
  }
  queueIssues(db, ids);
  if (ids.length && !state.queue.running) {
    Promise.resolve(runDownloads()).catch((e) => { state.queue.error = String(e); });
  }
  logInfo(`Wanted search: queued ${ids.length} of ${total} missing issue(s)`, 'download');
  job.finish({ queued: ids.length, wanted: total });
  return { queued: ids.length, wanted: total };
}

// Scheduled new-releases lane: queue missing issues of FOLLOWED series that hit
// the shelves in the last recentSearchDays. Unlike the backfill above, FAILED
// items are retried on every run while they're inside the window — a comic
// released yesterday often isn't on the indexers yet, and availability changes
// daily in week one. Once an issue ages out of the window it stops being
// retried (the nightly backfill's skip-failed rule takes over).
async function runRecentSearch() {
  const job = startJob('recent-search', 'Search new releases');
  const days = Math.max(1, Number(config.recentSearchDays) || 14);
  const { items, total } = listWantedIssues(db, { followedOnly: true, releasedWithinDays: days, limit: 200 });
  const fresh = [], failed = [];
  for (const it of items) {
    // 'pending' is PARKED (a cancelled or interrupted queue entry), not
    // in-flight — inside the new-releases window it gets picked back up:
    // followed means "keep this complete". Only genuinely moving statuses
    // (queued/downloading/grabbed/saving/done) are left alone.
    const bucket = it.queue_status === 'failed' ? failed
      : (!it.queue_status || it.queue_status === 'pending') ? fresh
      : null;
    if (bucket) bucket.push(ensureCvIssueRow(db, { seriesId: it.series_id, cvIssueId: it.cv_issue_id, number: it.issue_number, title: it.issue_name }));
  }
  // Failed rows keep no files (they never downloaded) — just reset them to
  // pending so queueIssues picks them up alongside the fresh ones.
  clearIssuesForRedownload(db, failed);
  const ids = [...fresh, ...failed];
  queueIssues(db, ids);
  if (ids.length && !state.queue.running) {
    Promise.resolve(runDownloads()).catch((e) => { state.queue.error = String(e); });
  }
  logInfo(`New releases: queued ${fresh.length} new, retried ${failed.length} failed (of ${total} recent missing)`, 'download');
  job.finish({ queued: fresh.length, retried: failed.length, recent: total });
  return { queued: fresh.length, retried: failed.length, recent: total };
}

// RSS watch: poll the indexers' latest-uploads feed (empty-query search) and
// grab anything matching a missing issue of a followed series. Each item is
// considered once (rss_seen); a match is PINNED to the issue so the queue
// downloads exactly that release — no re-search. See src/rsswatch.js.
async function runRssWatch() {
  const job = startJob('rss-watch', 'Watch indexer RSS');
  const feeds = [];
  if (config.torrentEnabled) {
    const ixs = parseTorznab(config.torznabIndexers);
    if (ixs.length) feeds.push(searchTorznab(ixs, '', { limit: 100 })
      .then((r) => r.map((x) => ({ ...x, source: 'torrent' })))
      .catch((e) => { logWarn(`RSS watch: torznab feed failed — ${e?.message || e}`, 'download'); return []; }));
  }
  if (config.usenetEnabled) {
    const ixs = parseIndexers(config.newznabIndexers);
    if (ixs.length) feeds.push(searchNewznab(ixs, '', { limit: 100 })
      .then((r) => r.map((x) => ({ ...x, source: 'usenet' })))
      .catch((e) => { logWarn(`RSS watch: newznab feed failed — ${e?.message || e}`, 'download'); return []; }));
  }
  if (!feeds.length) { job.finish({ skipped: 'no sources enabled' }); return { skipped: true }; }
  const items = (await Promise.all(feeds)).flat();
  const fresh = unseenItems(db, items);
  const matches = fresh.length ? matchFeedItems(fresh, buildWantedIndex(db)) : [];
  const ids = [];
  for (const { item, wanted } of matches) {
    const id = ensureCvIssueRow(db, { seriesId: wanted.series_id, cvIssueId: wanted.cv_issue_id, number: wanted.issue_number, title: wanted.issue_name });
    if (manualPins.size >= 500) manualPins.delete(manualPins.keys().next().value);
    manualPins.set(id, { source: item.source, candidate: item });
    ids.push(id);
    logInfo(`RSS match: "${item.title}" → ${wanted.series_title} #${wanted.issue_number} (${item.source})`, 'download');
  }
  queueIssues(db, ids);
  markSeen(db, items); // every fetched item was considered — never re-process
  if (ids.length && !state.queue.running) {
    Promise.resolve(runDownloads()).catch((e) => { state.queue.error = String(e); });
  }
  if (fresh.length || ids.length) logInfo(`RSS watch: ${items.length} item(s), ${fresh.length} new, matched ${ids.length}`, 'download');
  job.finish({ items: items.length, fresh: fresh.length, queued: ids.length });
  return { items: items.length, fresh: fresh.length, queued: ids.length };
}

// Try a real search with the given key (or the saved one) — the Settings
// "Test" button for the API credential.
async function testCvKeys(keysText) {
  const key = cvKey(keysText || config.comicvineKeys);
  if (!key) return { ok: false, message: 'Enter an API key.' };
  try {
    const client = makeCvClient(config, { key, politeMs: 0 });
    const results = await client.search('batman');
    return { ok: true, message: `Key valid — test search returned ${results.length} volumes.` };
  } catch (e) { return { ok: false, message: String(e?.message || e) }; }
}

// Cancel an in-flight grab: remove the download from its client (with files —
// nothing was imported yet), fail the grab, and put the issue back to pending so
// it can be retried. Works for issue grabs and pack grabs alike.
async function cancelActiveGrab(grabId) {
  const grab = getGrab(db, Number(grabId));
  if (!grab) return { error: 'unknown grab' };
  if (grab.status !== 'active') return { error: 'grab is not active' };
  try {
    const client = grab.source === 'torrent' ? makeTorrentClient(config, {}) : makeNzbClient(config, {});
    await client.remove(grab.download_id, { deleteFiles: true }).catch(() => {});
  } catch { /* client unreachable — still cancel our side */ }
  setGrabStatus(db, grab.id, 'failed', { error: 'cancelled by user' });
  if (grab.kind !== 'pack' && grab.issue_id) setIssueStatus(db, grab.issue_id, 'pending');
  logInfo(`Cancelled ${grab.kind === 'pack' ? 'pack ' : ''}grab: ${grab.title || grab.id}`, grab.source || 'download');
  return { cancelled: true };
}

// Manual torrent PACK search for a series. Comics live on trackers as
// multi-issue packs, so this searches by series names only (no issue token) and
// returns candidates ranked by seeders for the user to pick from.
async function torrentSearch({ query, seriesId } = {}) {
  const indexers = parseTorznab(config.torznabIndexers);
  if (!indexers.length) return { error: 'No Torznab indexers configured (Settings → Download sources → Torrents).' };
  const q = String(query || '').trim();
  let queries;
  if (q) queries = [q];
  else if (seriesId) queries = seriesSearchNames(db, Number(seriesId)).filter(Boolean);
  if (!queries || !queries.length) return { error: 'Enter something to search for.' };
  try {
    const byUrl = new Map();
    for (const qq of queries) {
      for (const r of await searchTorznab(indexers, qq, { cat: '' })) {
        if (r.downloadUrl && !byUrl.has(r.downloadUrl)) byUrl.set(r.downloadUrl, r);
      }
    }
    return { results: [...byUrl.values()].sort((a, b) => (b.seeders - a.seeders) || (b.size - a.size)).slice(0, 100), searched: queries };
  } catch (e) { return { error: String(e?.message || e) }; }
}

// Manually grab a torrent PACK for a series: hand it to qBittorrent under our
// category and record a kind='pack' grab pinned to the series — the monitor
// post-processes it on completion (every missing issue of THAT volume imports;
// the pack keeps seeding).
async function torrentGrabPack({ seriesId, downloadUrl, releaseTitle }) {
  if (!downloadUrl) return { error: 'no release selected' };
  const sid = Number(seriesId);
  if (!sid || !getSeriesById(db, sid)) return { error: 'unknown series' };
  try {
    const client = makeTorrentClient(config, {});
    const downloadId = await client.add(downloadUrl, { name: releaseTitle, category: config.torrentCategory });
    recordGrab(db, { source: 'torrent', client: config.torrentClient || 'qbittorrent', downloadId, category: config.torrentCategory, title: releaseTitle, kind: 'pack', seriesId: sid });
    logInfo(`Grabbed torrent pack (manual): ${releaseTitle}`, 'torrent');
    return { grabbed: true };
  } catch (e) { return { error: String(e?.message || e) }; }
}

// Manual multi-source search: query every enabled source that supports it and
// return a merged, ranked list tagged by source. Broad (score is a ranking hint,
// not a filter) so the user sees options the auto-matcher would reject.
async function searchSources({ query, seriesId, cvIssueId, number } = {}) {
  const { orderedSources } = await import('./sources/index.js');
  const series = seriesId ? getSeriesById(db, Number(seriesId)) : null;
  const names = seriesId ? seriesSearchNames(db, Number(seriesId)) : [];
  const ctx = {
    config, db, query: query || '',
    seriesTitle: series?.title || null,
    seriesNames: names,
    seriesYear: series?.year || null,
    issue: { issue_number: number },
    cvIssueId,
  };
  const sources = orderedSources(config).filter((s) => typeof s.manualSearch === 'function');
  if (!sources.length) return { results: [], searched: [], errors: [], sources: [] };
  const searched = new Set();
  const errors = [];
  const results = [];
  // Sources run in parallel — one slow/blocked source doesn't hold up the rest.
  await Promise.all(sources.map(async (s) => {
    try {
      const r = await s.manualSearch(ctx);
      (r.searched || []).forEach((q) => searched.add(q));
      for (const it of (r.results || [])) results.push({ ...it, source: it.source || s.id });
      if (r.error) errors.push(`${s.label || s.id}: ${r.error}`);
    } catch (e) { errors.push(`${s.label || s.id}: ${String(e?.message || e)}`); }
  }));
  // Merged ranking: score desc (nulls last), then seeders desc, then size desc.
  results.sort((a, b) =>
    ((b.score ?? -1) - (a.score ?? -1)) ||
    ((b.seeders ?? -1) - (a.seeders ?? -1)) ||
    ((b.size ?? 0) - (a.size ?? 0)));
  // Give each result a stable id for the client (source + its grab token).
  results.forEach((r, i) => { r.rid = `${r.source}:${i}`; });
  return { results: results.slice(0, 100), searched: [...searched], errors, sources: sources.map((s) => s.id) };
}

// Grab a specific manual-search result: pin the chosen candidate to the issue so
// the download worker uses it (its source's grab/fetch path — reusing progress,
// queue display, and import), then queue + start. Returns { queued }.
function manualGrabResult({ result, seriesId, cvIssueId, number, name } = {}) {
  if (!result || !result.source) return { error: 'no result selected' };
  const issueId = ensureCvIssueRow(db, { seriesId: Number(seriesId), cvIssueId: Number(cvIssueId), number, title: name });
  // A re-grab of an already-owned issue: reset so queueIssues (which skips done
  // rows) actually queues it. Files aren't deleted here — finalizeComic dedupes.
  db.prepare("UPDATE issues SET status='pending', error=NULL WHERE id=? AND status='done'").run(issueId);
  // A pin is consumed when the worker reaches the issue; one that never does
  // (the row is cancelled/cleared first) would linger, so cap the map and
  // evict the oldest entry — insertion order is Map iteration order.
  if (manualPins.size >= 500) manualPins.delete(manualPins.keys().next().value);
  manualPins.set(issueId, { source: result.source, candidate: result });
  queueIssues(db, [issueId]);
  logInfo(`Manual grab via ${result.source}: ${result.title || 'issue ' + issueId}`, result.source);
  return { queued: true, issueId };
}

// Live progress for in-app (immediate-source) pack grabs, keyed by grab id —
// merged into the monitor's pack snapshot so in-app packs show in the queue
// exactly like torrent packs.
const inAppPackProgress = new Map();

// Grab a PACK from an immediate source that downloads in-app: record it as a
// pack grab (so it shows in the queue), then in the background
// download+extract the archive and run processPack — importing every missing
// issue of the series. Reuses the exact pack pipeline torrents use.
function grabSourcePack({ source, seriesId, result } = {}) {
  const sid = Number(seriesId);
  const series = getSeriesById(db, sid);
  if (!result || !series) return { error: 'unknown series or result' };
  const grabId = recordGrab(db, { source, downloadId: result.postUrl || result.downloadUrl || null, title: result.title, kind: 'pack', seriesId: sid });
  (async () => {
    const { orderedSources } = await import('./sources/index.js');
    const src = orderedSources(config).find((s) => s.id === source && typeof s.fetchPack === 'function');
    if (!src) { setGrabStatus(db, grabId, 'failed', { error: `${source} cannot grab packs` }); return; }
    const job = startJob('pack-import', `Import pack · ${result.title}`);
    inAppPackProgress.set(grabId, { state: 'downloading', progress: 0 });
    logInfo(`Grabbing ${source} pack: ${result.title}`, source);
    let dir = null, keepDir = false;
    try {
      // seriesId lets a source target the grab (e.g. AirDC++ cherry-picks only
      // the MISSING issues out of a peer's folder instead of the whole thing).
      const ctx = { db, config, seriesId: sid, seriesTitle: series.title, seriesNames: seriesSearchNames(db, sid), seriesYear: series.year, issue: {} };
      const fetched = await src.fetchPack(result, ctx, (p) => {
        if (p.unit === 'bytes' && p.total) inAppPackProgress.set(grabId, { state: 'downloading', progress: Math.round((p.done / p.total) * 100), bps: p.bps, source });
      });
      dir = fetched.dir;
      // A source may keep its own download in place (e.g. AirDC++ keeps sharing);
      // only temp dirs the source created for us get cleaned up.
      keepDir = !!fetched.keep;
      inAppPackProgress.set(grabId, { state: 'importing', progress: 100, source });
      const summary = await processPack(db, {
        dir, scope: { type: 'series', seriesId: sid }, cvClient,
        refreshVolume: (s) => refreshCvVolume(db, cvClient(), s),
        onProgress: (p) => job.progress({ done: p.done, total: p.total, message: `${p.imported} imported` }),
      });
      job.finish({ imported: summary.imported, skipped: summary.skipped, unmatched: summary.unmatched, failed: summary.failed });
      setGrabStatus(db, grabId, 'imported', { importedAt: new Date().toISOString() });
      logInfo(`${source} pack imported: ${summary.imported} new · ${summary.skipped} already owned · ${summary.unmatched} unmatched · ${summary.failed} failed — ${result.title}`, source);
      notifyRaw(db, { type: 'pack.done', category: 'import', level: summary.failed ? 'warn' : 'success', title: 'Pack imported', body: `${result.title} — ${summary.imported} new issue(s)` });
    } catch (e) {
      setGrabStatus(db, grabId, 'failed', { error: String(e?.message || e) });
      job.fail(e);
      logError(`${source} pack failed: ${result.title} — ${String(e?.message || e)}`, source);
      notifyRaw(db, { type: 'pack.failed', category: 'failure', level: 'error', title: 'Pack failed', body: `${result.title} — ${String(e?.message || e)}` });
    } finally {
      inAppPackProgress.delete(grabId);
      // processPack copies each imported file into the library, so a temp dir the
      // source made for us can go — unless it asked us to keep it (it's the
      // source's own space, e.g. an AirDC++ download that stays shared). Core
      // stays plugin-free — clean up with our own fs.
      if (dir && !keepDir) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  })();
  return { grabbed: true, grabId };
}

// Multi-source PACK search for a series (the "Search packs" button). Queries
// every enabled pack-capable source — an immediate source with fetchPack
// (in-app extract → processPack), or a deferred source whose client download is
// post-processed by the monitor. Searches by series name (no issue number).
async function searchPacks({ seriesId, query } = {}) {
  const sid = Number(seriesId);
  const series = getSeriesById(db, sid);
  if (!series) return { results: [], errors: ['unknown series'], sources: [] };
  const { orderedSources } = await import('./sources/index.js');
  const ctx = {
    config, db, query: query || '',
    seriesTitle: series.title, seriesNames: seriesSearchNames(db, sid), seriesYear: series.year,
    issue: {}, // no issue number → series-name search surfaces packs
  };
  // Pack-capable = has fetchPack (in-app packs) OR is deferred (client + monitor
  // processPack). Immediate sources without fetchPack have no packs.
  const sources = orderedSources(config).filter((s) =>
    typeof s.manualSearch === 'function' && (typeof s.fetchPack === 'function' || s.kind === 'deferred'));
  if (!sources.length) return { results: [], errors: [], sources: [] };
  const errors = [], results = [];
  await Promise.all(sources.map(async (s) => {
    try {
      const r = await s.manualSearch(ctx);
      for (const it of (r.results || [])) {
        // Deferred sources: every result is grabbed as a pack. Immediate
        // (fetchPack) sources: only titles that look like a pack.
        const keep = s.kind === 'deferred' ? true : !!it.isPack;
        if (keep) results.push({ ...it, source: it.source || s.id, isPack: true });
      }
      if (r.error) errors.push(`${s.label || s.id}: ${r.error}`);
    } catch (e) { errors.push(`${s.label || s.id}: ${String(e?.message || e)}`); }
  }));
  results.sort((a, b) =>
    ((b.seeders ?? -1) - (a.seeders ?? -1)) || ((b.score ?? -1) - (a.score ?? -1)) || ((b.size ?? 0) - (a.size ?? 0)));
  results.forEach((r, i) => { r.rid = `${r.source}:${i}`; });
  return { results: results.slice(0, 100), errors, sources: sources.map((s) => s.id) };
}

// Grab a pack from any source: immediate (fetchPack → in-app) via
// grabSourcePack, or deferred (client + monitor processPack) by handing the
// candidate to the source's client under a kind='pack' grab.
async function grabPack({ source, seriesId, result } = {}) {
  const sid = Number(seriesId);
  if (!result || !getSeriesById(db, sid)) return { error: 'unknown series or result' };
  const { orderedSources } = await import('./sources/index.js');
  const src = orderedSources(config).find((s) => s.id === source);
  if (!src) return { error: `${source} is not enabled` };
  if (typeof src.fetchPack === 'function') return grabSourcePack({ source, seriesId: sid, result });
  if (src.kind === 'deferred' && typeof src.grab === 'function') {
    try {
      const g = await src.grab(result, { config, db });
      const grabId = recordGrab(db, { source: src.id, kind: 'pack', seriesId: sid, client: g.client, downloadId: g.downloadId, category: g.category, title: g.title || result.title });
      logInfo(`Grabbed ${src.id} pack: ${g.title || result.title}`, src.id);
      return { grabbed: true, grabId };
    } catch (e) { return { error: String(e?.message || e) }; }
  }
  return { error: `${source} cannot grab packs` };
}

// Search Torznab for the newest weekly 0-Day pack and grab it — but only if its
// WEEK is newer than any pack we've already grabbed (title variants of the same
// week don't re-grab). The monitor post-processes it on completion. Scheduled or
// on-demand (Jobs page → Run now).
async function runZeroDayGrab() {
  const job = startJob('zero-day', 'Grab weekly 0-Day pack');
  if (!torrentSource.isEnabled(config)) {
    job.fail('Torrents are not enabled');
    return { error: 'Torrents are not enabled (Settings → Download sources → Torrents).' };
  }
  const indexers = parseTorznab(config.torznabIndexers);
  let results;
  try { results = await searchTorznab(indexers, config.zeroDayQuery || '0-Day Week', { cat: '' }); }
  catch (e) { logError(`0-Day search failed: ${e?.message || e}`, 'torrent'); job.fail(e); return { error: String(e?.message || e) }; }
  const grabbedTitles = db.prepare("SELECT title FROM grabs WHERE kind='pack' AND status!='failed'").all().map((g) => g.title);
  const best = pickZeroDayGrab(results, grabbedTitles);
  if (!best) {
    logInfo('0-Day check: no weekly pack newer than what we already have', 'torrent');
    job.finish({ skipped: 'nothing newer' });
    return { skipped: true };
  }
  try {
    const client = makeTorrentClient(config, {});
    const downloadId = await client.add(best.downloadUrl, { name: best.title, category: config.torrentCategory });
    recordGrab(db, { source: 'torrent', client: config.torrentClient || 'qbittorrent', downloadId, category: config.torrentCategory, title: best.title, kind: 'pack', seriesId: null });
    logInfo(`Grabbed 0-Day pack for week ${best.date}: ${best.title}`, 'torrent');
    job.finish({ grabbedWeek: best.date });
    return { grabbed: true, title: best.title, date: best.date };
  } catch (e) {
    logError(`0-Day grab failed for "${best.title}": ${e?.message || e}`, 'torrent');
    job.fail(e);
    return { error: String(e?.message || e) };
  }
}

// Manual picks from the multi-source search: issueId → { source, candidate }.
// The worker uses the pinned candidate instead of find() for that one issue.
const manualPins = new Map();

async function runDownloads() {
  state.queue.running = true;
  await runQueue({
    db,
    isPaused: () => state.queue.paused,
    pinnedFor: (id) => manualPins.get(id) || null,
    consumePin: (id) => manualPins.delete(id),
    onProgress: (p) => {
      state.queue.running = true;
      state.queue.event = p.event;
      // Per-issue live progress, keyed by issue id, so CONCURRENT immediate
      // downloads each get their own queue-row bar (deferred grabs already
      // report per-issue via the download monitor). Cleared when the issue
      // finishes or fails; the whole map is reset when the queue drains.
      const id = p.issue?.id;
      if (id != null) {
        const live = state.queue.live || (state.queue.live = {});
        if (p.event === 'done' || p.event === 'failed') {
          delete live[id];
        } else {
          const prev = live[id] || {};
          live[id] = {
            title: p.issue.title,
            source: p.source || prev.source || null,
            // Deferred sources emit a lifecycle phase (grabbed/queued/…);
            // immediate ones stream pages, so fall back to tagging/saving.
            phase: p.phase || (p.event === 'tagging' ? 'tagging' : p.event === 'start' ? 'starting' : 'saving'),
            page: p.event === 'page' ? p.page : (p.event === 'start' ? 0 : prev.page),
            pages: p.event === 'page' ? p.pages : (p.event === 'start' ? 0 : prev.pages),
            // Byte-stream sources add: unit='bytes' (page/pages are byte counts),
            // bps (speed), detail (host label, e.g. "PixelDrain").
            unit: p.event === 'page' ? (p.unit || null) : prev.unit,
            bps: p.event === 'page' ? (p.bps ?? null) : (p.event === 'start' ? null : prev.bps),
            detail: (p.detail != null ? p.detail : prev.detail) || null,
          };
        }
      }
      if (p.event === 'tag-result') recordProgressTagLog(p);
      if (p.event === 'failed') logError(`Download failed: ${p.issue?.title || 'issue ' + p.issue?.id} — ${p.error}`, 'download');
      else if (p.event === 'done') logInfo(`Downloaded: ${p.issue?.title || 'issue ' + p.issue?.id}${p.source ? ' (' + p.source + ')' : ''}`, 'download');
      else if (p.event === 'grabbed') logInfo(`Grabbed via ${p.source || 'usenet'}: ${p.issue?.title || 'issue ' + p.issue?.id}`, 'download');
    },
  });
  state.queue.running = false;
  state.queue.current = null;
  state.queue.live = {}; // queue drained — clear any lingering per-issue bars
}

// Surface tag outcomes from a download on the Logs page (category 'tag').
function recordProgressTagLog(p) {
  const what = `${p.series || ''} ${p.issue?.title || 'issue ' + p.issue?.id || ''}`.trim();
  const reason = p.result?.reason ? ` — ${p.result.reason}` : '';
  if (p.result?.outcome === 'tagged') logInfo(`Tagged: ${what}${reason}`, 'tag');
  else logWarn(`Tag skipped: ${what}${reason}`, 'tag');
}

// Delete the existing files for these issues and reset them so a re-download
// writes the correct name in place (instead of a (chapterId) duplicate).
async function prepareRedownload(issueIds) {
  const paths = clearIssuesForRedownload(db, issueIds);
  for (const p of paths) { try { await fsp.rm(p, { force: true }); } catch { /* already gone */ } }
}

const app = createApp({
  db, runDownloads, state,
  prepareRedownload,
  runCvMatch: runCvMatchSweep,
  cvSearch,
  cvVolumeInfo,
  cvIssueInfo,
  arcSearch: (q) => cvClient().searchArcs(q),
  arcIssues: (id) => cvClient().storyArcIssues(id),
  cleanupSeriesFiles,
  runImportScan,
  runImport,
  importState,
  runTool,
  toolsState,
  runLibraryRefile,
  refileState,
  stats: () => collectionStats(db, config),
  listSources: () => orderedSources(config).map((s) => ({ id: s.id, label: s.label || s.id })),
  queueProgress: () => downloadMonitor.getProgress(),
  packProgress: () => ({ ...downloadMonitor.getPackProgress(), ...Object.fromEntries(inAppPackProgress) }),
  cancelGrab: cancelActiveGrab,
  testCvKeys,
  usenetSearch,
  usenetGrab,
  torrentSearch,
  torrentGrabPack,
  searchSources,
  manualGrabResult,
  grabSourcePack,
  searchPacks,
  grabPack,
  setAliases,
  pluginRoutes: registeredRoutes(),
  pluginClientAssets: registeredClientAssets(),
  matchImportCandidate,
  confirmImportCandidate,
  skipImportCandidate,
  cvSetManual,
  addFromCv,
  scanSeriesFolder,
  deleteComic,
  refreshVolume,
  tagSeriesFiles,
  checkReleases,
  listJobs,
  clearJobs: clearFinishedJobs,
  listLogs: (opts) => ({ logs: listLogs(opts), counts: logCounts(), categories: logCategories() }),
  clearLogs,
  listSchedules: () => scheduler.list(),
  setScheduleCron,
  runScheduleNow: (key) => scheduler.runNow(key),
  getSettings: currentSettings,
  saveSettings,
  requestRestart,
});
const httpServer = app.listen(config.port, () => {
  console.log(`UI ready: http://localhost:${config.port}`);
});
scheduler.start();

// Resume the download queue after a restart. Queued rows survive in the DB
// but the worker only ever started when NEW work arrived — so a queue that
// was mid-flight when the app stopped sat forever. (Pause is in-memory and
// intentionally doesn't survive a restart.)
{
  const n = db.prepare("SELECT COUNT(*) AS n FROM issues WHERE status = 'queued'").get().n;
  if (n > 0) {
    logInfo(`Resuming download queue: ${n} issue(s) still queued from before the restart`, 'download');
    Promise.resolve(runDownloads()).catch((e) => { state.queue.error = String(e); state.queue.running = false; });
  }
}

// Self-restart (plugin enable/disable applies at boot). Two environments:
//  - under a supervisor (Docker restart policy, systemd): just exit — the
//    supervisor revives us, and re-execing from PID 1 would kill the container.
//  - bare `node src/index.js` / `npm start`: re-exec ourselves detached, then
//    exit once the port is released.
function requestRestart() {
  const supervised = fss.existsSync('/.dockerenv') || !!process.env.BACKISSUE_SUPERVISED;
  console.log(`restart requested (${supervised ? 'supervised: exiting for the supervisor' : 're-exec'})`);
  let relaunched = false;
  const relaunch = () => {
    if (relaunched) return;
    relaunched = true;
    if (!supervised) {
      const child = spawn(process.execPath, process.argv.slice(1), {
        cwd: process.cwd(),
        env: process.env,
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
    }
    process.exit(0);
  };
  setTimeout(() => {
    httpServer.close(relaunch);
    // The UI holds an SSE stream open — without this, close() never finishes
    // and the port stays bound, so the replacement process couldn't start.
    httpServer.closeAllConnections?.();
    setTimeout(relaunch, 5000).unref(); // belt and braces
  }, 300);
  return { ok: true, mode: supervised ? 'supervisor' : 'reexec' };
}

// Watch deferred (usenet) downloads: poll the client for our category, import
// finished grabs, and remove them from the client. Reconciles on boot.
const downloadMonitor = createDownloadMonitor({
  db,
  onProgress: (p) => {
    if (p.event === 'tag-result') recordProgressTagLog(p);
    if (p.event === 'done') { logInfo(`Imported from ${p.source || 'download'}: ${p.issue?.title || 'issue ' + p.issue?.id}`, p.source || 'usenet'); notifyRaw(db, { type: 'import.done', category: 'import', level: 'success', title: 'Downloaded', body: `${p.issue?.title || 'issue'}${p.source ? ' · ' + p.source : ''}` }); }
    if (p.event === 'failed') { logError(`${p.source || 'download'} import failed: ${p.issue?.title || 'issue ' + p.issue?.id} — ${p.error}`, p.source || 'usenet'); notifyRaw(db, { type: 'import.failed', category: 'failure', level: 'error', title: 'Download failed', body: `${p.issue?.title || 'issue'} — ${p.error}` }); }
    if (p.event === 'pack-start') logInfo(`Post-processing pack — ${p.title}…`, p.source || 'torrent');
    if (p.event === 'pack-import') {
      if (p.outcome === 'imported') logInfo(`[${p.done}/${p.total}] imported ${p.reason}`, p.source || 'torrent');
      else if (p.outcome === 'failed') logWarn(`[${p.done}/${p.total}] failed: ${p.file} — ${p.reason}`, p.source || 'torrent');
    }
    if (p.event === 'pack-done') {
      const s = p.summary;
      logInfo(`Pack done — ${p.title}: ${s.imported} imported, ${s.skipped} already owned, ${s.unmatched} not in collection, ${s.failed} failed`, p.source || 'torrent');
      if (!s.total) logWarn(`Pack "${p.title}" contained no comic files at all — wrong path mapping, or a bogus release?`, p.source || 'torrent');
      notifyRaw(db, { type: 'pack.done', category: 'import', level: s.failed ? 'warn' : 'success', title: 'Pack imported', body: `${p.title}: ${s.imported} new issue(s)${s.failed ? ', ' + s.failed + ' failed' : ''}` });
    }
    if (p.event === 'pack-failed') { logError(`Pack failed — ${p.title}: ${p.error}`, p.source || 'torrent'); notifyRaw(db, { type: 'pack.failed', category: 'failure', level: 'error', title: 'Pack failed', body: `${p.title}: ${p.error}` }); }
  },
});
downloadMonitor.start();

// Run plugin startup hooks (e.g. a catalog source launching its browser). Each
// may return a cleanup fn called on shutdown. Run in the background so the UI
// serves immediately; a plugin needing its resource ready guards for it.
const pluginCleanups = [];
(async () => {
  for (const fn of registeredStartups()) {
    try {
      const cleanup = await fn({ db, config, state });
      if (typeof cleanup === 'function') pluginCleanups.push(cleanup);
    } catch (e) { console.warn('plugin startup failed:', e?.message || e); }
  }
})();

// Clean shutdown on Ctrl+C: run plugin cleanups (e.g. close a browser so the
// persistent profile isn't left locked by an orphaned process).
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  try { logInfo(`Shutting down (${signal || 'signal'})`, 'app'); } catch { /* ignore */ }
  console.log('\nShutting down…');
  for (const c of pluginCleanups) { try { await c(); } catch { /* ignore */ } }
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
