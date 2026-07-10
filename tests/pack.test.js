import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import config from '../src/config.js';
import { processPack } from '../src/pack.js';
import {
  openDb, upsertSeries, setSeriesCv, setFollowed, upsertCvSeries, upsertCvIssue,
  upsertLibraryFile, linkFileCvIssue
} from '../src/db.js';

async function cbz(p) {
  const z = new JSZip(); z.file('001.jpg', Buffer.from([0xff, 0xd8, 0xff, 1]));
  await fs.writeFile(p, await z.generateAsync({ type: 'nodebuffer', compression: 'STORE' }));
}

// A collection with one followed, CV-matched series (Saga, issues #1 & #2), where
// #1 is already owned and #2 is missing.
async function setup() {
  const db = openDb(':memory:');
  const saga = upsertSeries(db, { title: 'Saga (2012)', url: 'cv:46568' });
  setSeriesCv(db, saga, 46568, { locked: 0 });
  setFollowed(db, saga, 1);
  upsertCvSeries(db, { id: 46568, name: 'Saga', publisher: 'Image', start_year: '2012', count_of_issues: 2 });
  upsertCvIssue(db, { id: 1, cv_series_id: 46568, number: '1', name: 'a' });
  upsertCvIssue(db, { id: 2, cv_series_id: 46568, number: '2', name: 'b' });
  // #1 already owned
  upsertLibraryFile(db, { path: '/lib/saga1.cbz', dir: '/lib', name: 'saga1.cbz', size: 1, mtime: 1, valid: 1, series_id: saga });
  linkFileCvIssue(db, '/lib/saga1.cbz', 1);
  return { db, saga };
}

test('processPack (collection, dry-run): imports missing collection issues, skips owned, ignores others', async () => {
  const { db } = await setup();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pack-'));
  await cbz(path.join(dir, 'Saga 001 (2012) (digital) (Empire).cbz'));       // owned → skip
  await cbz(path.join(dir, 'Saga 002 (2012) (digital) (Empire).cbz'));       // missing → import
  await cbz(path.join(dir, 'Random Unowned 005 (2026) (digital).cbz'));      // not in collection → unmatched
  const r = await processPack(db, { dir, scope: { type: 'collection' }, dryRun: true });
  assert.equal(r.total, 3);
  assert.equal(r.imported, 1, JSON.stringify(r.details));   // Saga #2
  assert.equal(r.skipped, 1);    // Saga #1 owned
  assert.equal(r.unmatched, 1);  // Random Unowned
  assert.equal(r.details.find((d) => d.outcome === 'would-import').file, 'Saga 002 (2012) (digital) (Empire).cbz');
  await fs.rm(dir, { recursive: true, force: true });
});

test('processPack (collection): really imports the missing issue into the library', async () => {
  const { db } = await setup();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pack-'));
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'lib-'));
  const savedRoots = config.rootFolders; const savedDl = config.downloadsDir;
  config.rootFolders = ''; config.downloadsDir = out; // land imports here
  try {
    await cbz(path.join(dir, 'Saga 002 (2012) (digital) (Empire).cbz'));
    const r = await processPack(db, { dir, scope: { type: 'collection' }, cvClient: () => { throw new Error('no cv'); } });
    assert.equal(r.imported, 1, JSON.stringify(r.details));
    assert.equal(r.failed, 0);
    // the source pack file is left in place (seeding-safe)
    assert.equal(await fs.access(path.join(dir, 'Saga 002 (2012) (digital) (Empire).cbz')).then(() => true, () => false), true);
    // a library file now exists for Saga #2
    assert.ok(db.prepare('SELECT 1 FROM library_files WHERE cv_issue_id=2 AND valid=1').get());
    // ...and the import landed in the history (what + from where)
    const hist = db.prepare("SELECT * FROM import_history WHERE source='torrent'").get();
    assert.equal(hist.series_title, 'Saga');
    assert.equal(hist.issue_number, '2');
  } finally {
    config.rootFolders = savedRoots; config.downloadsDir = savedDl;
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(out, { recursive: true, force: true });
  }
});

test('processPack (collection, addNew): adds+follows a confidently-matched new volume', async () => {
  const { db } = await setup();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pack-'));
  await cbz(path.join(dir, 'Absolute Superman 001 (2026) (digital) (Empire).cbz')); // not in collection
  // CV client: a clear single-name match, its volume + issue #1.
  const client = () => ({
    async search(q) { return q.toLowerCase().includes('absolute superman')
      ? [{ id: 700, name: 'Absolute Superman', publisher: 'DC', start_year: '2024', count_of_issues: 1 }] : []; },
    async volume() { return { id: 700, name: 'Absolute Superman', publisher: 'DC', start_year: '2024', count_of_issues: 1, issues: [{ id: 7001, number: '1', name: 'a' }] }; },
    async issue(id) { return { id, name: 'a', issue_number: '1', cover_date: '2026-01-01', store_date: null, description: '', credits: [], site_detail_url: null }; },
  });

  // Without addNew: unmatched.
  const off = await processPack(db, { dir, scope: { type: 'collection' }, cvClient: client, dryRun: true });
  assert.equal(off.imported, 0);
  assert.equal(off.unmatched, 1);

  // With addNew: the series is added+followed and its issue imported.
  const on = await processPack(db, { dir, scope: { type: 'collection', addNew: true }, cvClient: client });
  assert.equal(on.imported, 1);
  const s = db.prepare('SELECT id, followed, cv_id FROM series WHERE cv_id=700').get();
  assert.ok(s, 'new series created');
  assert.equal(s.followed, 1);
  assert.ok(db.prepare('SELECT 1 FROM library_files WHERE cv_issue_id=7001 AND valid=1').get(), 'issue imported');
  await fs.rm(dir, { recursive: true, force: true });
});

test('processPack: a .cbr file imports (converted to cbz — not "not a .cbr")', async () => {
  const { db } = await setup();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pack-'));
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'lib-'));
  const savedRoots = config.rootFolders, savedDl = config.downloadsDir;
  config.rootFolders = ''; config.downloadsDir = out;
  try {
    // A RAR-content .cbr (the case that failed with "not a .cbr") for missing Saga #2.
    await fs.copyFile('tests/fixtures/sample.cbr', path.join(dir, 'Saga 002 (2012) (digital) (Empire).cbr'));
    const r = await processPack(db, { dir, scope: { type: 'collection' }, cvClient: () => { throw new Error('no cv'); } });
    assert.equal(r.imported, 1, JSON.stringify(r.details));
    assert.equal(r.failed, 0);
    assert.ok(db.prepare('SELECT 1 FROM library_files WHERE cv_issue_id=2 AND valid=1').get());
  } finally {
    config.rootFolders = savedRoots; config.downloadsDir = savedDl;
    await fs.rm(dir, { recursive: true, force: true }); await fs.rm(out, { recursive: true, force: true });
  }
});

test('processPack: an unreadable pack folder throws (not a silent 0)', async () => {
  const { db } = await setup();
  await assert.rejects(
    () => processPack(db, { dir: path.join(os.tmpdir(), 'does-not-exist-' + Math.random().toString(36).slice(2)), scope: { type: 'collection' } }),
    /not readable|path mapping/,
  );
});

test('processPack (series scope): forces every file onto one series volume', async () => {
  const { db, saga } = await setup();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pack-'));
  // Filename says a different series name, but series-scope pins it to Saga.
  await cbz(path.join(dir, 'Whatever The Pack Is Called 002 (2012).cbz'));
  const r = await processPack(db, { dir, scope: { type: 'series', seriesId: saga }, dryRun: true });
  assert.equal(r.imported, 1, JSON.stringify(r.details)); // matched Saga #2 by number despite the filename series
  await fs.rm(dir, { recursive: true, force: true });
});
