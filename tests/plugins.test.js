import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pluginApi, registeredSources, loadPluginsFromDir, pluginCatalog, setPluginEnabled } from '../src/plugins.js';

test('registerSource adds a source and is idempotent by id', () => {
  const before = registeredSources().length;
  pluginApi.registerSource({ id: 'test-src-a', isEnabled: () => true });
  pluginApi.registerSource({ id: 'test-src-a', isEnabled: () => true }); // dupe id ignored
  const ids = registeredSources().map((s) => s.id);
  assert.equal(ids.filter((i) => i === 'test-src-a').length, 1);
  assert.equal(registeredSources().length, before + 1);
});

test('registerSource requires an id', () => {
  assert.throws(() => pluginApi.registerSource({ isEnabled: () => true }), /needs an id/);
});

test('loadPluginsFromDir loads a plugin and calls its register(api)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugtest-'));
  const pdir = path.join(dir, 'demo');
  fs.mkdirSync(pdir);
  fs.writeFileSync(path.join(pdir, 'index.js'),
    "export default (api) => api.registerSource({ id: 'demo-src', isEnabled: () => true });\n");
  const captured = [];
  const fakeApi = { registerSource: (s) => captured.push(s.id) };
  const loaded = await loadPluginsFromDir(dir, fakeApi);
  assert.deepEqual(loaded, ['demo']);
  assert.deepEqual(captured, ['demo-src']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadPluginsFromDir on a missing directory is a no-op', async () => {
  const loaded = await loadPluginsFromDir(path.join(os.tmpdir(), 'does-not-exist-xyz'));
  assert.deepEqual(loaded, []);
});

test('a plugin that throws is skipped, not fatal', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugtest-'));
  const pdir = path.join(dir, 'boom');
  fs.mkdirSync(pdir);
  fs.writeFileSync(path.join(pdir, 'index.js'), "export default () => { throw new Error('boom'); };\n");
  const loaded = await loadPluginsFromDir(dir, pluginApi);
  assert.deepEqual(loaded, []); // threw → not counted, no exception bubbles
  // ...but it IS in the catalog, carrying the error for the management page.
  const boom = pluginCatalog().find((p) => p.name === 'boom');
  assert.equal(boom.loaded, false);
  assert.match(boom.error, /boom/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('catalog: disabled plugins are listed but never imported; toggling flags a restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugtest-'));
  for (const name of ['alpha', 'omega']) {
    fs.mkdirSync(path.join(dir, name));
    fs.writeFileSync(path.join(dir, name, 'index.js'),
      `export default (api) => api.registerRoute('get', '/api/${name}', () => {});\n`);
    fs.writeFileSync(path.join(dir, name, 'package.json'),
      JSON.stringify({ name, version: '2.1.0', description: `the ${name} plugin` }));
  }
  // a sentinel file that is not a plugin directory must not crash the scan
  fs.writeFileSync(path.join(dir, 'README.md'), 'not a plugin');

  const loaded = await loadPluginsFromDir(dir, pluginApi, ['omega']);
  assert.deepEqual(loaded, ['alpha']);

  const byName = Object.fromEntries(pluginCatalog().map((p) => [p.name, p]));
  assert.equal(byName.alpha.loaded, true);
  assert.equal(byName.alpha.version, '2.1.0');
  assert.equal(byName.alpha.description, 'the alpha plugin');
  assert.equal(byName.alpha.counts.routes, 1);       // attribution via currentLoadingPlugin
  assert.equal(byName.alpha.restartRequired, false);

  assert.equal(byName.omega.loaded, false);          // never imported
  assert.equal(byName.omega.enabled, false);
  assert.equal(byName.omega.counts.routes, 0);
  assert.equal(byName.omega.restartRequired, false); // disabled AND not loaded = settled

  // toggling diverges desired state from loaded state → restart required
  setPluginEnabled('omega', true);
  assert.equal(pluginCatalog().find((p) => p.name === 'omega').restartRequired, true);
  setPluginEnabled('alpha', false);
  assert.equal(pluginCatalog().find((p) => p.name === 'alpha').restartRequired, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('registerLibraryType whitelists a plugin type for setSeriesType', async () => {
  const { pluginApi, pluginLibraryTypes } = await import('../src/plugins.js');
  const { openDb, upsertSeries, setSeriesType, getSeriesById, SERIES_TYPES } = await import('../src/db.js');
  pluginApi.registerLibraryType({ id: 'lightnovel', label: 'Light novels' });
  assert.ok(SERIES_TYPES.includes('lightnovel'));
  assert.ok(pluginLibraryTypes().some((t) => t.id === 'lightnovel'));
  const db = openDb(':memory:');
  const id = upsertSeries(db, { title: 'X', url: 'cv:9' });
  setSeriesType(db, id, 'lightnovel'); // must not throw once registered
  assert.equal(getSeriesById(db, id).type, 'lightnovel');
  assert.throws(() => pluginApi.registerLibraryType({}), /needs an id/);
});

test('registerLibraryType selfDescribed feeds the self-described whitelist', async () => {
  const { pluginApi } = await import('../src/plugins.js');
  const { SERIES_TYPES, SELF_DESCRIBED_TYPES } = await import('../src/db.js');
  pluginApi.registerLibraryType({ id: 'audiobook', label: 'Audiobooks', selfDescribed: true });
  assert.ok(SERIES_TYPES.includes('audiobook'));
  assert.ok(SELF_DESCRIBED_TYPES.has('audiobook'));
  pluginApi.registerLibraryType({ id: 'zine', label: 'Zines' }); // default: not self-described
  assert.ok(!SELF_DESCRIBED_TYPES.has('zine'));
});

test('registerImportHandler: validated and idempotent by id', async () => {
  const { pluginApi, registeredImportHandlers } = await import('../src/plugins.js');
  const before = registeredImportHandlers().length;
  pluginApi.registerImportHandler({ id: 'demo-files', scan: async () => [], import: async () => {} });
  pluginApi.registerImportHandler({ id: 'demo-files', scan: async () => [], import: async () => {} }); // dupe ignored
  assert.equal(registeredImportHandlers().filter((h) => h.id === 'demo-files').length, 1);
  assert.equal(registeredImportHandlers().length, before + 1);
  pluginApi.registerImportHandler({ id: 'no-scan', import: async () => {} }); // invalid — ignored
  pluginApi.registerImportHandler({ scan: async () => [], import: async () => {} }); // no id — ignored
  assert.equal(registeredImportHandlers().length, before + 1);
});
