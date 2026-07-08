import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDb, upsertSeries, setSeriesCv, upsertCvSeries, upsertCvIssue, upsertLibraryFile, linkFileCvIssue, getLibraryFile } from '../src/db.js';
import { convertAllCbr, removeAllDuplicates, relinkAllCv, verifyLibrary, scanEntireLibrary, tagAllUntagged } from '../src/tools.js';
import JSZip from 'jszip';

async function realCbz(p) {
  const z = new JSZip();
  z.file('001.jpg', Buffer.from([1, 2, 3]));
  await fs.writeFile(p, await z.generateAsync({ type: 'nodebuffer' }));
}

test('scanEntireLibrary: indexes comic files found under the root folders', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lib-'));
  const dir = path.join(root, 'Image', 'Saga (2012)');
  await fs.mkdir(dir, { recursive: true });
  await realCbz(path.join(dir, 'Saga V2012 #001.cbz'));
  await realCbz(path.join(dir, 'Saga V2012 #002.cbz'));
  const db = openDb(':memory:');
  const r = await scanEntireLibrary(db, [root]);
  assert.equal(r.files, 2); // both discovered + indexed
  assert.ok(getLibraryFile(db, path.join(dir, 'Saga V2012 #001.cbz')));
  await fs.rm(root, { recursive: true, force: true });
});

test('convertAllCbr: a ZIP-content .cbr is renamed to .cbz (not "not a RAR archive")', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tools-'));
  const cbr = path.join(dir, 'Action Comics V1938 #001.cbr');
  await realCbz(cbr); // ZIP bytes, .cbr name
  const db = openDb(':memory:');
  const sid = upsertSeries(db, { title: 'Action Comics', url: 'cv:1' });
  upsertLibraryFile(db, { path: cbr, dir, name: path.basename(cbr), size: 1, mtime: 1, valid: 1, series_id: sid });
  const r = await convertAllCbr(db);
  assert.deepEqual([r.total, r.converted, r.failed], [1, 1, 0]);
  const cbz = cbr.replace(/\.cbr$/, '.cbz');
  assert.equal(getLibraryFile(db, cbr), undefined); // row re-pointed
  assert.ok(getLibraryFile(db, cbz));
  assert.equal(await fs.access(cbr).then(() => true, () => false), false); // .cbr gone
  assert.ok(await fs.access(cbz).then(() => true, () => false));           // .cbz present
  await fs.rm(dir, { recursive: true, force: true });
});

test('convertAllCbr: converts every valid .cbr and re-points the index', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tools-'));
  const cbr = path.join(dir, 'Saga V2012 #003.cbr');
  await fs.copyFile('tests/fixtures/sample.cbr', cbr);
  const db = openDb(':memory:');
  const sid = upsertSeries(db, { title: 'Saga', url: 'cv:1' });
  upsertLibraryFile(db, { path: cbr, dir, name: path.basename(cbr), size: 1, mtime: 1, valid: 1, series_id: sid });
  const r = await convertAllCbr(db);
  assert.deepEqual([r.total, r.converted, r.failed], [1, 1, 0]);
  const cbz = cbr.replace(/\.cbr$/, '.cbz');
  assert.equal(getLibraryFile(db, cbr), undefined);
  assert.ok(getLibraryFile(db, cbz));
  assert.ok(await fs.access(cbz).then(() => true, () => false));
  await fs.rm(dir, { recursive: true, force: true });
});

test('convertAllCbr: when a valid .cbz already exists, removes the redundant .cbr', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tools-'));
  const cbr = path.join(dir, 'Saga V2012 #003.cbr');
  const cbz = path.join(dir, 'Saga V2012 #003.cbz');
  await fs.copyFile('tests/fixtures/sample.cbr', cbr);
  // a real, valid .cbz sibling for the same comic (convert the fixture to make one)
  const { convertCbrToCbz } = await import('../src/archive.js');
  const tmpCbr = path.join(dir, 'tmp.cbr');
  await fs.copyFile('tests/fixtures/sample.cbr', tmpCbr);
  await convertCbrToCbz(tmpCbr); // → tmp.cbz
  await fs.rename(path.join(dir, 'tmp.cbz'), cbz);
  const db = openDb(':memory:');
  const sid = upsertSeries(db, { title: 'Saga', url: 'cv:1' });
  upsertLibraryFile(db, { path: cbr, dir, name: path.basename(cbr), size: 1, mtime: 1, valid: 1, series_id: sid });
  upsertLibraryFile(db, { path: cbz, dir, name: path.basename(cbz), size: 1, mtime: 1, valid: 1, series_id: sid });

  const r = await convertAllCbr(db);
  assert.equal(r.deduped, 1);
  assert.equal(r.converted, 0);
  assert.equal(await fs.access(cbr).then(() => true, () => false), false); // .cbr removed
  assert.equal(getLibraryFile(db, cbr), undefined);
  assert.ok(getLibraryFile(db, cbz)); // .cbz kept
  await fs.rm(dir, { recursive: true, force: true });
});

test('removeAllDuplicates: drops invalid files superseded by a good copy, across series', async () => {
  const db = openDb(':memory:');
  const s = upsertSeries(db, { title: 'X', url: 'cv:1' });
  upsertLibraryFile(db, { path: '/a.cbr', dir: '/', name: 'a.cbr', size: 1, mtime: 1, valid: 0, series_id: s });
  linkFileCvIssue(db, '/a.cbr', 100);
  upsertLibraryFile(db, { path: '/a.cbz', dir: '/', name: 'a.cbz', size: 1, mtime: 1, valid: 1, series_id: s });
  linkFileCvIssue(db, '/a.cbz', 100);
  const r = await removeAllDuplicates(db);
  assert.equal(r.removed, 1);
  assert.equal(getLibraryFile(db, '/a.cbr'), undefined);
});

test('relinkAllCv: re-maps owned files to CV issues for matched series', async () => {
  const db = openDb(':memory:');
  const s = upsertSeries(db, { title: 'Invincible', url: 'cv:20' });
  setSeriesCv(db, s, 20, { locked: 1 });
  upsertCvSeries(db, { id: 20, name: 'Invincible', count_of_issues: 1 });
  upsertCvIssue(db, { id: 201, cv_series_id: 20, number: '1', name: 'One' });
  upsertLibraryFile(db, { path: '/inv1.cbz', dir: '/', name: 'Invincible V2003 #001.cbz', size: 1, mtime: 1, valid: 1, series_id: s }); // not yet linked
  const r = await relinkAllCv(db);
  assert.equal(r.seriesRelinked, 1);
  assert.equal(getLibraryFile(db, '/inv1.cbz').cv_issue_id, 201);
});

test('verifyLibrary: repacks a RAR-content .cbz into a real ZIP and marks it valid', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'lib-'));
  const p = path.join(d, 'prog.cbz');
  await fs.copyFile('tests/fixtures/sample.cbr', p); // RAR bytes, .cbz name
  const db = openDb(':memory:');
  const s = upsertSeries(db, { title: 'X', url: 'cv:1' });
  upsertLibraryFile(db, { path: p, dir: d, name: 'prog.cbz', size: 1, mtime: 1, valid: 0, error: 'End of central directory record signature not found.', series_id: s });
  const r = await verifyLibrary(db);
  assert.equal(r.repacked, 1);
  assert.equal(r.corrupt, 0);
  const row = getLibraryFile(db, p);
  assert.equal(row.valid, 1);
  assert.equal(row.error, null);
  assert.equal(row.page_count, 2); // refreshed from the repacked zip
  const head = await fs.readFile(p);
  assert.equal(head[0] === 0x50 && head[1] === 0x4b, true); // file is now a real ZIP (PK)
  await fs.rm(d, { recursive: true, force: true });
});

test('tagAllUntagged: counts untagged CV-matched files, links via a volume refresh, reports the rest', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tag-'));
  const db = openDb(':memory:');
  const sid = upsertSeries(db, { title: 'Saga (2012)', url: 'cv:46568' });
  setSeriesCv(db, sid, 46568, { locked: 0 });
  upsertCvSeries(db, { id: 46568, name: 'Saga', publisher: 'Image', start_year: '2012', count_of_issues: 1 });
  // Both untagged and NOT yet linked to a CV issue (cv_issue_id null).
  const f1 = path.join(dir, 'Saga V2012 #001 (2012).cbz'); await realCbz(f1); // #1 exists in the volume → links on refresh
  const f2 = path.join(dir, 'Saga V2012 #999 (2012).cbz'); await realCbz(f2); // #999 not in the volume → stays unmatched
  for (const p of [f1, f2]) upsertLibraryFile(db, { path: p, dir, name: path.basename(p), size: 1, mtime: 1, valid: 1, has_metadata: 0, series_id: sid });

  const client = {
    async volume() { return { id: 46568, name: 'Saga', publisher: 'Image', start_year: '2012', count_of_issues: 1, issues: [{ id: 1, number: '1', name: 'a' }] }; },
    async issue(id) { return { id, name: 'Ch', issue_number: '1', cover_date: '2012-01-01', store_date: null, description: 'd', credits: [], site_detail_url: null }; },
  };
  const r = await tagAllUntagged(db, client);
  assert.equal(r.total, 2);     // both counted (previously the unlinked ones were invisible → "0 total")
  assert.equal(r.tagged, 1);    // #1 linked by the refresh, then tagged
  assert.equal(r.problems, 1);  // #999 has no CV issue → reported, not silently skipped
  assert.equal(getLibraryFile(db, f1).has_metadata, 1);
  assert.equal(getLibraryFile(db, f2).has_metadata, 0);
  await fs.rm(dir, { recursive: true, force: true });
});

test('tagAllUntagged: halts and reports rateLimited when ComicVine throttles, tagging nothing', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tag-'));
  const db = openDb(':memory:');
  const sid = upsertSeries(db, { title: 'Saga (2012)', url: 'cv:46568' });
  setSeriesCv(db, sid, 46568, { locked: 0 });
  upsertCvSeries(db, { id: 46568, name: 'Saga', publisher: 'Image', start_year: '2012', count_of_issues: 72 });
  const paths = [];
  for (let i = 1; i <= 3; i++) {
    const p = path.join(dir, `Saga V2012 #00${i}.cbz`);
    await realCbz(p); paths.push(p);
    upsertCvIssue(db, { id: 3000 + i, cv_series_id: 46568, number: String(i), name: 'Ch ' + i });
    upsertLibraryFile(db, { path: p, dir, name: path.basename(p), size: 1, mtime: 1, valid: 1, has_metadata: 0, series_id: sid });
    linkFileCvIssue(db, p, 3000 + i);
  }
  const rlClient = { async issue() { const e = new Error('rate limited'); e.rateLimited = true; throw e; } };
  const r = await tagAllUntagged(db, rlClient);
  assert.equal(r.tagged, 0);
  assert.ok(r.rateLimited >= 1);
  for (const p of paths) assert.equal(getLibraryFile(db, p).has_metadata, 0); // left for a later run
  await fs.rm(dir, { recursive: true, force: true });
});

test('verifyLibrary: corruptOnly re-checks only files flagged valid=0', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'lib-'));
  const bad = path.join(d, 'bad.cbz'); await realCbz(bad);   // actually fine, currently flagged corrupt
  const good = path.join(d, 'good.cbz'); await realCbz(good); // fine and marked valid
  const db = openDb(':memory:');
  const s = upsertSeries(db, { title: 'X', url: 'cv:1' });
  upsertLibraryFile(db, { path: bad, dir: d, name: 'bad.cbz', size: 1, mtime: 1, valid: 0, error: 'entry crc/read failed', series_id: s });
  upsertLibraryFile(db, { path: good, dir: d, name: 'good.cbz', size: 1, mtime: 1, valid: 1, series_id: s });
  const r = await verifyLibrary(db, () => {}, { corruptOnly: true });
  assert.equal(r.total, 1);                       // only the corrupt one was touched
  assert.equal(getLibraryFile(db, bad).valid, 1); // re-verified and cleared
  assert.equal(getLibraryFile(db, bad).error, null);
  await fs.rm(d, { recursive: true, force: true });
});

test('verifyLibrary: prunes files missing from disk', async () => {
  const db = openDb(':memory:');
  const s = upsertSeries(db, { title: 'X', url: 'cv:1' });
  upsertLibraryFile(db, { path: '/gone.cbz', dir: '/', name: 'gone.cbz', size: 1, mtime: 1, valid: 1, series_id: s });
  const r = await verifyLibrary(db);
  assert.equal(r.missing, 1);
  assert.equal(getLibraryFile(db, '/gone.cbz'), undefined);
});

test('scanEntireLibrary: an unreachable root prunes NOTHING (share-down safety)', async () => {
  const db = openDb(':memory:');
  const s = upsertSeries(db, { title: 'X', url: 'cv:1' });
  upsertLibraryFile(db, { path: '/nas/x1.cbz', dir: '/nas', name: 'x1.cbz', size: 1, mtime: 1, valid: 1, series_id: s });
  const r = await scanEntireLibrary(db, [path.join(os.tmpdir(), 'no-such-root-' + Math.random().toString(36).slice(2))]);
  assert.equal(r.unreachableRoots, 1);
  assert.ok(getLibraryFile(db, '/nas/x1.cbz'), 'row survives a scan with the root down');
});

test('scanEntireLibrary: multiple roots prune once — root A scan keeps root B rows', async () => {
  const rootA = await fs.mkdtemp(path.join(os.tmpdir(), 'lib-a-'));
  const rootB = await fs.mkdtemp(path.join(os.tmpdir(), 'lib-b-'));
  await realCbz(path.join(rootA, 'A One V2020 #001.cbz'));
  await realCbz(path.join(rootB, 'B Two V2020 #001.cbz'));
  const db = openDb(':memory:');
  const r = await scanEntireLibrary(db, [rootA, rootB]);
  assert.equal(r.files, 2); // both roots indexed, neither pruned the other
  await fs.rm(rootA, { recursive: true, force: true });
  await fs.rm(rootB, { recursive: true, force: true });
});

test('verifyLibrary: unreachable files are kept (not pruned as missing)', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'lib-'));
  const gone = path.join(d, 'gone.cbz');          // parent exists, file deleted → prune
  const outage = '/no-such-share/comics/x.cbz';   // parent unreachable → keep
  const db = openDb(':memory:');
  const s = upsertSeries(db, { title: 'X', url: 'cv:1' });
  upsertLibraryFile(db, { path: gone, dir: d, name: 'gone.cbz', size: 1, mtime: 1, valid: 1, series_id: s });
  upsertLibraryFile(db, { path: outage, dir: '/no-such-share/comics', name: 'x.cbz', size: 1, mtime: 1, valid: 1, series_id: s });
  const r = await verifyLibrary(db);
  assert.equal(r.missing, 1);
  assert.equal(r.unreachable, 1);
  assert.equal(getLibraryFile(db, gone), undefined);   // genuinely deleted → pruned
  assert.ok(getLibraryFile(db, outage));               // outage → kept
  await fs.rm(d, { recursive: true, force: true });
});

test('backupDatabase: snapshots the db and rotates to the newest 5', async () => {
  const { backupDatabase } = await import('../src/tools.js');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bk-'));
  const dbPath = path.join(dir, 'catalog.db');
  const db = openDb(dbPath);
  upsertSeries(db, { title: 'Saga', url: 'cv:1' });
  for (let i = 0; i < 7; i++) { // 7 backups → only 5 kept
    await backupDatabase(db, dbPath);
    await new Promise((r) => setTimeout(r, 3)); // unique Date.now() stamps
  }
  const backups = (await fs.readdir(path.join(dir, 'backups'))).filter((f) => f.endsWith('.db'));
  assert.equal(backups.length, 5);
  // The snapshot is a real, openable database with the data.
  const restored = openDb(path.join(dir, 'backups', backups[backups.length - 1]));
  assert.equal(restored.prepare('SELECT COUNT(*) n FROM series').get().n, 1);
  restored.close(); db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('renameAllFiles: renames CV-linked files to the standard name, updates the index', async () => {
  const { renameAllFiles } = await import('../src/tools.js');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ren-'));
  const scene = path.join(dir, 'Saga 003 (2012) (digital) (Empire).cbz');
  await realCbz(scene);
  const db = openDb(':memory:');
  const sid = upsertSeries(db, { title: 'Saga (2012)', url: 'cv:46568' });
  setSeriesCv(db, sid, 46568, { locked: 0 });
  upsertCvSeries(db, { id: 46568, name: 'Saga', publisher: 'Image', start_year: '2012', count_of_issues: 3 });
  upsertCvIssue(db, { id: 3, cv_series_id: 46568, number: '3', name: 'Chapter Three' });
  upsertLibraryFile(db, { path: scene, dir, name: path.basename(scene), size: 1, mtime: 1, valid: 1, series_id: sid });
  linkFileCvIssue(db, scene, 3);
  const r = await renameAllFiles(db);
  assert.equal(r.renamed, 1);
  const expected = path.join(dir, 'Saga V2012 #003.cbz');
  assert.ok(await fs.access(expected).then(() => true, () => false), 'renamed on disk');
  assert.ok(getLibraryFile(db, expected), 'index re-pointed');
  assert.equal(getLibraryFile(db, scene), undefined);
  // Second run: nothing to do.
  const again = await renameAllFiles(db);
  assert.equal(again.renamed, 0);
  assert.equal(again.unchanged, 1);
  await fs.rm(dir, { recursive: true, force: true });
});
