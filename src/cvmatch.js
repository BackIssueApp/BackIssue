import { normalizeTitle, extractYear, normalizeNumber } from './matcher.js';
import { upsertCvSeries, upsertCvIssue, setSeriesCv, seriesNeedingCvMatch, listCvIssues, linkFileCvIssue, getSeriesByCvId, createCvSeries, setFollowed, defaultLibrary, assignSeriesLibrary, getSeriesById, getCvSeries, setSeriesPath } from './db.js';
import { parseIssueFromFilename } from './scanner.js';
import { poolWithResource } from './pool.js';

// A file's issue number: prefer the embedded ComicInfo number, else parse the filename.
function fileIssueNumber(f) {
  const n = f.ci_number || parseIssueFromFilename(f.name);
  return n != null && n !== '' ? normalizeNumber(n) : null;
}

// Match a series' owned files to CV issues by number and record cv_issue_id on
// each. This is what makes the collection roll up against CV's issue list.
export function linkFilesToCv(db, seriesId, cvSeriesId) {
  const byNum = new Map();
  for (const ci of listCvIssues(db, cvSeriesId)) {
    const k = normalizeNumber(ci.issue_number);
    if (k && !byNum.has(k)) byNum.set(k, ci.comicvine_id);
  }
  // Link ALL files (incl. invalid/corrupt ones) by number, so a corrupt copy maps
  // to its CV issue and surfaces as "corrupt" in the detail — not silently missing.
  const files = db.prepare('SELECT path, ci_number, name FROM library_files WHERE series_id=?').all(seriesId);
  let linked = 0;
  for (const f of files) {
    const k = fileIssueNumber(f);
    const cvId = k ? byNum.get(k) : null;
    linkFileCvIssue(db, f.path, cvId ?? null);
    if (cvId) linked++;
  }
  return linked;
}

// Score one CV volume against one of our series. Pure — no network.
// Name is the gate; year and publisher refine confidence.
export function scoreCvCandidate(series, cand) {
  const wn = normalizeTitle(series.title);
  const cn = normalizeTitle(cand.name || '');
  if (!wn || !cn) return { score: 0, reason: 'empty name' };

  let score;
  if (wn === cn) score = 100;
  else if (wn.length > 3 && (cn.includes(wn) || wn.includes(cn))) score = 40;
  else return { score: 0, reason: 'no name match' };

  const sy = series.year ? extractYear(String(series.year)) : null;
  const cy = cand.start_year ? String(cand.start_year) : null;
  let yearNote = 'year unknown';
  if (sy && cy) {
    if (sy === cy) { score += 30; yearNote = 'year match'; }
    else if (Math.abs(Number(sy) - Number(cy)) <= 1) { score += 10; yearNote = 'year ±1'; }
    else { score -= 25; yearNote = 'year differs'; }
  }

  if (series.publisher && cand.publisher) {
    const sp = normalizeTitle(series.publisher), cp = normalizeTitle(cand.publisher);
    if (sp && cp && (sp === cp || sp.includes(cp) || cp.includes(sp))) score += 15;
  }

  return { score, reason: `${wn === cn ? 'exact' : 'partial'} name, ${yearNote}` };
}

// Rank candidates best-first with a confidence label and an auto-accept flag.
// Auto-accept only a confident, clearly-winning match; everything else waits
// for a manual pick so we never silently mislink.
export function rankCandidates(series, candidates) {
  const ranked = (candidates || [])
    .map((cand) => ({ cand, ...scoreCvCandidate(series, cand) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!ranked.length) return { ranked: [], best: null, auto: false };
  const best = ranked[0];
  const margin = best.score - (ranked[1]?.score ?? 0);
  best.confidence = best.score >= 130 ? 'high' : best.score >= 100 ? 'medium' : 'low';
  const auto = best.score >= 130 || (best.score >= 100 && margin >= 30);
  return { ranked, best, auto, margin };
}

// Fetch a ComicVine volume and cache it locally (series metadata + issue stubs).
// THE one fetch+cache step — cacheAndLink, refreshCvVolume, and addSeriesFromCv
// all build on it; don't inline this loop anywhere else.
export async function cacheCvVolume(db, client, cvId) {
  const v = await client.volume(cvId);
  upsertCvSeries(db, v);
  for (const iss of v.issues || []) upsertCvIssue(db, { id: iss.id, cv_series_id: v.id, number: iss.number, name: iss.name });
  return v;
}

// Cache a chosen volume (metadata + issue list) and link the series to it.
export async function cacheAndLink(db, client, seriesId, cvId, { locked = 0 } = {}) {
  const v = await cacheCvVolume(db, client, cvId);
  setSeriesCv(db, seriesId, v.id, { locked });
  linkFilesToCv(db, seriesId, v.id); // link owned files to CV issues so the rollup is CV-based
  return v;
}

// Legacy hook once used to merge monitored CV-only series into a catalog twin
// after a crawl. Now a stable no-op: download sources are resolved on demand and
// never own collection identity, so there is nothing to merge (and merging a
// series that still owns issue rows would be an FK violation). Kept so the
// crawl/update callers don't need to change. Returns 0.
export function autoLinkCvSeries() { return 0; }

// Re-pull a matched comic's volume from ComicVine: refresh its cached metadata
// (name/publisher/year/cover/CV page url) and issue list (picks up newly
// published issues), then re-link owned files. Returns the fresh issue count.
export async function refreshCvVolume(db, client, seriesId) {
  const s = getSeriesById(db, seriesId);
  if (!s || !s.cv_id) return { ok: false, reason: 'not matched to ComicVine' };
  const v = await cacheCvVolume(db, client, s.cv_id);
  linkFilesToCv(db, seriesId, v.id);
  return { ok: true, issues: (v.issues || []).length };
}

// Match one series: search CV, rank, auto-accept a clear winner.
// Returns { status: 'matched'|'ambiguous'|'none', cvId?, confidence?, candidates? }.
export async function matchSeriesToCv(db, client, series) {
  const candidates = await client.search(series.title);
  const { ranked, best, auto } = rankCandidates(series, candidates);
  if (best && auto) {
    await cacheAndLink(db, client, series.id, best.cand.id, { locked: 0 });
    return { status: 'matched', cvId: best.cand.id, confidence: best.confidence };
  }
  if (best) return { status: 'ambiguous', candidates: ranked.slice(0, 5).map((r) => ({ ...r.cand, score: r.score, reason: r.reason })) };
  return { status: 'none', candidates: [] };
}

// Add a series to the collection straight from a ComicVine volume. Always a pure
// ComicVine series; a download source fills it on demand.
export async function addSeriesFromCv(db, client, comicvineId) {
  const v = await cacheCvVolume(db, client, comicvineId);
  const year = v.start_year != null ? String(v.start_year) : null;

  let seriesId, outcome;
  const already = getSeriesByCvId(db, v.id);
  if (already) {
    setFollowed(db, already.id, true);
    seriesId = already.id; outcome = 'existing';
  } else {
    // Always a pure ComicVine series. Download sources are resolved on demand —
    // never the collection identity — so we never adopt/merge a catalog volume
    // here (that legacy behavior misfiled comics onto fuzzy name matches).
    seriesId = createCvSeries(db, { cvId: v.id, title: v.name, publisher: v.publisher, year, coverUrl: v.image_url });
    // Every new series gets a home immediately (first comic library) — callers
    // with a specific destination (the manga lane, import auto-assign)
    // re-assign right after, which overrides this default.
    const home = defaultLibrary(db);
    if (home) { try { assignSeriesLibrary(db, seriesId, home.id); } catch { /* races a delete — boot migration re-homes */ } }
    outcome = 'created';
  }
  linkFilesToCv(db, seriesId, v.id);
  return { seriesId, outcome, cvId: v.id, title: v.name };
}

// One-time migration: convert series that "adopted"/merged a source identity
// (a catalog-URL row carrying a cv_id) into a pure ComicVine series, and demote
// the catalog row back to a plain volume (a download source, not identity).
// Owned files + synthetic CV-issue queue rows move to the CV series; the catalog
// volume keeps its crawled reader-URL issues as the source index.
// Idempotent — once run, no adopted rows remain. Returns { migrated }.
export function migrateAdoptedSeriesToCv(db) {
  const adopted = db.prepare("SELECT * FROM series WHERE cv_id IS NOT NULL AND url NOT LIKE 'cv:%'").all();
  let migrated = 0;
  for (const b of adopted) {
    const cvId = b.cv_id;
    const meta = getCvSeries(db, cvId);
    const cvSeriesId = createCvSeries(db, {
      cvId,
      title: (meta && meta.name) || b.title,
      publisher: (meta && meta.publisher) || b.publisher,
      year: (meta && meta.start_year) || b.year,
      coverUrl: (meta && meta.image_url) || b.cover_url,
    });
    if (cvSeriesId === b.id) continue; // paranoia: never merge into self
    // Owned files + synthetic CV-issue rows belong to the collection identity.
    db.prepare('UPDATE library_files SET series_id=? WHERE series_id=?').run(cvSeriesId, b.id);
    db.prepare("UPDATE issues SET series_id=? WHERE series_id=? AND (url LIKE 'cvissue:%' OR url LIKE 'cv:%')").run(cvSeriesId, b.id);
    if (b.path) setSeriesPath(db, cvSeriesId, b.path);
    setFollowed(db, cvSeriesId, true);
    // Demote the catalog row to a plain volume (keeps its reader-URL issues).
    db.prepare('UPDATE series SET cv_id=NULL, cv_locked=0, followed=0, path=NULL WHERE id=?').run(b.id);
    linkFilesToCv(db, cvSeriesId, cvId);
    migrated++;
  }
  return { migrated };
}

// Match every owned/followed series lacking a (locked) CV id, with progress.
export async function runCvMatch(db, client, { onProgress = () => {}, concurrency = 3 } = {}) {
  const list = seriesNeedingCvMatch(db);
  let done = 0, matched = 0, ambiguous = 0;
  await poolWithResource(
    list, concurrency,
    () => null,
    async (series) => {
      try {
        const r = await matchSeriesToCv(db, client, series);
        if (r.status === 'matched') matched++;
        else if (r.status === 'ambiguous') ambiguous++;
      } catch { /* leave unmatched; a later run or manual pick can retry */ }
      onProgress({ done: ++done, total: list.length, matched, ambiguous });
    },
    () => {},
  );
  // Backfill file→CV-issue linkage for every matched series — this catches
  // series matched before linkage existed and files indexed after a match.
  // Pure DB work, no API calls.
  let relinked = 0;
  for (const s of db.prepare('SELECT id, cv_id FROM series WHERE cv_id IS NOT NULL').all()) {
    try { relinked += linkFilesToCv(db, s.id, s.cv_id); } catch { /* skip */ }
  }
  return { total: list.length, matched, ambiguous, relinked };
}

// Re-fetch FULL detail (dates, summary, credits, enrichment extras) for every
// issue of a matched series — the deep half of "Refresh metadata". One request
// per issue, so callers run it as a background job; a rate-limit error halts
// the sweep instead of hammering on (partial progress is kept — details are
// per-issue and idempotent).
export async function refreshAllIssueDetails(db, client, cvSeriesId, { onProgress = () => {} } = {}) {
  const { setCvIssueDetail } = await import('./db.js');
  const issues = listCvIssues(db, cvSeriesId);
  let done = 0, failed = 0;
  for (const ci of issues) {
    try {
      const d = await client.issue(ci.comicvine_id);
      setCvIssueDetail(db, ci.comicvine_id, {
        cover_date: d.cover_date, store_date: d.store_date,
        description: d.description, credits: d.credits,
        site_detail_url: d.site_detail_url, image_url: d.image_url,
        character_credits: d.character_credits, team_credits: d.team_credits,
        location_credits: d.location_credits, story_arc_credits: d.story_arc_credits,
        associated_images: d.associated_images,
        ...(d.metron !== undefined ? { metron: d.metron } : {}),
      });
    } catch (e) {
      if (e?.rateLimited) return { done, failed, total: issues.length, halted: 'rate limited' };
      failed++;
    }
    done++;
    onProgress({ done, total: issues.length });
  }
  return { done, failed, total: issues.length };
}
