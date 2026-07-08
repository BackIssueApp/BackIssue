// The "rename downloads" toggle: on (default) files download-imports under the
// configured file pattern; off keeps the source's original filename (extension
// corrected), still inside the comic's folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import config from '../src/config.js';
import { finalizeComic, buildCbz } from '../src/downloader.js';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'renddl-'));
  const seriesPath = path.join(dir, 'Batman (2011)');
  fs.mkdirSync(seriesPath, { recursive: true });
  return { dir, seriesPath, rm: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const ISSUE = { issue_number: '1', title: null, url: 'cvissue:1' };

test('renameDownloads ON (default): file lands under the pattern name', async () => {
  const { dir, seriesPath, rm } = setup();
  try {
    config.renameDownloads = true; config.filePattern = '';
    const src = path.join(dir, 'batman.001.scene-GROUP.cbz');
    fs.writeFileSync(src, await buildCbz([{ name: 'p1.jpg', buffer: Buffer.from('X') }]));
    const r = await finalizeComic({ srcPath: src, issue: ISSUE, seriesTitle: 'Batman', seriesYear: '2011', seriesPath });
    assert.equal(path.basename(r.path), 'Batman V2011 #001.cbz');
    assert.equal(path.dirname(r.path), seriesPath);
  } finally { rm(); }
});

test('renameDownloads OFF: the source filename is kept (in the comic folder)', async () => {
  const { dir, seriesPath, rm } = setup();
  try {
    config.renameDownloads = false; config.filePattern = '';
    const src = path.join(dir, 'batman.001.scene-GROUP.cbz');
    fs.writeFileSync(src, await buildCbz([{ name: 'p1.jpg', buffer: Buffer.from('X') }]));
    const r = await finalizeComic({ srcPath: src, issue: ISSUE, seriesTitle: 'Batman', seriesYear: '2011', seriesPath });
    assert.equal(path.basename(r.path), 'batman.001.scene-GROUP.cbz');
    assert.equal(path.dirname(r.path), seriesPath);
  } finally { config.renameDownloads = true; rm(); }
});
