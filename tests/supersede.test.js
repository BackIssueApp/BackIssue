// A finished download replaces the old copy of the SAME issue — and nothing
// else: not a file linked to a different issue that shares its number (an
// annual), and not anything at all when the new download is broken.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { openDb, upsertSeries, upsertLibraryFile, linkLibraryFile } from '../src/db.js';
import { indexDownloadedFile } from '../src/library.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082', 'hex');
async function cbz(p) { const z = new JSZip(); z.file('001.png', PNG); fs.writeFileSync(p, await z.generateAsync({ type: 'nodebuffer' })); }

function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bi-supersede-'));
  const db = openDb(':memory:');
  const sid = upsertSeries(db, { title: 'Batman', url: 'local:batman' });
  const dir = path.join(tmp, 'Batman');
  fs.mkdirSync(dir);
  // An existing, valid file in the series, linked to a CV issue.
  const existing = async (name, cvIssueId) => {
    const p = path.join(dir, name);
    await cbz(p);
    upsertLibraryFile(db, { path: p, dir, name, size: 1, mtime: 1, ci_number: '1', valid: 1 });
    linkLibraryFile(db, p, sid, null);
    db.prepare('UPDATE library_files SET cv_issue_id=? WHERE path=?').run(cvIssueId, p);
    return p;
  };
  return { db, sid, dir, existing };
}

test('a download does not delete a different issue that shares its number', async () => {
  const { db, sid, dir, existing } = setup();
  const annual = await existing('Batman Annual 001 (2016).cbz', 999);
  const fresh = path.join(dir, 'Batman 001 (2016).cbz');
  await cbz(fresh);
  await indexDownloadedFile(db, { path: fresh, seriesId: sid, cvIssueId: 111 });
  assert.ok(fs.existsSync(annual));
});

test('a broken download leaves the old copy alone', async () => {
  const { db, sid, dir, existing } = setup();
  const old = await existing('Batman 001 (2016).cbr', 111);
  const broken = path.join(dir, 'Batman 001 (2016).cbz');
  fs.writeFileSync(broken, 'not an archive');
  await indexDownloadedFile(db, { path: broken, seriesId: sid, cvIssueId: 111 });
  assert.ok(fs.existsSync(old));
});

test('a good re-download of the same issue replaces the old copy', async () => {
  const { db, sid, dir, existing } = setup();
  const old = await existing('Batman 001 (2016) (old).cbz', 111);
  const fresh = path.join(dir, 'Batman 001 (2016).cbz');
  await cbz(fresh);
  await indexDownloadedFile(db, { path: fresh, seriesId: sid, cvIssueId: 111 });
  assert.ok(!fs.existsSync(old));
  assert.ok(fs.existsSync(fresh));
});
