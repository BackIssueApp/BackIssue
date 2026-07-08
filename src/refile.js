// Reorganize on-disk files to match the configured folder/file patterns.
// Used by the per-volume "Rename files" action and the library-wide tool.
// Never runs automatically — always invoked explicitly, with a dry-run available.
import fs from 'node:fs';
import path from 'node:path';
import config from './config.js';
import { parseRootFolders, seriesFolderName } from './paths.js';
import { fileStemFromPattern } from './naming.js';

// Series naming fields, preferring ComicVine's clean name/publisher/start-year.
function seriesForNaming(db, series) {
  if (series.cv_id) {
    const cv = db.prepare('SELECT name, publisher, start_year FROM cv_series WHERE comicvine_id = ?').get(series.cv_id);
    if (cv) return { title: cv.name || series.title, publisher: cv.publisher || null, year: cv.start_year || null };
  }
  return { title: series.title, publisher: null, year: null };
}

const norm = (p) => path.resolve(String(p || ''));
const underRoot = (file, root) => { const r = norm(root); return norm(file) === r || norm(file).startsWith(r + path.sep); };

// Existing filenames in a target directory, read once and cached. Collision
// detection uses this instead of a stat per file — one directory read per
// target folder (huge win on network storage with tens of thousands of files).
function dirNames(cache, dir) {
  let names = cache.get(dir);
  if (!names) { try { names = new Set(fs.readdirSync(dir)); } catch { names = new Set(); } cache.set(dir, names); }
  return names;
}

/** A series is re-fileable only if it's ComicVine-matched — otherwise there's
 *  no reliable publisher/title/year to build a pattern from. */
export function canRefile(series) { return !!series.cv_id; }

/** Plan the moves for one series (no filesystem changes). Each entry is
 *  { from, to, status } where status is 'move' | 'unchanged' | 'skip:<why>'. */
export function planSeries(db, series, cache = new Map()) {
  const roots = parseRootFolders(config.rootFolders);
  if (!canRefile(series)) return [];
  const snm = seriesForNaming(db, series);
  const folderRel = seriesFolderName(snm); // "Publisher/Title (Year)" (OS separators)
  const files = db.prepare(`
    SELECT lf.path, ci.issue_number, ci.name AS issue_title, ci.cover_date
      FROM library_files lf
      LEFT JOIN cv_issues ci ON ci.comicvine_id = lf.cv_issue_id
     WHERE lf.series_id = ? AND lf.valid = 1`).all(series.id);
  const plan = [];
  const claimed = new Set(); // guard against two source files → one target (collision within the batch)
  for (const f of files) {
    const ext = (path.extname(f.path).slice(1) || 'cbz').toLowerCase();
    const stem = fileStemFromPattern(snm, { issue_number: f.issue_number, title: f.issue_title, cover_date: f.cover_date }, config.filePattern);
    if (!stem) { plan.push({ from: f.path, to: null, status: 'skip:no-name' }); continue; }
    const root = roots.find((r) => underRoot(f.path, r)) || roots[0];
    if (!root) { plan.push({ from: f.path, to: null, status: 'skip:no-root' }); continue; }
    const to = path.join(root, folderRel, `${stem}.${ext}`);
    let status;
    if (norm(to) === norm(f.path)) status = 'unchanged';
    else if (claimed.has(norm(to)) || dirNames(cache, path.dirname(to)).has(path.basename(to))) status = 'skip:collision';
    else { status = 'move'; claimed.add(norm(to)); }
    plan.push({ from: f.path, to, status });
  }
  return plan;
}

// Move a file, falling back to copy+unlink across filesystems (EXDEV on NAS/drives).
function moveFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try { fs.renameSync(from, to); }
  catch (e) {
    if (e.code !== 'EXDEV') throw e;
    fs.copyFileSync(from, to); fs.unlinkSync(from);
  }
}

// Remove a directory if it's now empty (best effort), walking up while empty.
function pruneEmptyDirs(dir, roots) {
  let d = dir;
  try {
    while (d && roots.some((r) => underRoot(d, r)) && !roots.some((r) => norm(r) === norm(d))) {
      if (fs.readdirSync(d).length) break;
      fs.rmdirSync(d);
      d = path.dirname(d);
    }
  } catch { /* leave it */ }
}

/** Execute the plan for one series. Returns a summary. */
export function refileSeries(db, series) {
  const roots = parseRootFolders(config.rootFolders);
  const plan = planSeries(db, series);
  const res = { series: series.title, moved: 0, unchanged: 0, skipped: 0, errors: [] };
  const oldDirs = new Set();
  const update = db.prepare('UPDATE library_files SET path = ?, dir = ?, name = ? WHERE path = ?');
  let firstNewDir = null;
  for (const p of plan) {
    if (p.status === 'unchanged') { res.unchanged++; continue; }
    if (p.status.startsWith('skip')) { res.skipped++; if (p.status === 'skip:collision') res.errors.push(`collision: ${path.basename(p.to)}`); continue; }
    try {
      moveFile(p.from, p.to);
      db.transaction(() => update.run(p.to, path.dirname(p.to), path.basename(p.to), p.from))();
      oldDirs.add(path.dirname(p.from));
      firstNewDir = firstNewDir || path.dirname(p.to);
      res.moved++;
    } catch (e) { res.errors.push(`${path.basename(p.from)}: ${e.message}`); }
  }
  // Point the series at its new folder and tidy emptied old folders.
  if (firstNewDir) { try { db.prepare('UPDATE series SET path = ? WHERE id = ?').run(firstNewDir, series.id); } catch { /* no path col */ } }
  for (const d of oldDirs) pruneEmptyDirs(d, roots);
  return res;
}

// Every ComicVine-matched series — the only re-fileable ones.
function matchedSeries(db) {
  return db.prepare('SELECT id, title, cv_id, path FROM series WHERE cv_id IS NOT NULL ORDER BY title').all();
}

/** Dry-run across the whole library: aggregate counts + a sample of moves. */
export function planLibrary(db, { sample = 300 } = {}) {
  const counts = { move: 0, unchanged: 0, skip: 0, collision: 0 };
  const moves = [];
  const cache = new Map();
  let series = 0;
  for (const s of matchedSeries(db)) {
    series++;
    for (const p of planSeries(db, s, cache)) {
      if (p.status === 'move') { counts.move++; if (moves.length < sample) moves.push({ from: p.from, to: p.to }); }
      else if (p.status === 'unchanged') counts.unchanged++;
      else if (p.status === 'skip:collision') counts.collision++;
      else counts.skip++;
    }
  }
  return { series, counts, moves, truncated: counts.move > moves.length };
}

/** Execute across the whole library. Async with progress so it can run as a
 *  background job — a 40k-file reorganize on a NAS takes minutes, and the
 *  event loop must keep breathing (yields between series). */
export async function refileLibrary(db, onProgress = () => {}) {
  const all = matchedSeries(db);
  const totals = { series: 0, moved: 0, unchanged: 0, skipped: 0, errors: [] };
  for (const s of all) {
    totals.series++;
    const r = refileSeries(db, s);
    totals.moved += r.moved; totals.unchanged += r.unchanged; totals.skipped += r.skipped;
    for (const e of r.errors) totals.errors.push(`${s.title}: ${e}`);
    onProgress({ done: totals.series, total: all.length, moved: totals.moved, message: s.title });
    await new Promise((resolve) => setImmediate(resolve)); // let requests through
  }
  return totals;
}
