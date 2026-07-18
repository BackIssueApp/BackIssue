import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pluginApi } from '../src/plugins.js';
import { resolveIndexers, indexersManaged } from '../src/indexerproviders.js';

// A stand-in indexer provider (what the Prowlarr plugin registers). Active when
// config.fakeOn; exclusive, supplying one newznab feed and no torznab feeds.
pluginApi.registerIndexerProvider({
  id: 'fake',
  isActive: (c) => !!c.fakeOn,
  indexers: async (c, protocol) => protocol === 'newznab'
    ? { indexers: [{ name: 'P1', url: 'http://p/1/api', apiKey: 'k' }], exclusive: true }
    : { indexers: [], exclusive: true },
});

test('indexersManaged reflects whether a provider is active', () => {
  assert.equal(indexersManaged({ fakeOn: false }), false);
  assert.equal(indexersManaged({ fakeOn: true }), true);
});

test('resolveIndexers uses the manual list when no provider is active', async () => {
  const r = await resolveIndexers({ fakeOn: false, newznabIndexers: 'M | http://m/ | key' }, 'newznab');
  assert.deepEqual(r, [{ name: 'M', url: 'http://m', apiKey: 'key' }]);
});

test('an active, exclusive provider replaces the manual list', async () => {
  const r = await resolveIndexers({ fakeOn: true, newznabIndexers: 'M | http://m/ | key' }, 'newznab');
  assert.deepEqual(r, [{ name: 'P1', url: 'http://p/1/api', apiKey: 'k' }]); // manual dropped
});

test('exclusive provider with no feeds for the protocol yields nothing', async () => {
  const r = await resolveIndexers({ fakeOn: true, torznabIndexers: 'T | http://t/ | key' }, 'torznab');
  assert.deepEqual(r, []); // manual dropped, provider supplied none
});
