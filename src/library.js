import fs from 'node:fs/promises';
import config from './config.js';
import { findComicFiles, parseIssueFromFilename, COMIC_RE } from './scanner.js';
import { readArchiveInfo, verifyArchive } from './archive.js';
import { upsertLibraryFile, getLibraryFile, pruneLibraryFiles, libraryStats, linkLibraryFile, deleteLibraryFile, getCvIssue } from './db.js';
import { normalizeNumber } from './matcher.js';
import { poolWithResource } from './pool.js';
import { linkFile } from './collection.js';
import { linkFilesToCv } from './cvmatch.js';

// After a fresh download lands for an issue, remove any OTHER file in the series
// that represents the SAME issue — a re-download replaces the old copy (incl. a
// stale/corrupt .cbr the new .cbz supersedes). Matches by CV issue id and by
// normalized issue number, so it also catches files that were never CV-linked.
async function supersedeOldFiles(db, newPath, seriesId) {
  const row = getLibraryFile(db, newPath);
  if (!row || seriesId == null) return 0;
  let num = null;
  if (row.cv_issue_id != null) { const ci = getCvIssue(db, row.cv_issue_id); if (ci) num = normalizeNumber(ci.issue_number); }
  if (!num) num = normalizeNumber(row.ci_number || parseIssueFromFilename(row.name));
  const siblings = db.prepare('SELECT path, ci_number, name, cv_issue_id FROM library_files WHERE series_id=? AND path<>?').all(seriesId, newPath);
  let removed = 0;
  for (const f of siblings) {
    const sameCv = row.cv_issue_id != null && f.cv_issue_id === row.cv_issue_id;
    const sameNum = num && normalizeNumber(f.ci_number || parseIssueFromFilename(f.name)) === num;
    if (!sameCv && !sameNum) continue;
    try { await fs.unlink(f.path); } catch { /* already gone */ }
    deleteLibraryFile(db, f.path);
    removed++;
  }
  return removed;
}

// One-shot cleanup: delete invalid files that are already superseded by a valid
// copy of the same ComicVine issue (e.g. an old corrupt .cbr left beside a good
// re-downloaded .cbz). Removes them from disk + index. Returns how many.
export async function removeSupersededFiles(db, seriesId) {
  const good = new Set(
    db.prepare('SELECT DISTINCT cv_issue_id FROM library_files WHERE series_id=? AND valid=1 AND cv_issue_id IS NOT NULL')
      .all(seriesId).map((r) => r.cv_issue_id)
  );
  const bad = db.prepare('SELECT path, cv_issue_id FROM library_files WHERE series_id=? AND valid=0 AND cv_issue_id IS NOT NULL').all(seriesId);
  let removed = 0;
  for (const f of bad) {
    if (!good.has(f.cv_issue_id)) continue;
    try { await fs.unlink(f.path); } catch { /* already gone */ }
    deleteLibraryFile(db, f.path);
    removed++;
  }
  return removed;
}

// Walk the library, read each new/changed file's metadata + health into
// library_files, skip unchanged files (mtime+size), and prune deleted ones.
// `collect` (optional): accumulate seen paths there and SKIP pruning — the
// multi-root caller prunes once at the end, so scanning root A can never delete
// root B's rows, and an unreachable root can never wipe the index.
export async function indexLibrary({ db, dir, deep = false, onProgress = () => {}, collect = null }) {
  // An unreachable folder (share down, bad path) must not read as "everything
  // was deleted" — report it instead of scanning an empty listing.
  const dirOk = await fs.stat(dir).then((s) => s.isDirectory()).catch(() => false);
  if (!dirOk) return { total: 0, error: `folder not found: ${dir}` };
  const files = await findComicFiles(dir);
  const seen = collect ?? new Set();
  let done = 0;
  await poolWithResource(
    files, config.libraryConcurrency || 8,
    () => null,
    async (f) => {
      seen.add(f.path);
      let st;
      try { st = await fs.stat(f.path); } catch { onProgress({ done: ++done, total: files.length, read: 0 }); return; }
      const mtime = Math.floor(st.mtimeMs);
      const size = st.size;
      const existing = getLibraryFile(db, f.path);
      if (existing && existing.mtime === mtime && existing.size === size && (!deep || existing.verified)) {
        // Unchanged on disk — skip the re-read, but re-link if it isn't linked yet
        // (e.g. files indexed before linking existed). Uses the stored metadata, no I/O.
        if (existing.series_id == null) {
          const link = linkFile(db, {
            path: existing.path, dir: existing.dir, name: existing.name,
            ci_series: existing.ci_series, ci_volume: existing.ci_volume,
            ci_number: existing.ci_number, has_metadata: existing.has_metadata,
          });
          linkLibraryFile(db, existing.path, link.seriesId, link.issueId);
        }
        onProgress({ done: ++done, total: files.length, read: 0 });
        return;
      }
      const info = await readArchiveInfo(f.path);
      let valid = info.ok ? 1 : 0;
      let error = info.error || null;
      let verified = 0;
      if (deep && info.ok) {
        const v = await verifyArchive(f.path);
        valid = v.ok ? 1 : 0;
        if (!v.ok) error = v.error;
        verified = 1;
      }
      const ci = info.comicInfo || {};
      upsertLibraryFile(db, {
        path: f.path, dir: f.dir, name: f.name, size, mtime,
        page_count: info.pageCount ?? null, has_metadata: info.hasComicInfo ? 1 : 0,
        ci_series: ci.series || null, ci_number: ci.number || null, ci_volume: ci.volume || null, ci_title: ci.title || null,
        valid, error, verified,
      });
      // Only attribute files that aren't linked yet. A re-scan must NOT reassign
      // a file that already belongs to a series — the fuzzy matcher can pick a
      // different same-named series (e.g. an unmatched catalog row whose title
      // carries the year), silently moving owned files off their series. Files
      // that already have a series keep it (upsertLibraryFile preserves it);
      // this mirrors the unchanged-file path above.
      if (existing?.series_id == null) {
        const link = linkFile(db, { path: f.path, dir: f.dir, name: f.name, ci_series: ci.series, ci_volume: ci.volume, ci_number: ci.number, has_metadata: info.hasComicInfo ? 1 : 0 });
        linkLibraryFile(db, f.path, link.seriesId, link.issueId);
      }
      onProgress({ done: ++done, total: files.length, read: 1 });
    },
    () => {},
  );
  if (!collect) pruneLibraryFiles(db, seen, COMIC_RE); // multi-root callers prune once, at the end; comic files only — other indexers own their own rows
  // Now that files are attributed to series (above), link them to CV issues for
  // every matched series so the collection's owned/missing rolls up against
  // ComicVine. Pure DB, no I/O.
  for (const s of db.prepare('SELECT id, cv_id FROM series WHERE cv_id IS NOT NULL').all()) {
    try { linkFilesToCv(db, s.id, s.cv_id); } catch { /* skip */ }
  }
  return libraryStats(db);
}

// Index a single comic's folder and attribute every file in it to that comic
// (the folder IS its location), then link to CV issues. Incremental — unchanged
// files aren't re-read. This is the per-volume replacement for a global index.
export async function indexFolderForSeries({ db, dir, seriesId, cvId = null, deep = false, onProgress = () => {} }) {
  // An unreachable folder (share down, bad path) must not wipe the index —
  // report it instead of treating it as "everything was deleted".
  const dirOk = await fs.stat(dir).then((s) => s.isDirectory()).catch(() => false);
  if (!dirOk) return { total: 0, error: `folder not found: ${dir}` };
  const files = await findComicFiles(dir);
  let done = 0;
  await poolWithResource(
    files, config.libraryConcurrency || 8,
    () => null,
    async (f) => {
      let st;
      try { st = await fs.stat(f.path); } catch { onProgress({ done: ++done, total: files.length }); return; }
      const mtime = Math.floor(st.mtimeMs), size = st.size;
      const existing = getLibraryFile(db, f.path);
      if (!(existing && existing.mtime === mtime && existing.size === size && (!deep || existing.verified))) {
        const info = await readArchiveInfo(f.path);
        let valid = info.ok ? 1 : 0, error = info.error || null, verified = 0;
        if (deep && info.ok) { const v = await verifyArchive(f.path); valid = v.ok ? 1 : 0; if (!v.ok) error = v.error; verified = 1; }
        const ci = info.comicInfo || {};
        upsertLibraryFile(db, {
          path: f.path, dir: f.dir, name: f.name, size, mtime,
          page_count: info.pageCount ?? null, has_metadata: info.hasComicInfo ? 1 : 0,
          ci_series: ci.series || null, ci_number: ci.number || null, ci_volume: ci.volume || null, ci_title: ci.title || null,
          valid, error, verified,
        });
      }
      // Force attribution to THIS comic; borrow the source issue id from the
      // matcher when it agrees on the series (owned still rolls up via CV).
      const row = getLibraryFile(db, f.path);
      const link = linkFile(db, row);
      linkLibraryFile(db, f.path, seriesId, link.seriesId === seriesId ? link.issueId : null);
      onProgress({ done: ++done, total: files.length });
    },
    () => {},
  );
  if (cvId) linkFilesToCv(db, seriesId, cvId);
  // Prune index rows for this comic's files that are gone from disk (deleted or
  // moved) — otherwise a removed file still counts as owned. If a vanished file
  // backed a 'done' source issue, reset it so the issue is downloadable again.
  const seen = new Set(files.map((f) => f.path));
  let pruned = 0;
  for (const row of db.prepare('SELECT path, issue_id FROM library_files WHERE series_id=?').all(seriesId)) {
    if (seen.has(row.path)) continue;
    const gone = await fs.stat(row.path).then(() => false).catch(() => true);
    if (!gone) continue; // lives outside the scanned folder and still exists
    db.prepare('DELETE FROM library_files WHERE path=?').run(row.path);
    if (row.issue_id != null) {
      db.prepare("UPDATE issues SET status='pending', file_path=NULL WHERE id=? AND status='done'").run(row.issue_id);
    }
    pruned++;
  }
  return { total: files.length, pruned };
}

// Index one freshly downloaded/tagged file and link it to its comic and CV
// issue, so it counts as owned immediately — no manual folder scan needed.
// `cvIssueId` (when the caller knows exactly which CV issue this file IS) beats
// the number-based relink — a release's embedded ComicInfo can carry a wrong
// number, and the identity we imported it as is authoritative.
export async function indexDownloadedFile(db, { path: p, seriesId, issueId = null, cvId = null, cvIssueId = null }) {
  let st;
  try { st = await fs.stat(p); } catch { return false; }
  const info = await readArchiveInfo(p);
  const ci = info.comicInfo || {};
  upsertLibraryFile(db, {
    path: p, dir: p.replace(/[\\/][^\\/]+$/, ''), name: p.replace(/^.*[\\/]/, ''),
    size: st.size, mtime: Math.floor(st.mtimeMs),
    page_count: info.pageCount ?? null, has_metadata: info.hasComicInfo ? 1 : 0,
    ci_series: ci.series || null, ci_number: ci.number || null, ci_volume: ci.volume || null, ci_title: ci.title || null,
    valid: info.ok ? 1 : 0, error: info.error || null, verified: 0,
  });
  linkLibraryFile(db, p, seriesId, issueId);
  if (cvId) linkFilesToCv(db, seriesId, cvId);
  if (cvIssueId) db.prepare('UPDATE library_files SET cv_issue_id=? WHERE path=?').run(cvIssueId, p);
  // Replace any prior copy of this issue (a re-download supersedes the old file).
  await supersedeOldFiles(db, p, seriesId);
  return true;
}

// One-time cleanup for libraries indexed under the old global model: attribute
// any orphaned files to their catalog series, CV-link matched series, then prune
// files that don't belong to a tracked comic (followed or ComicVine-matched).
export function reconcileLibrary(db) {
  let attributed = 0;
  for (const f of db.prepare('SELECT * FROM library_files WHERE series_id IS NULL').all()) {
    const link = linkFile(db, f);
    if (link.seriesId) { linkLibraryFile(db, f.path, link.seriesId, link.issueId); attributed++; }
  }
  for (const s of db.prepare('SELECT id, cv_id FROM series WHERE cv_id IS NOT NULL').all()) {
    try { linkFilesToCv(db, s.id, s.cv_id); } catch { /* skip */ }
  }
  // Members of an explicit library are tracked by definition (libraries own
  // their contents — incl. plugin types whose series never carry a CV id).
  const pruned = db.prepare(
    'DELETE FROM library_files WHERE series_id IS NULL OR series_id IN (SELECT id FROM series WHERE followed=0 AND cv_id IS NULL AND library_id IS NULL)'
  ).run().changes;
  return { attributed, pruned };
}
