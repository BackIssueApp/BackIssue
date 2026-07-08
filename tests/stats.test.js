import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectionStats } from '../src/stats.js';
import {
  openDb, upsertSeries, setSeriesCv, upsertCvSeries, upsertCvIssue,
  upsertLibraryFile, linkFileCvIssue, recordGrab, setGrabStatus,
} from '../src/db.js';

// A collection: one fully-owned matched series, one half-owned, one unmatched
// (files but no CV link), plus some corrupt/untagged files and grabs.
function seed() {
  const db = openDb(':memory:');

  // Matched, complete: Saga (2 CV issues, both owned + tagged)
  const saga = upsertSeries(db, { title: 'Saga (2012)', url: 'cv:46568' });
  setSeriesCv(db, saga, 46568, { locked: 0 });
  upsertCvSeries(db, { id: 46568, name: 'Saga', publisher: 'Image', start_year: '2012', count_of_issues: 2 });
  upsertCvIssue(db, { id: 1, cv_series_id: 46568, number: '1', name: 'a' });
  upsertCvIssue(db, { id: 2, cv_series_id: 46568, number: '2', name: 'b', has_detail: 1 });
  for (const [i, id] of [[1, 1], [2, 2]]) {
    const p = `/s/saga${i}.cbz`;
    upsertLibraryFile(db, { path: p, dir: '/s', name: `saga${i}.cbz`, size: 1000, mtime: 1, page_count: 20, has_metadata: 1, valid: 1, series_id: saga });
    linkFileCvIssue(db, p, id);
  }

  // Matched, half-owned: X-Men (4 CV issues, 1 owned) — a gap of 3
  const xm = upsertSeries(db, { title: 'X-Men (1991)', url: 'cv:100' });
  setSeriesCv(db, xm, 100, { locked: 0 });
  upsertCvSeries(db, { id: 100, name: 'X-Men', publisher: 'Marvel', start_year: '1991', count_of_issues: 4 });
  for (let n = 1; n <= 4; n++) upsertCvIssue(db, { id: 100 + n, cv_series_id: 100, number: String(n), name: 'x' });
  upsertLibraryFile(db, { path: '/x/xm1.cbz', dir: '/x', name: 'xm1.cbz', size: 2000, mtime: 1, page_count: 30, has_metadata: 0, valid: 1, series_id: xm });
  linkFileCvIssue(db, '/x/xm1.cbz', 101); // owned, but untagged
  // a corrupt file for X-Men (no valid copy of that issue)
  upsertLibraryFile(db, { path: '/x/xm2.cbr', dir: '/x', name: 'xm2.cbr', size: 500, mtime: 1, valid: 0, series_id: xm });

  // Unmatched: files but no CV link
  const un = upsertSeries(db, { title: 'Homemade Scans', url: '/c/home' });
  upsertLibraryFile(db, { path: '/u/h1.cbz', dir: '/u', name: 'h1.cbz', size: 3000, mtime: 1, page_count: 10, has_metadata: 0, valid: 1, series_id: un });

  // Grabs (download activity)
  const gi = recordGrab(db, { issueId: 1, source: 'usenet', title: 'Saga 001' });
  setGrabStatus(db, gi, 'imported', { importedAt: new Date().toISOString() });
  recordGrab(db, { issueId: 2, source: 'usenet', title: 'Saga 002' }); // active
  const gf = recordGrab(db, { issueId: 3, source: 'usenet', title: 'Bad' });
  setGrabStatus(db, gf, 'failed', { error: 'x' });

  return db;
}

test('collectionStats: files, formats, and health totals', () => {
  const s = collectionStats(seed(), { comicvineKeys: 'k1\nk2' });
  assert.equal(s.files.total, 5);      // 4 valid + 1 corrupt
  assert.equal(s.files.valid, 4);
  assert.equal(s.files.corrupt, 1);
  assert.equal(s.files.tagged, 2);     // the two Saga files
  assert.equal(s.files.untagged, 2);   // xm1 + h1
  assert.equal(s.files.bytes, 7500);   // all files: 1000+1000+2000+3000 + 500 corrupt
  assert.equal(s.files.pages, 80);     // 20+20+30+10 (corrupt has no page_count)
  assert.equal(s.files.formats.cbz, 4); // 4 valid files, all .cbz
  assert.equal(s.files.formats.cbr, 0); // xm2.cbr is corrupt → excluded from valid-only format mix
});

test('collectionStats: collection, publishers, owned issues', () => {
  const s = collectionStats(seed(), {});
  assert.equal(s.collection.series, 3);          // saga, xm, unmatched (all have valid files)
  assert.equal(s.collection.ownedIssues, 3);     // saga#1, saga#2, xm#1
  const pubs = Object.fromEntries(s.collection.byPublisher.map((p) => [p.publisher, p]));
  assert.equal(pubs.Image.issues, 2);
  assert.equal(pubs.Marvel.issues, 1);
  assert.ok(pubs.Unmatched.series >= 1);
});

test('collectionStats: completion counts complete/incomplete and biggest gaps', () => {
  const s = collectionStats(seed(), {});
  assert.equal(s.completion.complete, 1);        // Saga
  assert.equal(s.completion.incomplete, 1);      // X-Men
  assert.equal(s.completion.cvIssuesTotal, 6);   // 2 + 4
  assert.equal(s.completion.missingIssues, 3);   // X-Men 4-1
  assert.equal(s.completion.topGaps[0].title, 'X-Men');
  assert.equal(s.completion.topGaps[0].missing, 3);
  assert.ok(Number.isInteger(s.completion.topGaps[0].id)); // series id for the /volume link
});

test('collectionStats: ComicVine cache + key presence + linkage', () => {
  const s = collectionStats(seed(), { comicvineKeys: 'k1' });
  assert.equal(s.comicvine.keys, 1); // 1 = a key is configured, 0 = none
  assert.equal(s.comicvine.volumes, 2);
  assert.equal(s.comicvine.issues, 6);
  assert.equal(s.comicvine.detailed, 1);
  assert.equal(s.comicvine.seriesMatched, 2);
  assert.equal(s.comicvine.seriesUnmatched, 1);
  assert.equal(s.comicvine.filesLinked, 3); // valid + cv_issue_id
});

test('collectionStats: activity grabs totals and zero-filled 14-day series', () => {
  const s = collectionStats(seed(), {});
  assert.equal(s.activity.grabs.imported, 1);
  assert.equal(s.activity.grabs.active, 1);
  assert.equal(s.activity.grabs.failed, 1);
  assert.equal(s.activity.perDay.length, 14);
  assert.equal(s.activity.perDay.reduce((a, d) => a + d.n, 0), 1); // the one imported grab
  assert.equal(s.activity.recent[0].title, 'Saga 001');
});
