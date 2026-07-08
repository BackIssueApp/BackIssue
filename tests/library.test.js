import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { openDb, getLibraryFile, upsertSeries, upsertIssue, upsertCvSeries, upsertCvIssue, setSeriesCv, seriesCollectionDetail, upsertLibraryFile } from '../src/db.js';
import { indexLibrary, indexFolderForSeries, reconcileLibrary, indexDownloadedFile, removeSupersededFiles } from '../src/library.js';
import { linkFileCvIssue } from '../src/db.js';

async function cbz(p, { ci = true } = {}) {
  const z = new JSZip();
  z.file('001.jpg', Buffer.from([1]));
  if (ci) z.file('ComicInfo.xml', '<ComicInfo><Series>S</Series></ComicInfo>');
  await fs.writeFile(p, await z.generateAsync({ type: 'nodebuffer' }));
}

test('indexLibrary links each file to its catalog series/issue', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lib-'));
  const sdir = path.join(root, 'Marvel', 'Earth X (1999)');
  await fs.mkdir(sdir, { recursive: true });
  const z = new JSZip();
  z.file('001.jpg', Buffer.from([1]));
  z.file('ComicInfo.xml', '<ComicInfo><Series>Earth X</Series><Volume>1999</Volume><Number>1</Number></ComicInfo>');
  await fs.writeFile(path.join(sdir, 'Earth X V1999 #001.cbz'), await z.generateAsync({ type: 'nodebuffer' }));
  const db = openDb(':memory:');
  const sid = upsertSeries(db, { title: 'Earth X (1999)', url: '/c/ex', publisher: 'Marvel', coverUrl: '' });
  const iid = upsertIssue(db, { seriesId: sid, title: 'Earth X #1', issueNumber: '1', url: '/i/1' });
  await indexLibrary({ db, dir: root });
  const row = getLibraryFile(db, path.join(sdir, 'Earth X V1999 #001.cbz'));
  assert.equal(row.series_id, sid);
  assert.equal(row.issue_id, iid);
  await fs.rm(root, { recursive: true, force: true });
});

test('indexLibrary links files to CV issues for a matched series (owned rolls up)', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lib-'));
  const sdir = path.join(root, 'Image', 'Invincible (2003)');
  await fs.mkdir(sdir, { recursive: true });
  const z = new JSZip();
  z.file('001.jpg', Buffer.from([1]));
  z.file('ComicInfo.xml', '<ComicInfo><Series>Invincible</Series><Volume>2003</Volume><Number>1</Number></ComicInfo>');
  await fs.writeFile(path.join(sdir, 'Invincible V2003 #001.cbz'), await z.generateAsync({ type: 'nodebuffer' }));
  const db = openDb(':memory:');
  const sid = upsertSeries(db, { title: 'Invincible (2003)', url: '/c/inv', publisher: 'Image' });
  db.prepare('UPDATE series SET year=? WHERE id=?').run('2003', sid);
  // Series is already CV-matched with a cached issue list.
  upsertCvSeries(db, { id: 17993, name: 'Invincible', count_of_issues: 2 });
  upsertCvIssue(db, { id: 501, cv_series_id: 17993, number: '1', name: 'One' });
  upsertCvIssue(db, { id: 502, cv_series_id: 17993, number: '2', name: 'Two' });
  setSeriesCv(db, sid, 17993, { locked: 0 });

  await indexLibrary({ db, dir: root });
  const row = getLibraryFile(db, path.join(sdir, 'Invincible V2003 #001.cbz'));
  assert.equal(row.series_id, sid);
  assert.equal(row.cv_issue_id, 501);       // linked to CV issue #1 by the index
  const det = seriesCollectionDetail(db, sid);
  assert.equal(det.issues.find((i) => i.number === '1').owned, true);
  await fs.rm(root, { recursive: true, force: true });
});

test('indexFolderForSeries scans one folder and attributes files to that comic', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lib-'));
  const sdir = path.join(root, 'Image', 'Invincible (2003)');
  await fs.mkdir(sdir, { recursive: true });
  const z = new JSZip();
  z.file('001.jpg', Buffer.from([1]));
  z.file('ComicInfo.xml', '<ComicInfo><Series>Invincible</Series><Volume>2003</Volume><Number>1</Number></ComicInfo>');
  const fp = path.join(sdir, 'Invincible V2003 #001.cbz');
  await fs.writeFile(fp, await z.generateAsync({ type: 'nodebuffer' }));
  const db = openDb(':memory:');
  const sid = upsertSeries(db, { title: 'Invincible (2003)', url: '/c/inv', publisher: 'Image' });
  db.prepare('UPDATE series SET year=? WHERE id=?').run('2003', sid);
  upsertCvSeries(db, { id: 17993, name: 'Invincible', count_of_issues: 1 });
  upsertCvIssue(db, { id: 501, cv_series_id: 17993, number: '1', name: 'One' });
  setSeriesCv(db, sid, 17993, { locked: 0 });

  const r = await indexFolderForSeries({ db, dir: sdir, seriesId: sid, cvId: 17993 });
  assert.equal(r.total, 1);
  const row = getLibraryFile(db, fp);
  assert.equal(row.series_id, sid);
  assert.equal(row.cv_issue_id, 501);
  assert.equal(seriesCollectionDetail(db, sid).issues.find((i) => i.number === '1').owned, true);
  await fs.rm(root, { recursive: true, force: true });
});

test('indexFolderForSeries prunes deleted files and resets their issue status', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lib-'));
  const sdir = path.join(root, 'Titan', 'Horizon Zero Dawn (2020)');
  await fs.mkdir(sdir, { recursive: true });
  const mk = async (n) => {
    const z = new JSZip();
    z.file('001.jpg', Buffer.from([1]));
    z.file('ComicInfo.xml', `<ComicInfo><Series>Horizon Zero Dawn</Series><Number>${n}</Number></ComicInfo>`);
    const fp = path.join(sdir, `Horizon Zero Dawn #00${n}.cbz`);
    await fs.writeFile(fp, await z.generateAsync({ type: 'nodebuffer' }));
    return fp;
  };
  const f1 = await mk(1), f2 = await mk(2);
  const db = openDb(':memory:');
  const sid = upsertSeries(db, { title: 'Horizon Zero Dawn (2020)', url: '/c/hzd', publisher: 'Titan' });
  const i2 = upsertIssue(db, { seriesId: sid, title: 'HZD #2', issueNumber: '2', url: '/i/hzd2' });
  upsertCvSeries(db, { id: 128902, name: 'Horizon Zero Dawn', count_of_issues: 2 });
  upsertCvIssue(db, { id: 901, cv_series_id: 128902, number: '1', name: 'One' });
  upsertCvIssue(db, { id: 902, cv_series_id: 128902, number: '2', name: 'Two' });
  setSeriesCv(db, sid, 128902, { locked: 0 });

  await indexFolderForSeries({ db, dir: sdir, seriesId: sid, cvId: 128902 });
  // Simulate: #2 was downloaded (issue done), then the user deletes the file.
  db.prepare('UPDATE library_files SET issue_id=? WHERE path=?').run(i2, f2);
  db.prepare("UPDATE issues SET status='done', file_path=? WHERE id=?").run(f2, i2);
  assert.equal(seriesCollectionDetail(db, sid).issues.filter((i) => i.owned).length, 2);
  await fs.rm(f2);

  const r = await indexFolderForSeries({ db, dir: sdir, seriesId: sid, cvId: 128902 });
  assert.equal(r.pruned, 1);
  assert.equal(getLibraryFile(db, f2), undefined);            // index row gone
  assert.ok(getLibraryFile(db, f1));                          // surviving file untouched
  const det = seriesCollectionDetail(db, sid);
  assert.equal(det.issues.find((i) => i.number === '2').owned, false); // no longer owned
  assert.equal(db.prepare('SELECT status, file_path FROM issues WHERE id=?').get(i2).status, 'pending'); // downloadable again

  // An unreachable folder must NOT prune anything.
  const bad = await indexFolderForSeries({ db, dir: path.join(root, 'nope'), seriesId: sid, cvId: 128902 });
  assert.match(bad.error, /folder not found/);
  assert.ok(getLibraryFile(db, f1)); // index intact
  await fs.rm(root, { recursive: true, force: true });
});

test('indexDownloadedFile makes a fresh download count as owned immediately', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lib-'));
  const sdir = path.join(root, 'Image', 'Saga (2012)');
  await fs.mkdir(sdir, { recursive: true });
  const z = new JSZip();
  z.file('001.jpg', Buffer.from([1]));
  z.file('ComicInfo.xml', '<ComicInfo><Series>Saga</Series><Number>3</Number></ComicInfo>');
  const fp = path.join(sdir, 'Saga V2012 #003 (2012).cbz');
  await fs.writeFile(fp, await z.generateAsync({ type: 'nodebuffer' }));

  const db = openDb(':memory:');
  const sid = upsertSeries(db, { title: 'Saga (2012)', url: '/c/saga', publisher: 'Image' });
  const iid = upsertIssue(db, { seriesId: sid, title: 'Saga #3', issueNumber: '3', url: '/i/s3' });
  upsertCvSeries(db, { id: 46568, name: 'Saga', count_of_issues: 3 });
  upsertCvIssue(db, { id: 3003, cv_series_id: 46568, number: '3', name: 'Chapter Three' });
  setSeriesCv(db, sid, 46568, { locked: 0 });

  // Simulate the post-download/post-tag hook.
  assert.equal(await indexDownloadedFile(db, { path: fp, seriesId: sid, issueId: iid, cvId: 46568 }), true);
  const row = getLibraryFile(db, fp);
  assert.equal(row.series_id, sid);
  assert.equal(row.issue_id, iid);
  assert.equal(row.cv_issue_id, 3003);
  const det = seriesCollectionDetail(db, sid);
  assert.equal(det.issues.find((i) => i.number === '3').owned, true); // no folder scan needed

  // A vanished path reports false without throwing.
  assert.equal(await indexDownloadedFile(db, { path: path.join(sdir, 'nope.cbz'), seriesId: sid }), false);
  await fs.rm(root, { recursive: true, force: true });
});

test('removeSupersededFiles deletes invalid files that have a valid same-issue copy', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lib-'));
  await fs.mkdir(root, { recursive: true });
  const db = openDb(':memory:');
  const sid = upsertSeries(db, { title: 'Saga', url: 'cv:46568' });
  setSeriesCv(db, sid, 46568, { locked: 1 });
  upsertCvSeries(db, { id: 46568, name: 'Saga', count_of_issues: 2 });
  upsertCvIssue(db, { id: 3003, cv_series_id: 46568, number: '3', name: 'Three' });
  upsertCvIssue(db, { id: 3004, cv_series_id: 46568, number: '4', name: 'Four' });
  // #3: corrupt .cbr + valid .cbz → the .cbr is superseded (removed).
  const cbr = path.join(root, 's3.cbr'); await fs.writeFile(cbr, Buffer.from([0]));
  upsertLibraryFile(db, { path: cbr, dir: root, name: 's3.cbr', size: 1, mtime: 1, valid: 0, series_id: sid }); linkFileCvIssue(db, cbr, 3003);
  upsertLibraryFile(db, { path: '/s3.cbz', dir: root, name: 's3.cbz', size: 1, mtime: 1, valid: 1, series_id: sid }); linkFileCvIssue(db, '/s3.cbz', 3003);
  // #4: only a corrupt copy → kept (not superseded).
  upsertLibraryFile(db, { path: '/s4.cbr', dir: root, name: 's4.cbr', size: 1, mtime: 1, valid: 0, series_id: sid }); linkFileCvIssue(db, '/s4.cbr', 3004);

  const removed = await removeSupersededFiles(db, sid);
  assert.equal(removed, 1);
  assert.equal(getLibraryFile(db, cbr), undefined);            // superseded .cbr gone
  assert.equal(await fs.access(cbr).then(() => true, () => false), false); // deleted from disk
  assert.ok(getLibraryFile(db, '/s4.cbr'));                    // lone corrupt copy kept
  await fs.rm(root, { recursive: true, force: true });
});

test('indexDownloadedFile supersedes an old copy of the same issue (re-download deletes it)', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lib-'));
  const sdir = path.join(root, 'Image', 'Saga (2012)');
  await fs.mkdir(sdir, { recursive: true });
  const db = openDb(':memory:');
  const sid = upsertSeries(db, { title: 'Saga (2012)', url: 'cv:46568', publisher: 'Image' });
  setSeriesCv(db, sid, 46568, { locked: 1 });
  upsertCvSeries(db, { id: 46568, name: 'Saga', count_of_issues: 3 });
  upsertCvIssue(db, { id: 3003, cv_series_id: 46568, number: '3', name: 'Three' });

  // An old (corrupt, unlinked) .cbr for issue #3 is on disk + in the index.
  const oldPath = path.join(sdir, 'Saga V2012 #003 (2012).cbr');
  await fs.writeFile(oldPath, Buffer.from([0]));
  upsertLibraryFile(db, { path: oldPath, dir: sdir, name: 'Saga V2012 #003 (2012).cbr', size: 1, mtime: 1, valid: 0, series_id: sid });

  // Re-download lands a fresh valid .cbz for the same issue.
  const z = new JSZip();
  z.file('001.jpg', Buffer.from([1]));
  z.file('ComicInfo.xml', '<ComicInfo><Series>Saga</Series><Number>3</Number></ComicInfo>');
  const newPath = path.join(sdir, 'Saga V2012 #003.cbz');
  await fs.writeFile(newPath, await z.generateAsync({ type: 'nodebuffer' }));
  await indexDownloadedFile(db, { path: newPath, seriesId: sid, cvId: 46568 });

  // Old file is gone from disk + index; only the new copy remains.
  assert.equal(getLibraryFile(db, oldPath), undefined);
  assert.equal(await fs.access(oldPath).then(() => true, () => false), false);
  assert.ok(getLibraryFile(db, newPath));
  await fs.rm(root, { recursive: true, force: true });
});

test('reconcileLibrary attributes orphaned files and prunes untracked ones', () => {
  const db = openDb(':memory:');
  // Tracked comic (CV-matched) with an orphaned indexed file in its folder.
  const tracked = upsertSeries(db, { title: 'Saga (2012)', url: '/c/saga', publisher: 'Image' });
  db.prepare('UPDATE series SET year=? WHERE id=?').run('2012', tracked);
  upsertCvSeries(db, { id: 900, name: 'Saga', count_of_issues: 1 });
  upsertCvIssue(db, { id: 9001, cv_series_id: 900, number: '1', name: 'One' });
  setSeriesCv(db, tracked, 900, { locked: 0 });
  upsertLibraryFile(db, { path: '/lib/Saga (2012)/s1.cbz', dir: '/lib/Saga (2012)', name: 'Saga V2012 #001.cbz', size: 1, mtime: 1, valid: 1, ci_series: 'Saga', ci_number: '1' });
  // Untracked comic (not followed, no CV) with an orphaned file.
  upsertSeries(db, { title: 'Random Book (2005)', url: '/c/rand' });
  upsertLibraryFile(db, { path: '/lib/Random Book (2005)/r1.cbz', dir: '/lib/Random Book (2005)', name: 'Random Book V2005 #001.cbz', size: 1, mtime: 1, valid: 1 });

  const res = reconcileLibrary(db);
  assert.ok(res.attributed >= 1);
  assert.ok(res.pruned >= 1);
  // Tracked comic's file survived, attributed + CV-linked.
  const kept = getLibraryFile(db, '/lib/Saga (2012)/s1.cbz');
  assert.equal(kept.series_id, tracked);
  assert.equal(kept.cv_issue_id, 9001);
  // Untracked comic's file was pruned.
  assert.equal(getLibraryFile(db, '/lib/Random Book (2005)/r1.cbz'), undefined);
});

test('indexLibrary indexes files, skips unchanged, prunes deleted', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lib-'));
  const sdir = path.join(root, 'Marvel', 'S');
  await fs.mkdir(sdir, { recursive: true });
  await cbz(path.join(sdir, 'a.cbz'), { ci: true });
  await cbz(path.join(sdir, 'b.cbz'), { ci: false });
  const db = openDb(':memory:');

  const s1 = await indexLibrary({ db, dir: root });
  assert.equal(s1.total, 2);
  assert.equal(s1.tagged, 1);
  assert.equal(s1.untagged, 1);
  assert.equal(getLibraryFile(db, path.join(sdir, 'a.cbz')).has_metadata, 1);

  // second run: nothing changed -> everything skipped (0 reads)
  let reads = 0;
  await indexLibrary({ db, dir: root, onProgress: (p) => { reads += p.read || 0; } });
  assert.equal(reads, 0);

  // delete one -> pruned
  await fs.rm(path.join(sdir, 'b.cbz'));
  const s3 = await indexLibrary({ db, dir: root });
  assert.equal(s3.total, 1);

  await fs.rm(root, { recursive: true, force: true });
});

test('indexLibrary re-links an unlinked file on a skip pass without re-reading', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lib-'));
  const sdir = path.join(root, 'Marvel', 'Earth X (1999)');
  await fs.mkdir(sdir, { recursive: true });
  const z = new JSZip();
  z.file('001.jpg', Buffer.from([1]));
  z.file('ComicInfo.xml', '<ComicInfo><Series>Earth X</Series><Volume>1999</Volume><Number>1</Number></ComicInfo>');
  const fp = path.join(sdir, 'Earth X V1999 #001.cbz');
  await fs.writeFile(fp, await z.generateAsync({ type: 'nodebuffer' }));
  const db = openDb(':memory:');

  // Index once BEFORE the catalog series exists — nothing to link to, so series_id stays null.
  await indexLibrary({ db, dir: root });
  assert.equal(getLibraryFile(db, fp).series_id, null);

  // The catalog is populated later.
  const sid = upsertSeries(db, { title: 'Earth X (1999)', url: '/c/ex', publisher: 'Marvel', coverUrl: '' });
  const iid = upsertIssue(db, { seriesId: sid, title: 'Earth X #1', issueNumber: '1', url: '/i/1' });

  // Re-index: the file is unchanged so it's skipped for reading, but must still get linked.
  let reads = 0;
  await indexLibrary({ db, dir: root, onProgress: (p) => { reads += p.read || 0; } });
  assert.equal(reads, 0, 'unchanged file must not be re-read');
  const row = getLibraryFile(db, fp);
  assert.equal(row.series_id, sid);
  assert.equal(row.issue_id, iid);

  await fs.rm(root, { recursive: true, force: true });
});
