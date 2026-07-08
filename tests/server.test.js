import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, upsertSeries, upsertIssue, upsertCvSeries, upsertCvIssue } from '../src/db.js';
import { createApp } from '../src/server.js';

function makeApp() {
  const db = openDb(':memory:');
  const sid = upsertSeries(db, { title: 'Batman', url: '/c/batman', publisher: 'DC', coverUrl: '' });
  upsertIssue(db, { seriesId: sid, title: 'Batman #1', issueNumber: '1', url: '/i/b1' });
  const calls = { crawl: 0, downloads: [], updates: [] };
  const app = createApp({
    db,
    runDownloads: async (ids) => { calls.downloads.push(ids); },
    prepareRedownload: async (ids) => { calls.prepared = ids; },
    runCvMatch: () => { calls.cvMatch = (calls.cvMatch || 0) + 1; },
    cvSearch: async (q) => { calls.cvSearch = q; return [{ id: 7, name: 'Earth X', start_year: '1999', publisher: 'Marvel', count_of_issues: 12 }]; },
    cvIssueInfo: async (cvIssueId) => { calls.issueInfo = cvIssueId; return { cv_issue_id: cvIssueId, number: '1', name: 'One', credits: [], files: [] }; },
    cvVolumeInfo: async (id) => { calls.volumeInfo = id; return { id, name: 'Aquaman and The Others', start_year: '2014', count_of_issues: 11, publisher: 'DC Comics' }; },
    cleanupSeriesFiles: async (id) => { calls.cleaned = id; return { removed: 3, detail: { issues: [] } }; },
    runImportScan: async (opts) => { calls.importScan = opts; return { started: true }; },
    runImport: async () => { calls.importRun = true; return { started: true }; },
    importState: () => ({ running: false, candidates: [{ id: 1, name: 'Invincible', confidence: 'low', status: 'review' }] }),
    runTool: (tool, opts) => { calls.tool = tool; calls.toolOpts = opts; return { started: true }; },
    stats: () => ({ files: { total: 5 }, collection: { series: 2 } }),
    listSources: () => [{ id: 'usenet', label: 'usenet' }, { id: 'torrent', label: 'torrent' }],
    usenetSearch: async (q) => { calls.usenetSearch = q; return { results: [{ title: 'Saga 001 (2012)', size: 42000000, nzbUrl: 'http://nz/1.nzb', indexer: 'nz' }] }; },
    usenetGrab: async (b) => { calls.usenetGrab = b; return { grabbed: true }; },
    torrentSearch: async (b) => { calls.torrentSearch = b; return { results: [{ title: 'Saga v1 (001-054) pack', size: 3e9, seeders: 40, indexer: 'p', downloadUrl: 'magnet:?xt=urn:btih:x' }] }; },
    torrentGrabPack: async (b) => { calls.torrentGrabPack = b; return { grabbed: true }; },
    searchSources: async (b) => { calls.searchSources = b; return { results: [{ source: 'usenet', rid: 'usenet:0', title: 'Saga 012', size: 42e6, meta: 'nz', score: 100 }], searched: ['Saga 012'], errors: [], sources: ['usenet'] }; },
    manualGrabResult: (b) => { calls.manualGrab = b; return { queued: true, issueId: 99 }; },
    grabSourcePack: (b) => { calls.grabPack = b; return { grabbed: true, grabId: 5 }; },
    searchPacks: async (b) => { calls.searchPacks = b; return { results: [{ source: 'torrent', rid: 'torrent:0', title: 'Saga Vol 1', size: 2e8, seeders: 30, isPack: true }], errors: [], sources: ['torrent', 'ddl'] }; },
    grabPack: async (b) => { calls.packGrab = b; return { grabbed: true, grabId: 8 }; },
    cancelGrab: async (id) => { calls.cancelGrab = id; return { cancelled: true }; },
    packProgress: () => ({ 7: { state: 'downloading', progress: 42, seeders: 12 } }),
    setAliases: (id, aliases) => { calls.setAliases = { id, aliases }; return { searchNames: ['2000 AD', '2000AD'] }; },
    toolsState: () => ({ running: false, catalog: [{ id: 'verify', label: 'Verify archives', desc: '…' }] }),
    matchImportCandidate: (id, m) => { calls.importMatch = { id, m }; return { id, status: 'ready' }; },
    confirmImportCandidate: (id) => { calls.importConfirm = id; return { id, status: 'ready' }; },
    skipImportCandidate: (id) => { calls.importSkip = id; return { id, status: 'skipped' }; },
    cvSetManual: async (id, cvId) => { calls.cvSet = { id, cvId }; return { series: { id }, cv: { id: cvId } }; },
    addFromCv: async (cvId) => { calls.addedCv = cvId; return { seriesId: 5, outcome: 'created', cvId }; },
    scanSeriesFolder: async (id) => { calls.scanned = id; return { started: true, dir: '/lib/X' }; },
    deleteComic: async (id, opts) => { calls.deleted = { id, ...opts }; return { deleted: true, deletedFiles: opts.deleteFiles ? 3 : 0 }; },
    refreshVolume: async (id) => { calls.refreshed = id; return { ok: true, issues: 7, detail: { issues: [] } }; },
    tagSeriesFiles: async (id, opts) => { calls.taggedSeries = id; calls.tagOpts = opts; return { started: true, total: 4 }; },
    checkReleases: (opts) => { calls.releasesChecked = opts || {}; return { started: true }; },
    listJobs: () => [{ id: 1, type: 'cv-match', label: 'Match ComicVine', status: 'done', done: 5, total: 5, result: { matched: 3 }, startedAt: 0, finishedAt: 1000 }],
    clearJobs: () => { calls.jobsCleared = true; return 0; },
    listLogs: (opts) => { calls.logsQuery = opts; return { logs: [{ ts: 0, level: 'error', category: 'download', message: 'Download failed: X — no source' }], counts: { error: 1, warn: 0, info: 0 }, categories: ['download', 'usenet'] }; },
    clearLogs: () => { calls.logsCleared = true; return 4; },
    listSchedules: () => [{ key: 'releases', label: 'Check releases', cron: '0 */12 * * *', enabled: true, lastRun: null, nextRun: 999, running: false }],
    setScheduleCron: (key, { cron, enabled }) => { calls.schedSet = { key, cron, enabled }; return key === 'releases' ? { key, cron, enabled } : { error: 'unknown task' }; },
    runScheduleNow: (key) => { calls.schedRun = key; return key === 'releases'; },
    getSettings: () => ({ format: 'cbz', downloadConcurrency: 4 }),
    saveSettings: (b) => { calls.saved = b; return { ...b, format: b.format || 'cbz' }; },
    state: { crawl: { running: false }, queue: { running: false }, updates: { running: false }, cv: { running: false, matched: 4 }, scanFolder: { running: false }, tagFiles: { running: false }, releases: { running: false, releases: [] } },
  });
  return { app, db, calls };
}

async function listen(app) {
  return new Promise((res) => { const s = app.listen(0, () => res(s)); });
}

test('GET /api/series returns cataloged series', async () => {
  const { app } = makeApp();
  const s = await listen(app);
  const r = await fetch(`http://localhost:${s.address().port}/api/series`);
  const body = await r.json();
  assert.equal(body.length, 1);
  assert.equal(body[0].title, 'Batman');
  s.close();
});

test('client routes serve the app shell; unknown /api 404s', async () => {
  const { app } = makeApp();
  const s = await listen(app);
  const base = `http://localhost:${s.address().port}`;
  try {
    const fs = await import('node:fs');
    const uiBuilt = fs.existsSync('frontend/dist/index.html');
    let shell = '';
    for (const p of ['/volume/482', '/settings', '/queue', '/logs', '/?filter=incomplete']) {
      const r = await fetch(base + p);
      if (uiBuilt) {
        assert.equal(r.status, 200, p);
        shell = await r.text();
        assert.match(shell, /<title>BackIssue<\/title>/, p);
      } else {
        // No build yet → a helpful 503, never a hang or a blank page.
        assert.equal(r.status, 503, p);
        assert.match(await r.text(), /npm run build/, p);
      }
    }
    if (uiBuilt) {
      // a real (hashed) asset is still served as itself, not the shell
      const href = shell.match(/href="(\/assets\/[^"]+\.css)"/)?.[1];
      assert.ok(href, 'built shell links a hashed stylesheet');
      const css = await fetch(base + href);
      assert.match(css.headers.get('content-type') || '', /css/);
      assert.match(css.headers.get('cache-control') || '', /immutable/); // hashed → cache forever
    }
    // unknown API path is not swallowed by the catch-all
    assert.equal((await fetch(`${base}/api/nope`)).status, 404);
  } finally {
    s.close();
  }
});

test('POST /api/download queues issues and invokes runDownloads', async () => {
  const { app, calls, db } = makeApp();
  const s = await listen(app);
  const issueId = db.prepare('SELECT id FROM issues LIMIT 1').get().id;
  const r = await fetch(`http://localhost:${s.address().port}/api/download`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ issueIds: [issueId] }),
  });
  const body = await r.json();
  assert.equal(body.queued, 1);
  assert.deepEqual(calls.downloads[0], [issueId]);
  s.close();
});

test('GET /api/settings returns current settings; POST saves them', async () => {
  const { app, calls } = makeApp();
  const s = await listen(app);
  const base = `http://localhost:${s.address().port}`;
  const got = await (await fetch(`${base}/api/settings`)).json();
  assert.equal(got.format, 'cbz');
  const saved = await (await fetch(`${base}/api/settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ format: 'pdf', downloadConcurrency: 8 }),
  })).json();
  assert.equal(saved.format, 'pdf');
  assert.deepEqual(calls.saved, { format: 'pdf', downloadConcurrency: 8 });
  s.close();
});

test('queue: list, pause, and clear', async () => {
  const { app, db } = makeApp();
  const issueId = db.prepare('SELECT id FROM issues LIMIT 1').get().id;
  db.prepare("UPDATE issues SET status='queued' WHERE id=?").run(issueId);
  const s = await listen(app);
  const base = `http://localhost:${s.address().port}`;

  let q = await (await fetch(`${base}/api/queue`)).json();
  assert.equal(q.items.length, 1);
  assert.equal(q.items[0].series_title, 'Batman');
  assert.equal(q.paused, false);

  await fetch(`${base}/api/queue/pause`, { method: 'POST' });
  q = await (await fetch(`${base}/api/queue`)).json();
  assert.equal(q.paused, true);

  const cleared = await (await fetch(`${base}/api/queue/clear`, { method: 'POST' })).json();
  assert.equal(cleared.cleared, 1);
  assert.equal(db.prepare('SELECT status FROM issues WHERE id=?').get(issueId).status, 'pending');
  s.close();
});

test('POST /api/redownload prepares (delete/reset) then queues + starts', async () => {
  const { app, calls, db } = makeApp();
  const issueId = db.prepare('SELECT id FROM issues LIMIT 1').get().id;
  const s = await listen(app);
  const r = await fetch(`http://localhost:${s.address().port}/api/redownload`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ issueIds: [issueId] }),
  });
  assert.equal((await r.json()).queued, 1);
  assert.deepEqual(calls.prepared, [issueId]);
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(calls.downloads.length, 1);
  s.close();
});

test('POST /api/retry-failed requeues failed issues and starts downloads', async () => {
  const { app, calls, db } = makeApp();
  const issueId = db.prepare('SELECT id FROM issues LIMIT 1').get().id;
  db.prepare("UPDATE issues SET status='failed' WHERE id=?").run(issueId);
  const s = await listen(app);
  const r = await fetch(`http://localhost:${s.address().port}/api/retry-failed`, { method: 'POST' });
  const body = await r.json();
  assert.equal(body.requeued, 1);
  assert.equal(db.prepare('SELECT status FROM issues WHERE id=?').get(issueId).status, 'queued');
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(calls.downloads.length, 1);
  s.close();
});

test('collection API: monitor adds a series; detail returns its issues', async () => {
  const { app, db } = makeApp();
  const sid = db.prepare('SELECT id FROM series LIMIT 1').get().id;
  const s = await listen(app);
  const base = `http://localhost:${s.address().port}`;
  let coll = await (await fetch(`${base}/api/collection`)).json();
  assert.equal(coll.length, 0); // not monitored, no files
  await fetch(`${base}/api/collection/${sid}/monitor`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ monitored: true }) });
  coll = await (await fetch(`${base}/api/collection`)).json();
  assert.equal(coll.length, 1);
  assert.equal(coll[0].id, sid);
  const detail = await (await fetch(`${base}/api/collection/${sid}`)).json();
  assert.ok(Array.isArray(detail.issues));
  s.close();
});

test('POST /api/cv/match starts matching; GET /api/cv returns state', async () => {
  const { app, calls } = makeApp();
  const s = await listen(app);
  const base = `http://localhost:${s.address().port}`;
  const ok = await (await fetch(`${base}/api/cv/match`, { method: 'POST' })).json();
  assert.equal(ok.started, true);
  assert.equal(calls.cvMatch, 1);
  const st = await (await fetch(`${base}/api/cv`)).json();
  assert.equal(st.matched, 4);
  s.close();
});

test('POST /api/collection/:id/path sets a comic folder; GET detail returns location', async () => {
  const { app, db } = makeApp();
  const s = await listen(app);
  const base = `http://localhost:${s.address().port}`;
  const sid = db.prepare('SELECT id FROM series LIMIT 1').get().id;
  const r = await (await fetch(`${base}/api/collection/${sid}/path`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/comics/Batman' }) })).json();
  assert.equal(r.path, '/comics/Batman');
  assert.equal(r.location, '/comics/Batman');
  const det = await (await fetch(`${base}/api/collection/${sid}`)).json();
  assert.equal(det.location, '/comics/Batman');
  s.close();
});

test('schedules API: list, update cron/enabled (validated), run now', async () => {
  const { app, calls } = makeApp();
  const s = await listen(app);
  const base = `http://localhost:${s.address().port}`;
  const list = await (await fetch(`${base}/api/schedules`)).json();
  assert.equal(list[0].key, 'releases');
  const set = await (await fetch(`${base}/api/schedules/releases`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cron: '0 9 * * 3', enabled: true }) })).json();
  assert.deepEqual(calls.schedSet, { key: 'releases', cron: '0 9 * * 3', enabled: true });
  assert.equal(set.cron, '0 9 * * 3');
  assert.equal((await fetch(`${base}/api/schedules/releases`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) })).status, 400);
  assert.equal((await fetch(`${base}/api/schedules/nope`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cron: '* * * * *' }) })).status, 404);
  const run = await (await fetch(`${base}/api/schedules/releases/run`, { method: 'POST' })).json();
  assert.equal(calls.schedRun, 'releases');
  assert.equal(run.started, true);
  s.close();
});

test('GET /api/jobs lists jobs; POST /api/jobs/clear clears finished', async () => {
  const { app, calls } = makeApp();
  const s = await listen(app);
  const base = `http://localhost:${s.address().port}`;
  const jobs = await (await fetch(`${base}/api/jobs`)).json();
  assert.equal(jobs[0].type, 'cv-match');
  assert.equal(jobs[0].status, 'done');
  const c = await (await fetch(`${base}/api/jobs/clear`, { method: 'POST' })).json();
  assert.equal(calls.jobsCleared, true);
  assert.equal(c.remaining, 0);
  s.close();
});

test('POST /api/releases/check starts the check; GET /api/releases returns state', async () => {
  const { app, calls } = makeApp();
  const s = await listen(app);
  const base = `http://localhost:${s.address().port}`;
  const r = await (await fetch(`${base}/api/releases/check`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ week: '26', year: '2026' }) })).json();
  assert.equal(r.started, true);
  assert.deepEqual(calls.releasesChecked, { week: '26', year: '2026' });
  const st = await (await fetch(`${base}/api/releases`)).json();
  assert.equal(typeof st.running, 'boolean');
  s.close();
});

test('POST /api/collection/:id/tag starts native tagging; GET /api/tag-files returns state', async () => {
  const { app, calls } = makeApp();
  const s = await listen(app);
  const base = `http://localhost:${s.address().port}`;
  const r = await (await fetch(`${base}/api/collection/11/tag`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ onlyUntagged: true }),
  })).json();
  assert.equal(calls.taggedSeries, 11);
  assert.equal(calls.tagOpts.onlyUntagged, true); // only untagged files, not a full re-tag
  assert.equal(r.started, true);
  const st = await (await fetch(`${base}/api/tag-files`)).json();
  assert.equal(typeof st.running, 'boolean');
  s.close();
});

test('POST /api/collection/:id/refresh re-pulls from ComicVine', async () => {
  const { app, calls } = makeApp();
  const s = await listen(app);
  const base = `http://localhost:${s.address().port}`;
  const r = await (await fetch(`${base}/api/collection/6/refresh`, { method: 'POST' })).json();
  assert.equal(calls.refreshed, 6);
  assert.equal(r.issues, 7);
  s.close();
});

test('POST /api/collection/:id/delete removes a comic (keeps files by default)', async () => {
  const { app, calls } = makeApp();
  const s = await listen(app);
  const base = `http://localhost:${s.address().port}`;
  // default: no deleteFiles
  const r1 = await (await fetch(`${base}/api/collection/4/delete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
  assert.deepEqual(calls.deleted, { id: 4, deleteFiles: false });
  assert.equal(r1.deletedFiles, 0);
  // opt-in file deletion
  const r2 = await (await fetch(`${base}/api/collection/4/delete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deleteFiles: true }) })).json();
  assert.equal(calls.deleted.deleteFiles, true);
  assert.equal(r2.deletedFiles, 3);
  s.close();
});

test('POST /api/collection/:id/scan starts a per-volume folder scan', async () => {
  const { app, calls } = makeApp();
  const s = await listen(app);
  const base = `http://localhost:${s.address().port}`;
  const r = await (await fetch(`${base}/api/collection/8/scan`, { method: 'POST' })).json();
  assert.equal(calls.scanned, 8);
  assert.equal(r.started, true);
  const st = await (await fetch(`${base}/api/scan-folder`)).json();
  assert.equal(typeof st.running, 'boolean');
  s.close();
});


test('POST /api/collection/add-cv adds from ComicVine (400 without id)', async () => {
  const { app, calls } = makeApp();
  const s = await listen(app);
  const base = `http://localhost:${s.address().port}`;
  const bad = await fetch(`${base}/api/collection/add-cv`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(bad.status, 400);
  const r = await (await fetch(`${base}/api/collection/add-cv`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ comicvineId: 42 }) })).json();
  assert.equal(calls.addedCv, 42);
  assert.equal(r.outcome, 'created');
  s.close();
});

test('GET /api/cv/search proxies ComicVine search', async () => {
  const { app, calls } = makeApp();
  const s = await listen(app);
  const base = `http://localhost:${s.address().port}`;
  const r = await (await fetch(`${base}/api/cv/search?q=Earth%20X`)).json();
  assert.equal(calls.cvSearch, 'Earth X');
  assert.equal(r[0].name, 'Earth X');
  s.close();
});

test('POST /api/collection/:id/cleanup removes superseded files', async () => {
  const { app, calls } = makeApp();
  const s = await listen(app);
  const base = `http://localhost:${s.address().port}`;
  const r = await (await fetch(`${base}/api/collection/12/cleanup`, { method: 'POST' })).json();
  assert.equal(calls.cleaned, 12);
  assert.equal(r.removed, 3);
  s.close();
});

test('GET /api/logs returns entries + counts; clear works', async () => {
  const { app, calls } = makeApp();
  const s = await listen(app);
  const base = `http://localhost:${s.address().port}`;
  const r = await (await fetch(`${base}/api/logs?level=error&category=download`)).json();
  assert.equal(calls.logsQuery.level, 'error');
  assert.equal(calls.logsQuery.category, 'download');
  assert.equal(r.logs[0].message, 'Download failed: X — no source');
  assert.equal(r.counts.error, 1);
  assert.deepEqual(r.categories, ['download', 'usenet']);
  const c = await (await fetch(`${base}/api/logs/clear`, { method: 'POST' })).json();
  assert.equal(calls.logsCleared, true);
  assert.equal(c.cleared, 4);
  s.close();
});

test('POST /api/collection/:id/aliases saves alternative names', async () => {
  const { app, calls } = makeApp();
  const s = await listen(app);
  const base = `http://localhost:${s.address().port}`;
  const r = await (await fetch(`${base}/api/collection/42/aliases`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ aliases: '2000AD' }) })).json();
  assert.deepEqual(calls.setAliases, { id: 42, aliases: '2000AD' });
  assert.deepEqual(r.searchNames, ['2000 AD', '2000AD']);
  s.close();
});

test('usenet: manual search returns releases; grab validates + forwards', async () => {
  const { app, calls } = makeApp();
  const s = await listen(app);
  const base = `http://localhost:${s.address().port}`;
  const search = await (await fetch(`${base}/api/usenet/search`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'Saga 1' }) })).json();
  assert.equal(calls.usenetSearch.query, 'Saga 1');
  assert.equal(search.results[0].nzbUrl, 'http://nz/1.nzb');
  // grab requires seriesId + cvIssueId + nzbUrl
  assert.equal((await fetch(`${base}/api/usenet/grab`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 400);
  const grab = await (await fetch(`${base}/api/usenet/grab`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ seriesId: 3, cvIssueId: 71, nzbUrl: 'http://nz/1.nzb', releaseTitle: 'Saga 001' }) })).json();
  assert.equal(grab.grabbed, true);
  assert.equal(calls.usenetGrab.nzbUrl, 'http://nz/1.nzb');
  s.close();
});

test('sources: GET /api/sources lists enabled sources in priority order', async () => {
  const { app } = makeApp();
  const s = await listen(app);
  const base = `http://localhost:${s.address().port}`;
  const r = await (await fetch(`${base}/api/sources`)).json();
  assert.deepEqual(r.sources.map((x) => x.id), ['usenet', 'torrent']);
  s.close();
});

test('an async route that throws returns 500 JSON instead of hanging (express 5)', async () => {
  const db = openDb(':memory:');
  const app = createApp({
    db, state: { queue: {} },
    cleanupSeriesFiles: async () => { throw new Error('disk exploded'); },
  });
  const s = await listen(app);
  const base = `http://localhost:${s.address().port}`;
  const res = await fetch(`${base}/api/collection/1/cleanup`, { method: 'POST' });
  assert.equal(res.status, 500);           // NOT a hung request
  const body = await res.json();
  assert.match(body.error, /disk exploded/);
  s.close();
});

test('stats: GET /api/stats returns the collection stats payload', async () => {
  const { app } = makeApp();
  const s = await listen(app);
  const base = `http://localhost:${s.address().port}`;
  const st = await (await fetch(`${base}/api/stats`)).json();
  assert.equal(st.files.total, 5);
  assert.equal(st.collection.series, 2);
  s.close();
});

test('library tools: list catalog + run a tool', async () => {
  const { app, calls } = makeApp();
  const s = await listen(app);
  const base = `http://localhost:${s.address().port}`;
  const st = await (await fetch(`${base}/api/tools`)).json();
  assert.equal(st.catalog[0].id, 'verify');
  const r = await (await fetch(`${base}/api/tools/verify`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ corruptOnly: true }),
  })).json();
  assert.equal(calls.tool, 'verify');
  assert.deepEqual(calls.toolOpts, { corruptOnly: true }); // options forwarded to the tool
  assert.equal(r.started, true);
  s.close();
});

test('library import: scan, list, match, confirm, skip, run', async () => {
  const { app, calls } = makeApp();
  const s = await listen(app);
  const base = `http://localhost:${s.address().port}`;
  await fetch(`${base}/api/import/scan`, { method: 'POST' });
  assert.deepEqual(calls.importScan, { fresh: false }); // default: incremental
  await fetch(`${base}/api/import/scan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fresh: true }) });
  assert.deepEqual(calls.importScan, { fresh: true }); // full rescan
  const state = await (await fetch(`${base}/api/import`)).json();
  assert.equal(state.candidates[0].name, 'Invincible');
  const m = await (await fetch(`${base}/api/import/candidate/1/match`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cvId: 17993, cvName: 'Invincible' }),
  })).json();
  assert.equal(calls.importMatch.m.cvId, 17993);
  assert.equal(m.status, 'ready');
  await fetch(`${base}/api/import/candidate/1/confirm`, { method: 'POST' });
  assert.equal(calls.importConfirm, 1);
  await fetch(`${base}/api/import/candidate/1/skip`, { method: 'POST' });
  assert.equal(calls.importSkip, 1);
  await fetch(`${base}/api/import/run`, { method: 'POST' });
  assert.equal(calls.importRun, true);
  // match requires a cvId
  const bad = await fetch(`${base}/api/import/candidate/1/match`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(bad.status, 400);
  s.close();
});

test('GET /api/cv/volume/:id looks up one volume (400 on bad id)', async () => {
  const { app, calls } = makeApp();
  const s = await listen(app);
  const base = `http://localhost:${s.address().port}`;
  const v = await (await fetch(`${base}/api/cv/volume/72763`)).json();
  assert.equal(calls.volumeInfo, 72763);
  assert.equal(v.name, 'Aquaman and The Others');
  assert.equal((await fetch(`${base}/api/cv/volume/abc`)).status, 400);
  s.close();
});

test('GET /api/issue/:cvIssueId returns issue info', async () => {
  const { app, calls } = makeApp();
  const s = await listen(app);
  const base = `http://localhost:${s.address().port}`;
  const r = await (await fetch(`${base}/api/issue/453120`)).json();
  assert.equal(calls.issueInfo, 453120);
  assert.equal(r.name, 'One');
  assert.equal(r.number, '1');
  s.close();
});

test('POST /api/collection/:id/cv sets a manual match (400 without id)', async () => {
  const { app, calls } = makeApp();
  const s = await listen(app);
  const base = `http://localhost:${s.address().port}`;
  const bad = await fetch(`${base}/api/collection/5/cv`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(bad.status, 400);
  const r = await (await fetch(`${base}/api/collection/5/cv`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ comicvineId: 7 }) })).json();
  assert.deepEqual(calls.cvSet, { id: 5, cvId: 7 });
  assert.equal(r.cv.id, 7);
  s.close();
});

test('legacy basic-auth config migrates to an admin user; basic still works', async () => {
  const config = (await import('../src/config.js')).default;
  const db = openDb(':memory:');
  try {
    // createApp() runs the migration: authUser/authPass become the first admin.
    config.authUser = 'me'; config.authPass = 's3cretpass';
    const app = createApp({ db, state: { queue: {} }, stats: () => ({ ok: 1 }) });
    const s = await listen(app);
    const base = `http://localhost:${s.address().port}`;
    try {
      // a user now exists → auth is active
      assert.equal((await fetch(`${base}/api/stats`)).status, 401);
      // HTTP Basic verified against the users table (the migrated admin)
      const auth = { Authorization: 'Basic ' + Buffer.from('me:s3cretpass').toString('base64') };
      assert.equal((await fetch(`${base}/api/stats`, { headers: auth })).status, 200);
      assert.equal((await fetch(`${base}/api/stats`, {
        headers: { Authorization: 'Basic ' + Buffer.from('me:wrong').toString('base64') },
      })).status, 401);
      // the migrated account is a real admin (admin surface reachable)
      assert.equal((await fetch(`${base}/api/users`, { headers: auth })).status, 200);
      // the SPA shell stays public (login page must load)
      assert.notEqual((await fetch(`${base}/`)).status, 401);
    } finally { s.close(); }
  } finally {
    config.authUser = ''; config.authPass = '';
  }
});

test('manual torrent pack search + grab routes', async () => {
  const { app, calls } = makeApp();
  const s = await listen(app);
  const base = `http://localhost:${s.address().port}`;
  const sr = await (await fetch(`${base}/api/torrent/search`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ seriesId: 3 }) })).json();
  assert.deepEqual(calls.torrentSearch, { seriesId: 3 });
  assert.equal(sr.results[0].seeders, 40);
  const bad = await fetch(`${base}/api/torrent/grab-pack`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ seriesId: 3 }) });
  assert.equal(bad.status, 400); // downloadUrl required
  const ok = await (await fetch(`${base}/api/torrent/grab-pack`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ seriesId: 3, downloadUrl: 'magnet:?x', releaseTitle: 'pack' }) })).json();
  assert.equal(ok.grabbed, true);
  assert.equal(calls.torrentGrabPack.seriesId, 3);
  s.close();
});

test('CV redownload re-queues an issue whose row is already done (the delete-then-cannot-queue bug)', async () => {
  const { app, calls, db } = makeApp();
  // A previously downloaded issue: cv-identity row marked done with a file_path.
  db.prepare('INSERT INTO cv_issues (comicvine_id, cv_series_id, issue_number, name) VALUES (1175701, 999, ?, ?)').run('16', 'Minor Arcana #16');
  const sid = db.prepare('SELECT id FROM series LIMIT 1').get().id;
  const issueId = db.prepare('INSERT INTO issues (series_id, title, issue_number, url, status, file_path) VALUES (?,?,?,?,?,?)')
    .run(sid, 'Minor Arcana #16', '16', 'cvissue:1175701', 'done', '/tmp/nope.cbz').lastInsertRowid;
  const s = await listen(app);
  try {
    const r = await (await fetch(`http://localhost:${s.address().port}/api/collection/${sid}/redownload`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cvIssueIds: [1175701] }),
    })).json();
    assert.equal(r.queued, 1);
    const row = db.prepare('SELECT status, file_path FROM issues WHERE id=?').get(issueId);
    assert.equal(row.status, 'queued', 'a done row must be reset so it actually re-queues — files were already deleted');
    assert.equal(row.file_path, null, 'stale file_path must be cleared (the file is gone)');
    await new Promise((res) => setTimeout(res, 20));
    assert.equal(calls.downloads.length, 1, 'the download worker must be started');
  } finally {
    s.close();
  }
});

test('CV download resets a stale done row whose file is gone (else the queue guard strands it)', async () => {
  const { app, calls, db } = makeApp();
  db.prepare('INSERT INTO cv_issues (comicvine_id, cv_series_id, issue_number, name) VALUES (1175702, 999, ?, ?)').run('17', 'Minor Arcana #17');
  const sid = db.prepare('SELECT id FROM series LIMIT 1').get().id;
  // Row claims done, but the file doesn't exist and no library_files row owns it.
  const issueId = db.prepare('INSERT INTO issues (series_id, title, issue_number, url, status, file_path) VALUES (?,?,?,?,?,?)')
    .run(sid, 'Minor Arcana #17', '17', 'cvissue:1175702', 'done', '/definitely/not/there.cbz').lastInsertRowid;
  const s = await listen(app);
  try {
    const r = await (await fetch(`http://localhost:${s.address().port}/api/collection/${sid}/download`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cvIssueIds: [1175702] }),
    })).json();
    assert.equal(r.queued, 1);
    const row = db.prepare('SELECT status FROM issues WHERE id=?').get(issueId);
    assert.equal(row.status, 'queued', "a 'done' claim with no file on disk is stale — the download must still queue");
    await new Promise((res) => setTimeout(res, 20));
    assert.equal(calls.downloads.length, 1);
  } finally {
    s.close();
  }
});

test('multi-source search: /api/search aggregates; /api/search/grab pins + queues', async () => {
  const { app, calls } = makeApp();
  const s = await listen(app);
  const base = `http://localhost:${s.address().port}`;
  try {
    const sr = await (await fetch(`${base}/api/search`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ seriesId: 3, cvIssueId: 71, number: '12' }) })).json();
    assert.deepEqual(calls.searchSources, { seriesId: 3, cvIssueId: 71, number: '12' });
    assert.equal(sr.results[0].source, 'usenet');
    assert.deepEqual(sr.sources, ['usenet']);
    // grab requires seriesId + cvIssueId + result
    assert.equal((await fetch(`${base}/api/search/grab`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 400);
    const g = await (await fetch(`${base}/api/search/grab`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ result: sr.results[0], seriesId: 3, cvIssueId: 71, number: '12', name: 'Saga #12' }) })).json();
    assert.equal(g.queued, true);
    assert.equal(calls.manualGrab.result.source, 'usenet');
    assert.equal(calls.manualGrab.seriesId, 3);
    // A pack result routes to the pack pipeline, not the single-issue pin.
    const gp = await (await fetch(`${base}/api/search/grab`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ result: { source: 'ddl', isPack: true, postUrl: 'https://x/p', title: 'Saga Vol 1 (#1-6)' }, seriesId: 3, cvIssueId: 71, number: '12', name: 'Saga' }) })).json();
    assert.equal(gp.grabbed, true);
    assert.equal(calls.grabPack.source, 'ddl');
    assert.equal(calls.grabPack.seriesId, 3);
  } finally {
    s.close();
  }
});

test('multi-source pack search: /api/packs/search aggregates; /api/packs/grab dispatches', async () => {
  const { app, calls } = makeApp();
  const s = await listen(app);
  const base = `http://localhost:${s.address().port}`;
  try {
    const sr = await (await fetch(`${base}/api/packs/search`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ seriesId: 3 }) })).json();
    assert.deepEqual(calls.searchPacks, { seriesId: 3 });
    assert.equal(sr.results[0].isPack, true);
    assert.deepEqual(sr.sources, ['torrent', 'ddl']);
    assert.equal((await fetch(`${base}/api/packs/grab`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 400);
    const g = await (await fetch(`${base}/api/packs/grab`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ result: sr.results[0], seriesId: 3 }) })).json();
    assert.equal(g.grabbed, true);
    assert.equal(calls.packGrab.source, 'torrent');
    assert.equal(calls.packGrab.seriesId, 3);
  } finally {
    s.close();
  }
});

test('GET /api/events is an SSE stream: hello, then a changed event naming domains', async () => {
  const { app } = makeApp();
  const s = await listen(app);
  const base = `http://localhost:${s.address().port}`;
  const ac = new AbortController();
  try {
    const res = await fetch(`${base}/api/events`, { signal: ac.signal });
    assert.match(res.headers.get('content-type') || '', /text\/event-stream/);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const deadline = Date.now() + 5000;
    // First the hello handshake, then the first tick reports every domain changed.
    while (!/event: changed/.test(buf) && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
    }
    assert.match(buf, /event: hello/);
    assert.match(buf, /event: changed/);
    const data = buf.match(/event: changed\ndata: (.+)/)?.[1];
    const domains = JSON.parse(data);
    for (const key of ['status', 'queue', 'jobs', 'schedules', 'tools']) {
      assert.ok(domains.includes(key), `first tick should report ${key}`);
    }
  } finally {
    ac.abort();               // close our SSE connection
    s.closeAllConnections?.(); // and any straggler, so the test can never hang
    s.close();
  }
});

test('queue exposes active pack grabs with live progress; grabs can be cancelled', async () => {
  const { app, calls, db } = makeApp();
  const { recordGrab } = await import('../src/db.js');
  recordGrab(db, { source: 'torrent', downloadId: 'h', title: '0-Day Week of X', kind: 'pack', seriesId: null }); // grab id 1... may vary
  db.prepare("UPDATE grabs SET id=7 WHERE kind='pack'").run(); // pin the id the packProgress mock uses
  const s = await listen(app);
  const base = `http://localhost:${s.address().port}`;
  const q = await (await fetch(`${base}/api/queue`)).json();
  assert.equal(q.packs.length, 1);
  assert.equal(q.packs[0].title, '0-Day Week of X');
  assert.equal(q.packs[0].live.progress, 42);
  const c = await (await fetch(`${base}/api/grabs/7/cancel`, { method: 'POST' })).json();
  assert.equal(c.cancelled, true);
  assert.equal(calls.cancelGrab, 7);
  s.close();
});

test('add-cv auto-queues every missing issue of the added volume', async () => {
  const { app, db, calls } = makeApp();
  // what a real addFromCv leaves behind: the local series row (the stub
  // returns seriesId 5) and the CV volume's cached issue list
  db.prepare("INSERT INTO series (id, title, url) VALUES (5, 'Earth X', 'cv:42')").run();
  upsertCvSeries(db, { id: 42, name: 'Earth X' });
  upsertCvIssue(db, { id: 901, cv_series_id: 42, issue_number: '1', name: 'One' });
  upsertCvIssue(db, { id: 902, cv_series_id: 42, issue_number: '2', name: 'Two' });
  const s = await listen(app);
  const base = `http://localhost:${s.address().port}`;
  try {
    const r = await (await fetch(`${base}/api/collection/add-cv`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ comicvineId: 42 }),
    })).json();
    assert.equal(r.queued, 2, 'both missing issues queued on add');
    const rows = db.prepare("SELECT status FROM issues WHERE url LIKE 'cvissue:%'").all();
    assert.equal(rows.length, 2);
    assert.ok(rows.every((x) => x.status === 'queued'));
    assert.ok(calls.downloads.length >= 1, 'the queue worker was kicked');
  } finally { s.close(); }
});
