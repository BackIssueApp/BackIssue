import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setSeriesAliases, seriesSearchNames, createCvSeries } from '../src/db.js';
import {
  openDb, upsertSeries, upsertIssue, listSeries, listIssues,
  setIssueStatus, queueIssues, getNextQueued, countByStatus, getSeriesTitleById,
  resetDownloading, claimNextQueued, setSeriesComplete, getSeriesById, requeueFailed,
  clearIssuesForRedownload, listQueue, queuedCount,
  setSeriesMeta, getSeriesByUrl, clearFailed,
  setScanOverride, getScanOverride, clearScanOverride,
  upsertLibraryFile, getLibraryFile, listLibraryFiles, libraryStats, pruneLibraryFiles,
  setSeriesRestricted, isSeriesRestricted,
  linkLibraryFile, collectionSeries, seriesCollectionDetail, setFollowed,
  upsertCvSeries, upsertCvIssue, setSeriesCv, linkFileCvIssue, setCvIssueDetail, getCvIssue,
  upsertImportCandidate, listImportCandidates, setImportCandidateMatch, setImportCandidateStatus, readyImportCandidates, clearImportCandidates,
} from '../src/db.js';

test('import candidates: upsert by folder, match, ready set, clear keeps imported', () => {
  const db = openDb(':memory:');
  upsertImportCandidate(db, { folder: '/lib/Saga (2012)', name: 'Saga', year: '2012', file_count: 3, confidence: 'low', status: 'review' });
  upsertImportCandidate(db, { folder: '/lib/Invincible (2003)', name: 'Invincible', year: '2003', file_count: 5, confidence: 'high', status: 'ready' });
  const [c] = listImportCandidates(db).filter((x) => x.name === 'Saga');
  // upsert on the same folder replaces, doesn't duplicate
  upsertImportCandidate(db, { folder: '/lib/Saga (2012)', name: 'Saga', year: '2012', file_count: 4, confidence: 'low', status: 'review' });
  assert.equal(listImportCandidates(db).length, 2);
  // match → ready
  setImportCandidateMatch(db, c.id, { cvId: 18166, cvName: 'Saga', cvYear: '2012' });
  const saga = listImportCandidates(db).find((x) => x.id === c.id);
  assert.equal(saga.cv_id, 18166);
  assert.equal(saga.confidence, 'manual');
  assert.equal(saga.status, 'ready');
  assert.equal(readyImportCandidates(db).length, 2); // Saga + Invincible
  // clear keeps imported rows
  setImportCandidateStatus(db, c.id, 'imported');
  clearImportCandidates(db);
  assert.deepEqual(listImportCandidates(db).map((x) => x.status), ['imported']);
});

test('seriesCollectionDetail flags owned / untagged / corrupt / missing per CV issue', () => {
  const db = openDb(':memory:');
  const s = upsertSeries(db, { title: 'Invincible (2003)', url: 'cv:17993', publisher: 'Image' });
  setSeriesCv(db, s, 17993, { locked: 1 });
  upsertCvSeries(db, { id: 17993, name: 'Invincible', count_of_issues: 4 });
  for (const [id, n] of [[501, '1'], [502, '2'], [503, '3'], [504, '4']]) upsertCvIssue(db, { id, cv_series_id: 17993, number: n, name: 'Iss ' + n });
  // #1 owned + tagged, #2 owned + untagged, #3 corrupt (present but invalid), #4 missing
  upsertLibraryFile(db, { path: '/i1.cbz', dir: '/d', name: 'i1.cbz', size: 1, mtime: 1, valid: 1, has_metadata: 1, series_id: s });
  linkFileCvIssue(db, '/i1.cbz', 501);
  upsertLibraryFile(db, { path: '/i2.cbz', dir: '/d', name: 'i2.cbz', size: 1, mtime: 1, valid: 1, has_metadata: 0, series_id: s });
  linkFileCvIssue(db, '/i2.cbz', 502);
  upsertLibraryFile(db, { path: '/i3.cbz', dir: '/d', name: 'i3.cbz', size: 1, mtime: 1, valid: 0, has_metadata: 0, error: 'entry crc/read failed', series_id: s });
  linkFileCvIssue(db, '/i3.cbz', 503);

  const by = Object.fromEntries(seriesCollectionDetail(db, s).issues.map((i) => [i.number, i]));
  assert.deepEqual([by['1'].owned, by['1'].untagged, by['1'].corrupt], [true, false, false]);
  assert.deepEqual([by['2'].owned, by['2'].untagged, by['2'].corrupt], [true, true, false]);
  assert.deepEqual([by['3'].owned, by['3'].untagged, by['3'].corrupt], [false, false, true]);
  assert.deepEqual([by['4'].owned, by['4'].untagged, by['4'].corrupt], [false, false, false]);
  assert.equal(by['4'].downloadable, true);
  assert.equal(by['3'].downloadable, true); // corrupt is re-downloadable
  assert.equal(by['3'].files[0].error, 'entry crc/read failed'); // corrupt reason surfaced
  // Per-issue files are slim: no path — the UI shows name/size/health only,
  // and paths dominated the JSON payload on 2,000-issue series.
  assert.ok(!('path' in by['1'].files[0]), 'issue files must not carry the full path');
  assert.equal(by['1'].files[0].name, 'i1.cbz');
});

test('setCvIssueDetail caches the cover image url', () => {
  const db = openDb(':memory:');
  upsertCvSeries(db, { id: 20, name: 'Invincible', count_of_issues: 1 });
  upsertCvIssue(db, { id: 201, cv_series_id: 20, number: '1', name: 'One' });
  setCvIssueDetail(db, 201, { image_url: 'https://cv/covers/inv1.jpg', description: 'x' });
  assert.equal(getCvIssue(db, 201).image_url, 'https://cv/covers/inv1.jpg');
});

test('collectionSeries corrupt count: an invalid file superseded by a valid copy is not corrupt', () => {
  const db = openDb(':memory:');
  const s = upsertSeries(db, { title: 'Invincible', url: 'cv:20', publisher: 'Image' });
  setSeriesCv(db, s, 20, { locked: 1 });
  upsertCvSeries(db, { id: 20, name: 'Invincible', count_of_issues: 2 });
  upsertCvIssue(db, { id: 201, cv_series_id: 20, number: '1', name: 'One' });
  upsertCvIssue(db, { id: 202, cv_series_id: 20, number: '2', name: 'Two' });
  // Issue 1: an old corrupt .cbr AND a fresh valid .cbz (re-downloaded) → NOT corrupt.
  upsertLibraryFile(db, { path: '/i1.cbr', dir: '/d', name: 'i1.cbr', size: 1, mtime: 1, valid: 0, series_id: s });
  linkFileCvIssue(db, '/i1.cbr', 201);
  upsertLibraryFile(db, { path: '/i1.cbz', dir: '/d', name: 'i1.cbz', size: 1, mtime: 1, valid: 1, has_metadata: 1, series_id: s });
  linkFileCvIssue(db, '/i1.cbz', 201);
  // Issue 2: only a corrupt copy → still corrupt.
  upsertLibraryFile(db, { path: '/i2.cbr', dir: '/d', name: 'i2.cbr', size: 1, mtime: 1, valid: 0, series_id: s });
  linkFileCvIssue(db, '/i2.cbr', 202);

  const row = collectionSeries(db, {}).find((r) => r.id === s);
  assert.equal(row.corrupt, 1); // only issue 2 — issue 1 has a good copy
});

test('collectionSeries + seriesCollectionDetail: unmatched comics surface no catalog data', () => {
  const db = openDb(':memory:');
  const s = upsertSeries(db, { title: 'Earth X (1999)', url: '/c/ex', publisher: 'M', coverUrl: '' });
  // Catalog issues exist for this series, but with no CV match they must NOT surface.
  const i1 = upsertIssue(db, { seriesId: s, title: 'Earth X #1', issueNumber: '1', url: '/i/1' });
  upsertIssue(db, { seriesId: s, title: 'Earth X #2', issueNumber: '2', url: '/i/2' });
  upsertIssue(db, { seriesId: s, title: 'Earth X #3', issueNumber: '3', url: '/i/3' });
  upsertLibraryFile(db, { path: '/f1.cbz', dir: '/M/Earth X (1999)', name: 'f1.cbz', size: 1, mtime: 1, valid: 1, has_metadata: 1 });
  linkLibraryFile(db, '/f1.cbz', s, i1);
  upsertLibraryFile(db, { path: '/f2.cbz', dir: '/M/Earth X (1999)', name: 'f2.cbz', size: 1, mtime: 1, valid: 1, has_metadata: 0 });
  linkLibraryFile(db, '/f2.cbz', s, null);
  const s2 = upsertSeries(db, { title: 'Batman (2016)', url: '/c/bm', publisher: 'DC', coverUrl: '' });
  setFollowed(db, s2, true);

  const all = collectionSeries(db, {});
  assert.equal(all.length, 2); // Earth X (owned) + Batman (monitored, 0 files)
  const ex = all.find((r) => r.id === s);
  assert.equal(ex.matched, false);
  assert.equal(ex.title, null);            // no catalog title/publisher/cover
  assert.equal(ex.publisher, null);
  assert.equal(ex.folder, 'Earth X (1999)'); // neutral disk folder
  assert.equal(ex.files, 2);
  assert.equal(ex.total, 0);               // no catalog issue rollup
  assert.equal(ex.untagged, 1);            // file-health is still tracked
  assert.equal(collectionSeries(db, { filter: 'problems' }).length, 1); // Earth X has an untagged file
  assert.ok(collectionSeries(db, { filter: 'unmonitored' }).some((r) => r.id === s)); // Earth X not followed

  const d = seriesCollectionDetail(db, s);
  assert.equal(d.source, 'unmatched');
  assert.equal(d.series.title, null);
  assert.equal(d.issues.length, 0);        // no catalog issue list
  assert.equal(d.files.length, 2);
});

test('linkLibraryFile sets/clears series_id/issue_id and upsert preserves the link', () => {
  const db = openDb(':memory:');
  upsertLibraryFile(db, { path: '/a.cbz', dir: '/M/S', name: 'a.cbz', size: 1, mtime: 1, valid: 1 });
  linkLibraryFile(db, '/a.cbz', 7, 42);
  assert.equal(getLibraryFile(db, '/a.cbz').series_id, 7);
  assert.equal(getLibraryFile(db, '/a.cbz').issue_id, 42);
  upsertLibraryFile(db, { path: '/a.cbz', dir: '/M/S', name: 'a.cbz', size: 2, mtime: 2, valid: 1 }); // re-index
  assert.equal(getLibraryFile(db, '/a.cbz').series_id, 7); // link preserved
  linkLibraryFile(db, '/a.cbz', 7, null);
  assert.equal(getLibraryFile(db, '/a.cbz').issue_id, null);
});

test('library_files: upsert/get/list/stats/prune', () => {
  const db = openDb(':memory:');
  const base = { size: 100, mtime: 1, page_count: 20, valid: 1, error: null };
  upsertLibraryFile(db, { path: '/a.cbz', dir: '/M/S', name: 'a.cbz', has_metadata: 1, ci_series: 'S', ...base });
  upsertLibraryFile(db, { path: '/b.cbz', dir: '/M/S', name: 'b.cbz', has_metadata: 0, ...base });
  upsertLibraryFile(db, { path: '/c.cbr', dir: '/M/S', name: 'c.cbr', has_metadata: 0, ...base, valid: 0, error: 'bad' });
  assert.equal(getLibraryFile(db, '/a.cbz').ci_series, 'S');
  assert.equal(listLibraryFiles(db, { filter: 'untagged' }).length, 1); // /b.cbz
  assert.equal(listLibraryFiles(db, { filter: 'corrupt' }).length, 1);  // /c.cbr
  assert.equal(listLibraryFiles(db, { filter: 'cbr' }).length, 1);
  const s = libraryStats(db);
  assert.equal(s.total, 3); assert.equal(s.tagged, 1); assert.equal(s.untagged, 1); assert.equal(s.corrupt, 1); assert.equal(s.cbr, 1);
  assert.equal(pruneLibraryFiles(db, new Set(['/a.cbz'])), 2);
  assert.equal(libraryStats(db).total, 1);
});

test('scan overrides set/get/upsert/clear', () => {
  const db = openDb(':memory:');
  assert.equal(getScanOverride(db, '/lib/X'), undefined);
  setScanOverride(db, '/lib/X', 42);
  assert.equal(getScanOverride(db, '/lib/X'), 42);
  setScanOverride(db, '/lib/X', 99); // upsert same dir
  assert.equal(getScanOverride(db, '/lib/X'), 99);
  assert.equal(clearScanOverride(db, '/lib/X'), 1);
  assert.equal(getScanOverride(db, '/lib/X'), undefined);
});

test('clearFailed resets failed issues to pending and drops the error', () => {
  const db = openDb(':memory:');
  const sid = upsertSeries(db, { title: 'X', url: '/c/x', publisher: '', coverUrl: '' });
  const iid = upsertIssue(db, { seriesId: sid, title: 'X #1', issueNumber: '1', url: '/i/1' });
  setIssueStatus(db, iid, 'failed', { error: 'boom' });
  assert.equal(countByStatus(db).failed, 1);
  assert.equal(clearFailed(db), 1);
  assert.equal(countByStatus(db).failed, undefined);
  assert.equal(countByStatus(db).pending, 1);
});

test('getSeriesByUrl finds a series by url, undefined when absent', () => {
  const db = openDb(':memory:');
  const sid = upsertSeries(db, { title: 'X', url: '/c/x', publisher: 'P', coverUrl: '' });
  assert.equal(getSeriesByUrl(db, '/c/x').id, sid);
  assert.equal(getSeriesByUrl(db, '/c/none'), undefined);
});

test('setSeriesMeta sets year/publisher without clobbering absent fields', () => {
  const db = openDb(':memory:');
  const sid = upsertSeries(db, { title: 'Earth X', url: '/c/ex', publisher: 'OldPub', coverUrl: '' });
  setSeriesMeta(db, sid, { year: '1999', publisher: 'Marvel' });
  let s = getSeriesById(db, sid);
  assert.equal(s.year, '1999');
  assert.equal(s.publisher, 'Marvel');
  setSeriesMeta(db, sid, { writer: 'ignored' }); // no year/publisher -> existing kept
  s = getSeriesById(db, sid);
  assert.equal(s.year, '1999');
  assert.equal(s.publisher, 'Marvel');
});

test('upsertIssue refreshes issue_number on re-crawl (url conflict)', () => {
  const db = openDb(':memory:');
  const sid = upsertSeries(db, { title: 'S', url: '/c/s', publisher: '', coverUrl: '' });
  const id1 = upsertIssue(db, { seriesId: sid, title: 'X #1/2', issueNumber: '1', url: '/i/x' });
  const id2 = upsertIssue(db, { seriesId: sid, title: 'X #1/2', issueNumber: '½', url: '/i/x' });
  assert.equal(id1, id2); // same row updated
  assert.equal(listIssues(db, { seriesId: sid })[0].issue_number, '½');
});

test('clearIssuesForRedownload returns file paths and resets issues to pending', () => {
  const db = openDb(':memory:');
  const sid = upsertSeries(db, { title: 'S', url: '/c/s', publisher: '', coverUrl: '' });
  const i1 = upsertIssue(db, { seriesId: sid, title: 'I1', issueNumber: '1', url: '/i/1' });
  const i2 = upsertIssue(db, { seriesId: sid, title: 'I2', issueNumber: '2', url: '/i/2' });
  setIssueStatus(db, i1, 'done', { filePath: '/x/a.cbz' });
  setIssueStatus(db, i2, 'done', { filePath: '/x/b.cbz' });
  const paths = clearIssuesForRedownload(db, [i1, i2]);
  assert.deepEqual(paths.sort(), ['/x/a.cbz', '/x/b.cbz']);
  const rows = listIssues(db, { seriesId: sid });
  assert.equal(rows.find((r) => r.id === i1).status, 'pending');
  assert.equal(rows.find((r) => r.id === i1).file_path, null);
});

function freshDb() { return openDb(':memory:'); }

test('setSeriesComplete flips the complete flag (defaults to 0)', () => {
  const db = freshDb();
  const sid = upsertSeries(db, { title: 'S', url: '/c/s', publisher: '', coverUrl: '' });
  assert.equal(getSeriesById(db, sid).complete, 0);
  setSeriesComplete(db, sid);
  assert.equal(getSeriesById(db, sid).complete, 1);
});

test('requeueFailed re-queues failed issues and clears their error', () => {
  const db = freshDb();
  const sid = upsertSeries(db, { title: 'S', url: '/c/s', publisher: '', coverUrl: '' });
  const i1 = upsertIssue(db, { seriesId: sid, title: 'I1', issueNumber: '1', url: '/i/i1' });
  const i2 = upsertIssue(db, { seriesId: sid, title: 'I2', issueNumber: '2', url: '/i/i2' });
  setIssueStatus(db, i1, 'failed', { error: 'boom' });
  setIssueStatus(db, i2, 'done', { filePath: '/x.cbz' });
  assert.equal(requeueFailed(db), 1);
  const rows = listIssues(db, { seriesId: sid });
  assert.equal(rows.find((r) => r.id === i1).status, 'queued');
  assert.equal(rows.find((r) => r.id === i1).error, null);
  assert.equal(rows.find((r) => r.id === i2).status, 'done');
});

test('claimNextQueued marks the issue downloading and never returns it twice', () => {
  const db = freshDb();
  const sid = upsertSeries(db, { title: 'S', url: '/c/s', publisher: '', coverUrl: '' });
  const a = upsertIssue(db, { seriesId: sid, title: 'A', issueNumber: '1', url: '/i/a' });
  const b = upsertIssue(db, { seriesId: sid, title: 'B', issueNumber: '2', url: '/i/b' });
  queueIssues(db, [a, b]);
  const first = claimNextQueued(db);
  assert.equal(first.id, a);
  assert.equal(listIssues(db, { seriesId: sid }).find((i) => i.id === a).status, 'downloading');
  const second = claimNextQueued(db);
  assert.equal(second.id, b);
  assert.equal(claimNextQueued(db), undefined);
});

test('upsertSeries is idempotent on url', () => {
  const db = freshDb();
  const a = upsertSeries(db, { title: 'Batman', url: '/c/batman', publisher: 'DC', coverUrl: 'x' });
  const b = upsertSeries(db, { title: 'Batman (2016)', url: '/c/batman', publisher: 'DC', coverUrl: 'y' });
  assert.equal(a, b);
  assert.equal(listSeries(db).length, 1);
});

test('upsertIssue links to series and lists with status pending', () => {
  const db = freshDb();
  const sid = upsertSeries(db, { title: 'Batman', url: '/c/batman', publisher: 'DC', coverUrl: '' });
  const iid = upsertIssue(db, { seriesId: sid, title: 'Batman #1', issueNumber: '1', url: '/i/batman-1' });
  const issues = listIssues(db, { seriesId: sid });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].id, iid);
  assert.equal(issues[0].status, 'pending');
});

test('listSeries search filters by title and reports issue_count', () => {
  const db = freshDb();
  const s1 = upsertSeries(db, { title: 'Batman', url: '/c/batman', publisher: 'DC', coverUrl: '' });
  upsertSeries(db, { title: 'Superman', url: '/c/superman', publisher: 'DC', coverUrl: '' });
  upsertIssue(db, { seriesId: s1, title: 'Batman #1', issueNumber: '1', url: '/i/b1' });
  const hits = listSeries(db, { search: 'bat' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].issue_count, 1);
});

test('queueIssues + getNextQueued + setIssueStatus lifecycle', () => {
  const db = freshDb();
  const sid = upsertSeries(db, { title: 'Batman', url: '/c/batman', publisher: '', coverUrl: '' });
  const i1 = upsertIssue(db, { seriesId: sid, title: 'B1', issueNumber: '1', url: '/i/b1' });
  queueIssues(db, [i1]);
  assert.equal(getNextQueued(db).id, i1);
  setIssueStatus(db, i1, 'done', { filePath: '/x/B1.cbz' });
  assert.equal(getNextQueued(db), undefined);
  assert.equal(countByStatus(db).done, 1);
});

test('queueIssues does not re-queue done issues', () => {
  const db = freshDb();
  const sid = upsertSeries(db, { title: 'S', url: '/c/s', publisher: '', coverUrl: '' });
  const i1 = upsertIssue(db, { seriesId: sid, title: 'I1', issueNumber: '1', url: '/i/i1' });
  setIssueStatus(db, i1, 'done', { filePath: '/x.cbz' });
  queueIssues(db, [i1]);
  assert.equal(listIssues(db, { seriesId: sid })[0].status, 'done');
});

test('getSeriesTitleById returns title for existing series and undefined for missing id', () => {
  const db = freshDb();
  const sid = upsertSeries(db, { title: 'Spider-Man', url: '/c/spider-man', publisher: 'Marvel', coverUrl: '' });
  assert.equal(getSeriesTitleById(db, sid), 'Spider-Man');
  assert.equal(getSeriesTitleById(db, 9999), undefined);
});

test('resetDownloading flips downloading back to pending', () => {
  const db = freshDb();
  const sid = upsertSeries(db, { title: 'S', url: '/c/s', publisher: '', coverUrl: '' });
  const i1 = upsertIssue(db, { seriesId: sid, title: 'I1', issueNumber: '1', url: '/i/i1' });
  setIssueStatus(db, i1, 'downloading');
  resetDownloading(db);
  assert.equal(listIssues(db, { seriesId: sid })[0].status, 'pending');
});

test('listQueue and queuedCount include tagging issues', () => {
  const db = openDb(':memory:');
  const sid = upsertSeries(db, { title: 'S', url: '/c/s', publisher: '', coverUrl: '' });
  const a = upsertIssue(db, { seriesId: sid, title: 'A', issueNumber: '1', url: '/i/1' });
  const b = upsertIssue(db, { seriesId: sid, title: 'B', issueNumber: '2', url: '/i/2' });
  setIssueStatus(db, a, 'tagging', { filePath: '/stage/A.cbz' });
  setIssueStatus(db, b, 'queued');
  const q = listQueue(db);
  assert.ok(q.some((r) => r.id === a && r.status === 'tagging'));
  assert.equal(queuedCount(db), 2); // queued + tagging both count as in-progress
});

test('listQueue shows the ComicVine name for matched series', async () => {
  const db = openDb(':memory:');
  const dbmod = await import('../src/db.js');
  const sid = upsertSeries(db, { title: 'Invincible (2003)', url: '/c/inv', publisher: '', coverUrl: '' });
  const a = upsertIssue(db, { seriesId: sid, title: 'A', issueNumber: '1', url: '/i/1' });
  setIssueStatus(db, a, 'queued');
  assert.equal(listQueue(db)[0].series_title, 'Invincible (2003)'); // unmatched: catalog fallback
  dbmod.upsertCvSeries(db, { id: 17993, name: 'Invincible' });
  dbmod.setSeriesCv(db, sid, 17993, { locked: 0 });
  assert.equal(listQueue(db)[0].series_title, 'Invincible'); // matched: CV name
});


test('seriesSearchNames: title + CV aliases + user aliases, deduped', () => {
  const db = openDb(':memory:');
  upsertCvSeries(db, { id: 19752, name: '2000 AD', aliases: '2000AD' });
  const sid = createCvSeries(db, { cvId: 19752, title: '2000 AD' });
  setSeriesCv(db, sid, 19752, { locked: 0 });
  // Just CV: canonical name + its alias.
  assert.deepEqual(seriesSearchNames(db, sid), ['2000 AD', '2000AD']);
  // User adds another; a dup of the CV alias is ignored (case-insensitive).
  setSeriesAliases(db, sid, '2000AD, Two Thousand AD');
  assert.deepEqual(seriesSearchNames(db, sid), ['2000 AD', '2000AD', 'Two Thousand AD']);
  // Clearing user aliases leaves the CV ones.
  setSeriesAliases(db, sid, '');
  assert.deepEqual(seriesSearchNames(db, sid), ['2000 AD', '2000AD']);
});


test('restricted series: hidden from collection/list/wanted when includeRestricted=false', () => {
  const db = openDb(':memory:');
  const open = upsertSeries(db, { title: 'Bone', url: 'u:bone' });
  const mature = upsertSeries(db, { title: 'Crossed', url: 'u:crossed' });
  // A missing issue on each so they surface in wanted, and are followed.
  setFollowed(db, open, 1);
  setFollowed(db, mature, 1);
  upsertIssue(db, { seriesId: open, issueNumber: '1', title: 'Bone #1', url: 'u:bone1' });
  upsertIssue(db, { seriesId: mature, issueNumber: '1', title: 'Crossed #1', url: 'u:crossed1' });

  // Default: both visible.
  assert.equal(collectionSeries(db, {}).length, 2);
  assert.equal(listSeries(db).length, 2);

  // Flag one mature.
  setSeriesRestricted(db, mature, 1);
  assert.equal(isSeriesRestricted(db, mature), true);
  assert.equal(isSeriesRestricted(db, open), false);

  // Restricted excluded when the caller lacks permission.
  const coll = collectionSeries(db, { includeRestricted: false });
  assert.deepEqual(coll.map((r) => r.id), [open]);
  const list = listSeries(db, { includeRestricted: false });
  assert.deepEqual(list.map((r) => r.id), [open]);

  // But the collection row carries the flag when visible (curators see the badge).
  const withFlag = collectionSeries(db, {}).find((r) => r.id === mature);
  assert.equal(withFlag.restricted, true);

  // Unflag restores visibility.
  setSeriesRestricted(db, mature, 0);
  assert.equal(collectionSeries(db, { includeRestricted: false }).length, 2);
});

test('personal follows are per-user; the monitor flag stays global', async () => {
  const { setUserFollow } = await import('../src/db.js');
  const db = openDb(':memory:');
  const s = upsertSeries(db, { title: 'Saga', url: 'cv:1' });
  setFollowed(db, s, true); // GLOBAL monitor flag (automation)

  // No personal follow yet: both users see followed=0 but monitored=1.
  const a = collectionSeries(db, { userId: 1 }).find((r) => r.id === s);
  assert.equal(a.followed, 0);
  assert.equal(a.monitored, 1);

  // User 1 follows; user 2 doesn't see it.
  setUserFollow(db, 1, s, true);
  assert.equal(collectionSeries(db, { userId: 1 }).find((r) => r.id === s).followed, 1);
  assert.equal(collectionSeries(db, { userId: 2 }).find((r) => r.id === s).followed, 0);

  // The 'followed' filter is personal too.
  assert.equal(collectionSeries(db, { userId: 1, filter: 'followed' }).length, 1);
  assert.equal(collectionSeries(db, { userId: 2, filter: 'followed' }).length, 0);

  // Detail view mirrors it.
  assert.equal(seriesCollectionDetail(db, s, 1).series.followed, 1);
  assert.equal(seriesCollectionDetail(db, s, 2).series.followed, 0);
  assert.equal(seriesCollectionDetail(db, s, 2).series.monitored, 1);

  // A personally-followed but unmonitored, fileless series is still visible
  // to its follower (collection membership includes personal follows).
  const quiet = upsertSeries(db, { title: 'Quiet', url: 'cv:2' });
  setUserFollow(db, 2, quiet, true);
  assert.ok(collectionSeries(db, { userId: 2 }).find((r) => r.id === quiet), 'follower sees it');
  assert.ok(!collectionSeries(db, { userId: 1 }).find((r) => r.id === quiet), 'others do not');

  // Unfollow removes it from the personal list without touching the monitor flag.
  setUserFollow(db, 1, s, false);
  const after = collectionSeries(db, { userId: 1 }).find((r) => r.id === s);
  assert.equal(after.followed, 0);
  assert.equal(after.monitored, 1);
});
