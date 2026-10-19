// Reorganize on-disk files to match the configured folder/file patterns.
// Used by the per-volume "Rename files" action and the library-wide tool.
// Never runs automatically — always invoked explicitly, with a dry-run available.
// All filesystem work is async: libraries live on network mounts, where one
// synchronous directory read or cross-device copy can hold the event loop for
// minutes (long enough for the watchdog to kill the process mid-copy).
import fs from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import path from 'node:path';
import config from './config.js';
import { parseRootFolders, seriesFolderName } from './paths.js';
import { fileStemFromPattern } from './naming.js';
import { sidecarPath } from './archive.js';

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
// Names compare without case: on Windows/macOS "batman.cbz" and "Batman.cbz"
// are the same file, and a rename onto one silently replaces it.
const fold = (p) => norm(p).toLowerCase();
const yieldLoop = () => new Promise((resolve) => setImmediate(resolve));

// The series' library (when it has its own root folders and folder pattern).
function libraryOf(db, series) {
  if (!series.library_id) return null;
  try { return db.prepare('SELECT root_folder, folder_pattern FROM libraries WHERE id = ?').get(series.library_id) || null; }
  catch { return null; }
}
const splitFolders = (s) => String(s || '').split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);

// Roots a series may file under: its library's folders first (the first is
// the library's default filing target), then the global roots.
function rootsFor(db, series) {
  const lib = libraryOf(db, series);
  return { lib, roots: [...new Set([...splitFolders(lib?.root_folder), ...parseRootFolders(config.rootFolders)])] };
}
function allRoots(db) {
  let libs = [];
  try { libs = db.prepare('SELECT root_folder FROM libraries').all().flatMap((l) => splitFolders(l.root_folder)); } catch { /* no libraries table */ }
  return [...new Set([...libs, ...parseRootFolders(config.rootFolders)])];
}

// Existing filenames (case-folded) in a target directory, read once and
// cached. Collision detection uses this instead of a stat per file — one
// directory read per target folder (huge win on network storage with tens of
// thousands of files).
async function dirNames(cache, dir) {
  let names = cache.get(dir);
  if (!names) {
    try { names = new Set((await fs.readdir(dir)).map((n) => n.toLowerCase())); } catch { names = new Set(); }
    cache.set(dir, names);
  }
  return names;
}

/** A series is re-fileable only if it's ComicVine-matched — otherwise there's
 *  no reliable publisher/title/year to build a pattern from. */
export function canRefile(series) { return !!series.cv_id; }

/** Plan the moves for one series (no filesystem changes). Each entry is
 *  { from, to, status } where status is 'move' | 'unchanged' | 'skip:<why>'. */
export async function planSeries(db, series, cache = new Map()) {
  if (!canRefile(series)) return [];
  const { lib, roots } = rootsFor(db, series);
  const snm = seriesForNaming(db, series);
  // "Publisher/Title (Year)" (OS separators) — the library's own pattern when
  // it has one, as downloads use (manga trees often skip the publisher level).
  const folderRel = seriesFolderName(snm, lib?.folder_pattern);
  const files = db.prepare(`
    SELECT lf.path, ci.issue_number, ci.name AS issue_title, ci.cover_date
      FROM library_files lf
      LEFT JOIN cv_issues ci ON ci.comicvine_id = lf.cv_issue_id
     WHERE lf.series_id = ? AND lf.valid = 1`).all(series.id);
  const plan = [];
  const claimed = new Set(); // guard against two source files → one target (collision within the batch)
  let i = 0;
  for (const f of files) {
    if (++i % 200 === 0) await yieldLoop();
    const ext = (path.extname(f.path).slice(1) || 'cbz').toLowerCase();
    const stem = fileStemFromPattern(snm, { issue_number: f.issue_number, title: f.issue_title, cover_date: f.cover_date }, config.filePattern);
    if (!stem) { plan.push({ from: f.path, to: null, status: 'skip:no-name' }); continue; }
    const root = roots.find((r) => underRoot(f.path, r)) || roots[0];
    if (!root) { plan.push({ from: f.path, to: null, status: 'skip:no-root' }); continue; }
    const to = path.join(root, folderRel, `${stem}.${ext}`);
    let status;
    if (norm(to) === norm(f.path)) status = 'unchanged';
    else if (fold(to) === fold(f.path)) { status = 'move'; claimed.add(fold(to)); } // a case-only rename of itself
    else if (claimed.has(fold(to)) || (await dirNames(cache, path.dirname(to))).has(path.basename(to).toLowerCase())) status = 'skip:collision';
    else { status = 'move'; claimed.add(fold(to)); }
    plan.push({ from: f.path, to, status });
  }
  return plan;
}

const exists = (p) => fs.lstat(p).then(() => true, () => false);
const collision = (to) => Object.assign(new Error(`${path.basename(to)} already exists`), { code: 'EEXIST' });
// Something other than `from` itself sits at `to` (a case-only rename on a
// case-insensitive disk finds the source there, which is fine).
async function occupied(from, to) {
  const t = await fs.stat(to).catch(() => null);
  if (!t) return false;
  if (fold(to) !== fold(from)) return true;
  const f = await fs.stat(from);
  return !(t.ino === f.ino && t.dev === f.dev);
}

// Move a file without ever replacing one at the target. Across filesystems
// (EXDEV on NAS/drives) it copies to "<to>.part", checks the size, renames it
// into place and only then removes the source, so an interrupted copy leaves
// a .part (swept by the library scan) rather than a truncated comic.
async function moveFile(from, to) {
  await fs.mkdir(path.dirname(to), { recursive: true });
  if (await occupied(from, to)) throw collision(to);
  try { await fs.rename(from, to); }
  catch (e) {
    if (e.code !== 'EXDEV') throw e;
    const part = `${to}.part`;
    try {
      await fs.copyFile(from, part, FS.COPYFILE_EXCL);
      const [a, b] = await Promise.all([fs.stat(from), fs.stat(part)]);
      if (a.size !== b.size) throw Object.assign(new Error(`${b.size} of ${a.size} bytes copied`), { code: 'ESHORTCOPY' });
      if (await exists(to)) throw collision(to);
      await fs.rename(part, to);
    } catch (err) {
      await fs.rm(part, { force: true }).catch(() => {});
      throw err;
    }
    await fs.unlink(from);
  }
  // A sidecar metadata file travels with its archive (same basename, .xml) —
  // unless one is already there, which is left alone.
  const fromSide = sidecarPath(from);
  if (fromSide !== from && await exists(fromSide)) {
    try { await moveFile(fromSide, sidecarPath(to)); } catch { /* metadata is rebuildable */ }
  }
}

// Remove a directory if it's now empty (best effort), walking up while empty.
async function pruneEmptyDirs(dir, roots) {
  let d = dir;
  try {
    while (d && roots.some((r) => underRoot(d, r)) && !roots.some((r) => norm(r) === norm(d))) {
      if ((await fs.readdir(d)).length) break;
      await fs.rmdir(d);
      d = path.dirname(d);
    }
  } catch { /* leave it */ }
}

/** Execute the plan for one series. Returns a summary. */
export async function refileSeries(db, series) {
  const roots = allRoots(db);
  const plan = await planSeries(db, series);
  const res = { series: series.title, moved: 0, unchanged: 0, skipped: 0, errors: [] };
  const oldDirs = new Set();
  // The index row AND the issue's recorded file move together — a stale
  // issues.file_path reads as "downloaded file missing" and re-downloads it.
  const update = db.prepare('UPDATE library_files SET path = ?, dir = ?, name = ? WHERE path = ?');
  const updateIssue = db.prepare('UPDATE issues SET file_path = ? WHERE file_path = ?');
  const record = db.transaction((from, to) => { update.run(to, path.dirname(to), path.basename(to), from); updateIssue.run(to, from); });
  let firstNewDir = null;
  for (const p of plan) {
    if (p.status === 'unchanged') { res.unchanged++; continue; }
    if (p.status.startsWith('skip')) { res.skipped++; if (p.status === 'skip:collision') res.errors.push(`collision: ${path.basename(p.to)}`); continue; }
    try {
      await moveFile(p.from, p.to);
    } catch (e) {
      if (e.code === 'EEXIST') { res.skipped++; res.errors.push(`collision: ${path.basename(p.to)}`); }
      else res.errors.push(`${path.basename(p.from)}: ${e.message}`);
      continue;
    }
    try { record(p.from, p.to); }
    catch (e) { console.warn('refile: moved but not recorded (a rescan fixes it)', p.from, '->', p.to, e?.message || e); res.errors.push(`${path.basename(p.from)}: ${e.message}`); }
    oldDirs.add(path.dirname(p.from));
    firstNewDir = firstNewDir || path.dirname(p.to);
    res.moved++;
  }
  // Point the series at its new folder and tidy emptied old folders.
  if (firstNewDir) { try { db.prepare('UPDATE series SET path = ? WHERE id = ?').run(firstNewDir, series.id); } catch { /* no path col */ } }
  for (const d of oldDirs) await pruneEmptyDirs(d, roots);
  return res;
}

// Every ComicVine-matched series — the only re-fileable ones.
function matchedSeries(db) {
  return db.prepare('SELECT * FROM series WHERE cv_id IS NOT NULL ORDER BY title').all();
}

/** Dry-run across the whole library: aggregate counts + a sample of moves.
 *  Yields between series so a big library on a NAS doesn't stall requests. */
export async function planLibrary(db, { sample = 300 } = {}) {
  const counts = { move: 0, unchanged: 0, skip: 0, collision: 0 };
  const moves = [];
  const cache = new Map();
  let series = 0;
  for (const s of matchedSeries(db)) {
    series++;
    for (const p of await planSeries(db, s, cache)) {
      if (p.status === 'move') { counts.move++; if (moves.length < sample) moves.push({ from: p.from, to: p.to }); }
      else if (p.status === 'unchanged') counts.unchanged++;
      else if (p.status === 'skip:collision') counts.collision++;
      else counts.skip++;
    }
    await yieldLoop();
  }
  return { series, counts, moves, truncated: counts.move > moves.length };
}

/** Execute across the whole library. Async with progress so it can run as a
 *  background job — a 40k-file reorganize on a NAS takes minutes, and the
 *  event loop must keep breathing. */
export async function refileLibrary(db, onProgress = () => {}) {
  const all = matchedSeries(db);
  const totals = { series: 0, moved: 0, unchanged: 0, skipped: 0, errors: [] };
  for (const s of all) {
    totals.series++;
    const r = await refileSeries(db, s);
    totals.moved += r.moved; totals.unchanged += r.unchanged; totals.skipped += r.skipped;
    for (const e of r.errors) totals.errors.push(`${s.title}: ${e}`);
    onProgress({ done: totals.series, total: all.length, moved: totals.moved, message: s.title });
    await yieldLoop(); // let requests through
  }
  return totals;
}
