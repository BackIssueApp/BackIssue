// Every indexer, download-client, metadata, catalog and reading-list request
// carries an abort signal, so a peer that stops answering fails the call
// instead of holding it for the HTTP stack's 5-minute default.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchIndexer } from '../src/newznab.js';
import { searchTorznab } from '../src/torznab.js';
import { makeNzbClient } from '../src/nzbclients.js';
import { makeQbClient, makeTransmissionClient } from '../src/torrentclients.js';
import { makeCvClient } from '../src/cv.js';
import { fetchCatalog } from '../src/plugincatalog.js';
import { fetchCatalogCbl } from '../src/cbl.js';
import { fetchWeeklyReleases } from '../src/releases.js';

function spy(body = '{}') {
  const seen = [];
  const fetchImpl = async (url, opts = {}) => {
    seen.push({ url: String(url), signal: opts.signal });
    return { ok: true, status: 200, headers: new Headers({ 'set-cookie': 'SID=x' }), text: async () => body, json: async () => JSON.parse(body), arrayBuffer: async () => new ArrayBuffer(0) };
  };
  return { seen, fetchImpl };
}
const allSigned = (seen) => {
  assert.ok(seen.length > 0, 'made a request');
  for (const s of seen) assert.ok(s.signal instanceof AbortSignal, `no timeout on ${s.url}`);
};

test('indexer searches carry a timeout', async () => {
  const a = spy('<rss><channel></channel></rss>');
  await searchIndexer({ name: 'n', url: 'http://idx', apikey: 'k' }, 'x', { fetchImpl: a.fetchImpl }).catch(() => {});
  allSigned(a.seen);
  const b = spy('<rss><channel></channel></rss>');
  await searchTorznab([{ name: 't', url: 'http://idx', apikey: 'k' }], 'x', { fetchImpl: b.fetchImpl }).catch(() => {});
  allSigned(b.seen);
});

test('download-client calls carry a timeout', async () => {
  const sab = spy('{"queue":{"slots":[]},"history":{"slots":[]}}');
  await makeNzbClient({ nzbClient: 'sabnzbd', nzbClientUrl: 'http://sab', nzbClientApiKey: 'k' }, { fetchImpl: sab.fetchImpl }).listByCategory('comics').catch(() => {});
  allSigned(sab.seen);
  const qb = spy('[]');
  await makeQbClient({ qbHost: 'qb' }, { fetchImpl: qb.fetchImpl }).listByCategory('comics').catch(() => {});
  allSigned(qb.seen);
  const tr = spy('{"result":"success","arguments":{"torrents":[]}}');
  await makeTransmissionClient({ trHost: 'tr' }, { fetchImpl: tr.fetchImpl }).listByCategory('comics').catch(() => {});
  allSigned(tr.seen);
});

test('metadata, catalog, release and reading-list fetches carry a timeout', async () => {
  const cv = spy('{"status_code":1,"results":[]}');
  await makeCvClient({}, { fetchImpl: cv.fetchImpl, key: 'K', politeMs: 0, noDispatch: true }).search('x');
  allSigned(cv.seen);
  const cat = spy('{"plugins":[]}');
  await fetchCatalog({ fetchImpl: cat.fetchImpl, url: 'http://cat' });
  allSigned(cat.seen);
  const cbl = spy('<ReadingList></ReadingList>');
  await fetchCatalogCbl('x.cbl', { fetchImpl: cbl.fetchImpl }).catch(() => {});
  allSigned(cbl.seen);
  const rel = spy('[]');
  await fetchWeeklyReleases({ week: 1, year: 2026 }, { fetchImpl: rel.fetchImpl });
  allSigned(rel.seen);
});

test('a metadata request that times out is retried', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    if (++calls === 1) throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    return { ok: true, status: 200, json: async () => ({ status_code: 1, results: [] }) };
  };
  const r = await makeCvClient({}, { fetchImpl, key: 'K', politeMs: 0, noDispatch: true }).search('x');
  assert.deepEqual(r, []);
  assert.equal(calls, 2);
});
