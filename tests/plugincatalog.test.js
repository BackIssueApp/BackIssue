import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import JSZip from 'jszip';

// Point the plugin dir at a temp folder BEFORE importing the module — pluginsDir()
// reads PLUGINS_DIR at load time.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bi-plugintest-'));
process.env.PLUGINS_DIR = TMP;
const { installPlugin, uninstallPlugin } = await import('../src/plugincatalog.js');

async function bundle(files) {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  return zip.generateAsync({ type: 'nodebuffer' });
}
const mockFetch = (buf, ok = true, status = 200) => async () => ({ ok, status, arrayBuffer: async () => buf });
const INDEX = 'export default () => {};';

test('installPlugin extracts a bundle into plugins/<id>/', async () => {
  const buf = await bundle({ 'index.js': INDEX, 'client/x.js': '//x' });
  const r = await installPlugin({ id: 'demo', download: 'http://x/demo.zip', version: '1.0.0' }, { fetchImpl: mockFetch(buf) });
  assert.equal(r.id, 'demo');
  assert.equal(r.version, '1.0.0');
  assert.ok(fs.existsSync(path.join(TMP, 'demo', 'index.js')));
  assert.ok(fs.existsSync(path.join(TMP, 'demo', 'client', 'x.js')));
});

test('correct checksum installs; a mismatch refuses', async () => {
  const buf = await bundle({ 'index.js': INDEX });
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  await installPlugin({ id: 'ok', download: 'x', sha256: sha }, { fetchImpl: mockFetch(buf) });
  assert.ok(fs.existsSync(path.join(TMP, 'ok', 'index.js')));

  await assert.rejects(
    installPlugin({ id: 'bad', download: 'x', sha256: 'deadbeef' }, { fetchImpl: mockFetch(buf) }),
    /checksum mismatch/,
  );
  assert.ok(!fs.existsSync(path.join(TMP, 'bad')), 'nothing installed on mismatch');
});

test('a path-traversal entry cannot escape the plugin folder', async () => {
  const zip = new JSZip();
  zip.file('index.js', INDEX);
  zip.file('../evil.js', 'pwned');
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  await installPlugin({ id: 'trav', download: 'x' }, { fetchImpl: mockFetch(buf) }).catch(() => {});
  // Security property: regardless of whether it threw, nothing landed a level up.
  assert.ok(!fs.existsSync(path.join(TMP, 'evil.js')), 'traversal entry must not escape');
});

test('a github-style single-folder bundle resolves to the inner root', async () => {
  const buf = await bundle({ 'plugin-demo/index.js': INDEX, 'plugin-demo/a.js': '//a' });
  await installPlugin({ id: 'wrapped', download: 'x' }, { fetchImpl: mockFetch(buf) });
  assert.ok(fs.existsSync(path.join(TMP, 'wrapped', 'index.js')));
  assert.ok(fs.existsSync(path.join(TMP, 'wrapped', 'a.js')));
});

test('a bundle without index.js is rejected', async () => {
  const buf = await bundle({ 'readme.md': 'nope' });
  await assert.rejects(installPlugin({ id: 'noidx', download: 'x' }, { fetchImpl: mockFetch(buf) }), /no index\.js/);
  assert.ok(!fs.existsSync(path.join(TMP, 'noidx')));
});

test('a failed download does not clobber an existing install', async () => {
  const good = await bundle({ 'index.js': INDEX, 'v1.js': '//1' });
  await installPlugin({ id: 'keep', download: 'x' }, { fetchImpl: mockFetch(good) });
  await assert.rejects(
    installPlugin({ id: 'keep', download: 'x' }, { fetchImpl: mockFetch(Buffer.alloc(0), false, 500) }),
    /download failed/,
  );
  assert.ok(fs.existsSync(path.join(TMP, 'keep', 'v1.js')), 'old install intact after a failed reinstall');
});

test('a bundle with dependencies triggers npm install; without deps it does not', async () => {
  const calls = [];
  const npmInstall = async (dir) => { calls.push(dir); };

  const withDeps = await bundle({ 'index.js': INDEX, 'package.json': JSON.stringify({ name: 'wd', dependencies: { sharp: '^0.35.0' } }) });
  await installPlugin({ id: 'withdeps', download: 'x' }, { fetchImpl: mockFetch(withDeps), npmInstall });
  assert.deepEqual(calls, [path.join(TMP, 'withdeps')], 'npm install ran in the plugin folder');

  const noDeps = await bundle({ 'index.js': INDEX, 'package.json': JSON.stringify({ name: 'nd' }) });
  await installPlugin({ id: 'nodeps', download: 'x' }, { fetchImpl: mockFetch(noDeps), npmInstall });
  assert.equal(calls.length, 1, 'no dependencies → npm install skipped');
});

test('a dependency-install failure surfaces but leaves files in place', async () => {
  const withDeps = await bundle({ 'index.js': INDEX, 'package.json': JSON.stringify({ dependencies: { sharp: '^0.35.0' } }) });
  const npmInstall = async () => { throw new Error('boom'); };
  await assert.rejects(
    installPlugin({ id: 'depfail', download: 'x' }, { fetchImpl: mockFetch(withDeps), npmInstall }),
    /dependency install failed/,
  );
  assert.ok(fs.existsSync(path.join(TMP, 'depfail', 'index.js')), 'files remain so it is visible/retryable');
});

test('uninstallPlugin removes the folder', async () => {
  const buf = await bundle({ 'index.js': INDEX });
  await installPlugin({ id: 'rm', download: 'x' }, { fetchImpl: mockFetch(buf) });
  assert.equal(uninstallPlugin('rm').removed, true);
  assert.ok(!fs.existsSync(path.join(TMP, 'rm')));
  assert.equal(uninstallPlugin('rm').removed, false, 'second uninstall is a no-op');
});
