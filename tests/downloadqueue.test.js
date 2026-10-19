// The download queue's failure paths: a throw outside a source call fails the
// one issue (not the worker), a placed file is never fetched twice, crash
// recovery checks the issue's REAL destination, and a re-download keeps the
// old copy until a good replacement exists.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bi-dlqueue-'));
process.env.DATA_DIR = tmp;
process.env.PLUGINS_DIR = path.join(tmp, 'plugins');
fs.mkdirSync(process.env.PLUGINS_DIR);

let D, db, pluginApi, buildCbz, config;
const fetches = [];
before(async () => {
  D = await import('../src/db.js');
  ({ pluginApi } = await import('../src/plugins.js'));
  ({ buildCbz } = await import('../src/downloader.js'));
  config = (await import('../src/config.js')).default;
  config.actionDelayMs = 1;
  config.renameDownloads = true; config.filePattern = '';
  await import('../src/sources/index.js');
  pluginApi.registerSource({
    id: 'fake', kind: 'immediate', isEnabled: () => true,
    find: async (ctx) => ({ title: ctx.issue.title }),
    fetch: async (cand, ctx) => {
      fetches.push(ctx.issue.id);
      return { buffer: await buildCbz([{ name: '001.jpg', buffer: Buffer.from('img') }]), format: 'cbz' };
    },
  });
});

function seriesWithIssue(name, n) {
  db = D.openDb(':memory:');
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  const sid = D.upsertSeries(db, { title: name, url: `local:${name}` });
  D.setSeriesPath(db, sid, dir);
  const id = D.upsertIssue(db, { seriesId: sid, title: `${name} #${n}`, issueNumber: String(n), url: `cvissue:${100 + n}` });
  return { sid, id, dir };
}

test('a throw outside the source calls fails that issue and the queue run still settles', async () => {
  const { runQueue } = await import('../src/downloader.js');
  const { id } = seriesWithIssue('Throwy', 1);
  D.queueIssues(db, [id]);
  await runQueue({ db, concurrency: 1, onProgress: (p) => { if (p.event === 'searching') throw new Error('listener broke'); } });
  const row = db.prepare('SELECT status, error FROM issues WHERE id=?').get(id);
  assert.equal(row.status, 'failed');
  assert.match(row.error, /listener broke/);
});

test('a failure after the file is placed does not fetch and place a second copy', async () => {
  const { runQueue } = await import('../src/downloader.js');
  const { id, dir } = seriesWithIssue('Once', 2);
  db.exec('DROP TABLE import_history'); // recording the import throws
  D.queueIssues(db, [id]);
  fetches.length = 0;
  await runQueue({ db, concurrency: 1 });
  assert.deepEqual(fetches, [id], 'fetched exactly once');
  const files = fs.readdirSync(dir).filter((f) => /\.cbz$/.test(f));
  assert.equal(files.length, 1, `one file on disk, got ${files}`);
  assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith('.part')), 'no .part left');
});

test('recovery finds a finished file at the series folder and requeues a truncated one', async () => {
  const { reconcileDownloading, targetPath } = await import('../src/downloader.js');
  const { sid, id, dir } = seriesWithIssue('Recover', 3);
  const id2 = D.upsertIssue(db, { seriesId: sid, title: 'Recover #4', issueNumber: '4', url: 'cvissue:104' });
  const issue = (x) => db.prepare('SELECT * FROM issues WHERE id=?').get(x);
  const good = targetPath('Recover', issue(id), 'cbz', undefined, dir);
  fs.writeFileSync(good, await buildCbz([{ name: '001.jpg', buffer: Buffer.from('img') }]));
  fs.writeFileSync(targetPath('Recover', issue(id2), 'cbz', undefined, dir), Buffer.from('PK\x03\x04trunc'));
  D.setIssueStatus(db, id, 'downloading');
  D.setIssueStatus(db, id2, 'downloading');
  await reconcileDownloading(db);
  assert.equal(issue(id).status, 'done');
  assert.equal(issue(id).file_path, good);
  assert.equal(issue(id2).status, 'queued', 'a truncated file is not a finished download');
});

test('a re-download keeps the old copy, then replaces it under the clean name', async () => {
  const { finishImport, buildIssueContext, targetPath } = await import('../src/downloader.js');
  const { sid, id, dir } = seriesWithIssue('Again', 5);
  const issue = () => db.prepare('SELECT * FROM issues WHERE id=?').get(id);
  const clean = targetPath('Again', issue(), 'cbz', undefined, dir);
  fs.writeFileSync(clean, await buildCbz([{ name: 'old.jpg', buffer: Buffer.from('old') }]));
  D.upsertLibraryFile(db, { path: clean, dir, name: path.basename(clean), size: 1, mtime: 1, valid: 1 });
  D.linkLibraryFile(db, clean, sid, id);
  db.prepare('UPDATE library_files SET cv_issue_id=105 WHERE path=?').run(clean);
  D.setIssueStatus(db, id, 'done', { filePath: clean });

  D.clearIssuesForRedownload(db, [id]);
  assert.ok(fs.existsSync(clean), 'nothing deleted before the replacement exists');

  const ic = await buildIssueContext(db, issue(), () => null);
  const fetched = { buffer: await buildCbz([{ name: 'new.jpg', buffer: Buffer.from('new') }]), format: 'cbz' };
  const r = await finishImport(db, { issue: issue(), ic, fetched, source: 'fake' });
  assert.equal(r.path, clean);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => /\.cbz$/.test(f)), [path.basename(clean)]);
  const JSZip = (await import('jszip')).default;
  assert.ok((await JSZip.loadAsync(fs.readFileSync(clean))).file('new.jpg'), 'the new copy holds the name');
  assert.equal(issue().file_path, clean);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM library_files WHERE path=?').get(clean).n, 1);
});

test('re-downloading an in-flight issue leaves it alone', () => {
  const { id } = seriesWithIssue('Busy', 6);
  D.setIssueStatus(db, id, 'grabbed');
  D.clearIssuesForRedownload(db, [id]);
  assert.equal(db.prepare('SELECT status FROM issues WHERE id=?').get(id).status, 'grabbed');
});
