import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weekOfYear, fetchWeeklyReleases, matchReleases } from '../src/releases.js';
import { openDb, upsertSeries, upsertCvSeries, upsertCvIssue, setSeriesCv, upsertLibraryFile, linkLibraryFile, linkFileCvIssue, getCvIssue } from '../src/db.js';

test('weekOfYear matches strftime %U (Sunday-based)', () => {
  assert.deepEqual(weekOfYear(new Date(Date.UTC(2026, 6, 1))), { week: '26', year: '2026' });
  assert.deepEqual(weekOfYear(new Date(Date.UTC(2026, 0, 1))), { week: '00', year: '2026' });
  assert.deepEqual(weekOfYear(new Date(Date.UTC(2026, 11, 31))), { week: '52', year: '2026' });
});

test('fetchWeeklyReleases builds the /newcomics.php URL and returns the list', async () => {
  let seen;
  const stub = async (url) => { seen = url; return { ok: true, json: async () => [{ comicid: '1' }] }; };
  const r = await fetchWeeklyReleases({ week: '26', year: '2026' }, { fetchImpl: stub });
  assert.match(seen, /\/newcomics\.php\?week=26&year=2026$/);
  assert.equal(r.week, '26');
  assert.equal(r.releases.length, 1);

  await assert.rejects(() => fetchWeeklyReleases({ week: '1', year: '2026' }, { fetchImpl: async () => ({ ok: false, status: 522 }) }), /HTTP 522/);
  await assert.rejects(() => fetchWeeklyReleases({ week: '1', year: '2026' }, { fetchImpl: async () => ({ ok: true, json: async () => ({}) }) }), /not a list/);
});

test('matchReleases cross-references tracked comics by ComicVine id', () => {
  const db = openDb(':memory:');
  const sid = upsertSeries(db, { title: 'Invincible (2003)', url: '/c/inv', publisher: 'Image' });
  upsertCvSeries(db, { id: 17993, name: 'Invincible', publisher: 'Image Comics' });
  setSeriesCv(db, sid, 17993, { locked: 0 });
  // We own issue #1 (cv issue 1001).
  upsertCvIssue(db, { id: 1001, cv_series_id: 17993, number: '1', name: 'One' });
  upsertLibraryFile(db, { path: '/a.cbz', dir: '/', name: 'a.cbz', size: 1, mtime: 1, valid: 1 });
  linkLibraryFile(db, '/a.cbz', sid, null);
  linkFileCvIssue(db, '/a.cbz', 1001);

  const releases = [
    { comicid: '17993', issueid: '1001', issue: '1', title: 'One', publisher: 'Image', shipdate: '2026-07-01', series: 'Invincible' }, // owned
    { comicid: '17993', issueid: '2002', issue: '9', title: 'Nine', publisher: 'Image', shipdate: '2026-07-01', series: 'Invincible' }, // brand new, missing
    { comicid: '99999', issueid: '3003', issue: '1', title: 'X', publisher: 'Y', shipdate: '2026-07-01', series: 'Other' }, // not tracked
  ];
  const r = matchReleases(db, releases);
  assert.equal(r.total, 3);          // ALL releases are returned
  assert.equal(r.hits, 2);           // two match our tracked series
  assert.equal(r.added, 1);          // #9 was newly cached

  const owned = r.releases.find((m) => m.issueId === 1001);
  assert.equal(owned.tracked, true);
  assert.equal(owned.owned, true);
  assert.equal(owned.series, 'Invincible'); // CV name, not the release's raw series

  const fresh = r.releases.find((m) => m.issueId === 2002);
  assert.equal(fresh.tracked, true);
  assert.equal(fresh.owned, false);
  assert.equal(fresh.isNew, true);
  assert.equal(fresh.seriesId, sid);
  assert.ok(getCvIssue(db, 2002)); // now in the cache → collection shows it as missing

  const untracked = r.releases.find((m) => m.cvId === 99999);
  assert.equal(untracked.tracked, false);
  assert.equal(untracked.seriesId, null);
  assert.equal(untracked.series, 'Other'); // falls back to the release's raw name
  assert.equal(getCvIssue(db, 3003), undefined); // untracked issues are NOT cached

  // tracked comics sort to the top
  assert.ok(r.releases[0].tracked && r.releases[r.releases.length - 1].tracked === false);
});
