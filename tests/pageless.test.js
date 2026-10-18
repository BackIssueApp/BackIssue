// Comic archives that hold no pages (here: an empty temp folder plus a
// ComicInfo.xml, the shape a broken external post-process leaves behind) must
// count as invalid, including rows indexed before that rule existed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { openDb, upsertLibraryFile } from '../src/db.js';
import { indexLibrary } from '../src/library.js';

async function pagelessCbz(file) {
  const zip = new JSZip();
  zip.folder('tmp/tmp.kX1xgsXgwb');
  zip.file('ComicInfo.xml', '<ComicInfo><Series>Aquaman</Series><Number>7</Number></ComicInfo>');
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));
}

const staleRow = (p, st) => ({
  path: p, dir: path.dirname(p), name: path.basename(p), size: st.size, mtime: Math.floor(st.mtimeMs),
  page_count: 0, has_metadata: 1, valid: 1, error: null, verified: 1,
});

test('opening the database marks stale page-less comic archives invalid', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bi-pageless-'));
  const dbFile = path.join(dir, 'catalog.db');
  try {
    let db = openDb(dbFile);
    const st = { size: 1309, mtimeMs: 1 };
    upsertLibraryFile(db, staleRow(path.join(dir, 'Aquaman #007.cbz'), st));
    upsertLibraryFile(db, { ...staleRow(path.join(dir, 'Book.pdf'), st) }); // not a comic archive: untouched
    db.close();
    db = openDb(dbFile);
    const rows = Object.fromEntries(db.prepare('SELECT name, valid, error FROM library_files').all().map((r) => [r.name, r]));
    assert.equal(rows['Aquaman #007.cbz'].valid, 0);
    assert.match(rows['Aquaman #007.cbz'].error, /no pages/);
    assert.equal(rows['Book.pdf'].valid, 1);
    db.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a scan re-reads an unchanged archive recorded as valid with no pages', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bi-pageless-scan-'));
  try {
    const file = path.join(dir, 'Aquaman V2003 #007 (August 2003).cbz');
    await pagelessCbz(file);
    const db = openDb(':memory:');
    // Indexed long ago as valid; same size and date as on disk now.
    upsertLibraryFile(db, staleRow(file, fs.statSync(file)));
    await indexLibrary({ db, dir });
    const row = db.prepare('SELECT valid, error FROM library_files WHERE path=?').get(file);
    assert.equal(row.valid, 0);
    assert.match(row.error, /no pages/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
