import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { existsSync } from 'node:fs';
import { readArchiveInfo, parseComicInfo, isImageName, convertCbrToCbz, verifyArchive, sniffFormat, repackRarAsZip, unwrapNestedArchive, unwrapNestedBuffer } from '../src/archive.js';

test('readArchiveInfo reads the committed .cbr fixture', async () => {
  const r = await readArchiveInfo('tests/fixtures/sample.cbr');
  assert.equal(r.ok, true);
  assert.equal(r.format, 'cbr');
  assert.equal(r.pageCount, 2);
  assert.equal(r.hasComicInfo, true);
  assert.equal(r.comicInfo.series, 'Fixture');
  assert.equal(r.comicInfo.number, '7');
});

test('readArchiveInfo: RAR content mislabeled .cbz is sniffed and read, not flagged corrupt', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'arc-'));
  const p = path.join(d, 'mislabeled.cbz'); // .cbz name, RAR bytes inside
  await fs.copyFile('tests/fixtures/sample.cbr', p);
  const r = await readArchiveInfo(p);
  assert.equal(r.ok, true);
  assert.equal(r.format, 'cbr');            // decoded by content, not extension
  assert.equal(r.pageCount, 2);
  assert.equal((await verifyArchive(p)).ok, true); // deep-verify also uses the sniffed format
  await fs.rm(d, { recursive: true, force: true });
});

test('convertCbrToCbz: a ZIP-content .cbr is renamed, not fed to the RAR extractor', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'arc-'));
  const p = path.join(d, 'mislabeled.cbr'); // .cbr name, ZIP bytes inside
  const zip = new JSZip();
  zip.file('001.jpg', Buffer.from([0xff, 0xd8, 0xff, 1]));
  zip.file('ComicInfo.xml', '<ComicInfo><Series>Zed</Series></ComicInfo>');
  await fs.writeFile(p, await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' }));
  const r = await convertCbrToCbz(p);
  assert.equal(r.renamed, true);              // renamed, not repacked
  assert.equal(r.cbzPath, path.join(d, 'mislabeled.cbz'));
  assert.equal(existsSync(p), false);         // original .cbr gone
  const info = await readArchiveInfo(r.cbzPath);
  assert.equal(info.ok, true);
  assert.equal(info.pageCount, 1);            // content intact
  assert.equal(info.comicInfo.series, 'Zed');
  await fs.rm(d, { recursive: true, force: true });
});

test('repackRarAsZip: rewrites RAR-content .cbz into a real ZIP at the same path, preserving entries', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'arc-'));
  const p = path.join(d, 'prog.cbz'); // .cbz name, RAR bytes inside
  await fs.copyFile('tests/fixtures/sample.cbr', p);
  assert.equal(await sniffFormat(p), 'cbr'); // starts as RAR
  const r = await repackRarAsZip(p);
  assert.equal(r.repacked, true);
  assert.equal(await sniffFormat(p), 'cbz'); // now genuinely a ZIP, same path
  const info = await readArchiveInfo(p);
  assert.equal(info.format, 'cbz');
  assert.equal(info.pageCount, 2);           // pages preserved
  assert.equal(info.comicInfo.series, 'Fixture'); // ComicInfo.xml preserved
  assert.equal((await verifyArchive(p)).ok, true);
  await fs.rm(d, { recursive: true, force: true });
});

test('readArchiveInfo: ZIP content mislabeled .cbr is sniffed and read as zip', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'arc-'));
  const p = path.join(d, 'mislabeled.cbr'); // .cbr name, ZIP bytes inside
  const zip = new JSZip(); zip.file('001.jpg', Buffer.from([0xff, 0xd8, 0xff, 1])); zip.file('002.jpg', Buffer.from([0xff, 0xd8, 0xff, 2]));
  await fs.writeFile(p, await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' }));
  const r = await readArchiveInfo(p);
  assert.equal(r.ok, true);
  assert.equal(r.format, 'cbz');            // read as zip despite the .cbr name
  assert.equal(r.pageCount, 2);
  await fs.rm(d, { recursive: true, force: true });
});

test('readArchiveInfo: corrupt .cbr -> ok false', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'arc-'));
  const p = path.join(d, 'bad.cbr');
  await fs.writeFile(p, Buffer.from('Rar! not really an archive'));
  assert.equal((await readArchiveInfo(p)).ok, false);
  await fs.rm(d, { recursive: true, force: true });
});

test('convertCbrToCbz makes a .cbz with the same entries and removes the .cbr', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'conv-'));
  const src = path.join(d, 'sample.cbr');
  await fs.copyFile('tests/fixtures/sample.cbr', src);
  const { cbzPath } = await convertCbrToCbz(src);
  assert.equal(cbzPath, path.join(d, 'sample.cbz'));
  assert.equal(existsSync(src), false); // .cbr removed
  const r = await readArchiveInfo(cbzPath);
  assert.equal(r.ok, true);
  assert.equal(r.format, 'cbz');
  assert.equal(r.pageCount, 2);
  assert.equal(r.hasComicInfo, true);
  assert.equal(r.comicInfo.series, 'Fixture');
  await fs.rm(d, { recursive: true, force: true });
});

test('convertCbrToCbz refuses to clobber an existing .cbz', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'conv-'));
  const src = path.join(d, 'sample.cbr');
  await fs.copyFile('tests/fixtures/sample.cbr', src);
  await fs.writeFile(path.join(d, 'sample.cbz'), 'existing');
  await assert.rejects(() => convertCbrToCbz(src));
  await fs.rm(d, { recursive: true, force: true });
});

test('verifyArchive: valid .cbz ok, corrupt not ok', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'ver-'));
  const good = path.join(d, 'g.cbz');
  const zip = new JSZip(); zip.file('001.jpg', Buffer.from([1, 2, 3])); zip.file('ComicInfo.xml', '<ComicInfo/>');
  await fs.writeFile(good, await zip.generateAsync({ type: 'nodebuffer' }));
  assert.equal((await verifyArchive(good)).ok, true);
  const bad = path.join(d, 'b.cbz'); await fs.writeFile(bad, Buffer.from('nope'));
  assert.equal((await verifyArchive(bad)).ok, false);
  await fs.rm(d, { recursive: true, force: true });
});

test('verifyArchive: tolerates an off-by-one declared uncompressed size (yauzl strict, readers lenient)', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'ver-'));
  const p = path.join(d, 'loose.cbz');
  const zip = new JSZip();
  zip.file('001.jpg', Buffer.alloc(3000, 7)); // compressible so it's a real deflate stream
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  // Declare the uncompressed size in the central directory one byte short — this is
  // exactly the "too many bytes in the stream" case seen on real CBZs. The deflate
  // data is untouched, so it still inflates; only the size field lies.
  const cd = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); // central dir header
  buf.writeUInt32LE(buf.readUInt32LE(cd + 24) - 1, cd + 24);     // uncompressed size field
  await fs.writeFile(p, buf);
  assert.equal((await verifyArchive(p)).ok, true); // not flagged corrupt over a 1-byte size lie
  await fs.rm(d, { recursive: true, force: true });
});

test('verifyArchive: many-entry .cbz drains every stream sequentially without crashing', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'ver-'));
  const p = path.join(d, 'big.cbz');
  const zip = new JSZip();
  // Compressed (DEFLATE) entries so each opens a real inflate stream — this is the
  // path that raced the fd close and crashed fd-slicer with concurrent reads.
  for (let i = 1; i <= 60; i++) zip.file(String(i).padStart(3, '0') + '.jpg', Buffer.alloc(4096, i));
  await fs.writeFile(p, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  assert.equal((await verifyArchive(p)).ok, true);
  await fs.rm(d, { recursive: true, force: true });
});

const CI = '<?xml version="1.0"?><ComicInfo><Series>Earth X</Series><Number>1</Number><Volume>1999</Volume><Title>Chapter One</Title><Count>14</Count><Publisher>Marvel</Publisher><Year>1999</Year></ComicInfo>';

async function makeCbz(dir, name, { withCI = true, pages = 3 } = {}) {
  const zip = new JSZip();
  for (let i = 1; i <= pages; i++) zip.file(String(i).padStart(3, '0') + '.jpg', Buffer.from([0xff, 0xd8, 0xff, i]));
  if (withCI) zip.file('ComicInfo.xml', CI);
  const p = path.join(dir, name);
  await fs.writeFile(p, await zip.generateAsync({ type: 'nodebuffer' }));
  return p;
}

test('parseComicInfo pulls the fields', () => {
  const m = parseComicInfo(CI);
  assert.equal(m.series, 'Earth X');
  assert.equal(m.number, '1');
  assert.equal(m.volume, '1999');
  assert.equal(m.publisher, 'Marvel');
  assert.equal(m.count, '14');
});

test('isImageName', () => {
  assert.equal(isImageName('001.jpg'), true);
  assert.equal(isImageName('a/b.WEBP'), true);
  assert.equal(isImageName('ComicInfo.xml'), false);
});

test('readArchiveInfo reads a .cbz: pages + ComicInfo', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'arc-'));
  const p = await makeCbz(d, 'x.cbz', { withCI: true, pages: 4 });
  const r = await readArchiveInfo(p);
  assert.equal(r.ok, true);
  assert.equal(r.format, 'cbz');
  assert.equal(r.pageCount, 4);
  assert.equal(r.hasComicInfo, true);
  assert.equal(r.comicInfo.series, 'Earth X');
  await fs.rm(d, { recursive: true, force: true });
});

test('readArchiveInfo: .cbz without ComicInfo', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'arc-'));
  const p = await makeCbz(d, 'y.cbz', { withCI: false, pages: 2 });
  const r = await readArchiveInfo(p);
  assert.equal(r.hasComicInfo, false);
  assert.equal(r.pageCount, 2);
  await fs.rm(d, { recursive: true, force: true });
});

test('readArchiveInfo: corrupt .cbz -> ok false', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'arc-'));
  const p = path.join(d, 'bad.cbz');
  await fs.writeFile(p, Buffer.from('not a zip at all'));
  const r = await readArchiveInfo(p);
  assert.equal(r.ok, false);
  await fs.rm(d, { recursive: true, force: true });
});

// A .cbz whose whole payload is another archive: a well-formed zip, readable
// metadata, and nothing to read. These passed every check and sat in libraries
// looking healthy, which is how the reporter ended up with unreadable issues
// the app insisted were fine.
async function nestedCbz(dir, { withComicInfo = true } = {}) {
  const inner = new JSZip();
  inner.file('001.jpg', Buffer.from([0xff, 0xd8, 0xff]));
  inner.file('002.jpg', Buffer.from([0xff, 0xd8, 0xff]));
  const innerBuf = await inner.generateAsync({ type: 'nodebuffer' });

  const outer = new JSZip();
  outer.file('Some Comic 038 (Digital-Empire).cbr', innerBuf);   // named .cbr, zip bytes
  if (withComicInfo) outer.file('ComicInfo.xml', '<ComicInfo><Series>Wrapped</Series><Number>38</Number></ComicInfo>');
  const p = path.join(dir, 'Wrapped 038.cbz');
  await fs.writeFile(p, await outer.generateAsync({ type: 'nodebuffer' }));
  return p;
}

test('a .cbz containing only another archive is not valid, and says why', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nested-'));
  const p = await nestedCbz(dir);
  const r = await readArchiveInfo(p);
  assert.equal(r.ok, false, 'an archive with no pages is not a readable comic');
  assert.equal(r.pageCount, 0);
  assert.match(r.error, /contains another archive/);
  assert.match(r.error, /\.cbr/, 'the error names the thing inside');
  // The metadata is still read — it is what makes these look healthy.
  assert.equal(r.hasComicInfo, true);
});

test('an archive with no images and no nested archive is reported plainly', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'empty-'));
  const zip = new JSZip();
  zip.file('readme.txt', 'nothing to see');
  const p = path.join(dir, 'Empty 001.cbz');
  await fs.writeFile(p, await zip.generateAsync({ type: 'nodebuffer' }));
  const r = await readArchiveInfo(p);
  assert.equal(r.ok, false);
  assert.match(r.error, /no pages/);
  assert.doesNotMatch(r.error, /contains another archive/);
});

test('a normal comic is unaffected', async () => {
  const r = await readArchiveInfo('tests/fixtures/sample.cbr');
  assert.equal(r.ok, true);
  assert.equal(r.pageCount, 2);
});

test('only comics are judged on pages — an .epub of XHTML is left alone', async () => {
  // EPUBs are zips that can legitimately hold no image at all. Books come in
  // through their own plugin, but this reader must not condemn one if handed it.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'epub-'));
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip');
  zip.file('OEBPS/chapter1.xhtml', '<html><body>text only</body></html>');
  const p = path.join(dir, 'Book.epub');
  await fs.writeFile(p, await zip.generateAsync({ type: 'nodebuffer' }));
  const r = await readArchiveInfo(p);
  assert.equal(r.ok, true, 'an image-free epub is not a corrupt comic');
});

test('unwrapNestedArchive lifts the inner pages out, in place, keeping ComicInfo', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unwrap-'));
  const p = await nestedCbz(dir);
  const before = await fs.stat(p);

  const r = await unwrapNestedArchive(p);
  assert.equal(r.unwrapped, true);
  assert.equal(r.pages, 2);

  const after = await readArchiveInfo(p);
  assert.equal(after.ok, true, 'the file is readable now');
  assert.equal(after.pageCount, 2);
  assert.equal(after.hasComicInfo, true, 'the wrapper’s metadata was carried across');
  assert.equal(after.comicInfo.series, 'Wrapped');
  assert.ok(before.size > 0);
  assert.ok(!existsSync(p + '.part'), 'no temp file left behind');
});

test('unwrapNestedArchive refuses what it cannot prove, and leaves the file alone', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'refuse-'));

  // Nothing inside to lift out.
  const empty = new JSZip();
  empty.file('readme.txt', 'x');
  const p1 = path.join(dir, 'Empty.cbz');
  await fs.writeFile(p1, await empty.generateAsync({ type: 'nodebuffer' }));
  const bytes1 = await fs.readFile(p1);
  assert.equal((await unwrapNestedArchive(p1)).unwrapped, false);
  assert.deepEqual(await fs.readFile(p1), bytes1, 'untouched');

  // Two archives inside — which one is the comic? Leave it for a human.
  const two = new JSZip();
  const in1 = new JSZip(); in1.file('001.jpg', Buffer.from([0xff, 0xd8, 0xff]));
  two.file('a.cbr', await in1.generateAsync({ type: 'nodebuffer' }));
  two.file('b.cbr', await in1.generateAsync({ type: 'nodebuffer' }));
  const p2 = path.join(dir, 'Two.cbz');
  await fs.writeFile(p2, await two.generateAsync({ type: 'nodebuffer' }));
  const bytes2 = await fs.readFile(p2);
  const r2 = await unwrapNestedArchive(p2);
  assert.equal(r2.unwrapped, false);
  assert.match(r2.reason, /more than one/);
  assert.deepEqual(await fs.readFile(p2), bytes2, 'untouched');

  // A good comic is not "unwrapped" into something worse.
  const good = path.join(dir, 'Good.cbz');
  const g = new JSZip(); g.file('001.jpg', Buffer.from([0xff, 0xd8, 0xff]));
  await fs.writeFile(good, await g.generateAsync({ type: 'nodebuffer' }));
  assert.equal((await unwrapNestedArchive(good)).unwrapped, false);
});

test('unwrapNestedBuffer leaves a real comic alone and straightens a wrapper', async () => {
  // The download path uses this before anything touches disk.
  const good = new JSZip();
  good.file('001.jpg', Buffer.from([0xff, 0xd8, 0xff]));
  const goodBuf = await good.generateAsync({ type: 'nodebuffer' });
  const left = await unwrapNestedBuffer(goodBuf);
  assert.equal(left.buffer, undefined);
  assert.equal(left.reason, 'already has pages');

  const inner = new JSZip();
  inner.file('001.jpg', Buffer.from([0xff, 0xd8, 0xff]));
  const outer = new JSZip();
  outer.file('Release.cbr', await inner.generateAsync({ type: 'nodebuffer' }));
  outer.file('ComicInfo.xml', '<ComicInfo><Series>S</Series></ComicInfo>');
  const fixed = await unwrapNestedBuffer(await outer.generateAsync({ type: 'nodebuffer' }));
  assert.ok(fixed.buffer, 'the wrapper was unwrapped in memory');
  const names = Object.keys((await JSZip.loadAsync(fixed.buffer)).files);
  assert.ok(names.some(isImageName), 'pages are at the top level now');
  assert.ok(names.some((n) => /ComicInfo\.xml$/i.test(n)), 'the wrapper metadata came with it');
});

test('AVIF pages count, and macOS junk does not', async () => {
  // The reader renders .avif, so core must not call such a comic pageless.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'avif-'));
  const zip = new JSZip();
  zip.file('001.avif', Buffer.from([0, 0, 0, 0]));
  zip.file('__MACOSX/._001.avif', Buffer.from([0]));
  const p = path.join(dir, 'Modern 001.cbz');
  await fs.writeFile(p, await zip.generateAsync({ type: 'nodebuffer' }));
  const r = await readArchiveInfo(p);
  assert.equal(r.ok, true, 'an AVIF comic is a comic');
  assert.equal(r.pageCount, 1, 'the resource fork is not a page');
});

test('an archive of nothing but macOS junk has no pages', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'junk-'));
  const zip = new JSZip();
  zip.file('__MACOSX/._001.jpg', Buffer.from([0]));
  zip.file('.DS_Store', Buffer.from([0]));
  const p = path.join(dir, 'Junk 001.cbz');
  await fs.writeFile(p, await zip.generateAsync({ type: 'nodebuffer' }));
  const r = await readArchiveInfo(p);
  assert.equal(r.ok, false);
  assert.match(r.error, /no pages/);
});
