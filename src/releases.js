import config from './config.js';
import { getCvSeries, getCvIssue, upsertCvIssue } from './db.js';

// Weekly new-release detection. Pulls a Mylar-compatible /newcomics.php list
// (entries are pre-tagged with ComicVine ids) and cross-references it against
// the comics you track — no fuzzy matching, just cv_id lookups.

const UA = 'comic-metadata-client/1.0';

// strftime %U: week of year, Sunday as the first day (00-53). Matches what the
// provider (and Mylar) expects.
export function weekOfYear(date) {
  const y = date.getUTCFullYear();
  const yday = Math.floor((Date.UTC(y, date.getUTCMonth(), date.getUTCDate()) - Date.UTC(y, 0, 1)) / 86400000);
  const week = Math.floor((yday + 7 - date.getUTCDay()) / 7);
  return { week: String(week).padStart(2, '0'), year: String(y) };
}

export function currentWeek(now = new Date()) { return weekOfYear(now); }

// The %U week `delta` weeks away from (week, year). Week 00 starts Jan 1; week
// N≥1 starts at the first Sunday + (N-1) weeks. Same arithmetic as the UI.
export function shiftWeek(week, year, delta) {
  const y = Number(year), w = Number(week);
  const jan1Dow = new Date(Date.UTC(y, 0, 1)).getUTCDay();
  const anchorYday = w === 0 ? 0 : (7 - jan1Dow) % 7 + (w - 1) * 7;
  return weekOfYear(new Date(Date.UTC(y, 0, 1 + anchorYday + delta * 7)));
}

// A release "type" (the provider's series type) that is a collected edition
// rather than a single issue — the Releases view hides these by default.
const COLLECTED = /trade|hard ?cover|omnibus|collect|graphic novel|tpb|paperback|compendium/i;
export const isCollected = (type) => !!type && COLLECTED.test(String(type));

// Fetch the raw release list for a week. Uses the configured proxy if set.
export async function fetchWeeklyReleases({ week, year } = {}, { fetchImpl } = {}) {
  const cur = currentWeek();
  const wk = week ?? cur.week;
  const yr = year ?? cur.year;
  const base = String(config.releaseProviderUrl || 'https://data.backissue.app').replace(/\/+$/, '');
  const url = `${base}/newcomics.php?week=${encodeURIComponent(wk)}&year=${encodeURIComponent(yr)}`;
  const doFetch = fetchImpl || fetch;
  const resp = await doFetch(url, { headers: { 'User-Agent': UA } });
  if (!resp.ok) throw new Error(`release provider HTTP ${resp.status}`);
  const data = await resp.json();
  if (!Array.isArray(data)) throw new Error('unexpected release-provider response (not a list)');
  return { week: wk, year: yr, releases: data };
}

// Enrich the full weekly release list, flagging which entries are comics you
// track (matched to a ComicVine volume). For tracked hits, cache the issue (so
// it shows as missing in the collection) and report ownership. Returns the whole
// list, tracked-first. { releases, total, hits, added }.
export function matchReleases(db, releases, { cache = true } = {}) {
  const tracked = new Map(); // cv volume id -> our series row
  for (const s of db.prepare('SELECT id, cv_id, followed FROM series WHERE cv_id IS NOT NULL').all()) {
    tracked.set(s.cv_id, s);
  }
  const ownedStmt = db.prepare('SELECT 1 FROM library_files WHERE cv_issue_id=? AND valid=1 LIMIT 1');
  const coverStmt = db.prepare('SELECT image_url FROM cv_issues WHERE comicvine_id=? AND image_url IS NOT NULL');
  const out = [];
  let added = 0, hits = 0;
  for (const r of releases || []) {
    const cvId = Number(r.comicid) || null;
    const s = cvId ? tracked.get(cvId) : null;
    const issueId = Number(r.issueid) || null;
    // The feed's `title` is the walksoftly-style FULL name ("Series (2016) #12"),
    // not a story title. Only keep it when it says more than series + number,
    // so it never doubles the series line or gets cached as the issue's name.
    const full = String(r.title || '').replace(/\s+/g, ' ').trim();
    const num = String(r.issue ?? '').trim();
    const story = full && !(num && full.replace(/#\s+/g, '#').endsWith('#' + num)) ? full : null;
    let owned = false, isNew = false;
    // The provider's series type, cover date, volume number and start year —
    // what tells two same-named runs apart and whether this is a collection.
    const kind = r.type ? String(r.type).trim() || null : null;
    const dateOnly = (v) => (/^\d{4}-\d{2}-\d{2}/.test(String(v || '')) ? String(v).slice(0, 10) : null);
    if (s) {
      hits++;
      if (issueId && cache) {
        isNew = !getCvIssue(db, issueId);
        // Carry the provider's ship date into the cache as the store date —
        // it's what makes this issue visible to the new-releases search lane
        // (which filters by release date). upsertCvIssue only backfills a
        // missing date, never overwrites one ComicVine already supplied.
        const ship = /^\d{4}-\d{2}-\d{2}/.test(String(r.shipdate || '')) ? String(r.shipdate).slice(0, 10) : null;
        upsertCvIssue(db, { id: issueId, cv_series_id: cvId, number: r.issue, name: story, store_date: ship });
        if (isNew) added++;
      }
      owned = issueId ? !!ownedStmt.get(issueId) : false;
    }
    const cv = s ? getCvSeries(db, cvId) : null;
    // Cover for the row: the issue's own art when its detail is cached, else
    // the series cover for tracked series. Untracked issues without a cached
    // cover stay null — the UI lazy-loads those via /api/issue/:id on scroll.
    const cover = (issueId && coverStmt.get(issueId)?.image_url) || (cv && cv.image_url) || null;
    out.push({
      cvId, issueId, cover,
      seriesId: s ? s.id : null,
      tracked: !!s,
      series: (cv && cv.name) || r.series || 'Comic',
      publisher: (cv && cv.publisher) || r.publisher || null,
      number: r.issue ?? null,
      title: story,
      type: kind, collected: isCollected(kind),
      coverdate: dateOnly(r.coverdate),
      seriesYear: r.seriesyear != null && String(r.seriesyear) !== '' ? String(r.seriesyear) : null,
      volume: r.volume != null && String(r.volume) !== '' ? String(r.volume) : null,
      shipdate: r.shipdate ?? null,
      owned, isNew,
      followed: s ? !!s.followed : false,
    });
  }
  // Tracked comics float to the top, then alphabetical by publisher/series.
  out.sort((a, b) =>
    (b.tracked - a.tracked) ||
    (a.publisher || '').localeCompare(b.publisher || '') ||
    (a.series || '').localeCompare(b.series || '') ||
    String(a.number).localeCompare(String(b.number)));
  return { releases: out, total: out.length, hits, added };
}
