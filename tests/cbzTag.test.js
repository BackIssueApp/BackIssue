// Tagging a .cbz on disk by rewriting only the zip's tail: pages stay
// byte-identical, ComicInfo.xml is replaced (never duplicated), and the result
// opens in both zip readers the app uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { writeComicInfoInPlace } from '../src/cbzTag.js';
import { writeComicInfo } from '../src/metatagger.js';
import { readArchiveInfo } from '../src/archive.js';

const PAGES = { '001.jpg': Buffer.from('page one bytes'), '002.jpg': Buffer.from('page two bytes'), 'sub/003.png': Buffer.from('page three') };
const XML1 = '<?xml version="1.0"?><ComicInfo><Series>First</Series></ComicInfo>';
const XML2 = '<?xml version="1.0"?><ComicInfo><Series>Second — ünïcode</Series><Number>2</Number></ComicInfo>';

async function makeCbz({ comicInfoFirst = null, comment } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cbztag-'));
  const p = path.join(dir, 'Test #001.cbz');
  const z = new JSZip();
  if (comicInfoFirst) z.file('ComicInfo.xml', comicInfoFirst);
  for (const [n, b] of Object.entries(PAGES)) z.file(n, b);
  await fs.writeFile(p, await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', comment }));
  return { p, dir };
}

async function contents(p) {
  const z = await JSZip.loadAsync(await fs.readFile(p));
  const names = Object.keys(z.files).filter((n) => !z.files[n].dir);
  const out = {};
  for (const n of names) out[n] = await z.file(n).async('nodebuffer');
  return out;
}

test('tags an untagged cbz: pages unchanged, ComicInfo readable by both zip readers', async () => {
  const { p, dir } = await makeCbz();
  const before = await fs.readFile(p);
  await writeComicInfoInPlace(p, XML1);
  const c = await contents(p);
  assert.equal(c['ComicInfo.xml'].toString(), XML1);
  for (const [n, b] of Object.entries(PAGES)) assert.deepEqual(c[n], b, n);
  const info = await readArchiveInfo(p); // yauzl
  assert.equal(info.ok, true);
  assert.equal(info.pageCount, 3);
  assert.equal(info.hasComicInfo, true);
  assert.equal(info.comicInfo.series, 'First');
  // Everything before the old directory is byte-identical: no page was rewritten.
  const after = await fs.readFile(p);
  const firstCd = before.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.deepEqual(after.subarray(0, firstCd), before.subarray(0, firstCd));
  await fs.rm(dir, { recursive: true, force: true });
});

test('re-tagging replaces the ComicInfo it wrote, reusing its space', async () => {
  const { p, dir } = await makeCbz();
  await writeComicInfoInPlace(p, XML1);
  const size1 = (await fs.stat(p)).size;
  await writeComicInfoInPlace(p, XML1);
  assert.equal((await fs.stat(p)).size, size1, 'same tag twice = same size, nothing left behind');
  await writeComicInfoInPlace(p, XML2);
  const c = await contents(p);
  assert.equal(Object.keys(c).filter((n) => /comicinfo/i.test(n)).length, 1);
  assert.equal(c['ComicInfo.xml'].toString(), XML2);
  assert.equal((await readArchiveInfo(p)).comicInfo.number, '2');
  await fs.rm(dir, { recursive: true, force: true });
});

test('an existing ComicInfo before the pages is dropped from the directory, not duplicated', async () => {
  const { p, dir } = await makeCbz({ comicInfoFirst: XML1 });
  await writeComicInfoInPlace(p, XML2);
  const c = await contents(p);
  assert.deepEqual(Object.keys(c).filter((n) => /comicinfo/i.test(n)), ['ComicInfo.xml']);
  assert.equal(c['ComicInfo.xml'].toString(), XML2);
  for (const [n, b] of Object.entries(PAGES)) assert.deepEqual(c[n], b, n);
  await fs.rm(dir, { recursive: true, force: true });
});

test('keeps the archive comment', async () => {
  const { p, dir } = await makeCbz({ comment: 'scanned by someone' });
  await writeComicInfoInPlace(p, XML1);
  const z = await JSZip.loadAsync(await fs.readFile(p));
  assert.equal(z.comment, 'scanned by someone');
  assert.equal((await readArchiveInfo(p)).hasComicInfo, true);
  await fs.rm(dir, { recursive: true, force: true });
});

test('something that is not a zip is refused without being touched', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cbztag-'));
  const p = path.join(dir, 'Broken.cbz');
  await fs.writeFile(p, Buffer.from('not a zip at all'));
  await assert.rejects(writeComicInfoInPlace(p, XML1), (e) => e.code === 'NOT_SIMPLE_ZIP');
  assert.equal((await fs.readFile(p)).toString(), 'not a zip at all');
  await fs.rm(dir, { recursive: true, force: true });
});

test('writeComicInfo tags through the in-place path', async () => {
  const { p, dir } = await makeCbz();
  await writeComicInfo(p, XML1);
  assert.equal((await contents(p))['ComicInfo.xml'].toString(), XML1);
  await fs.rm(dir, { recursive: true, force: true });
});
