// RSS watch: poll the indexers' LATEST-uploads feed (an empty-query search is
// the RSS feed in Newznab/Torznab) and match new items against missing issues
// of followed series — so a fresh upload is grabbed within one poll interval
// instead of waiting for the next scheduled search. This is a bonus channel on
// top of the search lanes: feed quality varies by indexer, so the scheduled
// searches remain the reliable floor.
import { listWantedIssues, seriesSearchNames } from './db.js';
import { normalizeNumber } from './matcher.js';
import { parseReleaseName, normalizeSeries, scoreRelease, suspiciouslySmall } from './sources/usenet.js';

// ---- seen-item dedupe (rss_seen table) --------------------------------------
// Each feed item is considered exactly once, keyed by its guid. Entries expire
// after a week — long past every indexer's feed horizon.
export function initRssTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS rss_seen (
    key TEXT PRIMARY KEY,
    seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  )`);
}

export function unseenItems(db, items) {
  const check = db.prepare('SELECT 1 FROM rss_seen WHERE key=?');
  return items.filter((it) => it.guid && !check.get(String(it.guid)));
}

export function markSeen(db, items) {
  const ins = db.prepare('INSERT OR IGNORE INTO rss_seen (key) VALUES (?)');
  const tx = db.transaction((list) => { for (const it of list) if (it.guid) ins.run(String(it.guid)); });
  tx(items);
  db.prepare("DELETE FROM rss_seen WHERE seen_at < datetime('now', '-7 days')").run();
}

// ---- wanted index -----------------------------------------------------------
// Every missing issue of every FOLLOWED series, indexed by normalized series
// alias → issue number, so each feed item is one parse + one map lookup instead
// of a scan over tens of thousands of wanted rows.
export function buildWantedIndex(db) {
  const { items } = listWantedIssues(db, { followedOnly: true, limit: 100000 });
  const bySeries = new Map(); // series_id → { names, numbers: Map(normNumber → wanted) }
  const index = new Map();    // normalized alias → [series entries]
  for (const it of items) {
    // In-flight rows are left to the queue; parked/failed ones are fair game —
    // a fresh upload is exactly the retry signal they've been waiting for.
    if (it.queue_status && !['pending', 'failed'].includes(it.queue_status)) continue;
    let entry = bySeries.get(it.series_id);
    if (!entry) {
      const names = seriesSearchNames(db, it.series_id);
      if (!names.length) names.push(it.series_title);
      entry = { names, numbers: new Map() };
      bySeries.set(it.series_id, entry);
      for (const n of names) {
        const key = normalizeSeries(n);
        if (!key) continue;
        if (!index.has(key)) index.set(key, []);
        index.get(key).push(entry);
      }
    }
    const norm = normalizeNumber(it.issue_number);
    if (norm !== '') entry.numbers.set(norm, it);
  }
  return index;
}

// ---- matching ---------------------------------------------------------------
// From NEW feed items + the wanted index, the grabs to make: one item per
// wanted issue (first match wins — the feed is newest-first). Each match is
// { item, wanted } where item carries the source ('torrent'/'usenet') and the
// exact release to pin.
export function matchFeedItems(items, index) {
  const matches = [];
  const claimed = new Set(); // one grab per cv issue per run
  for (const item of items) {
    if (suspiciouslySmall(item.size)) continue; // KB-scale fakes
    const p = parseReleaseName(item.title);
    if (!p.series || p.number == null) continue;
    const entries = index.get(normalizeSeries(p.series));
    if (!entries) continue;
    for (const entry of entries) {
      const wanted = entry.numbers.get(p.number);
      if (!wanted || claimed.has(wanted.cv_issue_id)) continue;
      // Final strict validation with the canonical matcher (aliases + number).
      if (scoreRelease(item.title, { series: entry.names[0], names: entry.names, number: wanted.issue_number }) == null) continue;
      claimed.add(wanted.cv_issue_id);
      matches.push({ item, wanted });
      break;
    }
  }
  return matches;
}
