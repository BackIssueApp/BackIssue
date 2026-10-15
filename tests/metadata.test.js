import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  registerMetadataProvider, _resetMetadataProviders, metadataSourceIds, selectedMetadataProvider,
  activeMetadataProvider, metadataProviderList, makeMetadataClient, testMetadataProvider,
} from '../src/metadata.js';
import { makeCvClient } from '../src/cv.js';
import { validateSettings } from '../src/settings.js';

afterEach(() => _resetMetadataProviders());

const fake = (extra = {}) => ({
  id: 'fakedb', label: 'Fake DB', fields: [{ key: 'fakeKey', label: 'Key', type: 'password' }],
  isConfigured: (c) => !!c.fakeKey,
  makeClient: (c) => ({ provider: 'fakedb', key: c.fakeKey, async search() { return [{ id: 1 }]; } }),
  ...extra,
});

test('the built-in providers are hosted, comicvine and metron', () => {
  assert.deepEqual(metadataSourceIds(), ['hosted', 'comicvine', 'metron']);
});

test('makeCvClient hands a metron source to the Metron client, unconfigured falls back to hosted', () => {
  const metron = makeCvClient({ metadataSource: 'metron', metronUser: 'u', metronPass: 'p' });
  assert.equal(metron.provider, 'metron');
  assert.equal(typeof metron.list, 'undefined');
  const fallback = makeCvClient({ metadataSource: 'metron', metronUser: '', metronPass: '' });
  assert.equal(fallback.provider, undefined);
  assert.equal(typeof fallback.list, 'function'); // the ComicVine-shaped hosted client
  assert.equal(activeMetadataProvider({ metadataSource: 'metron' }).id, 'hosted');
  assert.equal(selectedMetadataProvider({ metadataSource: 'metron' }).id, 'metron');
});

test('noDispatch keeps a call on the built-in client even with another source selected', () => {
  const c = makeCvClient({ metadataSource: 'metron', metronUser: 'u', metronPass: 'p' }, { noDispatch: true });
  assert.equal(c.provider, undefined);
});

test('a plugin provider registers once, validates its shape, and dispatches', () => {
  assert.equal(registerMetadataProvider({ id: 'Bad Id!', label: 'x', makeClient() {} }), false);
  assert.equal(registerMetadataProvider({ id: 'hosted', label: 'x', makeClient() {} }), false); // cannot replace a built-in
  assert.equal(registerMetadataProvider({ id: 'nofn', label: 'x' }), false);
  assert.equal(registerMetadataProvider(fake(), 'fake-plugin'), true);
  assert.equal(registerMetadataProvider(fake(), 'fake-plugin'), false); // idempotent
  assert.ok(metadataSourceIds().includes('fakedb'));
  const c = makeCvClient({ metadataSource: 'fakedb', fakeKey: 'k' });
  assert.equal(c.provider, 'fakedb');
  assert.equal(c.key, 'k');
  // Not configured → the hosted client, like ComicVine-direct without a key.
  assert.equal(makeCvClient({ metadataSource: 'fakedb' }).provider, undefined);
  assert.equal(makeMetadataClient({ metadataSource: 'fakedb', fakeKey: 'k' }).provider, 'fakedb');
});

test('metadataProviderList describes providers without leaking values', () => {
  registerMetadataProvider(fake(), 'fake-plugin');
  const cfg = { metadataSource: 'fakedb', fakeKey: 'secret', comicvineKeys: 'cvsecret', metronUser: 'u', metronPass: 'pw' };
  const list = metadataProviderList(cfg);
  const json = JSON.stringify(list);
  assert.ok(!json.includes('secret') && !json.includes('pw"'));
  const byId = Object.fromEntries(list.map((p) => [p.id, p]));
  assert.equal(byId.fakedb.plugin, 'fake-plugin');
  assert.equal(byId.fakedb.configured, true);
  assert.equal(byId.fakedb.active, true);
  assert.equal(byId.fakedb.selected, true);
  assert.equal(byId.hosted.active, false);
  assert.equal(byId.metron.configured, true);
  assert.equal(byId.comicvine.fields[0].key, 'comicvineKeys');
  assert.deepEqual(byId.metron.fields.map((f) => f.type), ['text', 'password']);
  // Selected but unconfigured: active flips to hosted.
  const l2 = metadataProviderList({ metadataSource: 'fakedb' });
  assert.equal(l2.find((p) => p.id === 'fakedb').active, false);
  assert.equal(l2.find((p) => p.id === 'hosted').active, true);
});

test('validateSettings accepts every registered source id and nothing else', () => {
  assert.equal(validateSettings({ metadataSource: 'metron' }).metadataSource, 'metron');
  assert.equal(validateSettings({ metadataSource: 'bogus' }).metadataSource, undefined);
  registerMetadataProvider(fake());
  assert.equal(validateSettings({ metadataSource: 'fakedb' }).metadataSource, 'fakedb');
  assert.equal(validateSettings({ metronUser: ' me ', metronPass: '' }).metronUser, 'me');
  assert.equal(validateSettings({ metronPass: '' }).metronPass, ''); // clearable
});

test('testMetadataProvider overlays only the declared fields and uses the provider test', async () => {
  let seen = null;
  registerMetadataProvider(fake({ test: async (c) => { seen = c; return { ok: true, message: 'hi' }; } }));
  const r = await testMetadataProvider({ metadataSource: 'hosted', other: 1 }, { provider: 'fakedb', values: { fakeKey: 'k', other: 'ignored', metronPass: 'nope' } });
  assert.deepEqual(r, { ok: true, message: 'hi' });
  assert.equal(seen.fakeKey, 'k');
  assert.equal(seen.other, 1);
  assert.equal(seen.metronPass, undefined);
  assert.equal(seen.metadataSource, 'fakedb');
  assert.deepEqual(await testMetadataProvider({}, { provider: 'nope' }), { ok: false, message: 'Unknown metadata provider.' });
  // Without a test fn the default is a search; a throwing client is reported, not thrown.
  registerMetadataProvider({ id: 'boom', label: 'Boom', makeClient: () => ({ async search() { throw new Error('down'); } }) });
  assert.deepEqual(await testMetadataProvider({}, { provider: 'boom' }), { ok: false, message: 'down' });
  // ComicVine with no key is a clear message, not a network call.
  assert.deepEqual(await testMetadataProvider({}, { provider: 'comicvine', values: { comicvineKeys: '' } }), { ok: false, message: 'Enter an API key.' });
});
