import fs from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import { parseIndexers, searchNewznab } from '../newznab.js';
import { makeNzbClient } from '../nzbclients.js';
import { loadReleaseBlacklist, normReleaseTitle } from '../db.js';
import { normalizeNumber } from '../matcher.js';
import { cbrBufferToCbz } from '../archive.js';

export const COMIC_EXT = new Set(['.cbz', '.cbr', '.pdf', '.zip', '.rar']);
const IMG_EXT = /\.(jpe?g|png|gif|webp|bmp)$/i;

// Normalize a series name for exact comparison: lowercase, & → and, drop a
// leading "the", collapse everything non-alphanumeric. So "The Amazing
// Spider-Man" and "Amazing Spider-Man" compare equal, but "Spider-Man" and
// "Amazing Spider-Man" do NOT.
export function normalizeSeries(s) {
  return String(s || '').toLowerCase()
    .replace(/&/g, 'and')
    .replace(/^\s*the\s+/, '')
    .replace(/[^a-z0-9]+/g, '');
}

// Parse a scene release name into { series, number, year }. Comic releases look
// like "<Series> <NNN> (<Year>) (tags…)". The year is the first (YYYY); the issue
// number is the last bare number in the text before the year (tags and "(of N)"
// part-counts stripped first); the series is everything before that number.
export function parseReleaseName(title) {
  const t = String(title || '').trim();
  const yearMatch = t.match(/\((\d{4})\)/);
  const year = yearMatch ? yearMatch[1] : null;
  const head = yearMatch ? t.slice(0, yearMatch.index) : t;
  // Drop parenthetical/bracket tags (incl. "(of 6)") and separators, but keep a
  // dot that sits BETWEEN digits so decimal issue numbers survive ("000.5" is the
  // ½ promo, "1.1" a point-one — not "5" or "1").
  const cleaned = head
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/_+/g, ' ')
    .replace(/(?<!\d)\.|\.(?!\d)/g, ' ');
  // Capture an optional leading minus for the "-1" (Flashback) issues, but ONLY
  // when it's a standalone token — a "-" glued to a word char is a hyphenated
  // series name (X-23, Spider-Man), not a negative issue number.
  const nums = cleaned.match(/(?<!\w)-?\d+(?:\.\d+)?/g);
  let number = null, series = cleaned;
  if (nums) {
    const last = nums[nums.length - 1];
    number = normalizeNumber(last);   // "001" -> "1", "000.5" -> "0.5"
    series = cleaned.slice(0, cleaned.lastIndexOf(last));
  }
  return { series: series.trim(), number, year };
}

// Score a release against the wanted issue, or return null if it's the wrong
// comic. The series must match EXACTLY (this is what stops a "Spider-Man" search
// grabbing "Amazing Spider-Man …"), and the issue number must match. Year only
// affects ranking: a matching volume year is preferred, a mismatch is penalized
// but not rejected (long-running volumes tag issues with their cover year, not the
// volume's start year).
export function scoreRelease(title, target) {
  const p = parseReleaseName(title);
  // The release's series must exactly match the wanted series OR any of its
  // aliases (indexers name a volume differently — "2000 AD" vs "2000AD"). Exact
  // match on the normalized name is what stops "Spider-Man" grabbing "Amazing
  // Spider-Man …".
  const accepted = (target.names && target.names.length ? target.names : [target.series]).map(normalizeSeries).filter(Boolean);
  if (!accepted.includes(normalizeSeries(p.series))) return null;
  // Normalize both sides so ½ / 1/2 / 0.5 / 000.5 all compare equal.
  const wantNum = normalizeNumber(target.number);
  if (wantNum !== '') {
    if (p.number == null || normalizeNumber(p.number) !== wantNum) return null;
  }
  let score = 100;
  const wantYear = String(target.year ?? '').match(/\d{4}/);
  if (wantYear && p.year) score += (p.year === wantYear[0] ? 20 : -10);
  return score;
}

// Boolean form: does this release match the wanted series + issue number?
export function matchesIssue(title, series, number) {
  return scoreRelease(title, { series, number }) != null;
}

// Fake/malware releases on indexers are typically tiny (a KB-scale exe or scam
// text with a comic-shaped name and inflated seeders). No real comic is under a
// megabyte, so auto-grab refuses anything smaller. Unknown size (0/absent) is NOT
// rejected — many indexers omit it, and unknown ≠ fake.
export const MIN_RELEASE_BYTES = 1024 * 1024;
export function suspiciouslySmall(size) {
  return Number(size) > 0 && Number(size) < MIN_RELEASE_BYTES;
}

// The zero-padded issue token, or '' for fractional/special numbers (query stays
// broad and the strict matcher filters). A negative "-1" issue is searchable as
// a literal token (releases name it "-1", not "-001"), so it keeps its sign and
// isn't padded — without it the query would fall back to the bare series name
// and never surface the issue.
export function issueToken(issue) {
  const norm = normalizeNumber(issue?.issue_number);
  if (/^\d+$/.test(norm)) return norm.padStart(3, '0');
  if (/^-\d+$/.test(norm)) return norm; // "-1" stays "-1"
  return '';
}

export function buildQuery(ctx) {
  return [ctx.seriesTitle, issueToken(ctx.issue)].filter(Boolean).join(' ').trim();
}

// The scoring target for a manual search (series + all aliases + wanted number
// + volume year). Used to rank/label results across every source.
export function manualTarget(ctx) {
  const names = (ctx.seriesNames && ctx.seriesNames.length) ? ctx.seriesNames : [ctx.seriesTitle].filter(Boolean);
  return { series: ctx.seriesTitle, names, number: ctx.issue?.issue_number, year: ctx.seriesYear };
}

// Search queries for a manual search: the user's free-text query verbatim if
// given, otherwise "<name> <padded-token>" for each known volume name. Sources
// whose site uses a different number form build their own.
export function manualQueries(ctx) {
  const q = String(ctx.query || '').trim();
  if (q) return [q];
  const names = (ctx.seriesNames && ctx.seriesNames.length) ? ctx.seriesNames : [ctx.seriesTitle].filter(Boolean);
  const token = issueToken(ctx.issue);
  return names.map((n) => [n, token].filter(Boolean).join(' ').trim()).filter(Boolean);
}

// Recursively list every file under a directory (the client may extract into
// nested subfolders).
export async function walkFiles(dir) {
  const out = [];
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await walkFiles(full));
    else out.push(full);
  }
  return out;
}

// Find the finished comic in the client's completed download. `srcPath` may be a
// folder (usenet, multi-file torrents) or a single file (single-file torrents).
// Returns { buffer|srcPath, format }. A .cbr is converted to CBZ in memory; a
// release of loose page images (no archive at all) is packed into a CBZ so it
// imports and tags like any other.
async function importCompleted(srcPath, name) {
  const st = await fs.stat(srcPath).catch(() => null);
  const files = st && st.isFile() ? [srcPath] : await walkFiles(srcPath);
  if (!files.length) throw new Error(`can't read completed download ${srcPath} for "${name}"`);

  const comic = files.find((f) => COMIC_EXT.has(path.extname(f).toLowerCase()));
  if (comic) {
    const ext = path.extname(comic).toLowerCase();
    if (ext === '.pdf') return { srcPath: comic, format: 'pdf' };
    if (ext === '.cbz' || ext === '.zip') return { srcPath: comic, format: 'cbz' };
    // .cbr / .rar → convert to CBZ so it can be tagged uniformly
    return { buffer: await cbrBufferToCbz(await fs.readFile(comic)), format: 'cbz' };
  }

  // No archive — some releases are just the loose page images. Pack them into a
  // CBZ, renamed to a zero-padded index (natural-sorted) so readers show them in
  // order regardless of the original file names.
  const images = files.filter((f) => IMG_EXT.test(f))
    .sort((a, b) => path.basename(a).localeCompare(path.basename(b), undefined, { numeric: true, sensitivity: 'base' }));
  if (images.length) {
    const zip = new JSZip();
    let n = 0;
    for (const img of images) zip.file(String(++n).padStart(3, '0') + path.extname(img).toLowerCase(), await fs.readFile(img));
    return { buffer: await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' }), format: 'cbz' };
  }

  throw new Error(`no comic archive or page images found in ${srcPath} for "${name}"`);
}

// Deferred download source: usenet via Newznab indexers + SABnzbd/NZBGet.
// "Deferred" means grab() hands the NZB to the download client and returns
// immediately; the background monitor (src/downloadmonitor.js) polls the client
// by category, and calls importCompleted() to finish the job when it's done.
export const usenet = {
  id: 'usenet',
  label: 'usenet',
  kind: 'deferred',
  isEnabled: (config) => !!config?.usenetEnabled && parseIndexers(config.newznabIndexers).length > 0 && !!(config.nzbClientHost || config.nzbClientUrl),

  async find(ctx) {
    const indexers = parseIndexers(ctx.config.newznabIndexers);
    if (!indexers.length) return null;
    // Search under every known name for this volume (title + CV/user aliases), so
    // an indexer that lists it as "2000AD" is found even though CV says "2000 AD".
    const names = (ctx.seriesNames && ctx.seriesNames.length) ? ctx.seriesNames : [ctx.seriesTitle];
    const token = issueToken(ctx.issue);
    const byUrl = new Map();
    for (const name of names) {
      const query = [name, token].filter(Boolean).join(' ').trim();
      if (!query) continue;
      const results = await searchNewznab(indexers, query, {});
      for (const r of results) if (r.nzbUrl && !byUrl.has(r.nzbUrl)) byUrl.set(r.nzbUrl, r);
    }
    const target = { series: ctx.seriesTitle, names, number: ctx.issue?.issue_number, year: ctx.seriesYear };
    // Drop releases that previously failed to download — a broken post is very
    // likely to fail again on retry, so skip it and let the next-best win.
    const blocked = ctx.db ? loadReleaseBlacklist(ctx.db, 'usenet') : { guids: new Set(), titles: new Set() };
    const isBlocked = (r) => (r.guid && blocked.guids.has(r.guid)) || blocked.titles.has(normReleaseTitle(r.title));
    // Keep only true matches (series matches any alias + number) that aren't
    // suspiciously small (fake-release guard), then prefer the best year. Larger
    // files sort first within a score (searchNewznab order).
    const scored = [...byUrl.values()]
      .filter((r) => !suspiciouslySmall(r.size) && !isBlocked(r))
      .map((r) => ({ r, score: scoreRelease(r.title, target) }))
      .filter((x) => x.score != null)
      .sort((a, b) => b.score - a.score);
    const best = scored[0]?.r;
    return best ? { source: 'usenet', ...best } : null;
  },

  // Send the NZB to the client under our category and return the client's id so
  // the monitor can match it later. Does not wait for the download.
  async grab(candidate, ctx) {
    const client = makeNzbClient(ctx.config, {});
    const downloadId = await client.add(candidate.nzbUrl, { name: candidate.title, category: ctx.config.nzbCategory });
    return { downloadId, client: ctx.config.nzbClient, category: ctx.config.nzbCategory, title: candidate.title, releaseGuid: candidate.guid || null };
  },

  // Multi-result manual search (for the source-search modal). Returns a list of
  // candidates the user can pick from — broad (no strict score filter), so the
  // user sees options the auto-matcher would reject; score is a ranking hint.
  async manualSearch(ctx) {
    const indexers = parseIndexers(ctx.config.newznabIndexers);
    if (!indexers.length) return { results: [] };
    const queries = manualQueries(ctx);
    const target = manualTarget(ctx);
    const byUrl = new Map();
    for (const q of queries) {
      for (const r of await searchNewznab(indexers, q, {})) if (r.nzbUrl && !byUrl.has(r.nzbUrl)) byUrl.set(r.nzbUrl, r);
    }
    const results = [...byUrl.values()]
      .filter((r) => !suspiciouslySmall(r.size))
      .map((r) => ({ source: 'usenet', nzbUrl: r.nzbUrl, title: r.title, size: r.size, meta: r.indexer || 'indexer', score: scoreRelease(r.title, target) }));
    return { results, searched: queries };
  },
};

export { importCompleted };
