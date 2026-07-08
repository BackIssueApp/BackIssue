import path from 'node:path';
import config from './config.js';
import { seriesFolderFromPattern } from './naming.js';

// Root folders where comics live on disk (Radarr-style), newline/comma separated.
export function parseRootFolders(text) {
  return String(text || '').split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
}

// Map a path a download client reports (on ITS filesystem) onto the path this
// app reads it at (e.g. over SMB) — Mylar-style drop-dir remap. THE one remap
// implementation, shared by every deferred-source client (SABnzbd/NZBGet,
// qBittorrent, …). No prefix match (or no mapping configured) → unchanged.
export function remapClientPath(p, remotePrefix, localPrefix) {
  if (!p) return null;
  if (remotePrefix && localPrefix && p.startsWith(remotePrefix)) {
    return (localPrefix.replace(/[\\/]+$/, '') + p.slice(remotePrefix.replace(/[\\/]+$/, '').length)).replace(/\\/g, '/');
  }
  return p;
}

// Make one path segment safe for a folder name (strip characters illegal on
// Windows/SMB, collapse whitespace). Not for full paths — one segment only.
export function safeSegment(s) {
  return String(s || '').replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// The on-disk folder (relative to a root) for a comic, from the admin's folder
// pattern — blank falls back to the built-in "Publisher/Title (Year)" default.
export function seriesFolderName(series) {
  // Pattern uses "/" for sub-folders; return OS-native separators.
  return seriesFolderFromPattern(series, config.folderPattern).split('/').join(path.sep);
}

// Prefer ComicVine's clean name/publisher/start-year over the (possibly
// ongoing-marked) source title when the comic is CV-matched.
function cvEnriched(db, series) {
  if (!series.cv_id) return series;
  const cv = db.prepare('SELECT name, publisher, start_year FROM cv_series WHERE comicvine_id=?').get(series.cv_id);
  if (!cv) return series;
  return { ...series, title: cv.name || series.title, publisher: cv.publisher || series.publisher, year: cv.start_year || series.year };
}

// Root folders where comics are organized as Publisher/Title (Year).
function effectiveRoots() {
  return parseRootFolders(config.rootFolders);
}

// The effective on-disk folder for a comic:
//   1. an explicit series.path, if set
//   2. else the folder its existing files live in (most-common valid-file dir)
//   3. else a root folder (or the library folder) + "Publisher/Title (Year)"
//   4. else the global downloads folder + title (legacy last resort)
export function resolveSeriesDir(db, series) {
  if (series.path) return series.path;
  const row = db.prepare(
    'SELECT dir, COUNT(*) n FROM library_files WHERE series_id=? AND valid=1 AND dir IS NOT NULL GROUP BY dir ORDER BY n DESC LIMIT 1'
  ).get(series.id);
  if (row && row.dir) return row.dir;
  const s = cvEnriched(db, series);
  const roots = effectiveRoots();
  if (roots[0]) return path.join(roots[0], seriesFolderName(s));
  return path.join(config.downloadsDir, safeSegment(s.title));
}

// Where a comic's folder WOULD go under the configured root (ignoring existing
// files) — used to preview/pin a fresh location.
export function defaultRootedDir(db, series) {
  const roots = effectiveRoots();
  return roots[0] ? path.join(roots[0], seriesFolderName(cvEnriched(db, series))) : null;
}
