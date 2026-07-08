import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openDb, upsertSeries, setSeriesCv, setFollowed, upsertCvSeries, upsertCvIssue,
  upsertLibraryFile, linkFileCvIssue, ensureCvIssueRow, setIssueStatus, listWantedIssues,
} from '../src/db.js';
import { createApp } from '../src/server.js';

// Collection: Saga (followed, owns #1 of 3) and X-Men (owned-not-followed, owns
// nothing of 1); plus an out-of-collection series that must not appear.
function seed() {
  const db = openDb(':memory:');
  const saga = upsertSeries(db, { title: 'Saga (2012)', url: 'cv:46568' });
  setSeriesCv(db, saga, 46568, { locked: 0 }); setFollowed(db, saga, 1);
  upsertCvSeries(db, { id: 46568, name: 'Saga', publisher: 'Image', start_year: '2012', count_of_issues: 3 });
  for (let n = 1; n <= 3; n++) upsertCvIssue(db, { id: n, cv_series_id: 46568, number: String(n), name: 'ch' + n });
  upsertLibraryFile(db, { path: '/s1.cbz', dir: '/', name: 's1.cbz', size: 1, mtime: 1, valid: 1, series_id: saga });
  linkFileCvIssue(db, '/s1.cbz', 1); // owns #1 → #2, #3 wanted

  const xm = upsertSeries(db, { title: 'X-Men (1991)', url: 'cv:100' });
  setSeriesCv(db, xm, 100, { locked: 0 });
  upsertCvSeries(db, { id: 100, name: 'X-Men', publisher: 'Marvel', start_year: '1991', count_of_issues: 1 });
  upsertCvIssue(db, { id: 101, cv_series_id: 100, number: '1', name: 'x' });
  upsertLibraryFile(db, { path: '/x9.cbz', dir: '/', name: 'x9.cbz', size: 1, mtime: 1, valid: 1, series_id: xm }); // in collection via a file, #1 unlinked → wanted

  const out = upsertSeries(db, { title: 'Unrelated (2000)', url: 'cv:999' }); // no files, not followed
  setSeriesCv(db, out, 999, { locked: 0 });
  upsertCvSeries(db, { id: 999, name: 'Unrelated', publisher: 'Z', start_year: '2000', count_of_issues: 1 });
  upsertCvIssue(db, { id: 991, cv_series_id: 999, number: '1', name: 'u' });
  return { db, saga, xm };
}

test('listWantedIssues: missing issues of collection series only, owned excluded', () => {
  const { db } = seed();
  const w = listWantedIssues(db);
  assert.equal(w.total, 3); // Saga #2, #3 + X-Men #1 (Unrelated excluded)
  assert.deepEqual(w.items.map((i) => `${i.series_title} #${i.issue_number}`), ['Saga #2', 'Saga #3', 'X-Men #1']);
});

test('listWantedIssues: followedOnly + search + queue status + paging', () => {
  const { db, saga } = seed();
  // Queue Saga #2 → its wanted row carries the status.
  const iid = ensureCvIssueRow(db, { seriesId: saga, cvIssueId: 2, number: '2', title: 'Saga #2' });
  setIssueStatus(db, iid, 'queued');
  const fo = listWantedIssues(db, { followedOnly: true });
  assert.equal(fo.total, 2); // only Saga (followed)
  assert.equal(fo.items[0].queue_status, 'queued');
  const q = listWantedIssues(db, { search: 'x-m' });
  assert.equal(q.total, 1);
  assert.equal(q.items[0].series_title, 'X-Men');
  const page = listWantedIssues(db, { limit: 1, offset: 1 });
  assert.equal(page.items.length, 1);
  assert.equal(page.total, 3);
});

test('GET /api/wanted serves the paged wanted list', async () => {
  const { db } = seed();
  const app = createApp({ db, state: { queue: {} } });
  const s = await new Promise((res) => { const x = app.listen(0, () => res(x)); });
  const base = `http://localhost:${s.address().port}`;
  const all = await (await fetch(`${base}/api/wanted`)).json();
  assert.equal(all.total, 3);
  const fo = await (await fetch(`${base}/api/wanted?followed=1&q=saga`)).json();
  assert.equal(fo.total, 2);
  s.close();
});

test('listWantedIssues: hideUnreleased hides only KNOWN-future cover dates', () => {
  const { db, saga } = seed();
  void saga;
  // Saga #3 gets a future cover date; #2 stays date-less (stub) — only #3 hides.
  db.prepare("UPDATE cv_issues SET cover_date='2099-01-01' WHERE comicvine_id=3").run();
  const all = listWantedIssues(db);
  assert.equal(all.total, 3);
  const filtered = listWantedIssues(db, { hideUnreleased: true });
  assert.equal(filtered.total, 2); // #2 (unknown date) still shown — honest filter
  assert.ok(!filtered.items.some((i) => i.issue_number === '3' && i.series_title === 'Saga'));
});

test('listWantedIssues: releasedWithinDays = the new-releases lane', () => {
  const { db } = seed();
  const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
  // Saga #2 hit shelves 3 days ago; #3 is 60 days old; X-Men #1 has no date.
  db.prepare('UPDATE cv_issues SET store_date=? WHERE comicvine_id=2').run(daysAgo(3));
  db.prepare('UPDATE cv_issues SET store_date=? WHERE comicvine_id=3').run(daysAgo(60));
  const recent = listWantedIssues(db, { releasedWithinDays: 14 });
  assert.equal(recent.total, 1, 'only the 3-day-old release is "recent"');
  assert.equal(recent.items[0].issue_number, '2');

  // store_date beats a future cover date (cover dates run weeks ahead).
  db.prepare("UPDATE cv_issues SET cover_date='2099-01-01' WHERE comicvine_id=2").run();
  assert.equal(listWantedIssues(db, { releasedWithinDays: 14 }).total, 1, 'still recent via store_date');

  // A future store date is NOT recent (not out yet).
  db.prepare("UPDATE cv_issues SET store_date='2099-01-01' WHERE comicvine_id=2").run();
  assert.equal(listWantedIssues(db, { releasedWithinDays: 14 }).total, 0);
});
