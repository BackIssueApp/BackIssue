// RSS watch: seen-item dedupe, the wanted index, and feed-item matching.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openDb, upsertSeries, setSeriesCv, setFollowed, upsertCvSeries, upsertCvIssue,
  upsertLibraryFile, linkFileCvIssue, ensureCvIssueRow, setIssueStatus,
} from '../src/db.js';
import { initRssTables, unseenItems, markSeen, buildWantedIndex, matchFeedItems } from '../src/rsswatch.js';

// Followed: Saga (owns #1 of 3 → #2,#3 wanted) and 2000 AD (alias-rich, wants #2491).
// Not followed: X-Men (must never match).
function seed() {
  const db = openDb(':memory:');
  initRssTables(db);
  const saga = upsertSeries(db, { title: 'Saga (2012)', url: 'cv:46568' });
  setSeriesCv(db, saga, 46568, { locked: 0 }); setFollowed(db, saga, 1);
  upsertCvSeries(db, { id: 46568, name: 'Saga', publisher: 'Image', start_year: '2012', count_of_issues: 3 });
  for (let n = 1; n <= 3; n++) upsertCvIssue(db, { id: n, cv_series_id: 46568, number: String(n), name: 'ch' + n });
  upsertLibraryFile(db, { path: '/s1.cbz', dir: '/', name: 's1.cbz', size: 1, mtime: 1, valid: 1, series_id: saga });
  linkFileCvIssue(db, '/s1.cbz', 1);

  const ad = upsertSeries(db, { title: '2000 AD (1977)', url: 'cv:200' });
  setSeriesCv(db, ad, 200, { locked: 0 }); setFollowed(db, ad, 1);
  upsertCvSeries(db, { id: 200, name: '2000 AD', publisher: 'Rebellion', start_year: '1977', count_of_issues: 1, aliases: JSON.stringify(['2000AD']) });
  upsertCvIssue(db, { id: 2491, cv_series_id: 200, number: '2491', name: 'prog' });

  const xm = upsertSeries(db, { title: 'X-Men (1991)', url: 'cv:100' });
  setSeriesCv(db, xm, 100, { locked: 0 }); // NOT followed
  upsertCvSeries(db, { id: 100, name: 'X-Men', publisher: 'Marvel', start_year: '1991', count_of_issues: 1 });
  upsertCvIssue(db, { id: 101, cv_series_id: 100, number: '1', name: 'x' });
  return { db, saga };
}

test('rss dedupe: an item is new once, then seen; old entries prune', () => {
  const { db } = seed();
  const items = [{ guid: 'g1', title: 'a' }, { guid: 'g2', title: 'b' }, { title: 'no guid' }];
  assert.equal(unseenItems(db, items).length, 2, 'guid-less items are never processed');
  markSeen(db, items);
  assert.equal(unseenItems(db, items).length, 0, 'everything considered exactly once');
  // aged entries prune on the next markSeen
  db.prepare("UPDATE rss_seen SET seen_at = datetime('now', '-8 days') WHERE key='g1'").run();
  markSeen(db, []);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM rss_seen').get().n, 1, 'week-old keys pruned');
});

test('matchFeedItems: matches wanted issues of followed series only, via aliases', () => {
  const { db } = seed();
  const index = buildWantedIndex(db);
  const matches = matchFeedItems([
    { guid: 'a', title: 'Saga 002 (2012) (Digital) (Group)', size: 40e6, source: 'torrent', downloadUrl: 'magnet:x' },
    { guid: 'b', title: '2000AD 2491 (2026) (digital)', size: 90e6, source: 'usenet', nzbUrl: 'http://n' },   // alias form
    { guid: 'c', title: 'X-Men 001 (1991)', size: 40e6, source: 'torrent' },                                  // not followed
    { guid: 'd', title: 'Saga 001 (2012)', size: 40e6, source: 'torrent' },                                   // owned
    { guid: 'e', title: 'Amazing Saga 003 (2012)', size: 40e6, source: 'torrent' },                           // wrong series
    { guid: 'f', title: 'Saga 003 (2012) (Digital)', size: 200e3, source: 'torrent' },                        // KB fake
  ], index);
  assert.deepEqual(
    matches.map((m) => `${m.wanted.series_title} #${m.wanted.issue_number} via ${m.item.source}`).sort(),
    ['2000 AD #2491 via usenet', 'Saga #2 via torrent'],
  );
});

test('matchFeedItems: one grab per issue per run; in-flight issues skipped', () => {
  const { db, saga } = seed();
  // Saga #3 is mid-download → not eligible; #2 parked as failed → eligible.
  const id3 = ensureCvIssueRow(db, { seriesId: saga, cvIssueId: 3, number: '3', title: 'ch3' });
  setIssueStatus(db, id3, 'downloading');
  const id2 = ensureCvIssueRow(db, { seriesId: saga, cvIssueId: 2, number: '2', title: 'ch2' });
  setIssueStatus(db, id2, 'failed');
  const index = buildWantedIndex(db);
  const matches = matchFeedItems([
    { guid: 'a', title: 'Saga 002 (2012) (Digital)', size: 40e6, source: 'torrent' },
    { guid: 'b', title: 'Saga 002 (2012) (Digital) (repost)', size: 40e6, source: 'torrent' }, // dup → one grab
    { guid: 'c', title: 'Saga 003 (2012) (Digital)', size: 40e6, source: 'torrent' },          // in-flight → skip
  ], index);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].wanted.cv_issue_id, 2, 'failed issue is fair game; downloading one is not');
});
