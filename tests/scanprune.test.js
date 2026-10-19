// A library scan that cannot read one subfolder (a share hiccup, EIO) must not
// treat that subtree's files as deleted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDb, upsertLibraryFile } from '../src/db.js';
import { indexLibrary } from '../src/library.js';
import { findComicFiles } from '../src/scanner.js';

test('an unreadable subfolder keeps its indexed files; a real deletion is still pruned', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bi-scanprune-'));
  const marvel = path.join(root, 'Marvel'), dc = path.join(root, 'DC');
  fs.mkdirSync(marvel); fs.mkdirSync(dc);
  fs.writeFileSync(path.join(dc, 'Batman 001.cbz'), 'x');
  const db = openDb(':memory:');
  const row = (p) => upsertLibraryFile(db, { path: p, dir: path.dirname(p), name: path.basename(p), size: 1, mtime: 1, valid: 1 });
  const hidden = path.join(marvel, 'X-Men 001.cbz');
  const deleted = path.join(dc, 'Gone 001.cbz');
  row(hidden); row(deleted);

  const realReaddir = fsp.readdir;
  fsp.readdir = async (d, o) => { if (d === marvel) throw Object.assign(new Error('EIO'), { code: 'EIO' }); return realReaddir(d, o); };
  try {
    const found = await findComicFiles(root);
    assert.deepEqual(found.failedDirs, [marvel]);
    await indexLibrary({ db, dir: root });
  } finally { fsp.readdir = realReaddir; }
  const paths = db.prepare('SELECT path FROM library_files').all().map((r) => r.path);
  assert.ok(paths.includes(hidden), 'file under the unreadable folder kept');
  assert.ok(!paths.includes(deleted), 'a file really gone from a readable folder is pruned');
});
