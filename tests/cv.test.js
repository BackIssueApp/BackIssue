import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCvClient, normVolume, cvKey } from '../src/cv.js';

test('cvKey takes the first key from legacy multi-key values', () => {
  assert.equal(cvKey('a\nb , c'), 'a'); // old multi-key settings.json still loads
  assert.equal(cvKey(' solo-key '), 'solo-key');
  assert.equal(cvKey(''), '');
});
import { scoreCvCandidate, rankCandidates, matchSeriesToCv, runCvMatch, linkFilesToCv, addSeriesFromCv, autoLinkCvSeries, refreshCvVolume, migrateAdoptedSeriesToCv } from '../src/cvmatch.js';
import {
  openDb, upsertSeries, upsertIssue, upsertLibraryFile, linkLibraryFile,
  upsertCvSeries, getCvSeries, upsertCvIssue, listCvIssues, setSeriesCv,
  seriesNeedingCvMatch, setFollowed, getSeriesById, createCvSeries,
  collectionSeries, seriesCollectionDetail, getSeriesByCvId, untrackSeries, getLibraryFile, ensureCvIssueRow,
} from '../src/db.js';

// A fake CV client whose volume() returns a fixed volume with an issue list.
function volumeClient(vol) {
  return { async search() { return [vol]; }, async volume() { return { ...vol, issues: vol.issues || [] }; } };
}

// A fetch stub that returns queued JSON bodies in order, recording each URL.
function stubFetch(bodies) {
  const calls = [];
  const q = [...bodies];
  const impl = async (url) => {
    calls.push(url);
    const body = q.shift();
    if (body instanceof Error) throw body;
    return { ok: body.ok !== false, status: body.status || 200, json: async () => body.json };
  };
  impl.calls = calls;
  return impl;
}

test('normVolume flattens publisher and image', () => {
  const v = normVolume({ id: 42, name: 'X', publisher: { name: 'Marvel' }, start_year: '1999', count_of_issues: 12, image: { medium_url: 'u' }, site_detail_url: 'https://cv/x', deck: 'A short blurb.', aliases: 'Ex' });
  assert.deepEqual(v, { id: 42, name: 'X', publisher: 'Marvel', start_year: '1999', count_of_issues: 12, deck: 'A short blurb.', description: null, image_url: 'u', site_detail_url: 'https://cv/x', aliases: 'Ex' });
});

test('makeCvClient throws without a key', () => {
  assert.throws(() => makeCvClient({ comicvineKeys: '' }, {}), /no ComicVine API key/);
});

test('cv client search parses results and sends key + User-Agent', async () => {
  const fetchImpl = stubFetch([{ json: { status_code: 1, results: [
    { id: 7, name: 'Earth X', publisher: { name: 'Marvel' }, start_year: '1999', count_of_issues: 12, image: { medium_url: 'c' } },
  ] } }]);
  const cv = makeCvClient({}, { fetchImpl, key: 'K1', politeMs: 0 });
  const out = await cv.search('Earth X');
  assert.equal(out.length, 1);
  assert.equal(out[0].publisher, 'Marvel');
  assert.match(fetchImpl.calls[0], /api_key=K1/);
  assert.match(fetchImpl.calls[0], /resources=volume/);
});

test('cv client list() builds a filtered/sorted query, preserving : and | (CV syntax)', async () => {
  const fetchImpl = stubFetch([{ json: { status_code: 1, number_of_total_results: 147, offset: 0, limit: 100,
    results: [{ id: 1, name: 'Taro', issue_number: '1', store_date: '2026-07-03' }] } }]);
  const cv = makeCvClient({}, { fetchImpl, key: 'K1', politeMs: 0 });
  const out = await cv.list('issues', { filter: 'issue_number:1,store_date:2026-06-01|2026-08-31', sort: 'store_date:desc', fieldList: 'issue_number,store_date,volume', limit: 100 });
  assert.equal(out.total, 147);
  assert.equal(out.results.length, 1);
  const url = fetchImpl.calls[0];
  assert.match(url, /\/issues\/\?/);
  // The colons and pipe must survive URLSearchParams (CV rejects %3A/%7C).
  assert.match(url, /filter=issue_number:1,store_date:2026-06-01\|2026-08-31/);
  assert.match(url, /sort=store_date:desc/);
  assert.match(url, /limit=100/);
});

test('cv client uses a custom base URL (CloneVine) and skips politeness for it', async () => {
  const fetchImpl = stubFetch([{ json: { status_code: 1, results: [] } }]);
  const cv = makeCvClient({ cvBaseUrl: 'https://data.backissue.app/api/' }, { fetchImpl, key: 'K1' });
  const t0 = Date.now();
  await cv.search('saga');
  assert.ok(fetchImpl.calls[0].startsWith('https://data.backissue.app/api/search/'), 'custom base used, trailing slash trimmed: ' + fetchImpl.calls[0]);
  assert.ok(Date.now() - t0 < 200, 'no politeness pause against a self-hosted base');
});

test('cv client surfaces a 107 as a rateLimited error (no rotation — one key)', async () => {
  const fetchImpl = stubFetch([{ json: { status_code: 107, error: 'Rate Limit Exceeded' } }]);
  const cv = makeCvClient({}, { fetchImpl, key: 'K1', politeMs: 0 });
  await assert.rejects(() => cv.search('anything'), (e) => e.rateLimited === true);
  assert.equal(fetchImpl.calls.length, 1);
});

test('cv client volume returns metadata + issue stub list', async () => {
  const fetchImpl = stubFetch([{ json: { status_code: 1, results: {
    id: 7, name: 'Earth X', publisher: { name: 'Marvel' }, start_year: '1999', count_of_issues: 2, description: 'd', image: { medium_url: 'c' },
    issues: [{ id: 100, issue_number: '1', name: 'One' }, { id: 101, issue_number: '2', name: 'Two' }],
  } } }]);
  const cv = makeCvClient({}, { fetchImpl, key: 'K1', politeMs: 0 });
  const v = await cv.volume(7);
  assert.equal(v.name, 'Earth X');
  assert.equal(v.issues.length, 2);
  assert.deepEqual(v.issues[0], { id: 100, number: '1', name: 'One' });
});

test('scoreCvCandidate: exact name + year beats name-only', () => {
  const series = { title: 'Earth X (1999)', year: '1999', publisher: 'Marvel' };
  const exact = scoreCvCandidate(series, { name: 'Earth X', start_year: '1999', publisher: 'Marvel' });
  const nameOnly = scoreCvCandidate(series, { name: 'Earth X', start_year: null });
  const wrongYear = scoreCvCandidate(series, { name: 'Earth X', start_year: '2020' });
  assert.ok(exact.score > nameOnly.score);
  assert.ok(nameOnly.score > wrongYear.score);
});

test('rankCandidates auto-accepts a confident clear winner, not a tie', () => {
  const series = { title: 'Earth X', year: '1999', publisher: 'Marvel' };
  const clear = rankCandidates(series, [
    { id: 1, name: 'Earth X', start_year: '1999', publisher: 'Marvel' },
    { id: 2, name: 'Earth Y', start_year: '2005' },
  ]);
  assert.equal(clear.auto, true);
  assert.equal(clear.best.cand.id, 1);

  const tie = rankCandidates(series, [
    { id: 1, name: 'Earth X', start_year: null },
    { id: 2, name: 'Earth X', start_year: null },
  ]);
  assert.equal(tie.auto, false); // exact name but no year + no margin
});

test('matchSeriesToCv auto-match caches volume, issues, and links the series', async () => {
  const db = openDb(':memory:');
  const sid = upsertSeries(db, { title: 'Earth X (1999)', url: '/c/ex', publisher: 'Marvel' });
  db.prepare('UPDATE series SET year=? WHERE id=?').run('1999', sid);
  const series = getSeriesById(db, sid);

  const client = {
    async search() { return [{ id: 7, name: 'Earth X', start_year: '1999', publisher: 'Marvel', count_of_issues: 2 }]; },
    async volume() { return { id: 7, name: 'Earth X', publisher: 'Marvel', start_year: '1999', count_of_issues: 2, description: 'd', image_url: 'c', issues: [{ id: 100, number: '1', name: 'One' }, { id: 101, number: '2', name: 'Two' }] }; },
  };
  const r = await matchSeriesToCv(db, client, series);
  assert.equal(r.status, 'matched');
  assert.equal(r.cvId, 7);
  assert.equal(getSeriesById(db, sid).cv_id, 7);
  assert.ok(getCvSeries(db, 7));
  assert.equal(listCvIssues(db, 7).length, 2);
});

test('matchSeriesToCv returns candidates when ambiguous', async () => {
  const db = openDb(':memory:');
  const sid = upsertSeries(db, { title: 'Spawn', url: '/c/sp' });
  const series = getSeriesById(db, sid);
  const client = {
    async search() { return [{ id: 1, name: 'Spawn', start_year: null }, { id: 2, name: 'Spawn', start_year: null }]; },
    async volume() { throw new Error('should not fetch'); },
  };
  const r = await matchSeriesToCv(db, client, series);
  assert.equal(r.status, 'ambiguous');
  assert.equal(r.candidates.length, 2);
  assert.equal(getSeriesById(db, sid).cv_id, null);
});

test('seriesNeedingCvMatch: owned or followed, excludes matched and locked', () => {
  const db = openDb(':memory:');
  const owned = upsertSeries(db, { title: 'Owned', url: '/c/o' });
  const followed = upsertSeries(db, { title: 'Followed', url: '/c/f' });
  upsertSeries(db, { title: 'Neither', url: '/c/n' }); // neither owned nor followed

  const locked = upsertSeries(db, { title: 'Locked', url: '/c/l' });

  // owned: has a valid linked file
  upsertLibraryFile(db, { path: '/x.cbz', dir: '/', name: 'x.cbz', size: 1, mtime: 1, valid: 1 });
  linkLibraryFile(db, '/x.cbz', owned, null);
  setFollowed(db, followed, true);
  setFollowed(db, locked, true);
  setSeriesCv(db, locked, 999, { locked: 1 });

  const ids = seriesNeedingCvMatch(db).map((s) => s.id).sort((a, b) => a - b);
  assert.deepEqual(ids, [owned, followed].sort((a, b) => a - b));
});

test('upsertCvIssue preserves fetched detail on re-list', () => {
  const db = openDb(':memory:');
  upsertCvSeries(db, { id: 5, name: 'S', count_of_issues: 1 });
  upsertCvIssue(db, { id: 50, cv_series_id: 5, number: '1', name: 'One', cover_date: '1999-01-01', has_detail: 1 });
  upsertCvIssue(db, { id: 50, cv_series_id: 5, number: '1', name: 'One (updated)' }); // re-list from volume
  const iss = listCvIssues(db, 5)[0];
  assert.equal(iss.name, 'One (updated)');
  assert.equal(iss.cover_date, '1999-01-01'); // detail preserved
  assert.equal(iss.has_detail, 1);
});

test('linkFilesToCv maps owned files to CV issues by number', () => {
  const db = openDb(':memory:');
  const sid = upsertSeries(db, { title: 'Invincible', url: '/c/inv' });
  upsertCvSeries(db, { id: 20, name: 'Invincible', count_of_issues: 3 });
  upsertCvIssue(db, { id: 201, cv_series_id: 20, number: '1', name: 'One' });
  upsertCvIssue(db, { id: 202, cv_series_id: 20, number: '2', name: 'Two' });
  // Owned file for #1 (tagged) and #002 (leading zeros, via filename)
  upsertLibraryFile(db, { path: '/i1.cbz', dir: '/', name: 'Invincible #1.cbz', size: 1, mtime: 1, valid: 1, ci_number: '1' });
  linkLibraryFile(db, '/i1.cbz', sid, null);
  upsertLibraryFile(db, { path: '/i2.cbz', dir: '/', name: 'Invincible #002.cbz', size: 1, mtime: 1, valid: 1 });
  linkLibraryFile(db, '/i2.cbz', sid, null);
  const linked = linkFilesToCv(db, sid, 20);
  assert.equal(linked, 2);
  assert.equal(db.prepare('SELECT cv_issue_id FROM library_files WHERE path=?').get('/i1.cbz').cv_issue_id, 201);
  assert.equal(db.prepare('SELECT cv_issue_id FROM library_files WHERE path=?').get('/i2.cbz').cv_issue_id, 202);
});

test('linkFilesToCv also links invalid/corrupt files so they surface per-issue', () => {
  const db = openDb(':memory:');
  const sid = upsertSeries(db, { title: 'Invincible', url: 'cv:20' });
  setSeriesCv(db, sid, 20, { locked: 1 });
  upsertCvSeries(db, { id: 20, name: 'Invincible', count_of_issues: 2 });
  upsertCvIssue(db, { id: 201, cv_series_id: 20, number: '1', name: 'One' });
  upsertCvIssue(db, { id: 202, cv_series_id: 20, number: '2', name: 'Two' });
  upsertLibraryFile(db, { path: '/i1.cbz', dir: '/', name: 'Invincible V2003 #001.cbz', size: 1, mtime: 1, valid: 1, has_metadata: 1, series_id: sid });
  upsertLibraryFile(db, { path: '/i2.cbr', dir: '/', name: 'Invincible V2003 #002 (2004).cbr', size: 1, mtime: 1, valid: 0, series_id: sid }); // corrupt
  linkFilesToCv(db, sid, 20);
  assert.equal(db.prepare('SELECT cv_issue_id FROM library_files WHERE path=?').get('/i2.cbr').cv_issue_id, 202);
  const det = seriesCollectionDetail(db, sid);
  assert.equal(det.issues.find((i) => i.number === '2').corrupt, true); // now shows in the volume view
});

test('collection rolls up against CV when matched (not catalog)', async () => {
  const db = openDb(':memory:');
  const sid = upsertSeries(db, { title: 'Invincible', url: '/c/inv', publisher: 'Image' });
  db.prepare('UPDATE series SET year=? WHERE id=?').run('2003', sid);
  // catalog has 4 issues (inflated with a variant); we own 2 real ones.
  for (const n of ['1', '2', '3', '3']) upsertIssue(db, { seriesId: sid, title: 'Invincible #' + n, issueNumber: n, url: '/i/inv' + Math.random() });
  upsertLibraryFile(db, { path: '/a.cbz', dir: '/', name: 'a.cbz', size: 1, mtime: 1, valid: 1, ci_number: '1' });
  linkLibraryFile(db, '/a.cbz', sid, null);
  upsertLibraryFile(db, { path: '/b.cbz', dir: '/', name: 'b.cbz', size: 1, mtime: 1, valid: 1, ci_number: '2' });
  linkLibraryFile(db, '/b.cbz', sid, null);

  // CV says the volume is 3 issues.
  const client = {
    async search() { return [{ id: 20, name: 'Invincible', start_year: '2003', publisher: 'Image', count_of_issues: 3 }]; },
    async volume() { return { id: 20, name: 'Invincible', publisher: 'Image', start_year: '2003', count_of_issues: 3, image_url: 'i', issues: [{ id: 201, number: '1', name: 'One' }, { id: 202, number: '2', name: 'Two' }, { id: 203, number: '3', name: 'Three' }] }; },
  };
  await matchSeriesToCv(db, client, getSeriesById(db, sid));

  const row = collectionSeries(db, { filter: 'all' }).find((r) => r.id === sid);
  assert.equal(row.source, 'cv');
  assert.equal(row.total, 3);   // CV total, not catalog's 4
  assert.equal(row.owned, 2);
  assert.equal(row.missing, 1);

  const det = seriesCollectionDetail(db, sid);
  assert.equal(det.source, 'cv');
  assert.equal(det.issues.length, 3);
  // #3 is missing but maps to a catalog issue (downloadable)
  const three = det.issues.find((i) => i.number === '3');
  assert.equal(three.owned, false);
  assert.ok(three.id != null && three.downloadable);
});

test('addSeriesFromCv never adopts a catalog series — creates a pure CV series', async () => {
  const db = openDb(':memory:');
  // A catalog catalog volume with the same name+year exists...
  const sid = upsertSeries(db, { title: 'Saga (2012)', url: 'https://catalog.test/1-saga', publisher: 'Image' });
  db.prepare('UPDATE series SET year=? WHERE id=?').run('2012', sid);
  const client = volumeClient({ id: 30, name: 'Saga', start_year: '2012', publisher: 'Image', count_of_issues: 2, image_url: 'i', issues: [{ id: 301, number: '1', name: 'One' }] });
  const r = await addSeriesFromCv(db, client, 30);
  // ...but the collection identity is a fresh CV series, NOT the catalog row.
  assert.equal(r.outcome, 'created');
  assert.notEqual(r.seriesId, sid);
  const s = getSeriesByCvId(db, 30);
  assert.equal(s.url, 'cv:30');
  assert.equal(s.followed, 1);
  // The catalog catalog row is untouched — still a plain download-source entry.
  const bc = getSeriesById(db, sid);
  assert.equal(bc.cv_id, null);
  assert.equal(bc.followed, 0);
});

test('addSeriesFromCv creates a CV-only series when catalog has no match', async () => {
  const db = openDb(':memory:');
  const client = volumeClient({ id: 40, name: 'Obscure Indie Book', start_year: '2021', publisher: 'Tiny', count_of_issues: 3, image_url: 'i', issues: [{ id: 401, number: '1', name: 'One' }, { id: 402, number: '2', name: 'Two' }] });
  const r = await addSeriesFromCv(db, client, 40);
  assert.equal(r.outcome, 'created');
  const s = getSeriesByCvId(db, 40);
  assert.ok(s);
  assert.equal(s.url, 'cv:40');       // synthetic url, no catalog source
  assert.equal(s.followed, 1);
  assert.equal(s.title, 'Obscure Indie Book');
  // Appears in the collection (monitored), rolled up against CV's 2 cached issues.
  const row = collectionSeries(db, { filter: 'all' }).find((x) => x.id === s.id);
  assert.equal(row.total, 2);
  assert.equal(row.owned, 0);
  assert.equal(row.sourced, false); // no catalog download source yet
});

test('migrateAdoptedSeriesToCv: catalog-identity series → pure CV, catalog demoted', () => {
  const db = openDb(':memory:');
  const b = upsertSeries(db, { title: 'Invincible (2003)', url: 'https://catalog.test/6975-invincible.html' });
  db.prepare('UPDATE series SET cv_id=17993, cv_locked=1, followed=1, year=?, path=? WHERE id=?').run('2003', '\\\\T\\Invincible', b);
  upsertIssue(db, { seriesId: b, title: 'Invincible #1', issueNumber: '1', url: 'https://catalog.test/reader/6975/1' }); // catalog issue
  const syn = ensureCvIssueRow(db, { seriesId: b, cvIssueId: 900, number: '1' });                                      // synthetic CV row
  db.prepare('INSERT INTO library_files (path, name, series_id, valid) VALUES (?,?,?,1)').run('/x/inv1.cbz', 'inv1.cbz', b);

  const r = migrateAdoptedSeriesToCv(db);
  assert.equal(r.migrated, 1);

  const c = getSeriesByCvId(db, 17993);
  assert.equal(c.url, 'cv:17993');
  assert.equal(c.followed, 1);
  assert.equal(c.path, '\\\\T\\Invincible');
  assert.notEqual(c.id, b);
  // owned file + synthetic CV row moved to the CV series
  assert.equal(db.prepare('SELECT series_id FROM library_files WHERE path=?').get('/x/inv1.cbz').series_id, c.id);
  assert.equal(db.prepare('SELECT series_id FROM issues WHERE id=?').get(syn).series_id, c.id);
  // the crawled catalog reader issue stays on the (now demoted) catalog row
  assert.equal(db.prepare("SELECT series_id FROM issues WHERE url LIKE 'http%'").get().series_id, b);
  const bc = getSeriesById(db, b);
  assert.equal(bc.cv_id, null);
  assert.equal(bc.followed, 0);
  // idempotent
  assert.equal(migrateAdoptedSeriesToCv(db).migrated, 0);
});

test('addSeriesFromCv is idempotent for an already-added volume', async () => {
  const db = openDb(':memory:');
  const client = volumeClient({ id: 50, name: 'Nailbiter', start_year: '2014', publisher: 'Image', count_of_issues: 1, image_url: 'i', issues: [{ id: 501, number: '1', name: 'One' }] });
  const a = await addSeriesFromCv(db, client, 50);
  const b = await addSeriesFromCv(db, client, 50);
  assert.equal(a.seriesId, b.seriesId);
  assert.equal(b.outcome, 'existing');
  assert.equal(collectionSeries(db, { filter: 'all' }).filter((x) => x.cv_id === 50).length, 1);
});

test('autoLinkCvSeries is a no-op — catalog is a download-only source (no merging)', () => {
  const db = openDb(':memory:');
  upsertCvSeries(db, { id: 70, name: 'Monstress', count_of_issues: 1 });
  const cvOnly = createCvSeries(db, { cvId: 70, title: 'Monstress', publisher: 'Image', year: '2015' });
  const bc = upsertSeries(db, { title: 'Monstress (2015)', url: 'https://catalog.test/1-monstress', publisher: 'Image' });
  db.prepare('UPDATE series SET year=? WHERE id=?').run('2015', bc);
  // Even with a name+year catalog twin present, nothing is merged — the CV series
  // keeps its identity; the catalog volume stays a plain catalog entry.
  assert.equal(autoLinkCvSeries(db), 0);
  assert.equal(getSeriesById(db, cvOnly).url, 'cv:70'); // still a pure CV series
  assert.equal(getSeriesById(db, bc).cv_id, null);      // catalog row untouched
});

test('refreshCvVolume re-pulls metadata + issues from ComicVine and re-links files', async () => {
  const db = openDb(':memory:');
  const sid = upsertSeries(db, { title: 'Saga', url: '/c/saga' });
  upsertCvSeries(db, { id: 46568, name: 'Saga', publisher: 'Old Publisher', start_year: '2012', count_of_issues: 1 });
  upsertCvIssue(db, { id: 1, cv_series_id: 46568, number: '1', name: 'One' });
  setSeriesCv(db, sid, 46568, { locked: 0 });
  // An owned file for #2, which ComicVine doesn't list yet.
  upsertLibraryFile(db, { path: '/s2.cbz', dir: '/', name: 'Saga #2.cbz', size: 1, mtime: 1, valid: 1, ci_number: '2' });
  linkLibraryFile(db, '/s2.cbz', sid, null);

  const client = { async volume() { return { id: 46568, name: 'Saga', publisher: 'Image', start_year: '2012', count_of_issues: 2, image_url: 'c', site_detail_url: 'https://cv/saga', issues: [{ id: 1, number: '1', name: 'One' }, { id: 2, number: '2', name: 'Two' }] }; } };
  const r = await refreshCvVolume(db, client, sid);
  assert.equal(r.ok, true);
  assert.equal(r.issues, 2);
  const cv = getCvSeries(db, 46568);
  assert.equal(cv.publisher, 'Image');                 // metadata refreshed
  assert.equal(cv.site_detail_url, 'https://cv/saga'); // CV page url now cached
  assert.equal(listCvIssues(db, 46568).length, 2);     // newly published #2 picked up
  assert.equal(db.prepare('SELECT cv_issue_id FROM library_files WHERE path=?').get('/s2.cbz').cv_issue_id, 2);

  // Unmatched series can't be refreshed.
  const u = upsertSeries(db, { title: 'X', url: '/c/x' });
  assert.equal((await refreshCvVolume(db, client, u)).ok, false);
});

test('untrackSeries removes a comic from the collection (files on disk untouched)', () => {
  const db = openDb(':memory:');
  // A CV-only comic is deleted outright.
  upsertCvSeries(db, { id: 1, name: 'A', count_of_issues: 1 });
  const cvOnly = createCvSeries(db, { cvId: 1, title: 'A' });
  upsertLibraryFile(db, { path: '/a.cbz', dir: '/A', name: 'a.cbz', size: 1, mtime: 1, valid: 1 });
  linkLibraryFile(db, '/a.cbz', cvOnly, null);
  const r = untrackSeries(db, cvOnly);
  assert.deepEqual(r.files, ['/a.cbz']);          // reports the on-disk paths (caller may delete them)
  assert.equal(getSeriesById(db, cvOnly), undefined); // cv-only row removed
  assert.equal(getLibraryFile(db, '/a.cbz'), undefined); // index row removed

  // An adopted catalog series is kept in the catalog but untracked.
  const bc = upsertSeries(db, { title: 'B (2020)', url: '/c/b' });
  setFollowed(db, bc, true);
  setSeriesCv(db, bc, 99, { locked: 1 });
  untrackSeries(db, bc);
  const row = getSeriesById(db, bc);
  assert.ok(row);                 // catalog row survives
  assert.equal(row.followed, 0);  // but no longer tracked
  assert.equal(row.cv_id, null);
});

test('unmatched comics surface no catalog data — only a folder + files', () => {
  const db = openDb(':memory:');
  const sid = upsertSeries(db, { title: 'Some Catalog Title (2010-)', url: '/c/x', publisher: 'CatalogPub' });
  db.prepare('UPDATE series SET year=?, cover_url=? WHERE id=?').run('2010', '/bc.jpg', sid);
  setFollowed(db, sid, true);
  upsertIssue(db, { seriesId: sid, title: 'X #1', issueNumber: '1', url: '/i/x1' }); // catalog issues exist...
  upsertLibraryFile(db, { path: '/lib/Some Comic (2010)/x1.cbz', dir: '/lib/Some Comic (2010)', name: 'x1.cbz', size: 1, mtime: 1, valid: 1 });
  linkLibraryFile(db, '/lib/Some Comic (2010)/x1.cbz', sid, null);

  const row = collectionSeries(db, { filter: 'all' }).find((r) => r.id === sid);
  assert.equal(row.matched, false);
  assert.equal(row.title, null);        // ...but no catalog title/publisher/cover surfaces
  assert.equal(row.publisher, null);
  assert.equal(row.cover_url, null);
  assert.equal(row.folder, 'Some Comic (2010)'); // neutral: the disk folder
  assert.equal(row.files, 1);
  assert.equal(row.source, 'unmatched');

  const det = seriesCollectionDetail(db, sid);
  assert.equal(det.source, 'unmatched');
  assert.equal(det.series.title, null);
  assert.equal(det.issues.length, 0);   // no catalog issue list
  assert.equal(det.files.length, 1);
});

test('collection & detail display ComicVine name/publisher/year/cover when matched', () => {
  const db = openDb(':memory:');
  const sid = upsertSeries(db, { title: '20th Century Men (2022-)', url: '/c/20cm', publisher: 'CatalogPub' });
  db.prepare('UPDATE series SET year=?, cover_url=? WHERE id=?').run('2099', '/catalog-cover.jpg', sid);
  setFollowed(db, sid, true);
  upsertCvSeries(db, { id: 555, name: '20th Century Men', publisher: 'Image Comics', start_year: '2022', image_url: 'https://cv/cover.jpg' });
  upsertCvIssue(db, { id: 5551, cv_series_id: 555, number: '1', name: 'One' });
  setSeriesCv(db, sid, 555, { locked: 0 });

  const row = collectionSeries(db, { filter: 'all' }).find((r) => r.id === sid);
  assert.equal(row.title, '20th Century Men');      // CV name, not catalog "(2022-)"
  assert.equal(row.publisher, 'Image Comics');       // CV publisher
  assert.equal(row.year, '2022');                    // CV start year
  assert.equal(row.cover_url, 'https://cv/cover.jpg'); // CV cover

  const det = seriesCollectionDetail(db, sid);
  assert.equal(det.series.title, '20th Century Men');
  assert.equal(det.series.publisher, 'Image Comics');
  assert.equal(det.series.cover_url, 'https://cv/cover.jpg');

  // searchable by the ComicVine name even though the catalog title differs
  assert.ok(collectionSeries(db, { filter: 'all', search: '20th Century Men' }).some((r) => r.id === sid));
});

test('runCvMatch reports progress and counts matches', async () => {
  const db = openDb(':memory:');
  const a = upsertSeries(db, { title: 'Alpha', url: '/c/a' });
  setFollowed(db, a, true);
  const b = upsertSeries(db, { title: 'Beta', url: '/c/b' });
  setFollowed(db, b, true);
  const client = {
    async search(q) { return q === 'Alpha' ? [{ id: 1, name: 'Alpha', start_year: null, publisher: 'X' }] : []; },
    async volume() { return { id: 1, name: 'Alpha', issues: [] }; },
  };
  let last;
  const r = await runCvMatch(db, client, { onProgress: (p) => { last = p; }, concurrency: 1 });
  assert.equal(r.total, 2);
  assert.equal(r.matched, 1);
  assert.equal(last.done, 2);
});

test('cvEnrich adds enrich=metron to volume fetches and normVolume carries it', async () => {
  const payload = { status_code: 1, results: {
    id: 42594, name: 'Detective Comics', start_year: '2011',
    metron: { rating: 'Teen', status: 'Cancelled', year_end: 2016, series_type: 'Single Issue' },
    issues: [],
  } };
  // Enrichment ON: the param rides the volume request, metron passes through.
  let fetchImpl = stubFetch([{ json: payload }]);
  let cv = makeCvClient({ cvEnrich: true }, { fetchImpl, key: 'K1', politeMs: 0 });
  let v = await cv.volume(42594);
  assert.match(fetchImpl.calls[0], /enrich=metron/);
  assert.equal(v.metron.rating, 'Teen');
  assert.equal(v.metron.status, 'Cancelled');

  // Enrichment OFF: no param, and no metron key on the normalized volume.
  fetchImpl = stubFetch([{ json: { status_code: 1, results: { id: 1, name: 'X', issues: [] } } }]);
  cv = makeCvClient({}, { fetchImpl, key: 'K1', politeMs: 0 });
  v = await cv.volume(1);
  assert.ok(!/enrich=/.test(fetchImpl.calls[0]));
  assert.ok(!('metron' in v), 'no metron key when the endpoint attached none');
});

test('metron enrichment stores fields and auto-flags ONLY on the mature transition', async () => {
  const db = openDb(':memory:');
  const sid = upsertSeries(db, { title: 'Crossed', url: 'cv:800' });
  setSeriesCv(db, sid, 800, { locked: 0 });

  // First enriched upsert: rating arrives → fields stored, series auto-flagged.
  upsertCvSeries(db, { id: 800, name: 'Crossed', metron: { rating: 'Mature', status: 'Cancelled', year_end: 2010 } });
  assert.equal(getCvSeries(db, 800).metron_rating, 'Mature');
  assert.equal(getCvSeries(db, 800).metron_status, 'Cancelled');
  assert.equal(getSeriesById(db, sid).restricted, 1, 'mature transition auto-flags');

  // The user unflags manually — a later enriched refresh must NOT re-flag
  // (rating stays Mature: no transition).
  db.prepare('UPDATE series SET restricted=0 WHERE id=?').run(sid);
  upsertCvSeries(db, { id: 800, name: 'Crossed', metron: { rating: 'Mature', status: 'Cancelled', year_end: 2010 } });
  assert.equal(getSeriesById(db, sid).restricted, 0, 'manual unflag survives refreshes');

  // An UN-enriched refresh (no metron key) leaves enrichment untouched.
  upsertCvSeries(db, { id: 800, name: 'Crossed (renamed)' });
  assert.equal(getCvSeries(db, 800).metron_rating, 'Mature', 'plain refresh keeps enrichment');

  // A non-mature rating never flags.
  upsertCvSeries(db, { id: 801, name: 'Batman', metron: { rating: 'Teen', status: 'Ongoing' } });
  const sid2 = upsertSeries(db, { title: 'Batman', url: 'cv:801' });
  setSeriesCv(db, sid2, 801, { locked: 0 });
  upsertCvSeries(db, { id: 801, name: 'Batman', metron: { rating: 'Teen', status: 'Ongoing' } });
  assert.equal(getSeriesById(db, sid2).restricted, 0);
});

test('issue enrichment: cvEnrich adds the param; setCvIssueDetail stores + preserves extras', async () => {
  // Param rides the issue fetch when enabled.
  let fetchImpl = stubFetch([{ json: { status_code: 1, results: { id: 5, metron: { price: '2.99', upc: '123', story_titles: ['A', 'B'], reprints: [{ id: 1, issue: 'TPB #1' }] } } } }]);
  let cv = makeCvClient({ cvEnrich: true }, { fetchImpl, key: 'K1', politeMs: 0 });
  const d = await cv.issue(5);
  assert.match(fetchImpl.calls[0], /enrich=metron/);
  assert.equal(d.metron.price, '2.99');

  // Storage: extras persist, and an UN-enriched re-store leaves them alone.
  const db = openDb(':memory:');
  upsertCvSeries(db, { id: 900, name: 'S' });
  upsertCvIssue(db, { id: 5, cv_series_id: 900, number: '1' });
  const { setCvIssueDetail, getCvIssue: getIssue } = await import('../src/db.js');
  setCvIssueDetail(db, 5, { description: 'x', metron: d.metron });
  let row = getIssue(db, 5);
  assert.equal(row.metron_price, '2.99');
  assert.equal(JSON.parse(row.metron_story_titles).length, 2);
  assert.ok(row.metron_checked, 'checked marker set');
  setCvIssueDetail(db, 5, { description: 'y' }); // no metron key → untouched
  row = getIssue(db, 5);
  assert.equal(row.metron_upc, '123', 'plain re-store keeps enrichment');
  // A checked MISS records the check with empty fields (no eternal refetch).
  setCvIssueDetail(db, 6, { metron: null });
  upsertCvIssue(db, { id: 6, cv_series_id: 900, number: '2' });
  setCvIssueDetail(db, 6, { metron: null });
  assert.ok(getIssue(db, 6).metron_checked);
  assert.equal(getIssue(db, 6).metron_price, null);
});

test('refreshAllIssueDetails sweeps every issue, stores enrichment, halts on rate limit', async () => {
  const { refreshAllIssueDetails } = await import('../src/cvmatch.js');
  const db = openDb(':memory:');
  upsertCvSeries(db, { id: 900, name: 'Saga' });
  for (const [id, n] of [[101, '1'], [102, '2'], [103, '3']]) upsertCvIssue(db, { id, cv_series_id: 900, number: n });

  // Every issue gets a full detail (incl. enrichment extras) in one sweep.
  const client = { async issue(id) {
    return { id, cover_date: '2012-01-01', description: 'd' + id, credits: [{ name: 'BKV', role: 'writer' }],
      site_detail_url: null, image_url: null, metron: { price: '2.99', upc: String(id) } };
  } };
  const progress = [];
  const r = await refreshAllIssueDetails(db, client, 900, { onProgress: (p) => progress.push(p.done) });
  assert.deepEqual([r.done, r.failed, r.total], [3, 0, 3]);
  assert.deepEqual(progress, [1, 2, 3]);
  const { getCvIssue: getIssueRow } = await import('../src/db.js');
  const row = getIssueRow(db, 102);
  assert.equal(row.has_detail, 1);
  assert.equal(row.description, 'd102');
  assert.equal(row.metron_upc, '102');

  // A rate-limit error halts the sweep (partial progress kept).
  let calls = 0;
  const limited = { async issue() {
    calls++;
    if (calls === 2) { const e = new Error('slow down'); e.rateLimited = true; throw e; }
    return { id: 1, description: 'x', credits: [] };
  } };
  const r2 = await refreshAllIssueDetails(db, limited, 900, {});
  assert.equal(r2.halted, 'rate limited');
  assert.equal(r2.done, 1);
});

test('metadata editor: edits lock fields against every sync path until reset', async () => {
  const { updateCvSeriesUser, resetCvSeriesUser, updateCvIssueUser } = await import('../src/db.js');
  const { getCvIssue: issueRow } = await import('../src/db.js');
  const db = openDb(':memory:');
  upsertCvSeries(db, { id: 700, name: 'Batman', publisher: 'DC', description: 'orig' });

  // Edit title + description → a refresh payload must not clobber them,
  // but publisher (unedited) still refreshes.
  const r = updateCvSeriesUser(db, 700, { name: 'Batman (my name)', description: 'my words', bogus: 'ignored' });
  assert.deepEqual(r.updated.sort(), ['description', 'name']);
  upsertCvSeries(db, { id: 700, name: 'Batman', publisher: 'DC Comics', description: 'cv words' });
  let row = getCvSeries(db, 700);
  assert.equal(row.name, 'Batman (my name)', 'edited name survives refresh');
  assert.equal(row.description, 'my words');
  assert.equal(row.publisher, 'DC Comics', 'unedited field still refreshes');

  // Enrichment respects a locked rating — and cannot auto-flag over it.
  const sid = upsertSeries(db, { title: 'Batman', url: 'cv:700' });
  setSeriesCv(db, sid, 700, { locked: 0 });
  updateCvSeriesUser(db, 700, { metron_rating: 'Teen' });
  upsertCvSeries(db, { id: 700, name: 'Batman', metron: { rating: 'Mature', status: 'Ongoing' } });
  row = getCvSeries(db, 700);
  assert.equal(row.metron_rating, 'Teen', 'locked rating beats enrichment');
  assert.equal(row.metron_status, 'Ongoing', 'unlocked enrichment field lands');
  assert.equal(getSeriesById(db, sid).restricted, 0, 'no auto-flag over a locked rating');

  // Reset: locks drop, the next refresh restores source values.
  resetCvSeriesUser(db, 700);
  upsertCvSeries(db, { id: 700, name: 'Batman', description: 'cv words' });
  assert.equal(getCvSeries(db, 700).name, 'Batman');

  // Issue side: edited number/name survive stub upserts AND detail refreshes.
  upsertCvIssue(db, { id: 71, cv_series_id: 700, number: '1', name: 'Knight' });
  updateCvIssueUser(db, 71, { issue_number: '1.MY', name: 'My Title', metron_price: '9.99' });
  upsertCvIssue(db, { id: 71, cv_series_id: 700, number: '1', name: 'Knight' });
  const { setCvIssueDetail: setDetail } = await import('../src/db.js');
  setDetail(db, 71, { description: 'fresh', metron: { price: '3.99', upc: 'X' } });
  const irow = issueRow(db, 71);
  assert.equal(irow.issue_number, '1.MY');
  assert.equal(irow.name, 'My Title');
  assert.equal(irow.metron_price, '9.99', 'locked price beats enrichment');
  assert.equal(irow.metron_upc, 'X', 'unlocked enrichment field lands');
  assert.equal(irow.description, 'fresh', 'unedited detail field refreshes');
});
