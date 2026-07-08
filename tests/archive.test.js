import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { existsSync } from 'node:fs';
import { readArchiveInfo, parseComicInfo, isImageName, convertCbrToCbz, verifyArchive, sniffFormat, repackRarAsZip } from '../src/archive.js';

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
