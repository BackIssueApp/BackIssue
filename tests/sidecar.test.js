import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { existsSync } from 'node:fs';
import { readArchiveInfo, sidecarPath } from '../src/archive.js';
import { writeSidecar } from '../src/metatagger.js';

const XML = '<?xml version="1.0"?><ComicInfo><Series>Side</Series><Number>3</Number><Volume>2020</Volume><Title>Carried</Title></ComicInfo>';

async function makeCbz(dir, name, { withEmbedded = false } = {}) {
  const zip = new JSZip();
  zip.file('001.jpg', Buffer.from([0xff, 0xd8, 0xff, 1]));
  if (withEmbedded) zip.file('ComicInfo.xml', '<ComicInfo><Series>Embedded</Series><Number>1</Number></ComicInfo>');
  const p = path.join(dir, name);
  await fs.writeFile(p, await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' }));
  return p;
}

test('sidecarPath swaps the extension, and is a fixed point on .xml', () => {
  assert.equal(sidecarPath('/lib/Batman 001.cbz'), '/lib/Batman 001.xml');
  assert.equal(sidecarPath('/lib/Batman 001.cbr'), '/lib/Batman 001.xml');
  assert.equal(sidecarPath('/lib/Batman 001.xml'), '/lib/Batman 001.xml'); // guard for move/delete loops
  assert.equal(sidecarPath('/lib.v2/no-extension'), '/lib.v2/no-extension'); // a dot in the DIR must not be treated as an extension
});

test('writeSidecar writes next to the archive without touching it', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'side-'));
  const p = await makeCbz(d, 'Book 001.cbz');
  const before = await fs.readFile(p);
  await writeSidecar(p, XML);
  assert.equal(existsSync(path.join(d, 'Book 001.xml')), true);
  assert.deepEqual(await fs.readFile(p), before); // archive bytes identical
  await fs.rm(d, { recursive: true, force: true });
});

test('readArchiveInfo reports sidecar metadata as the file metadata', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'side-'));
  const p = await makeCbz(d, 'Book 001.cbz');
  await writeSidecar(p, XML);
  const r = await readArchiveInfo(p);
  assert.equal(r.ok, true);
  assert.equal(r.hasComicInfo, true);
  assert.equal(r.sidecar, true);
  assert.equal(r.comicInfo.series, 'Side');
  assert.equal(r.comicInfo.number, '3');
  await fs.rm(d, { recursive: true, force: true });
});

test('a sidecar wins over embedded ComicInfo (newer intent)', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'side-'));
  const p = await makeCbz(d, 'Book 001.cbz', { withEmbedded: true });
  assert.equal((await readArchiveInfo(p)).comicInfo.series, 'Embedded'); // baseline
  await writeSidecar(p, XML);
  assert.equal((await readArchiveInfo(p)).comicInfo.series, 'Side');
  await fs.rm(d, { recursive: true, force: true });
});

test('a non-ComicInfo .xml with the same basename is ignored', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'side-'));
  const p = await makeCbz(d, 'Book 001.cbz', { withEmbedded: true });
  await fs.writeFile(path.join(d, 'Book 001.xml'), '<opds:feed>not comic metadata</opds:feed>');
  const r = await readArchiveInfo(p);
  assert.equal(r.sidecar, undefined);
  assert.equal(r.comicInfo.series, 'Embedded'); // embedded still surfaces
  await fs.rm(d, { recursive: true, force: true });
});

test('sidecar works for .cbr without any conversion', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'side-'));
  const p = path.join(d, 'sample.cbr');
  await fs.copyFile('tests/fixtures/sample.cbr', p);
  const before = await fs.readFile(p);
  await writeSidecar(p, XML);
  const r = await readArchiveInfo(p);
  assert.equal(r.format, 'cbr');            // still a RAR — untouched
  assert.equal(r.comicInfo.series, 'Side'); // sidecar metadata surfaced
  assert.deepEqual(await fs.readFile(p), before);
  await fs.rm(d, { recursive: true, force: true });
});
