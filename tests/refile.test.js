import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import config from '../src/config.js';
import { planSeries, refileSeries, planLibrary } from '../src/refile.js';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refile-'));
  const root = path.join(dir, 'Comics');
  fs.mkdirSync(root, { recursive: true });
  const db = new Database(path.join(dir, 'cat.db'));
  db.exec(`
    CREATE TABLE series (id INTEGER PRIMARY KEY, title TEXT, cv_id INTEGER, path TEXT);
    CREATE TABLE cv_series (comicvine_id INTEGER PRIMARY KEY, name TEXT, publisher TEXT, start_year TEXT);
    CREATE TABLE cv_issues (comicvine_id INTEGER PRIMARY KEY, cv_series_id INTEGER, issue_number TEXT, name TEXT, cover_date TEXT);
    CREATE TABLE library_files (path TEXT PRIMARY KEY, dir TEXT, name TEXT, series_id INTEGER, cv_issue_id INTEGER, valid INTEGER);
    CREATE TABLE issues (id INTEGER PRIMARY KEY, file_path TEXT);
    INSERT INTO series VALUES (1, 'Batman', 900, NULL), (2, 'Loose Files', NULL, NULL);
    INSERT INTO cv_series VALUES (900, 'Batman', 'DC Comics', '2011');
    INSERT INTO cv_issues VALUES (10, 900, '1', 'The Court of Owls', '2011-11-01'), (11, 900, '2', NULL, '2011-12-01');
  `);
  // Two messy source files for the matched series, in a junk sub-folder.
  const messy = path.join(root, 'junk'); fs.mkdirSync(messy, { recursive: true });
  const f1 = path.join(messy, 'bm-01.cbz'); fs.writeFileSync(f1, 'ONE');
  const f2 = path.join(messy, 'bm-02.cbz'); fs.writeFileSync(f2, 'TWO');
  const ins = db.prepare('INSERT INTO library_files VALUES (?,?,?,?,?,1)');
  ins.run(f1, path.dirname(f1), path.basename(f1), 1, 10);
  ins.run(f2, path.dirname(f2), path.basename(f2), 1, 11);
  config.rootFolders = root; config.folderPattern = ''; config.filePattern = '';
  return { dir, root, db, series: db.prepare('SELECT * FROM series WHERE id=1').get(),
    unmatched: db.prepare('SELECT * FROM series WHERE id=2').get(),
    rm: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('refileSeries moves files into Publisher/Title (Year) with pattern names, updates the DB', async () => {
  const { root, db, series, rm } = setup();
  try {
    assert.ok((await planSeries(db, series)).every((p) => p.status === 'move'));
    const r = await refileSeries(db, series);
    assert.equal(r.moved, 2);
    const target = path.join(root, 'DC Comics', 'Batman (2011)');
    const t1 = path.join(target, 'Batman V2011 #001.cbz');
    const t2 = path.join(target, 'Batman V2011 #002.cbz');
    assert.ok(fs.existsSync(t1) && fs.readFileSync(t1, 'utf8') === 'ONE', 'issue 1 moved to pattern path');
    assert.ok(fs.existsSync(t2), 'issue 2 moved to pattern path');
    assert.equal(db.prepare('SELECT path FROM library_files WHERE cv_issue_id=10').get().path, t1, 'DB path updated');
    assert.equal(db.prepare('SELECT path FROM series WHERE id=1').get().path, target, 'series points at new folder');
    assert.ok(!fs.existsSync(path.join(root, 'junk')), 'emptied source folder pruned');
  } finally { rm(); }
});

test('a second refile is a no-op — files already match', async () => {
  const { db, series, rm } = setup();
  try {
    await refileSeries(db, series);
    const again = await refileSeries(db, series);
    assert.equal(again.moved, 0);
    assert.equal(again.unchanged, 2);
  } finally { rm(); }
});

test('unmatched series are skipped (no metadata to build a pattern)', async () => {
  const { db, unmatched, rm } = setup();
  try {
    assert.deepEqual(await planSeries(db, unmatched), []);
    const plan = await planLibrary(db);
    assert.equal(plan.series, 1, 'only the matched series is in the library plan');
    assert.equal(plan.counts.move, 2);
  } finally { rm(); }
});

test('a move updates the issue\'s recorded file too', async () => {
  const { root, db, series, rm } = setup();
  try {
    const from = db.prepare('SELECT path FROM library_files WHERE cv_issue_id=10').get().path;
    db.prepare('INSERT INTO issues (id, file_path) VALUES (1, ?)').run(from);
    await refileSeries(db, series);
    assert.equal(db.prepare('SELECT file_path FROM issues WHERE id=1').get().file_path,
      path.join(root, 'DC Comics', 'Batman (2011)', 'Batman V2011 #001.cbz'));
  } finally { rm(); }
});

test('a series in a library files under that library\'s root and folder pattern', async () => {
  const { dir, db, rm } = setup();
  try {
    const manga = path.join(dir, 'Manga'); fs.mkdirSync(manga);
    db.exec('ALTER TABLE series ADD COLUMN library_id INTEGER; CREATE TABLE libraries (id INTEGER PRIMARY KEY, root_folder TEXT, folder_pattern TEXT)');
    db.prepare('INSERT INTO libraries VALUES (5, ?, ?)').run(manga, '{Title}');
    db.prepare('UPDATE series SET library_id=5 WHERE id=1').run();
    const outside = path.join(dir, 'elsewhere.cbz'); fs.writeFileSync(outside, 'X');
    db.prepare('UPDATE library_files SET path=? WHERE cv_issue_id=11').run(outside);
    const plan = await planSeries(db, db.prepare('SELECT * FROM series WHERE id=1').get());
    const to = (from) => path.dirname(plan.find((p) => p.from === from).to);
    // A file stays under the root it is in, laid out by the library's pattern;
    // one outside every root goes to the library's own folder.
    assert.equal(to(db.prepare('SELECT path FROM library_files WHERE cv_issue_id=10').get().path), path.join(dir, 'Comics', 'Batman'));
    assert.equal(to(outside), path.join(manga, 'Batman'));
  } finally { rm(); }
});

test('a move across filesystems copies via .part, then removes the source', async () => {
  const { root, db, series, rm } = setup();
  const fsp = (await import('node:fs/promises')).default;
  const realRename = fsp.rename;
  // Cross-device for the archive itself; the .part rename stays on one device.
  fsp.rename = async (a, b) => { if (!String(a).endsWith('.part')) throw Object.assign(new Error('cross-device'), { code: 'EXDEV' }); return realRename(a, b); };
  try {
    const r = await refileSeries(db, series);
    assert.equal(r.moved, 2);
    const target = path.join(root, 'DC Comics', 'Batman (2011)');
    assert.equal(fs.readFileSync(path.join(target, 'Batman V2011 #001.cbz'), 'utf8'), 'ONE');
    assert.ok(!fs.readdirSync(target).some((f) => f.endsWith('.part')), 'no .part left behind');
    assert.ok(!fs.existsSync(path.join(root, 'junk', 'bm-01.cbz')), 'source removed after the copy');
  } finally { fsp.rename = realRename; rm(); }
});

test('a target that differs only in letter case is a collision, never overwritten', async () => {
  const { root, db, series, rm } = setup();
  try {
    const target = path.join(root, 'DC Comics', 'Batman (2011)');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'batman v2011 #001.cbz'), 'KEEP');
    const r = await refileSeries(db, series);
    assert.equal(r.moved, 1);
    assert.equal(r.skipped, 1);
    assert.equal(fs.readFileSync(path.join(target, 'batman v2011 #001.cbz'), 'utf8'), 'KEEP');
  } finally { rm(); }
});
