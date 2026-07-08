// Library-wide maintenance operations, each iterating files/series and reporting
// progress. Used by the Tools page. Pure orchestration over existing helpers.
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import config from './config.js';
import { poolWithResource } from './pool.js';
import { convertCbrToCbz, verifyArchive, readArchiveInfo, sniffFormat, repackRarAsZip } from './archive.js';
import { removeSupersededFiles, indexLibrary } from './library.js';
import { walkFiles } from './sources/usenet.js';
import { pruneLibraryFiles } from './db.js';
import { libraryStats } from './db.js';
import { linkFilesToCv, refreshCvVolume } from './cvmatch.js';
import { tagFileFromCv } from './metatagger.js';
import { fileStemFromPattern } from './naming.js';
import { deleteLibraryFile, getLibraryFile } from './db.js';
import { logWarn } from './logstore.js';

// Run fn over items with bounded concurrency, so per-file network I/O overlaps.
const eachFile = (items, fn) => poolWithResource(items, config.toolsConcurrency || 4, () => null, (item) => fn(item));

// Write ComicVine ComicInfo.xml into every owned, CV-linked file that lacks it
// (converting .cbr → .cbz first, which tagFileFromCv handles).
export async function tagAllUntagged(db, client, onProgress = () => {}) {
  // Every untagged file whose series is matched to ComicVine — including ones not
  // yet linked to a specific CV issue (so they're counted, not silently skipped).
  const files = db.prepare(`SELECT lf.path FROM library_files lf JOIN series s ON s.id=lf.series_id
    WHERE lf.valid=1 AND lf.has_metadata=0 AND s.cv_id IS NOT NULL`).all().map((r) => r.path);

  // Some untagged files aren't linked to a CV issue because their number isn't in
  // the cached CV issue list (a just-released issue, or a stale cache). Refresh each
  // affected volume once — refreshCvVolume re-pulls issues and re-links files by
  // number — so those become taggable. Bounded to the distinct series involved.
  const unlinkedSeries = db.prepare(`SELECT DISTINCT lf.series_id sid FROM library_files lf JOIN series s ON s.id=lf.series_id
    WHERE lf.valid=1 AND lf.has_metadata=0 AND s.cv_id IS NOT NULL AND lf.cv_issue_id IS NULL`).all().map((r) => r.sid);
  for (const sid of unlinkedSeries) {
    try { await refreshCvVolume(db, client, sid); }
    catch (e) { if (e?.rateLimited) break; /* other volumes: skip and carry on */ }
  }

  let done = 0, tagged = 0, problems = 0, rateLimited = 0, stopped = false;
  await eachFile(files, async (p) => {
    // Once ComicVine rate-limits us, every key is spent for the window — further
    // detail calls just fail slowly. Halt: leave the rest untagged (has_metadata
    // stays 0) so a later run finishes them, rather than writing partial tags.
    if (stopped) { rateLimited++; onProgress({ done: ++done, total: files.length, message: 'rate limited — run again later' }); return; }
    try {
      (await tagFileFromCv(db, client, p)).outcome === 'tagged' ? tagged++ : problems++;
    } catch (e) {
      if (e?.rateLimited) { stopped = true; rateLimited++; }
      else problems++;
    }
    onProgress({ done: ++done, total: files.length, message: `${tagged} tagged` });
  });
  if (rateLimited) logWarn(`Tagging hit the ComicVine rate limit — ${rateLimited} file(s) left untagged; run "Tag all untagged files" again later to finish.`, 'tag');
  return { total: files.length, tagged, problems, ...(rateLimited ? { rateLimited } : {}) };
}

// Convert every valid .cbr in the library to .cbz (re-pointing the index row).
export async function convertAllCbr(db, onProgress = () => {}) {
  const files = db.prepare("SELECT path FROM library_files WHERE valid=1 AND LOWER(name) LIKE '%.cbr'").all().map((r) => r.path);
  let done = 0, converted = 0, deduped = 0, failed = 0;
  await eachFile(files, async (p) => {
    const target = p.replace(/\.cbr$/i, '.cbz');
    try {
      if (existsSync(target)) {
        // A .cbz already exists for this comic. If it's a valid copy, the .cbr is
        // redundant — delete it. (Never drop the .cbr if the existing .cbz is bad.)
        const info = await readArchiveInfo(target);
        if (!info.ok) { failed++; console.warn('convert cbr: existing .cbz is unreadable, kept .cbr', p); }
        else {
          await fs.unlink(p).catch(() => {});
          if (getLibraryFile(db, target)) deleteLibraryFile(db, p); // .cbz already indexed → drop the .cbr row
          else db.prepare('UPDATE library_files SET path=?, name=?, has_metadata=?, page_count=?, valid=1 WHERE path=?')
            .run(target, path.basename(target), info.hasComicInfo ? 1 : 0, info.pageCount ?? null, p); // move the row onto the .cbz
          deduped++;
        }
      } else {
        const { cbzPath } = await convertCbrToCbz(p);
        const info = await readArchiveInfo(cbzPath);
        db.prepare('UPDATE library_files SET path=?, name=?, has_metadata=?, page_count=?, valid=? WHERE path=?')
          .run(cbzPath, path.basename(cbzPath), info.hasComicInfo ? 1 : 0, info.pageCount ?? null, info.ok ? 1 : 0, p);
        converted++;
      }
    } catch (e) { failed++; console.warn('convert cbr failed', p, e?.message || e); }
    onProgress({ done: ++done, total: files.length, message: `${converted} converted` });
  });
  return { total: files.length, converted, deduped, failed };
}

// Delete invalid files already superseded by a valid copy of the same issue,
// across every comic.
export async function removeAllDuplicates(db, onProgress = () => {}) {
  const series = db.prepare('SELECT DISTINCT series_id id FROM library_files WHERE series_id IS NOT NULL').all();
  let done = 0, removed = 0;
  for (const s of series) {
    try { removed += await removeSupersededFiles(db, s.id); } catch { /* skip */ }
    onProgress({ done: ++done, total: series.length, message: `${removed} removed` });
  }
  return { seriesChecked: series.length, removed };
}

// Deep integrity check of every archive; updates valid/error and prunes files
// that have vanished from disk.
export async function verifyLibrary(db, onProgress = () => {}, { corruptOnly = false } = {}) {
  // corruptOnly re-checks just the files currently flagged bad — a fast pass to
  // confirm fixes (mislabeled formats, off-by-one sizes) cleared them, instead of
  // deep-reading the whole library.
  const files = db.prepare(
    corruptOnly ? 'SELECT path FROM library_files WHERE valid=0' : 'SELECT path FROM library_files',
  ).all().map((r) => r.path);
  let done = 0, ok = 0, corrupt = 0, missing = 0, repacked = 0, unreachable = 0;
  await eachFile(files, async (p) => {
    try {
      const st = await fs.stat(p).catch(() => null);
      if (!st) {
        // Only treat this as "deleted" when its FOLDER is still reachable — if the
        // folder is gone too, the share is down (or the network blipped), and
        // deleting rows would wipe the index for an outage. Keep those rows.
        const parentOk = await fs.stat(path.dirname(p)).then(() => true).catch(() => false);
        if (parentOk) { deleteLibraryFile(db, p); missing++; }
        else unreachable++;
      }
      else {
        // A file with a .cbz/.zip name but RAR bytes inside reads fine now (we
        // sniff), but its extension still lies. Repack it in place into a real
        // ZIP so the name is honest and it stops needing the memory-heavy RAR
        // path. Only touches confirmed mismatches; a genuine .cbr is left for the
        // dedicated convert tool. A successful repack extracts every entry, which
        // IS the deep integrity check — so we skip the redundant verifyArchive
        // (a whole second read+inflate over the share) and just refresh metadata.
        if (/\.(cbz|zip)$/i.test(p) && (await sniffFormat(p)) === 'cbr') {
          try {
            await repackRarAsZip(p);
            repacked++;
            const info = await readArchiveInfo(p); // cheap now — real zip central directory
            db.prepare('UPDATE library_files SET valid=1, error=NULL, verified=1, page_count=COALESCE(?, page_count), has_metadata=? WHERE path=?')
              .run(info.pageCount ?? null, info.hasComicInfo ? 1 : 0, p);
            ok++;
            onProgress({ done: ++done, total: files.length, message: `${corrupt} corrupt, ${repacked} repacked` });
            return;
          } catch (e) { console.warn('repack failed', p, e?.message || e); /* fall through to a normal verify */ }
        }
        const v = await verifyArchive(p);
        db.prepare('UPDATE library_files SET valid=?, error=?, verified=1 WHERE path=?').run(v.ok ? 1 : 0, v.ok ? null : v.error, p);
        v.ok ? ok++ : corrupt++;
      }
    } catch (e) { corrupt++; console.warn('verify failed', p, e?.message || e); }
    onProgress({ done: ++done, total: files.length, message: `${corrupt} corrupt${repacked ? `, ${repacked} repacked` : ''}` });
  });
  if (unreachable) logWarn(`Verify: ${unreachable} file(s) were unreachable (share down?) — their rows were kept, not pruned.`, 'tools');
  return { total: files.length, ok, corrupt, missing, repacked, ...(unreachable ? { unreachable } : {}) };
}

// Walk every root folder and index all comic files — discovers files not yet in
// the library, refreshes changed ones, and prunes deleted rows. This is what
// brings the index up to the true on-disk count so the other tools cover
// everything.
// Temp files our own writers create (atomic-write .part, tagger .tag-*) can be
// stranded by a crash mid-write. Sweep ones old enough that no writer can still
// own them. Uses the shared recursive walker.
const TEMP_FILE_RE = /(\.part$|^\.tag-)/;
const TEMP_MAX_AGE_MS = 24 * 3600 * 1000;
async function sweepTempFiles(dir) {
  let swept = 0;
  for (const p of await walkFiles(dir)) {
    if (!TEMP_FILE_RE.test(path.basename(p))) continue;
    const st = await fs.stat(p).catch(() => null);
    if (st && Date.now() - st.mtimeMs > TEMP_MAX_AGE_MS) {
      await fs.unlink(p).catch(() => {});
      swept++;
    }
  }
  return swept;
}

export async function scanEntireLibrary(db, roots, onProgress = () => {}) {
  let base = 0;
  // One seen-set across ALL roots, pruned once at the end — and only when every
  // root was reachable. Pruning per-root would delete the other roots' rows, and
  // pruning after an unreachable root (share down) would wipe the whole index.
  const seen = new Set();
  let unreachable = 0, swept = 0;
  for (const root of roots) {
    let rootTotal = 0;
    const r = await indexLibrary({ db, dir: root, collect: seen, onProgress: (p) => {
      rootTotal = p.total;
      onProgress({ done: base + p.done, total: base + p.total, message: String(root).split(/[\\/]/).filter(Boolean).pop() || root });
    } });
    if (r?.error) { unreachable++; logWarn(`Library scan: ${r.error} — skipping (nothing pruned)`, 'tools'); }
    else swept += await sweepTempFiles(root); // crash-stranded .part/.tag-* litter
    base += rootTotal;
  }
  if (!unreachable && seen.size > 0) pruneLibraryFiles(db, seen);
  const s = libraryStats(db);
  return { files: s.total, tagged: s.tagged, untagged: s.untagged, corrupt: s.corrupt, ...(swept ? { tempSwept: swept } : {}), ...(unreachable ? { unreachableRoots: unreachable } : {}) };
}

// Rename library files to the configured file pattern (Settings → Library →
// File organization) so imported scene-named files converge with downloaded
// ones. Same naming core as downloads and the reorganize tool. Only valid,
// CV-linked files, renamed in place (same folder); a name collision skips.
export async function renameAllFiles(db, onProgress = () => {}) {
  const rows = db.prepare(`SELECT lf.path, ci.issue_number, ci.name issue_name, ci.cover_date,
      cv.name series_name, cv.publisher, cv.start_year
    FROM library_files lf
    JOIN cv_issues ci ON ci.comicvine_id = lf.cv_issue_id
    JOIN cv_series cv ON cv.comicvine_id = ci.cv_series_id
    WHERE lf.valid = 1 AND lf.cv_issue_id IS NOT NULL`).all();
  let done = 0, renamed = 0, unchanged = 0, collisions = 0;
  for (const r of rows) {
    const ext = path.extname(r.path).toLowerCase();
    const stem = fileStemFromPattern(
      { title: r.series_name, publisher: r.publisher, year: r.start_year },
      { issue_number: r.issue_number, title: r.issue_name, cover_date: r.cover_date },
      config.filePattern,
    );
    const target = path.join(path.dirname(r.path), stem + ext);
    if (target === r.path) unchanged++;
    else if (existsSync(target)) collisions++;
    else {
      try {
        await fs.rename(r.path, target);
        db.prepare('UPDATE library_files SET path=?, name=? WHERE path=?').run(target, path.basename(target), r.path);
        db.prepare('UPDATE issues SET file_path=? WHERE file_path=?').run(target, r.path);
        renamed++;
      } catch (e) { collisions++; console.warn('rename failed', r.path, e?.message || e); }
    }
    onProgress({ done: ++done, total: rows.length, message: `${renamed} renamed` });
  }
  return { total: rows.length, renamed, unchanged, collisions };
}

// Snapshot the database (SQLite online backup — safe while the app is running)
// into backups/ next to the live file, keeping the newest KEEP_BACKUPS. The
// catalog is the app's crown jewels; this is the cheap insurance policy.
const KEEP_BACKUPS = 5;
export async function backupDatabase(db, dbPath, onProgress = () => {}) {
  const dir = path.join(path.dirname(dbPath), 'backups');
  await fs.mkdir(dir, { recursive: true });
  const dest = path.join(dir, `catalog-${Date.now()}.db`);
  onProgress({ done: 0, total: 1, message: 'copying…' });
  await db.backup(dest);
  const all = (await fs.readdir(dir)).filter((f) => /^catalog-\d+\.db$/.test(f)).sort();
  for (const f of all.slice(0, Math.max(0, all.length - KEEP_BACKUPS))) {
    await fs.unlink(path.join(dir, f)).catch(() => {});
  }
  const st = await fs.stat(dest);
  onProgress({ done: 1, total: 1, message: path.basename(dest) });
  return { backupMB: Math.max(1, Math.round(st.size / 1e6)), kept: Math.min(all.length, KEEP_BACKUPS) };
}

// Re-map owned files to ComicVine issues for every matched series (useful after
// issue-number parsing improvements, or to repair a stale rollup).
export async function relinkAllCv(db, onProgress = () => {}) {
  const series = db.prepare('SELECT id, cv_id FROM series WHERE cv_id IS NOT NULL').all();
  let done = 0, filesLinked = 0;
  for (const s of series) {
    try { filesLinked += linkFilesToCv(db, s.id, s.cv_id); } catch { /* skip */ }
    onProgress({ done: ++done, total: series.length, message: `${filesLinked} linked` });
  }
  return { seriesRelinked: series.length, filesLinked };
}
