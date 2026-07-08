import fs from 'node:fs/promises';
import path from 'node:path';
import { issueNumberFromTitle } from './matcher.js';
import { listSeries, listIssues, getSeriesById, getScanOverride } from './db.js';
import { scoreMatch, normalizeNumber, normalizeTitle, extractYear } from './matcher.js';
import { detectEdition } from './editions.js';

const COMIC_RE = /\.(cbz|cbr)$/i;
const RANK = { high: 3, medium: 2, low: 1, none: 0 };

// Edition-aware match key so Annual/TPB/Special #1 never collide with regular
// #1: editions are namespaced by type ("annual:1"), regular issues are the bare
// normalized number ("1"). Issues with no parseable number/edition (e.g. a
// collected edition titled "... TPB 1 (Part 1)") fall back to a title slug
// ("name:...") so they're still tracked instead of being silently dropped.
export function issueKey(title, number) {
  const ed = detectEdition(title);
  if (ed) return ed.type.toLowerCase() + ':' + normalizeNumber(ed.num != null ? ed.num : number);
  const n = normalizeNumber(number);
  if (n) return n;
  const slug = String(title).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return slug ? 'name:' + slug : '';
}

// Human-readable label for the report: "Annual 1", "TPB 2", "12", or — for a
// numberless issue — its title.
export function issueLabel(title, number) {
  const ed = detectEdition(title);
  if (ed) return ed.type + (ed.num != null ? ' ' + ed.num : '');
  const n = normalizeNumber(number);
  if (n) return String(number);
  return String(title || '');
}

// Parse the issue number out of a comic filename. Handles "Series V1999 #001",
// trailing numbers, and the unicode fractions our naming uses for half issues.
export function parseIssueFromFilename(name) {
  const base = String(name).replace(/\.(cbz|cbr|pdf|zip|rar)$/i, '');
  if (/#\s*1\/2(?!\d)/.test(base)) return '½';
  const uni = base.match(/#\s*(½|¼|¾)/);
  if (uni) return uni[1];
  // Scene-style filename: "Series NNN (year) (tags)". Cut at the (year), drop
  // parenthetical/bracket tags, keep a dot BETWEEN digits (so "000.5" survives as
  // the ½ promo, "1.1" as a point-one), then take the last non-year number.
  const yearMatch = base.match(/\((?:19|20)\d{2}\)/);
  const head = yearMatch ? base.slice(0, yearMatch.index) : base;
  const cleaned = head
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/_+/g, ' ')
    .replace(/(?<!\d)\.|\.(?!\d)/g, ' ');
  const nums = cleaned.match(/\d+(?:\.\d+)?/g);
  if (nums) {
    const nonYear = nums.filter((n) => !/^(?:19|20)\d{2}$/.test(n));
    if (nonYear.length) return nonYear[nonYear.length - 1];
  }
  return issueNumberFromTitle(base);
}

// Group comic files by their immediate parent (the series folder). The series
// name is the folder name and the publisher is the parent folder.
export function groupSeries(files, seriesFolders = []) {
  const byDir = new Map();
  for (const f of files) {
    let g = byDir.get(f.dir);
    if (!g) {
      g = { seriesName: path.basename(f.dir), publisher: path.basename(path.dirname(f.dir)), dir: f.dir, present: new Set() };
      byDir.set(f.dir, g);
    }
    const base = f.name.replace(/\.(cbz|cbr|pdf)$/i, '');
    const key = issueKey(base, parseIssueFromFilename(f.name));
    if (key !== '') g.present.add(key); // skip files with no usable number/edition
  }
  // Include series folders that had no comic files at all, so an empty folder is
  // reported as "all missing" rather than silently omitted.
  for (const d of seriesFolders) {
    if (!byDir.has(d)) byDir.set(d, { seriesName: path.basename(d), publisher: path.basename(path.dirname(d)), dir: d, present: new Set() });
  }
  return [...byDir.values()];
}

// List series-level folders, including empty ones. The depth of series folders
// is discovered from the files (each comic file's dir IS a series folder), so we
// enumerate every sibling folder under those same publishers. Layout-agnostic:
// works whether scanDir is the library root or a single publisher folder. Skips
// hidden/system dirs (., @eaDir, ...).
export async function findSeriesFolders(files) {
  const parents = new Set(files.map((f) => path.dirname(f.dir))); // publisher dirs
  const ok = (name) => !/^[.@]/.test(name);
  const out = [];
  for (const parent of parents) {
    let entries;
    try { entries = await fs.readdir(parent, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isDirectory() && ok(e.name)) out.push(path.join(parent, e.name));
    }
  }
  return out;
}

// Catalog issues whose edition-aware key isn't on disk. Editions (Annual/TPB/
// Special) match only their own kind, never the regular run.
export function findMissing(issues, present) {
  const missing = [];
  for (const i of issues) {
    const key = issueKey(i.title, i.issue_number);
    if (key === '') continue; // no usable number/edition -> skip
    if (!present.has(key)) missing.push({ id: i.id, number: i.issue_number, title: i.title, label: issueLabel(i.title, i.issue_number) });
  }
  return missing;
}

// Recursively collect comic archives under dir. Unreadable/permission-denied
// folders are skipped, not fatal.
export async function findComicFiles(dir) {
  const out = [];
  async function walk(d) {
    let entries;
    try { entries = await fs.readdir(d, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (COMIC_RE.test(e.name)) out.push({ path: p, dir: d, name: e.name });
    }
  }
  await walk(dir);
  return out;
}

// Best catalog series for a scanned folder name (local catalog only, no network).
export function matchCatalogSeries(db, name, year) {
  const word = normalizeTitle(name).split(' ')[0];
  if (!word) return null;
  let best = null;
  for (const c of listSeries(db, { search: word })) {
    const { confidence } = scoreMatch({ name, year }, c.title);
    if (!best || RANK[confidence] > RANK[best.confidence]) best = { seriesId: c.id, title: c.title, confidence };
  }
  return best && RANK[best.confidence] >= RANK.low ? best : null;
}

// Walk a library folder, match each series to the catalog, and report missing.
export async function scanLibrary({ db, dir, onProgress = () => {} }) {
  const files = await findComicFiles(dir);
  const groups = groupSeries(files, await findSeriesFolders(files));
  const series = [];
  let done = 0;
  for (const g of groups) {
    // A saved manual override (from "Fix match") wins over the fuzzy match.
    let match = null;
    const overrideId = getScanOverride(db, g.dir);
    if (overrideId != null) {
      const orow = getSeriesById(db, overrideId);
      if (orow) match = { seriesId: overrideId, title: orow.title, confidence: 'manual' };
    }
    if (!match) match = matchCatalogSeries(db, g.seriesName, extractYear(g.seriesName));
    if (!match) {
      series.push({ seriesName: g.seriesName, publisher: g.publisher, dir: g.dir, present: [...g.present], have: g.present.size, total: null, matchedTitle: null, confidence: 'none', matched: null, missing: [], unmatched: true });
    } else {
      const all = listIssues(db, { seriesId: match.seriesId });
      const row = getSeriesById(db, match.seriesId);
      series.push({
        seriesName: g.seriesName, publisher: g.publisher, dir: g.dir, present: [...g.present],
        have: g.present.size, total: all.length, matchedTitle: match.title, confidence: match.confidence,
        matched: { id: row.id, title: row.title, url: row.url, publisher: row.publisher, cover_url: row.cover_url, followed: row.followed, issue_count: all.length },
        missing: findMissing(all, g.present), unmatched: false,
      });
    }
    onProgress({ done: ++done, total: groups.length, seriesName: g.seriesName });
  }
  series.sort((a, b) => (a.publisher || '').localeCompare(b.publisher || '') || a.seriesName.localeCompare(b.seriesName));
  return { dir, series };
}

// Re-link a scan report entry to a manually chosen catalog series, recomputing
// total/missing/matched against that series using the entry's stored present
// keys. Mutates and returns the entry, or null if the series doesn't exist.
export function relinkScanEntry(db, entry, seriesId) {
  const row = getSeriesById(db, seriesId);
  if (!row) return null;
  const all = listIssues(db, { seriesId });
  const present = new Set(entry.present || []);
  entry.matchedTitle = row.title;
  entry.confidence = 'manual';
  entry.unmatched = false;
  entry.total = all.length;
  entry.missing = findMissing(all, present);
  entry.matched = { id: row.id, title: row.title, url: row.url, publisher: row.publisher, cover_url: row.cover_url, followed: row.followed, issue_count: all.length };
  return entry;
}
