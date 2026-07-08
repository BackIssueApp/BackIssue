// Post-process a downloaded comic pack (a per-series pack, or a 0-day weekly pack
// of the whole week's releases). Walk every comic file, parse its series + issue
// number from the scene-style filename, match it to a ComicVine issue in the
// user's collection, and import the wanted, still-missing ones — copying each into
// the library (the pack itself is left in place, e.g. seeding in qBittorrent).
//
// scope.type:
//   'series'     — force every file onto one series' CV volume (manual pack grab).
//   'collection' — match each file to any series already in the collection
//                  (followed/owned); never creates new series (0-day pack).
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseReleaseName, normalizeSeries, importCompleted, walkFiles, COMIC_EXT } from './sources/usenet.js';
import { normalizeNumber } from './matcher.js';
import { buildIssueContext, finishImport } from './downloader.js';
import { rankCandidates, addSeriesFromCv } from './cvmatch.js';
import {
  getSeriesById, getCvSeries, listCvIssues, ensureCvIssueRow, getIssueById, seriesSearchNames,
} from './db.js';

// Every comic file in the pack — the shared recursive walker, filtered.
async function walkComics(dir) {
  return (await walkFiles(dir)).filter((f) => COMIC_EXT.has(path.extname(f).toLowerCase()));
}

// A series is in the collection if followed OR backed by a valid file. Build a
// map of every normalized name it's known by (title + CV name + aliases) → id.
function buildCollectionIndex(db) {
  const rows = db.prepare(`SELECT s.id FROM series s
    WHERE s.followed=1 OR EXISTS(SELECT 1 FROM library_files lf WHERE lf.series_id=s.id AND lf.valid=1)`).all();
  const index = new Map();
  for (const { id } of rows) {
    for (const name of seriesSearchNames(db, id)) {
      const key = normalizeSeries(name);
      if (key && !index.has(key)) index.set(key, id);
    }
  }
  return index;
}

// Add-and-follow a new series for a filename's series name by matching it to a
// ComicVine volume. Only auto-accepts a clear, unambiguous name winner (no year is
// passed — a 0-day filename's year is the cover year, not the volume's start year,
// so it would mislead), which safely skips common names with multiple volumes.
// Cached per run so several issues of the same new series resolve once.
async function addNewSeries(db, client, name, cache) {
  const key = normalizeSeries(name);
  if (cache.has(key)) return cache.get(key);
  let result = null;
  try {
    const { best, auto } = rankCandidates({ title: name }, await client.search(name));
    if (best && auto) {
      const r = await addSeriesFromCv(db, client, best.cand.id);
      result = { seriesId: r.seriesId, created: r.outcome === 'created', title: r.title };
    }
  } catch { /* CV error / no confident match → leave unmatched */ }
  cache.set(key, result);
  return result;
}

// Find the CV issue in a series' volume whose number matches (½/1/2/0.5 all equal).
function findCvIssue(db, cvSeriesId, number) {
  const want = normalizeNumber(number);
  if (want === '') return null;
  return listCvIssues(db, cvSeriesId).find((ci) => normalizeNumber(ci.issue_number) === want) || null;
}

// Is this CV issue already owned (a valid file linked to it)?
function issueOwned(db, cvIssueId) {
  return !!db.prepare('SELECT 1 FROM library_files WHERE cv_issue_id=? AND valid=1 LIMIT 1').get(cvIssueId);
}

export async function processPack(db, { dir, cvClient, scope, dryRun = false, refreshVolume = null, onProgress = () => {} }) {
  // Fail loudly if the pack folder isn't reachable — otherwise a wrong completed-
  // content path mapping silently looks like "0 files, all done" (walkComics would
  // just return []).
  try { await fs.stat(dir); }
  catch { throw new Error(`pack folder not readable: ${dir} — check the completed-content path mapping (Settings → Torrents → Completed content)`); }
  const files = await walkComics(dir);
  const index = scope.type === 'collection' ? buildCollectionIndex(db) : null;
  const refreshed = new Set(); // volumes we've already re-pulled from CV this run
  const newSeriesCache = new Map(); // parsed name → resolved seriesId (or null), for scope.addNew
  let imported = 0, skipped = 0, unmatched = 0, failed = 0, done = 0;
  const details = [];
  const note = (outcome, file, reason) => { details.push({ file: path.basename(file), outcome, reason }); };

  for (const file of files) {
    const stem = path.basename(file).replace(/\.(cbz|cbr|pdf|zip|rar)$/i, '');
    const parsed = parseReleaseName(stem);
    try {
      // 1. Resolve the collection series. With scope.addNew, a series not already
      // in the collection is matched to ComicVine and added+followed (0-day only).
      let seriesId, justAdded = false;
      if (scope.type === 'series') {
        seriesId = scope.seriesId;
      } else {
        seriesId = index.get(normalizeSeries(parsed.series)) ?? null;
        if (!seriesId && scope.addNew && cvClient) {
          const added = await addNewSeries(db, cvClient(), parsed.series, newSeriesCache);
          if (added) { seriesId = added.seriesId; justAdded = added.created; index.set(normalizeSeries(parsed.series), seriesId); } // reuse for later files
        }
      }
      if (!seriesId) { unmatched++; note('unmatched', file, scope.addNew ? `no confident ComicVine volume to add for "${parsed.series}"` : `series not in collection ("${parsed.series}")`); continue; }
      const series = getSeriesById(db, seriesId);
      if (!series?.cv_id) { unmatched++; note('unmatched', file, 'series not matched to ComicVine'); continue; }

      // 2. Match the issue number within that CV volume. If it's missing and we can
      // refresh (0-day: the just-released issue isn't in the CV cache yet), re-pull
      // the volume's issues once and try again.
      let cvIssue = findCvIssue(db, series.cv_id, parsed.number);
      if (!cvIssue && refreshVolume && !refreshed.has(series.cv_id)) {
        refreshed.add(series.cv_id);
        try { await refreshVolume(seriesId); cvIssue = findCvIssue(db, series.cv_id, parsed.number); } catch { /* keep null */ }
      }
      if (!cvIssue) { unmatched++; note('unmatched', file, `issue #${parsed.number} not in the CV volume`); continue; }

      // 3. Skip issues already owned (fill missing only).
      if (issueOwned(db, cvIssue.comicvine_id)) { skipped++; note('skipped', file, 'already owned'); continue; }

      if (dryRun) { imported++; note('would-import', file, `${getCvSeries(db, series.cv_id)?.name} #${cvIssue.issue_number}`); continue; }

      // 4. Import: create/reuse the issue row and run the shared import tail.
      const issueId = ensureCvIssueRow(db, { seriesId, cvIssueId: cvIssue.comicvine_id, number: cvIssue.issue_number, title: `${series.title} #${cvIssue.issue_number}` });
      const issue = getIssueById(db, issueId);
      const ic = await buildIssueContext(db, issue, cvClient);
      // importCompleted handles .cbz/.pdf (as srcPath) and converts .cbr→cbz /
      // loose images into a buffer — the same importer the download monitor uses.
      const fetched = await importCompleted(file, path.basename(file));
      await finishImport(db, { issue, ic, fetched, source: 'torrent', onProgress: () => {} });
      imported++; note('imported', file, `${ic.seriesTitle} #${cvIssue.issue_number}${justAdded ? ' — new series added + followed' : ''}`);
    } catch (e) {
      failed++; note('failed', file, String(e?.message || e));
    } finally {
      // Report this file's outcome so the caller can log per-import / per-failure.
      const d = details[details.length - 1] || {};
      onProgress({ done: ++done, total: files.length, imported, skipped, unmatched, failed, file: d.file, outcome: d.outcome, reason: d.reason });
    }
  }
  return { total: files.length, imported, skipped, unmatched, failed, details };
}
