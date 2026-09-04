import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openDb, upsertSeries, setSeriesCv, setFollowed, setMonitor, setIssueWants, clearIssuePicks, wantStates, wantedCounts,
  upsertCvSeries, upsertCvIssue, upsertLibraryFile, linkFileCvIssue, ensureCvIssueRow, setIssueStatus, listWantedIssues,
  getSeriesById, seriesCollectionDetail, mergeSeriesRows, createCvSeries, untrackSeries, clearSeriesCv,
} from '../src/db.js';
import { createApp } from '../src/server.js';

// Collection: Saga (monitored, owns #1 of 3) and X-Men (owns a file, not
// monitored, #1 missing); plus an out-of-collection series that must not appear.
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
  upsertLibraryFile(db, { path: '/x9.cbz', dir: '/', name: 'x9.cbz', size: 1, mtime: 1, valid: 1, series_id: xm }); // in the collection via a file, #1 is a GAP but not wanted

  const out = upsertSeries(db, { title: 'Unrelated (2000)', url: 'cv:999' }); // no files, not monitored
  setSeriesCv(db, out, 999, { locked: 0 });
  upsertCvSeries(db, { id: 999, name: 'Unrelated', publisher: 'Z', start_year: '2000', count_of_issues: 1 });
  upsertCvIssue(db, { id: 991, cv_series_id: 999, number: '1', name: 'u' });
  return { db, saga, xm, out };
}

test('wanted = the monitoring policy: only monitored series, owned excluded; gaps scope shows every hole', () => {
  const { db } = seed();
  const w = listWantedIssues(db);
  assert.equal(w.total, 2); // Saga #2, #3 — X-Men owns a file but is not monitored
  assert.deepEqual(w.items.map((i) => `${i.series_title} #${i.issue_number}`), ['Saga #2', 'Saga #3']);
  assert.ok(w.items.every((i) => i.wanted === 1 && i.why === 'policy'));
  // The honest "what's missing" view: collection series' gaps, flagged.
  const g = listWantedIssues(db, { scope: 'gaps' });
  assert.equal(g.total, 3); // + X-Men #1 (Unrelated is not in the collection)
  const flag = Object.fromEntries(g.items.map((i) => [`${i.series_title} #${i.issue_number}`, i.wanted]));
  assert.equal(flag['X-Men #1'], 0);
  assert.equal(flag['Saga #2'], 1);
});

test('legacy followedOnly is a no-op; search, queue status and paging still work', () => {
  const { db, saga } = seed();
  const iid = ensureCvIssueRow(db, { seriesId: saga, cvIssueId: 2, number: '2', title: 'Saga #2' });
  setIssueStatus(db, iid, 'queued');
  const fo = listWantedIssues(db, { followedOnly: true });
  assert.equal(fo.total, 2);
  assert.equal(fo.items[0].queue_status, 'queued');
  assert.equal(listWantedIssues(db, { search: 'x-m' }).total, 0); // not wanted…
  assert.equal(listWantedIssues(db, { search: 'x-m', scope: 'gaps' }).total, 1); // …but a gap
  const page = listWantedIssues(db, { limit: 1, offset: 1 });
  assert.equal(page.items.length, 1);
  assert.equal(page.total, 2);
});

test('policy "new": only issues numbered from the watermark; default watermark = newest known issue', () => {
  const { db, saga } = seed();
  // Saga #2, #3 missing. From #3 on → only #3.
  const r = setMonitor(db, saga, 'new', { from: 3 });
  assert.deepEqual(r, { monitor: 'new', monitor_from: '3', monitored: 1 });
  assert.deepEqual(listWantedIssues(db).items.map((i) => i.issue_number), ['3']);
  // No watermark given → starts at the newest issue ComicVine knows (#3).
  setMonitor(db, saga, 'new');
  assert.equal(getSeriesById(db, saga).monitor_from, '3');
  // A new issue arriving later is wanted with no extra bookkeeping.
  upsertCvIssue(db, { id: 4, cv_series_id: 46568, number: '4', name: 'ch4' });
  assert.deepEqual(listWantedIssues(db).items.map((i) => i.issue_number), ['3', '4']);
  // An issue without a plain number is not wanted under "new" (only by pick or "all").
  upsertCvIssue(db, { id: 5, cv_series_id: 46568, number: 'Annual 1', name: 'annual' });
  assert.ok(!listWantedIssues(db).items.some((i) => i.issue_number === 'Annual 1'));
  setMonitor(db, saga, 'all');
  assert.ok(listWantedIssues(db).items.some((i) => i.issue_number === 'Annual 1'));
  // followed stays in sync for plugins / the apps.
  setMonitor(db, saga, 'none');
  assert.equal(getSeriesById(db, saga).followed, 0);
  assert.equal(listWantedIssues(db).total, 0);
  assert.throws(() => setMonitor(db, saga, 'paused'), /monitor must be one of/);
});

test('picks beat the policy both ways, and only the exceptions are stored', () => {
  const { db, saga, xm } = seed();
  // Cherry-pick X-Men #1 from an unmonitored series.
  assert.equal(setIssueWants(db, xm, [101], true, { reason: 'list:7', userId: 4 }).changed, 1);
  const w = listWantedIssues(db);
  assert.deepEqual(w.items.map((i) => `${i.series_title} #${i.issue_number}`), ['Saga #2', 'Saga #3', 'X-Men #1']);
  const x = w.items.find((i) => i.series_title === 'X-Men');
  assert.equal(x.why, 'pick');
  assert.equal(x.reason, 'list:7');
  // Skip Saga #3 on a fully monitored series.
  assert.equal(setIssueWants(db, saga, [3], false).changed, 1);
  assert.deepEqual(listWantedIssues(db).items.map((i) => `${i.series_title} #${i.issue_number}`), ['Saga #2', 'X-Men #1']);
  // "Want" something the policy already wants stores nothing (no stale row to
  // shadow a later policy change).
  assert.equal(setIssueWants(db, saga, [2], true).changed, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM issue_picks').get().n, 2);
  // Wanting the skipped issue again just removes the skip.
  assert.equal(setIssueWants(db, saga, [3], true).changed, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM issue_picks WHERE series_id=?').get(saga).n, 0);
  // Ids that aren't in the series are ignored; unknown ids too.
  assert.equal(setIssueWants(db, saga, [101, 424242], true).changed, 0);
  // wantStates reports per issue, for a UI to patch its rows.
  assert.deepEqual(wantStates(db, xm, [101]), [{ cv_issue_id: 101, wanted: true, why: 'pick', pick: 'want', reason: 'list:7' }]);
  assert.deepEqual(wantedCounts(db, [saga, xm]), { [saga]: 2, [xm]: 1 });
  // Clearing picks returns to the policy: X-Men wants nothing again.
  assert.equal(clearIssuePicks(db, xm), 1);
  assert.equal(wantedCounts(db, [xm])[xm], undefined);
});

test('an issue that stops being wanted is parked: queued and failed rows go back to pending, in-flight rows finish', () => {
  const { db, saga } = seed();
  const q = ensureCvIssueRow(db, { seriesId: saga, cvIssueId: 2, number: '2', title: 'Saga #2' });
  const f = ensureCvIssueRow(db, { seriesId: saga, cvIssueId: 3, number: '3', title: 'Saga #3' });
  setIssueStatus(db, q, 'queued');
  setIssueStatus(db, f, 'failed');
  db.prepare("UPDATE issues SET error='no source' WHERE id=?").run(f);
  // Skipping #3 parks only #3.
  setIssueWants(db, saga, [3], false);
  assert.equal(db.prepare('SELECT status FROM issues WHERE id=?').get(q).status, 'queued');
  const parked = db.prepare('SELECT status, error FROM issues WHERE id=?').get(f);
  assert.equal(parked.status, 'pending');
  assert.equal(parked.error, null);
  // Unmonitoring the series parks the queued one too — but not a download in progress.
  setIssueStatus(db, q, 'downloading');
  const q2 = ensureCvIssueRow(db, { seriesId: saga, cvIssueId: 3, number: '3', title: 'Saga #3' });
  setIssueWants(db, saga, [3], true); setIssueStatus(db, q2, 'queued');
  setMonitor(db, saga, 'none');
  assert.equal(db.prepare('SELECT status FROM issues WHERE id=?').get(q).status, 'downloading');
  assert.equal(db.prepare('SELECT status FROM issues WHERE id=?').get(q2).status, 'pending');
});

test('series detail carries the policy and per-issue want state', () => {
  const { db, saga } = seed();
  setIssueWants(db, saga, [3], false, { reason: 'manual' });
  const d = seriesCollectionDetail(db, saga);
  assert.equal(d.series.monitor, 'all');
  assert.equal(d.series.monitored, 1);
  assert.equal(d.wanted, 1);
  assert.deepEqual(d.picks, { want: 0, skip: 1 });
  const byNum = Object.fromEntries(d.issues.map((i) => [i.number, i]));
  assert.equal(byNum['1'].wanted, false); // owned
  assert.equal(byNum['2'].wanted, true);
  assert.equal(byNum['2'].why, 'policy');
  assert.equal(byNum['3'].wanted, false);
  assert.equal(byNum['3'].pick, 'skip');
});

test('sorting: newest release first, most wanted first', () => {
  const { db, saga, xm } = seed();
  setMonitor(db, xm, 'all');
  db.prepare("UPDATE cv_issues SET store_date='2024-01-10' WHERE comicvine_id=2").run();
  db.prepare("UPDATE cv_issues SET store_date='2024-03-01' WHERE comicvine_id=101").run();
  const newest = listWantedIssues(db, { sort: 'newest' }).items.map((i) => `${i.series_title} #${i.issue_number}`);
  assert.deepEqual(newest, ['X-Men #1', 'Saga #2', 'Saga #3']); // undated last
  const most = listWantedIssues(db, { sort: 'most' }).items.map((i) => i.series_title);
  assert.deepEqual(most, ['Saga', 'Saga', 'X-Men']);
  const fewest = listWantedIssues(db, { sort: 'fewest' }).items.map((i) => i.series_title);
  assert.deepEqual(fewest, ['X-Men', 'Saga', 'Saga']);
  void saga;
});

test('migration: an old database maps followed to the policy, and a merge keeps the wider policy + picks', () => {
  const { db, saga, xm } = seed();
  // Simulate a pre-policy row: followed=1 but monitor still at the column default.
  db.prepare("UPDATE series SET monitor='none' WHERE id=?").run(saga);
  db.prepare("UPDATE series SET monitor = CASE WHEN followed=1 THEN 'all' ELSE 'none' END").run();
  assert.equal(getSeriesById(db, saga).monitor, 'all');
  assert.equal(getSeriesById(db, xm).monitor, 'none');
  // A newly created CV series is monitored in full.
  const fresh = createCvSeries(db, { cvId: 5555, title: 'Fresh' });
  assert.equal(getSeriesById(db, fresh).monitor, 'all');
  // Merge: keeper unmonitored + dropped 'new' → keeper becomes 'new' with the watermark; picks move.
  const twin = upsertSeries(db, { title: 'X-Men twin', url: 'cv:100-twin' });
  setSeriesCv(db, twin, 100, { locked: 0 });
  setMonitor(db, twin, 'new', { from: 1 });
  setIssueWants(db, twin, [101], false);
  mergeSeriesRows(db, xm, twin);
  const k = getSeriesById(db, xm);
  assert.equal(k.monitor, 'new');
  assert.equal(k.monitor_from, '1');
  assert.equal(db.prepare('SELECT series_id FROM issue_picks WHERE cv_issue_id=101').get().series_id, xm);
});

test('GET /api/wanted serves the paged list; ?followed=1 is the caller\'s ☆ stars; scope + sort are honoured', async () => {
  const { setUserFollow } = await import('../src/db.js');
  const { db, saga } = seed();
  const app = createApp({ db, state: { queue: {} } });
  const s = await new Promise((res) => { const x = app.listen(0, () => res(x)); });
  const base = `http://localhost:${s.address().port}`;
  try {
    const all = await (await fetch(`${base}/api/wanted`)).json();
    assert.equal(all.total, 2);
    assert.equal((await (await fetch(`${base}/api/wanted?scope=gaps`)).json()).total, 3);
    // No stars for this (auth-less) request's user yet → the Following view is empty,
    // even though Saga is monitored.
    assert.equal((await (await fetch(`${base}/api/wanted?followed=1`)).json()).total, 0);
    setUserFollow(db, 0, saga, true);
    assert.equal((await (await fetch(`${base}/api/wanted?followed=1&q=saga`)).json()).total, 2);
    // Policy + picks over the API.
    const m = await (await fetch(`${base}/api/collection/${saga}/monitor`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ monitor: 'new', from: 3 }) })).json();
    assert.deepEqual(m, { monitor: 'new', monitor_from: '3', monitored: 1 });
    assert.equal((await (await fetch(`${base}/api/wanted`)).json()).total, 1);
    const bad = await fetch(`${base}/api/collection/${saga}/monitor`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ monitor: 'paused' }) });
    assert.equal(bad.status, 400);
    // The legacy body still works (the mobile apps send it).
    const legacy = await (await fetch(`${base}/api/collection/${saga}/monitor`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ monitored: false }) })).json();
    assert.equal(legacy.monitor, 'none');
    const w = await (await fetch(`${base}/api/collection/${saga}/wanted`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cvIssueIds: [2], want: true }) })).json();
    assert.equal(w.changed, 1);
    assert.deepEqual(w.issues, [{ cv_issue_id: 2, wanted: true, why: 'pick', pick: 'want', reason: 'manual' }]);
    assert.deepEqual((await (await fetch(`${base}/api/wanted`)).json()).items.map((i) => i.issue_number), ['2']);
    // A manual download of an unwanted issue records a pick, so automation keeps after it.
    await fetch(`${base}/api/collection/${saga}/download`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cvIssueIds: [3] }) });
    assert.deepEqual((await (await fetch(`${base}/api/wanted`)).json()).items.map((i) => i.issue_number), ['2', '3']);
  } finally { s.close(); }
});

test('listWantedIssues: hideUnreleased hides only KNOWN-future cover dates', () => {
  const { db } = seed();
  // Saga #3 gets a future cover date; #2 stays date-less (stub) — only #3 hides.
  db.prepare("UPDATE cv_issues SET cover_date='2099-01-01' WHERE comicvine_id=3").run();
  assert.equal(listWantedIssues(db).total, 2);
  const filtered = listWantedIssues(db, { hideUnreleased: true });
  assert.equal(filtered.total, 1); // #2 (unknown date) still shown — honest filter
  assert.ok(!filtered.items.some((i) => i.issue_number === '3'));
});

test('listWantedIssues: releasedWithinDays = the new-releases lane', () => {
  const { db } = seed();
  const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
  // Saga #2 hit shelves 3 days ago; #3 is 60 days old.
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

test('Following is per-user (☆ stars), not the monitoring policy', async () => {
  const { setUserFollow } = await import('../src/db.js');
  const { db, saga, xm } = seed();
  setMonitor(db, xm, 'all');
  // Monitoring Saga is the automation policy — with no personal star, user 1's Following view is EMPTY.
  assert.equal(listWantedIssues(db, { userFollowedOnly: true, userId: 1 }).items.length, 0);
  // User 1 stars X-Men: their Following shows X-Men's wanted issue only — and the followed badge flags exactly that row.
  setUserFollow(db, 1, xm, true);
  const mine = listWantedIssues(db, { userFollowedOnly: true, userId: 1 });
  assert.deepEqual(mine.items.map((i) => i.series_title), ['X-Men']);
  // Another user's stars don't leak into user 1's view.
  setUserFollow(db, 2, saga, true);
  assert.equal(listWantedIssues(db, { userFollowedOnly: true, userId: 1 }).items.length, 1);
  // The unfiltered view still shows both series, with per-user badges.
  const all = listWantedIssues(db, { userId: 1 });
  const badge = Object.fromEntries(all.items.map((i) => [i.series_title, i.followed]));
  assert.equal(badge['X-Men'], 1);
  assert.equal(badge['Saga'], 0);
});

test('picks never outlive their series or volume: removal, re-match and unmatch drop them', () => {
  const { db, saga, xm } = seed();
  setIssueWants(db, saga, [3], false);          // skip on a monitored series
  setIssueWants(db, xm, [101], true);            // pick on an unmonitored one
  assert.equal(db.prepare('SELECT COUNT(*) n FROM issue_picks').get().n, 2);
  // Removing Saga from the library takes its skip with it — re-adding the
  // volume later must not silently skip #3.
  untrackSeries(db, saga);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM issue_picks WHERE cv_issue_id=3').get().n, 0);
  const again = createCvSeries(db, { cvId: 46568, title: 'Saga' });
  // (its file left with it, so every issue is a gap again — and none is skipped)
  assert.deepEqual(listWantedIssues(db).items.filter((i) => i.series_id === again).map((i) => i.issue_number), ['1', '2', '3']);
  // Fixing X-Men's match to another volume drops picks made for the old one;
  // re-pointing at the same volume keeps them.
  setSeriesCv(db, xm, 100, { locked: 1 });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM issue_picks WHERE series_id=?').get(xm).n, 1);
  setSeriesCv(db, xm, 999, { locked: 1 });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM issue_picks WHERE series_id=?').get(xm).n, 0);
  assert.deepEqual(seriesCollectionDetail(db, xm).picks, { want: 0, skip: 0 });
  // Unmatching clears them too.
  setIssueWants(db, xm, [991], true);
  clearSeriesCv(db, xm);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM issue_picks').get().n, 0);
});

test('the wanted view only walks monitored or picked series (index-able gate)', () => {
  const { db } = seed();
  const plan = db.prepare('EXPLAIN QUERY PLAN SELECT COUNT(*) FROM wanted_issues').all().map((r) => r.detail).join(' | ');
  assert.match(plan, /MULTI-INDEX OR/);
  assert.match(plan, /idx_series_monitor/);
  assert.doesNotMatch(plan, /SCAN series(?! USING)/, 'no full scan of series');
});
