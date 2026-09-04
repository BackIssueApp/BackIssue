import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setSeriesAliases, seriesSearchNames, createCvSeries, mergeSeriesRows } from '../src/db.js';
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

test('pruneLibraryFiles with `only`: a scan never deletes rows for file types it does not walk', () => {
  const db = openDb(':memory:');
  const base = { size: 1, mtime: 1, valid: 1 };
  upsertLibraryFile(db, { path: '/a.cbz', dir: '/M/S', name: 'a.cbz', ...base });
  upsertLibraryFile(db, { path: '/b.cbz', dir: '/M/S', name: 'b.cbz', ...base });
  upsertLibraryFile(db, { path: '/shelf/book.epub', dir: '/shelf', name: 'book.epub', ...base });
  // A comic walk saw only /a.cbz: the other comic is pruned, the ebook row —
  // owned by another indexer — is untouched even though the walk never saw it.
  assert.equal(pruneLibraryFiles(db, new Set(['/a.cbz']), /\.(cbz|cbr)$/i), 1);
  assert.ok(getLibraryFile(db, '/shelf/book.epub'), 'plugin-owned row survives');
  assert.ok(!getLibraryFile(db, '/b.cbz'));
});

test('self-described series: rendered from their own columns, never "unmatched", deleted whole', async () => {
  const { SELF_DESCRIBED_TYPES, SERIES_TYPES, seriesMatchesFilter, untrackSeries } = await import('../src/db.js');
  if (!SERIES_TYPES.includes('ebook')) SERIES_TYPES.push('ebook');
  SELF_DESCRIBED_TYPES.add('ebook'); // what registerLibraryType({ selfDescribed: true }) does
  const db = openDb(':memory:');
  const s = upsertSeries(db, { title: 'Dune', url: 'ebook:l1:b:dune~frank-herbert', publisher: 'Frank Herbert' });
  db.prepare("UPDATE series SET type='ebook', description='Spice.', year='1965' WHERE id=?").run(s);
  const i = upsertIssue(db, { seriesId: s, title: 'Dune', issueNumber: '1', url: 'ebookfile:/shelf/dune.epub' });
  db.prepare("UPDATE issues SET status='done' WHERE id=?").run(i);
  upsertLibraryFile(db, { path: '/shelf/dune.epub', dir: '/shelf', name: 'dune.epub', size: 9, mtime: 1, valid: 1, has_metadata: 1 });
  linkLibraryFile(db, '/shelf/dune.epub', s, i);

  // The Library grid row: matched + local, own title/byline, own rollup.
  const row = collectionSeries(db, {}).find((r) => r.id === s);
  assert.equal(row.source, 'local');
  assert.equal(row.matched, true);
  assert.equal(row.title, 'Dune');
  assert.equal(row.publisher, 'Frank Herbert');
  assert.deepEqual([row.total, row.owned, row.missing], [1, 1, 0]);
  assert.ok(seriesMatchesFilter(row, 'ebook'), 'its own type lane');
  assert.ok(!seriesMatchesFilter(row, 'unmatched'), 'self-described is never unmatched');

  // The series page: local issues in the CV shape, description included.
  const det = seriesCollectionDetail(db, s);
  assert.equal(det.source, 'local');
  assert.equal(det.series.description, 'Spice.');
  assert.deepEqual(det.issues.map((x) => [x.number, x.owned, x.downloadable, x.cv_issue_id]), [['1', true, false, null]]);

  // Removing from the library deletes the whole row set (the plugin's scan
  // re-creates it if the file remains) — no orphan series/issue rows.
  untrackSeries(db, s);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM series').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM issues').get().n, 0);
});

// Helpers for the on-demand ebook tests: a file-less remote book has a series +
// an issue row but NO library_files row (it downloads on first open); an owned
// book additionally has a valid linked file.
function seedEbookType() {
  return import('../src/db.js').then((m) => {
    if (!m.SERIES_TYPES.includes('ebook')) m.SERIES_TYPES.push('ebook');
    m.SELF_DESCRIBED_TYPES.add('ebook');
    return m;
  });
}
function addRemoteBook(db, { title, author = 'Some Author', libraryId = null }) {
  const url = `ebook:l1:b:${title.toLowerCase().replace(/\s+/g, '-')}`;
  const sid = upsertSeries(db, { title, url, publisher: author });
  db.prepare("UPDATE series SET type='ebook', library_id=? WHERE id=?").run(libraryId, sid);
  const iid = upsertIssue(db, { seriesId: sid, title, issueNumber: '1', url: `ebookremote:src:${title}` });
  db.prepare("UPDATE issues SET status='done', file_path=NULL WHERE id=?").run(iid);
  return { sid, iid };
}
function addOwnedBookIssue(db, sid, { title, path }) {
  const iid = upsertIssue(db, { seriesId: sid, title, issueNumber: '2', url: `ebookfile:${path}` });
  db.prepare("UPDATE issues SET status='done', file_path=? WHERE id=?").run(path, iid);
  upsertLibraryFile(db, { path, dir: '/shelf', name: title, size: 9, mtime: 1, valid: 1, has_metadata: 1 });
  linkLibraryFile(db, path, sid, iid);
  return iid;
}

test('on-demand ebooks: file-less self-described series is visible + available, not missing', async () => {
  const { collectionSeries, seriesMatchesFilter } = await seedEbookType();
  const db = openDb(':memory:');
  const { sid } = addRemoteBook(db, { title: 'Neuromancer' });

  // Visibility: a file-less, un-followed self-described series still shows up.
  const row = collectionSeries(db, {}).find((r) => r.id === sid);
  assert.ok(row, 'file-less on-demand ebook appears in the collection');
  assert.equal(row.matched, true);
  assert.equal(row.source, 'local');
  // Rollup: 1 issue, 0 owned, 1 available, 0 missing — available, NOT missing.
  assert.deepEqual([row.total, row.owned, row.available, row.missing], [1, 0, 1, 0]);
  assert.equal(row.on_demand, true);

  // Filter chips: it is in its own type lane, is NOT incomplete (missing===0),
  // is NOT a "problem", is NOT unmatched.
  assert.ok(seriesMatchesFilter(row, 'ebook'), 'in its ebook lane');
  assert.ok(!seriesMatchesFilter(row, 'incomplete'), 'available is not incomplete');
  assert.ok(!seriesMatchesFilter(row, 'problems'), 'no problems');
  assert.ok(!seriesMatchesFilter(row, 'unmatched'), 'never unmatched');
  assert.equal(collectionSeries(db, { filter: 'incomplete' }).find((r) => r.id === sid), undefined);
});

test('on-demand ebooks: a mixed series (some owned, some on-demand) rolls up correctly', async () => {
  const { collectionSeries } = await seedEbookType();
  const db = openDb(':memory:');
  // A calibre-style series: issue 1 is file-less/remote, issue 2 is owned.
  const { sid } = addRemoteBook(db, { title: 'Dune Saga' });
  addOwnedBookIssue(db, sid, { title: 'Dune Messiah', path: '/shelf/dune-messiah.epub' });

  const row = collectionSeries(db, {}).find((r) => r.id === sid);
  assert.deepEqual([row.total, row.owned, row.available, row.missing], [2, 1, 1, 0]);
  assert.equal(row.on_demand, true, 'still has an available book');
  assert.equal(row.files, 1, 'one file on disk');
});

test('on-demand ebooks: an all-owned self-described series is complete, not on-demand', async () => {
  const { collectionSeries } = await seedEbookType();
  const db = openDb(':memory:');
  const sid = upsertSeries(db, { title: 'Foundation', url: 'ebook:l1:b:foundation', publisher: 'Asimov' });
  db.prepare("UPDATE series SET type='ebook' WHERE id=?").run(sid);
  addOwnedBookIssue(db, sid, { title: 'Foundation', path: '/shelf/foundation.epub' });

  const row = collectionSeries(db, {}).find((r) => r.id === sid);
  assert.deepEqual([row.total, row.owned, row.available, row.missing], [1, 1, 0, 0]);
  assert.equal(row.on_demand, false);
});

test('collectionPage: fused counts match the list for every chip and are filter-independent', async () => {
  const { collectionPage, collectionSeries, collectionCounts } = await seedEbookType();
  const db = openDb(':memory:');
  // Two on-demand ebooks, one owned ebook, one incomplete comic, one followed comic.
  addRemoteBook(db, { title: 'Book A' });
  addRemoteBook(db, { title: 'Book B' });
  const owned = upsertSeries(db, { title: 'Book C', url: 'ebook:l1:b:c', publisher: 'X' });
  db.prepare("UPDATE series SET type='ebook' WHERE id=?").run(owned);
  addOwnedBookIssue(db, owned, { title: 'Book C', path: '/shelf/c.epub' });
  // A CV comic with a missing issue (incomplete) and a follow.
  const cvid = 555;
  const { upsertCvSeries, upsertCvIssue, setSeriesCv, setFollowed } = await import('../src/db.js');
  upsertCvSeries(db, { id: cvid, name: 'Saga', publisher: 'Image', start_year: 2012 });
  upsertCvIssue(db, { id: 9001, cv_series_id: cvid, issue_number: '1' });
  upsertCvIssue(db, { id: 9002, cv_series_id: cvid, issue_number: '2' });
  const comic = upsertSeries(db, { title: 'Saga', url: '/c/saga', publisher: 'Image' });
  setSeriesCv(db, comic, cvid);
  setFollowed(db, comic, 1);

  const keys = ['all', 'incomplete', 'followed', 'unmonitored', 'problems', 'unmatched', 'manga'];
  const page = collectionPage(db, { filter: 'all', keys });
  const all = collectionSeries(db, { filter: 'all' });

  // rows for filter=all == the full mapped set.
  assert.equal(page.rows.length, all.length);
  // Every chip count equals the independently-filtered list length.
  for (const k of keys) {
    const listLen = k === 'all' ? all.length : collectionSeries(db, { filter: k }).length;
    assert.equal(page.counts[k], listLen, `count[${k}] matches the list`);
  }
  // The standalone counts endpoint agrees with the fused counts.
  assert.deepEqual(collectionCounts(db, { keys }), page.counts);

  // Counts are independent of the active filter: asking for a narrow filter
  // returns fewer rows but identical counts.
  const narrow = collectionPage(db, { filter: 'incomplete', keys });
  assert.deepEqual(narrow.counts, page.counts, 'counts do not depend on the active filter');
  assert.equal(narrow.rows.length, page.counts.incomplete, 'rows honor the active filter');
  // The two on-demand ebooks never count as incomplete.
  assert.equal(page.counts.incomplete, 1, 'only the comic is incomplete');
});

test('collectionSeries: comic + manga rows keep their exact field shape (no ebook fields leak in)', async () => {
  await seedEbookType();
  const db = openDb(':memory:');
  // Owned comic (unmatched — no cv_id) and a followed manga.
  const comic = upsertSeries(db, { title: 'Local Comic', url: '/c/lc', publisher: 'Indie' });
  const iid = upsertIssue(db, { seriesId: comic, title: 'LC #1', issueNumber: '1', url: '/i/lc1' });
  upsertLibraryFile(db, { path: '/lib/lc/1.cbz', dir: '/lib/lc', name: '1.cbz', size: 5, mtime: 1, valid: 1, has_metadata: 1 });
  linkLibraryFile(db, '/lib/lc/1.cbz', comic, iid);
  const manga = upsertSeries(db, { title: 'Berserk', url: 'cv:1', publisher: 'Dark Horse' });
  db.prepare("UPDATE series SET type='manga', followed=1 WHERE id=?").run(manga);

  const rows = collectionSeries(db, {});
  const c = rows.find((r) => r.id === comic);
  const m = rows.find((r) => r.id === manga);
  // Comic rows carry the new fields defaulted (available/on_demand) but stay 0/false.
  assert.equal(c.available, 0);
  assert.equal(c.on_demand, false);
  assert.equal(c.type, 'comic');
  assert.equal(m.type, 'manga');
  assert.equal(m.available, 0);
  assert.equal(m.on_demand, false);
  // Exact key set is stable (guards against accidental shape drift).
  const keyset = Object.keys(c).sort().join(',');
  assert.equal(keyset, ['active', 'available', 'corrupt', 'cover_url', 'cv_id', 'cv_locked', 'files', 'folder', 'followed', 'id', 'latest', 'matched', 'missing', 'monitored', 'on_demand', 'owned', 'publisher', 'restricted', 'size', 'source', 'sourced', 'title', 'total', 'type', 'untagged', 'year'].join(','));
});

test('collectionSeries: search, sort and library filter still work with on-demand ebooks mixed in', async () => {
  const { collectionSeries, createLibrary, assignSeriesLibrary } = await seedEbookType();
  const db = openDb(':memory:');
  const lib = createLibrary(db, { name: 'Books', type: 'ebook' }); // assignment keeps members' ebook type
  const { sid: a } = addRemoteBook(db, { title: 'Alpha' });
  const { sid: z } = addRemoteBook(db, { title: 'Zeta' });
  assignSeriesLibrary(db, a, lib);

  // Search matches the self-described title.
  const found = collectionSeries(db, { search: 'Alph' });
  assert.equal(found.length, 1);
  assert.equal(found[0].id, a);

  // Title sort orders the two books A→Z.
  const titles = collectionSeries(db, { sort: 'title' }).map((r) => r.title);
  assert.ok(titles.indexOf('Alpha') < titles.indexOf('Zeta'));

  // Library lane returns only the assigned member.
  const inLib = collectionSeries(db, { library: lib });
  assert.equal(inLib.length, 1);
  assert.equal(inLib[0].id, a);
  assert.equal(collectionSeries(db, { library: lib }).some((r) => r.id === z), false);
});

// ---- Server-side pagination: collectionPage(limit/offset) parity vs the
// JS-filtered full scan, across a mixed comic + manga + ebook fixture. ----

// A diverse collection touching every filter-chip predicate branch. Returns the
// module + db + a map of labelled series ids so tests can assert membership.
async function seedMixedCollection() {
  const m = await seedEbookType();
  const { openDb, upsertSeries, upsertIssue, upsertLibraryFile, linkLibraryFile,
    upsertCvSeries, upsertCvIssue, setSeriesCv, linkFileCvIssue, setFollowed,
    setUserFollow, setSeriesRestricted } = m;
  const db = openDb(':memory:');
  const ids = {};
  let cvSeq = 7000, cvIssueSeq = 70000, fileSeq = 0;

  // A CV-matched comic/manga with `total` CV issues and `owned` valid+linked files.
  function cvSeries({ title, type = 'comic', total, owned, monitored = false, restricted = false }) {
    const cvId = ++cvSeq;
    upsertCvSeries(db, { id: cvId, name: title, publisher: 'Pub', start_year: 2000 });
    const cvIssueIds = [];
    for (let i = 1; i <= total; i++) { const cid = ++cvIssueSeq; upsertCvIssue(db, { id: cid, cv_series_id: cvId, issue_number: String(i) }); cvIssueIds.push(cid); }
    const sid = upsertSeries(db, { title, url: '/c/' + title, publisher: 'Pub' });
    if (type !== 'comic') db.prepare('UPDATE series SET type=? WHERE id=?').run(type, sid);
    setSeriesCv(db, sid, cvId);
    for (let i = 0; i < owned; i++) {
      const p = `/lib/${title}/${i}.cbz`;
      upsertLibraryFile(db, { path: p, dir: `/lib/${title}`, name: `${i}.cbz`, size: 5, mtime: 1, valid: 1, has_metadata: 1 });
      linkLibraryFile(db, p, sid, null);
      linkFileCvIssue(db, p, cvIssueIds[i]);
    }
    if (monitored) setFollowed(db, sid, 1);
    if (restricted) setSeriesRestricted(db, sid, true);
    return sid;
  }
  // An unmatched comic/manga: a folder of files, no CV link. untagged/corrupt drive "problems".
  function unmatched({ title, type = 'comic', untagged = false, corrupt = false }) {
    const sid = upsertSeries(db, { title, url: '/c/' + title });
    if (type !== 'comic') db.prepare('UPDATE series SET type=? WHERE id=?').run(type, sid);
    const good = `/lib/${title}/good-${++fileSeq}.cbz`;
    upsertLibraryFile(db, { path: good, dir: `/lib/${title}`, name: 'good.cbz', size: 5, mtime: 1, valid: 1, has_metadata: untagged ? 0 : 1 });
    linkLibraryFile(db, good, sid, null);
    if (corrupt) { const bad = `/lib/${title}/bad-${++fileSeq}.cbz`; upsertLibraryFile(db, { path: bad, dir: `/lib/${title}`, name: 'bad.cbz', size: 1, mtime: 1, valid: 0 }); linkLibraryFile(db, bad, sid, null); }
    return sid;
  }

  ids.comicIncomplete = cvSeries({ title: 'Alpha Comic', total: 4, owned: 1, monitored: true });   // incomplete, monitored, comics
  ids.comicComplete = cvSeries({ title: 'Bravo Comic', total: 2, owned: 2 });                        // complete, unmonitored, comics
  ids.comicUntagged = unmatched({ title: 'Charlie Comic', untagged: true });                          // unmatched + problems, comics
  ids.comicCorrupt = unmatched({ title: 'Delta Comic', corrupt: true });                              // unmatched + problems(corrupt)
  ids.mangaIncomplete = cvSeries({ title: 'Echo Manga', type: 'manga', total: 3, owned: 1 });         // manga + incomplete (owned<total)
  ids.mangaUnmatched = unmatched({ title: 'Foxtrot Manga', type: 'manga' });                          // manga + unmatched
  ids.comicRestricted = cvSeries({ title: 'Golf Comic', total: 2, owned: 0, monitored: true, restricted: true }); // mature member — hidden without perm

  // Ebooks (self-described): one fully owned, two on-demand (file-less).
  const eOwned = upsertSeries(db, { title: 'Hotel Ebook', url: 'ebook:l1:b:hotel', publisher: 'Auth' });
  db.prepare("UPDATE series SET type='ebook' WHERE id=?").run(eOwned);
  { const p = '/shelf/hotel.epub'; const iid = upsertIssue(db, { seriesId: eOwned, title: 'Hotel', issueNumber: '1', url: 'ebookfile:' + p }); db.prepare("UPDATE issues SET status='done' WHERE id=?").run(iid); upsertLibraryFile(db, { path: p, dir: '/shelf', name: 'hotel.epub', size: 9, mtime: 1, valid: 1, has_metadata: 1 }); linkLibraryFile(db, p, eOwned, iid); }
  ids.ebookOwned = eOwned;
  ids.ebookOnDemandA = addRemoteBook(db, { title: 'India Ebook' }).sid;
  ids.ebookOnDemandB = addRemoteBook(db, { title: 'Juliet Ebook' }).sid;

  // User 1 personally follows two of them (the per-user ☆).
  setUserFollow(db, 1, ids.comicIncomplete, true);
  setUserFollow(db, 1, ids.ebookOnDemandA, true);

  return { m, db, ids };
}

// Walk every page of collectionPage for one filter, returning the ordered ids.
function pageAllIds(collectionPage, db, opts, pageSize = 2) {
  const out = []; let offset = 0;
  for (;;) {
    const { rows } = collectionPage(db, { ...opts, keys: [], limit: pageSize, offset });
    for (const r of rows) out.push(r.id);
    if (rows.length < pageSize) break;
    offset += pageSize;
  }
  return out;
}

const MIX_FILTERS = ['all', 'incomplete', 'followed', 'unmonitored', 'problems', 'unmatched', 'comics', 'manga', 'ebook'];

test('collectionPage: every filter predicate matches the JS seriesMatchesFilter membership (mixed fixture)', async () => {
  const { m, db } = await seedMixedCollection();
  const { collectionPage, collectionSeries } = m;
  for (const filter of MIX_FILTERS) {
    const jsIds = collectionSeries(db, { filter, userId: 1 }).map((r) => r.id).sort((a, b) => a - b);
    const sqlIds = pageAllIds(collectionPage, db, { filter, userId: 1 }).slice().sort((a, b) => a - b);
    assert.deepEqual(sqlIds, jsIds, `filter "${filter}" membership must match the JS filter`);
    // No dup/skip: a single big page returns the same set with no repeats.
    const onePage = collectionPage(db, { filter, keys: [], userId: 1, limit: 500, offset: 0 });
    assert.equal(onePage.rows.length, jsIds.length, `filter "${filter}" total rows`);
    assert.equal(new Set(onePage.rows.map((r) => r.id)).size, jsIds.length, `filter "${filter}" no duplicate rows`);
  }
});

test('collectionPage: total per filter equals the full-scan count', async () => {
  const { m, db } = await seedMixedCollection();
  const { collectionPage, collectionSeries } = m;
  for (const filter of MIX_FILTERS) {
    const expected = collectionSeries(db, { filter, userId: 1 }).length;
    // total is computed alongside the chip counts (page 1); pass keys to get it.
    const { total } = collectionPage(db, { filter, keys: ['all'], userId: 1, limit: 3, offset: 0 });
    assert.equal(total, expected, `total for "${filter}"`);
  }
});

test('collectionPage: loadMore path (no keys) returns rows only, skipping the count/total scan', async () => {
  const { m, db } = await seedMixedCollection();
  const { collectionPage } = m;
  const more = collectionPage(db, { filter: 'all', keys: [], userId: 1, limit: 3, offset: 3 });
  assert.equal(more.rows.length, 3);
  assert.equal(more.total, null, 'total skipped when no chip keys are requested (loadMore)');
  assert.deepEqual(more.counts, {});
});

test('collectionPage: chip counts are filter-independent and match the JS tally', async () => {
  const { m, db } = await seedMixedCollection();
  const { collectionPage, collectionSeries, seriesMatchesFilter } = m;
  const keys = ['all', 'incomplete', 'followed', 'unmonitored', 'problems', 'unmatched', 'manga', 'comics', 'ebook'];
  const all = collectionSeries(db, { filter: 'all', userId: 1 });
  const jsCounts = {};
  for (const k of keys) jsCounts[k] = k === 'all' ? all.length : all.filter((r) => seriesMatchesFilter(r, k)).length;
  // Counts are identical no matter which filter the page is showing.
  for (const active of ['all', 'incomplete', 'ebook', 'problems']) {
    const { counts } = collectionPage(db, { filter: active, keys, userId: 1, limit: 3, offset: 0 });
    assert.deepEqual(counts, jsCounts, `counts must not depend on the active filter (was "${active}")`);
  }
  // And the standalone counts endpoint agrees.
  assert.deepEqual(m.collectionCounts(db, { keys, userId: 1 }), jsCounts);
});

test('collectionPage: sort orders (title / added / missing) are correct across page boundaries', async () => {
  const { m, db } = await seedMixedCollection();
  const { collectionPage, collectionSeries } = m;
  for (const sort of ['title', 'added', 'missing']) {
    const full = collectionSeries(db, { filter: 'all', sort, userId: 1 }).map((r) => r.id);
    const paged = pageAllIds(collectionPage, db, { filter: 'all', sort, userId: 1 }, 2); // tiny pages exercise boundaries
    assert.deepEqual(paged, full, `sort "${sort}" order must be identical across pages`);
  }
});

test('collectionPage: a limit/offset window is exactly that slice of the ordered result', async () => {
  const { m, db } = await seedMixedCollection();
  const { collectionPage, collectionSeries } = m;
  const full = collectionSeries(db, { filter: 'all', sort: 'title', userId: 1 }).map((r) => r.id);
  for (const [offset, limit] of [[0, 3], [3, 3], [2, 4], [full.length - 1, 5]]) {
    const win = collectionPage(db, { filter: 'all', sort: 'title', keys: [], userId: 1, limit, offset }).rows.map((r) => r.id);
    assert.deepEqual(win, full.slice(offset, offset + limit), `window offset=${offset} limit=${limit}`);
  }
});

test('collectionPage: search + library filter honored in the paged path', async () => {
  const { m, db, ids } = await seedMixedCollection();
  const { collectionPage, collectionSeries, createLibrary, assignSeriesLibrary } = m;
  // Search: every title containing "Ebook" (the owned + two on-demand ebooks).
  const searchFull = collectionSeries(db, { search: 'Ebook', userId: 1 }).map((r) => r.id).sort((a, b) => a - b);
  const searchPaged = pageAllIds(collectionPage, db, { search: 'Ebook', userId: 1 }, 2).sort((a, b) => a - b);
  assert.deepEqual(searchPaged, searchFull);
  assert.equal(collectionPage(db, { search: 'Ebook', keys: ['all'], userId: 1, limit: 100, offset: 0 }).total, searchFull.length);

  // Library lane: move one ebook into a library, page it back — only that member.
  const lib = createLibrary(db, { name: 'Books', type: 'ebook' });
  assignSeriesLibrary(db, ids.ebookOnDemandB, lib);
  const libPaged = pageAllIds(collectionPage, db, { library: lib, userId: 1 }, 2);
  assert.deepEqual(libPaged.sort((a, b) => a - b), [ids.ebookOnDemandB]);
});

test('collectionPage: includeRestricted=false hides mature members in both rows and counts', async () => {
  const { m, db, ids } = await seedMixedCollection();
  const { collectionPage } = m;
  const shown = pageAllIds(collectionPage, db, { includeRestricted: false, userId: 1 }, 3);
  assert.ok(!shown.includes(ids.comicRestricted), 'restricted series hidden without the mature perm');
  const withMature = pageAllIds(collectionPage, db, { includeRestricted: true, userId: 1 }, 3);
  assert.ok(withMature.includes(ids.comicRestricted), 'restricted series shown with the mature perm');
  // The chip counts respect the same visibility.
  const cRestricted = collectionPage(db, { includeRestricted: false, keys: ['all'], userId: 1, limit: 1, offset: 0 }).counts.all;
  const cAll = collectionPage(db, { includeRestricted: true, keys: ['all'], userId: 1, limit: 1, offset: 0 }).counts.all;
  assert.equal(cAll - cRestricted, 1, 'exactly the one restricted member is filtered out');
});

test('collectionPage: legacy no-limit call still returns the whole set + counts (back-compat)', async () => {
  const { m, db } = await seedMixedCollection();
  const { collectionPage, collectionSeries } = m;
  const legacy = collectionPage(db, { filter: 'all', keys: ['all', 'incomplete'], userId: 1 }); // no limit
  assert.equal(legacy.rows.length, collectionSeries(db, { filter: 'all', userId: 1 }).length, 'all rows returned');
  assert.equal(legacy.counts.all, legacy.rows.length);
  assert.ok('total' in legacy);
});

test('mergeSeriesRows folds a second row for the same volume into the folder-backed one', () => {
  const db = openDb(':memory:');
  upsertCvSeries(db, { id: 91273, name: 'Batman', start_year: '2016', count_of_issues: 163 });
  upsertCvIssue(db, { id: 5001, cv_series_id: 91273, number: '1', name: null });
  const keep = upsertSeries(db, { title: 'Batman', url: 'import:batman-2016' });
  setSeriesCv(db, keep, 91273);
  db.prepare('UPDATE series SET path=? WHERE id=?').run('/comics/Batman (2016)', keep);
  const drop = createCvSeries(db, { cvId: 91273, title: 'Batman', year: '2016' });
  const p = '/comics/Batman (2016)/Batman 001 (2016).cbz';
  upsertLibraryFile(db, { path: p, dir: '/comics/Batman (2016)', name: 'Batman 001 (2016).cbz', size: 10, mtime: 1 });
  linkLibraryFile(db, p, drop, null);
  linkFileCvIssue(db, p, 5001);
  db.prepare('INSERT INTO user_follows (user_id, series_id) VALUES (7, ?)').run(drop);
  assert.equal(mergeSeriesRows(db, keep, drop), true);
  assert.equal(getSeriesById(db, drop), undefined, 'the twin row is gone');
  assert.equal(getLibraryFile(db, p).series_id, keep, 'its file now belongs to the keeper');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM user_follows WHERE series_id=? AND user_id=7').get(keep).n, 1, 'the follow moved');
  const k = getSeriesById(db, keep);
  assert.equal(k.followed, 1);
  assert.equal(k.year, '2016', 'the keeper inherited the year it lacked');
  assert.equal(k.path, '/comics/Batman (2016)', 'the keeper kept its folder');
});
