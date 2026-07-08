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

test('matchReleases seeds the ship date as store_date (feeds the new-releases lane)', () => {
  const db = openDb(':memory:');
  const sid = upsertSeries(db, { title: 'Invincible (2003)', url: '/c/inv2' });
  upsertCvSeries(db, { id: 17993, name: 'Invincible' });
  setSeriesCv(db, sid, 17993, { locked: 0 });
  // An existing DATE-LESS stub (how release-seeded issues used to look) and an
  // issue ComicVine already dated.
  upsertCvIssue(db, { id: 5001, cv_series_id: 17993, number: '5', name: 'Five' });
  upsertCvIssue(db, { id: 5002, cv_series_id: 17993, number: '6', name: 'Six', store_date: '2026-01-01' });

  matchReleases(db, [
    { comicid: '17993', issueid: '5001', issue: '5', shipdate: '2026-07-08', series: 'Invincible' },
    { comicid: '17993', issueid: '5002', issue: '6', shipdate: '2026-07-08', series: 'Invincible' },
    { comicid: '17993', issueid: '5003', issue: '7', shipdate: '2026-07-08', series: 'Invincible' }, // brand new
    { comicid: '17993', issueid: '5004', issue: '8', shipdate: 'garbage', series: 'Invincible' },    // bad date → null
  ]);
  const d = (id) => db.prepare('SELECT store_date FROM cv_issues WHERE comicvine_id=?').get(id).store_date;
  assert.equal(d(5001), '2026-07-08', 'date-less stub backfilled from shipdate');
  assert.equal(d(5002), '2026-01-01', 'a real ComicVine date is never overwritten');
  assert.equal(d(5003), '2026-07-08', 'newly seeded issue carries the ship date');
  assert.equal(d(5004), null, 'malformed shipdate stays null');
});
