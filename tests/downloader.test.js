import { test } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { safeName, targetPath, buildCbz, trailingIdFromUrl, yearFromTitle, comicFileName, detectEdition, reconcileDownloading, finalizeComic } from '../src/downloader.js';
import { seriesForSearch } from '../src/downloader.js';
import { openDb, upsertSeries, upsertIssue, setIssueStatus, listIssues } from '../src/db.js';
import fsp from 'node:fs/promises';
import os from 'node:os';
import nodePath from 'node:path';

test('detectEdition recognizes catalog edition tags', () => {
  assert.deepEqual(detectEdition('Morning Glories _TPB 2'), { type: 'TPB', num: '2' });
  assert.deepEqual(detectEdition('The Amazing Spider-Man (1963) _Annual 1'), { type: 'Annual', num: '1' });
  assert.deepEqual(detectEdition('Series _Holiday Special'), { type: 'Holiday Special', num: null });
  assert.equal(detectEdition('Morning Glories Issue #2'), null);
});

test('detectEdition recognizes bare (non-underscore) edition keywords', () => {
  assert.deepEqual(detectEdition('The Shadow (1987) Annual 1'), { type: 'Annual', num: '1' });
  assert.deepEqual(detectEdition('The Shadow (1987) Annual #1'), { type: 'Annual', num: '1' });
  assert.deepEqual(detectEdition('The Shadow (1987) Special'), { type: 'Special', num: null });
  assert.deepEqual(detectEdition('Batman (2025) Holiday Special 1'), { type: 'Holiday Special', num: '1' });
  assert.equal(detectEdition('The Shadow (1987) #5'), null);       // regular issue, not an edition
  assert.equal(detectEdition('The Shadow (1987) Issue #5'), null); // regular issue
});

test('comicFileName encodes special editions distinctly', () => {
  assert.equal(comicFileName('Morning Glories (2010)', '2', undefined, 'Morning Glories _TPB 2'), 'Morning Glories V2010 TPB #002');
  assert.equal(comicFileName('The Amazing Spider-Man (1963)', '1', undefined, 'The Amazing Spider-Man (1963) _Annual 1'), 'The Amazing Spider-Man V1963 Annual #001');
  assert.equal(comicFileName('Series (2020)', null, undefined, 'Series _Holiday Special'), 'Series V2020 Holiday Special');
  // bare (non-underscore) annual — the catalog format that was being misnamed as #001
  assert.equal(comicFileName('The Shadow (1987)', '1', undefined, 'The Shadow (1987) Annual 1'), 'The Shadow V1987 Annual #001');
});

test('comicFileName/targetPath use the explicit page year over the title year', () => {
  // title has NO year (stripped for Mylar), but the page year is supplied
  assert.equal(comicFileName('Earth X', '5', undefined, 'Earth X Issue #5', '1999'), 'Earth X V1999 #005');
  const p = targetPath('Earth X', { title: 'Earth X Issue #5', issue_number: '5' }, 'cbz', '1999');
  assert.match(p.replaceAll('\\', '/'), /Earth X\/Earth X V1999 #005\.cbz$/);
  // no explicit year -> falls back to the title year (unchanged behavior)
  assert.equal(comicFileName('Earth X (1999)', '5'), 'Earth X V1999 #005');
});

test('targetPath names a half issue distinctly (not #001)', () => {
  const half = targetPath('Earth X (1999)', { title: 'Earth X Issue #1/2', issue_number: '½' });
  assert.match(half.replaceAll('\\', '/'), /Earth X \(1999\)\/Earth X V1999 #½\.cbz$/);
  const one = targetPath('Earth X (1999)', { title: 'Earth X Issue #1', issue_number: '1' });
  assert.match(one.replaceAll('\\', '/'), /Earth X V1999 #001\.cbz$/);
});

test('targetPath gives editions distinct names (no collision with the issue)', () => {
  const tpb = targetPath('Morning Glories (2010)', { title: 'Morning Glories _TPB 2', issue_number: '2' });
  assert.match(tpb.replaceAll('\\', '/'), /Morning Glories \(2010\)\/Morning Glories V2010 TPB #002\.cbz$/);
  const reg = targetPath('Morning Glories (2010)', { title: 'Morning Glories Issue #2', issue_number: '2' });
  assert.match(reg.replaceAll('\\', '/'), /Morning Glories V2010 #002\.cbz$/);
});

test('comicFileName builds a Mylar-parseable name (Series VYYYY #NNN (Month YYYY))', () => {
  assert.equal(comicFileName('Earth 2: Society (2015)', '14'), 'Earth 2 Society V2015 #014');
  assert.equal(comicFileName('Earth 2: Society (2015)', '8', '2016-03-01'), 'Earth 2 Society V2015 #008 (March 2016)');
  assert.equal(comicFileName('Invincible (2005-)', '7'), 'Invincible V2005 #007');
  assert.equal(comicFileName('Saga', '1'), 'Saga #001');
});

test('yearFromTitle extracts the first 4-digit year in parens', () => {
  assert.equal(yearFromTitle('Batman (2025-)'), '2025');
  assert.equal(yearFromTitle('Saga'), null);
});

test('buildCbz zips the given pages and adds no ComicInfo.xml', async () => {
  const buf = await buildCbz([
    { name: '001.jpg', buffer: Buffer.from('a') },
    { name: '002.jpg', buffer: Buffer.from('b') },
  ]);
  const zip = await JSZip.loadAsync(buf);
  assert.ok(zip.file('001.jpg'));
  assert.ok(zip.file('002.jpg'));
  assert.equal(zip.file('ComicInfo.xml'), null);
});

test('safeName removes illegal Windows filename characters', () => {
  assert.equal(safeName('Batman: Year One? <1>'), 'Batman Year One 1');
  assert.equal(safeName('  spaced  '), 'spaced');
});

test('targetPath builds a Mylar-style series-foldered cbz path', () => {
  const p = targetPath('Batman', { title: 'Batman #1', issue_number: '1' });
  assert.match(p.replaceAll('\\', '/'), /downloads\/Batman\/Batman #001\.cbz$/);
});

test('targetPath includes the volume year when the series has one', () => {
  const p = targetPath('Earth 2: Society (2015)', { title: 'x', issue_number: '14' });
  assert.match(p.replaceAll('\\', '/'), /downloads\/Earth 2 Society \(2015\)\/Earth 2 Society V2015 #014\.cbz$/);
});

test('targetPath honors the pdf format extension', () => {
  const p = targetPath('Batman', { title: 'Batman #1', issue_number: '1' }, 'pdf');
  assert.match(p.replaceAll('\\', '/'), /downloads\/Batman\/Batman #001\.pdf$/);
});

test('targetPath falls back to issue title when no number and no edition', () => {
  const p = targetPath('Saga', { title: 'Saga Prologue', issue_number: null });
  assert.match(p.replaceAll('\\', '/'), /downloads\/Saga\/Saga - Saga Prologue\.cbz$/);
});

test('buildCbz produces a valid zip with the given pages', async () => {
  const buf = await buildCbz([
    { name: '001.jpg', buffer: Buffer.from('a') },
    { name: '002.jpg', buffer: Buffer.from('b') },
  ]);
  assert.equal(buf[0], 0x50); // 'P'
  assert.equal(buf[1], 0x4b); // 'K'
  const zip = await JSZip.loadAsync(buf);
  assert.ok(zip.file('001.jpg'));
  assert.ok(zip.file('002.jpg'));
});

test('finalizeComic files by the sniffed container, not the source extension, and can tag', async () => {
  // A real ZIP handed in as format:"cbr" must still be filed as .cbz (magic bytes
  // win) and be taggable — this is the guard against writing RAR/mislabeled bytes
  // into a .cbz and crashing the JSZip tagger.
  const dir = await fsp.mkdtemp(nodePath.join(os.tmpdir(), 'finalize-'));
  try {
    const zip = await buildCbz([{ name: '001.jpg', buffer: Buffer.from('img') }]);
    const xml = '<?xml version="1.0"?><ComicInfo><Series>Alex + Ada</Series></ComicInfo>';
    const res = await finalizeComic({
      buffer: zip, format: 'cbr',                       // lie about the extension
      issue: { issue_number: '1', title: '#1', url: 'cvissue:1' },
      seriesTitle: 'Alex + Ada', seriesYear: '2013', seriesPath: dir,
      comicInfoXml: xml,
    });
    assert.match(res.path, /\.cbz$/, 'filed as .cbz despite format:"cbr"');
    assert.equal(res.tagged, true, 'a real zip is taggable');
    const out = await fsp.readFile(res.path);
    assert.equal(out[0], 0x50); assert.equal(out[1], 0x4b);            // still a zip
    const loaded = await JSZip.loadAsync(out);
    assert.ok(loaded.file('ComicInfo.xml'), 'ComicInfo.xml embedded');
    assert.ok(loaded.file('001.jpg'), 'original page preserved');
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('trailingIdFromUrl extracts the trailing numeric id', () => {
  assert.equal(trailingIdFromUrl('https://host/reader/33758/257460'), '257460');
  assert.equal(trailingIdFromUrl('https://host/reader/6966/38988#last'), '38988');
  assert.equal(trailingIdFromUrl('cvissue:555'), null); // no trailing /number
});

test('seriesForSearch strips trailing (year) and [tag] but keeps colons', () => {
  assert.equal(seriesForSearch('The Shadow (1987)'), 'The Shadow');
  assert.equal(seriesForSearch('Injustice: Gods Among Us [I]'), 'Injustice: Gods Among Us');
  assert.equal(seriesForSearch('X (2020) [I]'), 'X');
  assert.equal(seriesForSearch('Plain Title'), 'Plain Title');
});

test('reconcileDownloading requeues a stuck tagging issue with no dest file', () => {
  const db = openDb(':memory:');
  const sid = upsertSeries(db, { title: 'Zzz Test (2099)', url: '/c/z', publisher: '', coverUrl: '' });
  const id = upsertIssue(db, { seriesId: sid, title: 'Zzz Test #1', issueNumber: '1', url: '/i/zzz1' });
  setIssueStatus(db, id, 'tagging', { filePath: '/some/stage/Zzz.cbz' });
  reconcileDownloading(db);
  // dest doesn't exist -> back in the queue, resumed by the boot kick-off
  assert.equal(listIssues(db, { seriesId: sid })[0].status, 'queued');
});
