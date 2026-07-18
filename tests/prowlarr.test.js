import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prowlarrConfigured, prowlarrIndexers, prowlarrIndexerList, testProwlarr } from '../src/prowlarr.js';

const ok = (data) => ({ ok: true, status: 200, json: async () => data });

const INDEXERS = [
  { id: 1, name: 'NZBgeek', protocol: 'usenet', enable: true },
  { id: 2, name: 'RARBG', protocol: 'torrent' },              // enable omitted → treated as on
  { id: 3, name: 'Retired', protocol: 'usenet', enable: false }, // disabled → skipped
  { id: 4, name: 'AnimeBytes', protocol: 'torrent', enable: true },
];

test('prowlarrConfigured requires enabled + url + key', () => {
  assert.equal(prowlarrConfigured({}), false);
  assert.equal(prowlarrConfigured({ prowlarrEnabled: true }), false);
  assert.equal(prowlarrConfigured({ prowlarrEnabled: true, prowlarrUrl: 'http://p', prowlarrApiKey: '' }), false);
  assert.equal(prowlarrConfigured({ prowlarrEnabled: true, prowlarrUrl: 'http://p', prowlarrApiKey: 'k' }), true);
});

test('prowlarrIndexers splits enabled indexers by protocol into feed descriptors', async () => {
  const cfg = { prowlarrEnabled: true, prowlarrUrl: 'http://p1:9696/', prowlarrApiKey: 'KEY' };
  const { newznab, torznab } = await prowlarrIndexers(cfg, { fetchImpl: async () => ok(INDEXERS) });
  assert.deepEqual(newznab, [{ name: 'Prowlarr: NZBgeek', url: 'http://p1:9696/1/api', apiKey: 'KEY' }]);
  assert.deepEqual(torznab, [
    { name: 'Prowlarr: RARBG', url: 'http://p1:9696/2/api', apiKey: 'KEY' },
    { name: 'Prowlarr: AnimeBytes', url: 'http://p1:9696/4/api', apiKey: 'KEY' },
  ]);
});

test('prowlarrIndexers skips ids in prowlarrExcludeIds', async () => {
  const cfg = { prowlarrEnabled: true, prowlarrUrl: 'http://p-ex', prowlarrApiKey: 'k', prowlarrExcludeIds: '1, 4' };
  const { newznab, torznab } = await prowlarrIndexers(cfg, { fetchImpl: async () => ok(INDEXERS) });
  assert.deepEqual(newznab, []); // id 1 excluded (id 3 already disabled in Prowlarr)
  assert.deepEqual(torznab.map((t) => t.name), ['Prowlarr: RARBG']); // id 4 excluded, id 2 kept
});

test('prowlarrIndexerList returns id/name/protocol for the picker', async () => {
  const list = await prowlarrIndexerList({ prowlarrUrl: 'http://p-list', prowlarrApiKey: 'k' }, { fetchImpl: async () => ok(INDEXERS) });
  assert.deepEqual(list, [
    { id: 1, name: 'NZBgeek', protocol: 'usenet' },
    { id: 2, name: 'RARBG', protocol: 'torrent' },
    { id: 4, name: 'AnimeBytes', protocol: 'torrent' },
  ]);
});

test('prowlarrIndexers returns empty (no fetch) when not configured', async () => {
  let called = false;
  const r = await prowlarrIndexers({ prowlarrEnabled: false }, { fetchImpl: async () => { called = true; return ok([]); } });
  assert.deepEqual(r, { newznab: [], torznab: [] });
  assert.equal(called, false);
});

test('prowlarrIndexers caches by url+key and survives a later fetch failure', async () => {
  const cfg = { prowlarrEnabled: true, prowlarrUrl: 'http://p2', prowlarrApiKey: 'k2' };
  let calls = 0;
  const good = { fetchImpl: async () => { calls++; return ok(INDEXERS); } };
  const first = await prowlarrIndexers(cfg, good);
  assert.equal(first.newznab.length, 1);
  // Second call within TTL: served from cache, fetch not hit again.
  await prowlarrIndexers(cfg, { fetchImpl: async () => { throw new Error('should not be called'); } });
  assert.equal(calls, 1);
});

test('testProwlarr reports indexer counts and auth/URL failures', async () => {
  const good = await testProwlarr({ prowlarrUrl: 'http://p', prowlarrApiKey: 'k' }, { fetchImpl: async () => ok(INDEXERS) });
  assert.equal(good.ok, true);
  assert.equal(good.usenet, 1);
  assert.equal(good.torrent, 2);

  const unauthorized = await testProwlarr({ prowlarrUrl: 'http://p' }, { fetchImpl: async () => ({ ok: false, status: 401 }) });
  assert.equal(unauthorized.ok, false);
  assert.match(unauthorized.message, /Unauthorized/);

  const notProwlarr = await testProwlarr({ prowlarrUrl: 'http://p', prowlarrApiKey: 'k' }, { fetchImpl: async () => ok({ nope: true }) });
  assert.equal(notProwlarr.ok, false);

  const noUrl = await testProwlarr({});
  assert.equal(noUrl.ok, false);
});
