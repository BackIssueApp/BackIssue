import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIndexers, buildSearchUrl, parseNewznabJson, searchNewznab, testIndexer } from '../src/newznab.js';

test('parseIndexers: pipe-separated, skips blanks and comments', () => {
  const ix = parseIndexers('NZBgeek | https://api.nzbgeek.info/ | abc123\n# comment\n\nDrunken | https://drunkenslug.com | key2');
  assert.equal(ix.length, 2);
  assert.deepEqual(ix[0], { name: 'NZBgeek', url: 'https://api.nzbgeek.info', apiKey: 'abc123' });
  assert.equal(ix[1].url, 'https://drunkenslug.com'); // trailing slash trimmed
});

test('parseIndexers: empty/undefined → []', () => {
  assert.deepEqual(parseIndexers(''), []);
  assert.deepEqual(parseIndexers(undefined), []);
});

test('buildSearchUrl: newznab params with comics category', () => {
  const url = buildSearchUrl({ url: 'https://nz', apiKey: 'k' }, 'Invincible 001');
  assert.match(url, /^https:\/\/nz\/api\?/);
  assert.match(url, /t=search/);
  assert.match(url, /q=Invincible\+001/);
  assert.match(url, /cat=7030/);
  assert.match(url, /apikey=k/);
  assert.match(url, /o=json/);
});

test('parseNewznabJson: array items, link + size', () => {
  const json = { channel: { item: [
    { title: 'Invincible 001', guid: 'g1', link: 'https://nz/nzb/1', size: '52428800' },
    { title: 'Invincible 002', guid: 'g2', link: 'https://nz/nzb/2', size: '48000000' },
  ] } };
  const out = parseNewznabJson(json, 'NZ');
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { title: 'Invincible 001', guid: 'g1', nzbUrl: 'https://nz/nzb/1', size: 52428800, indexer: 'NZ' });
});

test('parseNewznabJson: single item object + enclosure url/length', () => {
  const json = { channel: { item: { title: 'Saga 001', guid: { '#text': 'g' }, enclosure: { '@attributes': { url: 'https://nz/e', length: '1000' } } } } };
  const out = parseNewznabJson(json, 'NZ');
  assert.equal(out.length, 1);
  assert.equal(out[0].nzbUrl, 'https://nz/e');
  assert.equal(out[0].size, 1000);
  assert.equal(out[0].guid, 'g');
});

test('parseNewznabJson: items with no link are skipped', () => {
  const json = { channel: { item: [{ title: 'no link' }, { title: 'ok', link: 'https://nz/x' }] } };
  assert.equal(parseNewznabJson(json, 'NZ').length, 1);
});

test('testIndexer: requires a url', async () => {
  const r = await testIndexer({ url: '' });
  assert.equal(r.ok, false);
  assert.match(r.message, /URL is required/i);
});

test('testIndexer: ok with results', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ channel: { item: [{ title: 'Batman 001', link: 'x', size: '1' }] } }) });
  const r = await testIndexer({ name: 'NZ', url: 'https://nz', apiKey: 'k' }, { fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.results, 1);
  assert.match(r.message, /valid/i);
});

test('testIndexer: ok but no comics results', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ channel: { item: [] } }) });
  const r = await testIndexer({ url: 'https://nz', apiKey: 'k' }, { fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.results, 0);
  assert.match(r.message, /no comics/i);
});

test('testIndexer: surfaces a newznab auth error (HTTP 200 + error body)', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ error: { code: '100', description: 'Incorrect user credentials' } }) });
  const r = await testIndexer({ url: 'https://nz', apiKey: 'bad' }, { fetchImpl });
  assert.equal(r.ok, false);
  assert.match(r.message, /Incorrect user credentials/);
});

test('testIndexer: HTTP error → not ok', async () => {
  const fetchImpl = async () => ({ ok: false, status: 404 });
  const r = await testIndexer({ url: 'https://nz' }, { fetchImpl });
  assert.equal(r.ok, false);
  assert.match(r.message, /404/);
});

test('testIndexer: non-JSON response → helpful message', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => { throw new Error('not json'); } });
  const r = await testIndexer({ url: 'https://nz' }, { fetchImpl });
  assert.equal(r.ok, false);
  assert.match(r.message, /Newznab API/i);
});

test('searchNewznab: merges indexers, largest first, survives a failure', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('good1')) return { ok: true, json: async () => ({ channel: { item: [{ title: 'A', link: 'a', size: '100' }] } }) };
    if (url.includes('good2')) return { ok: true, json: async () => ({ channel: { item: [{ title: 'B', link: 'b', size: '900' }] } }) };
    return { ok: false, status: 500 }; // 'bad' indexer
  };
  const indexers = [
    { name: 'g1', url: 'https://good1', apiKey: 'k' },
    { name: 'bad', url: 'https://bad', apiKey: 'k' },
    { name: 'g2', url: 'https://good2', apiKey: 'k' },
  ];
  const out = await searchNewznab(indexers, 'q', { fetchImpl });
  assert.deepEqual(out.map((r) => r.title), ['B', 'A']); // largest first, bad skipped
});
