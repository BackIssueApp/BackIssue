import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { magnetInfohash, torrentInfohash } from '../src/torrenthash.js';
import { parseTorznabJson, parseTorznab, searchTorznab, testTorznabIndexer } from '../src/torznab.js';
import { makeQbClient, qbBaseUrl, testTorrentClient } from '../src/torrentclients.js';
import { torrent } from '../src/sources/torrent.js';
import { createDownloadMonitor } from '../src/downloadmonitor.js';
import { openDb, upsertSeries, upsertIssue, recordGrab } from '../src/db.js';
import config from '../src/config.js';

// ---- infohash ----
test('magnetInfohash: hex btih (lowercased) and base32 → hex', () => {
  assert.equal(magnetInfohash('magnet:?xt=urn:btih:ABCDEF0123456789ABCDEF0123456789ABCDEF01&dn=x'),
    'abcdef0123456789abcdef0123456789abcdef01');
  // base32 of 20 zero bytes → 32 'A's → hex of 20 zero bytes
  assert.equal(magnetInfohash('magnet:?xt=urn:btih:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
    '0000000000000000000000000000000000000000');
  assert.equal(magnetInfohash('not a magnet'), null);
});

test('torrentInfohash: sha1 of the bencoded info dict', () => {
  const info = Buffer.concat([
    Buffer.from('d6:lengthi3e4:name5:a.jpg12:piece lengthi16384e6:pieces20:'),
    Buffer.alloc(20, 7), Buffer.from('e'),
  ]);
  const torrentBuf = Buffer.concat([Buffer.from('d4:info'), info, Buffer.from('e')]);
  const expected = crypto.createHash('sha1').update(info).digest('hex');
  assert.equal(torrentInfohash(torrentBuf), expected);
});

// ---- torznab parsing ----
test('parseTorznabJson: magnet attr, enclosure .torrent, seeders + size', () => {
  const json = { channel: { item: [
    { title: 'Saga 001 (2012)',
      enclosure: { '@attributes': { url: 'http://x/1.torrent', length: '1000', type: 'application/x-bittorrent' } },
      'torznab:attr': [ { '@attributes': { name: 'seeders', value: '50' } }, { '@attributes': { name: 'magneturl', value: 'magnet:?xt=urn:btih:aaaa' } } ] },
    { title: 'Saga 001 (2012)', link: 'magnet:?xt=urn:btih:bbbb', 'torznab:attr': { '@attributes': { name: 'seeders', value: '5' } } },
    { title: 'no link here' }, // dropped — no downloadable url
  ] } };
  const out = parseTorznabJson(json, 'jack');
  assert.equal(out.length, 2);
  assert.equal(out[0].downloadUrl, 'magnet:?xt=urn:btih:aaaa'); // magnet attr preferred over enclosure
  assert.equal(out[0].magnet, true);
  assert.equal(out[0].seeders, 50);
  assert.equal(out[0].size, 1000);
  assert.equal(out[1].downloadUrl, 'magnet:?xt=urn:btih:bbbb'); // magnet from link
});

// Prowlarr returns Torznab XML/RSS (not JSON) — the real-world case.
const PROWLARR_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed">
  <channel>
    <item>
      <title>Batman 001 (2016)</title>
      <guid>abc</guid>
      <link>https://prowlarr/10/download?apikey=k&amp;guid=abc</link>
      <size>123456</size>
      <enclosure url="magnet:?xt=urn:btih:aabbccddeeff00112233445566778899aabbccdd" length="123456" type="application/x-bittorrent"/>
      <torznab:attr name="seeders" value="42"/>
      <torznab:attr name="peers" value="50"/>
    </item>
  </channel>
</rss>`;

test('parseTorznab: parses Prowlarr XML (magnet from enclosure, seeders, size)', () => {
  const out = parseTorznab(PROWLARR_XML, 'prowlarr');
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'Batman 001 (2016)');
  assert.equal(out[0].downloadUrl, 'magnet:?xt=urn:btih:aabbccddeeff00112233445566778899aabbccdd');
  assert.equal(out[0].magnet, true);
  assert.equal(out[0].seeders, 42);
  assert.equal(out[0].size, 123456);
});

test('searchTorznab: tolerates a URL saved with a trailing /api (no /api/api)', async () => {
  const seen = [];
  const fetchImpl = async (url) => { seen.push(String(url)); return { ok: true, text: async () => '<rss><channel></channel></rss>' }; };
  for (const url of ['http://p/10', 'http://p/10/', 'http://p/10/api', 'http://p/10/api/']) {
    await searchTorznab([{ name: 'p', url, apiKey: 'k' }], 'x', { fetchImpl });
  }
  for (const u of seen) {
    assert.doesNotMatch(u, /\/api\/api/); // never doubled
    assert.match(u, /\/10\/api\?/);       // always the single API root
  }
});

test('searchTorznab: sorts by seeders then size, survives a dead indexer', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('dead')) throw new Error('down');
    return { ok: true, text: async () => JSON.stringify({ item: [
      { title: 'X 1', link: 'magnet:?xt=urn:btih:1', 'torznab:attr': [{ '@attributes': { name: 'seeders', value: '3' } }] },
      { title: 'X 2', link: 'magnet:?xt=urn:btih:2', 'torznab:attr': [{ '@attributes': { name: 'seeders', value: '99' } }] },
    ] }) };
  };
  const out = await searchTorznab([{ name: 'ok', url: 'http://ok', apiKey: 'k' }, { name: 'dead', url: 'http://dead', apiKey: 'k' }], 'x', { fetchImpl });
  assert.equal(out.length, 2);
  assert.equal(out[0].seeders, 99); // best-seeded first
});

test('testTorznabIndexer: reports connection + results from XML', async () => {
  const fetchImpl = async () => ({ ok: true, text: async () => PROWLARR_XML });
  const r = await testTorznabIndexer({ name: 'j', url: 'http://j', apiKey: 'k' }, { fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.results, 1);
});

test('testTorznabIndexer: connected but Comics category empty → still OK with a hint', async () => {
  const fetchImpl = async (url) => ({ ok: true, text: async () =>
    (String(url).includes('cat=7030') ? '<rss><channel></channel></rss>' : PROWLARR_XML) });
  const r = await testTorznabIndexer({ name: 'j', url: 'http://j', apiKey: 'k' }, { fetchImpl });
  assert.equal(r.ok, true);
  assert.match(r.message, /may not tag comics|matched by title/);
});

test('testTorznabIndexer: surfaces a Torznab <error> element', async () => {
  const fetchImpl = async () => ({ ok: true, text: async () => '<?xml version="1.0"?><error code="100" description="Invalid API Key"/>' });
  const r = await testTorznabIndexer({ name: 'j', url: 'http://j', apiKey: 'bad' }, { fetchImpl });
  assert.equal(r.ok, false);
  assert.match(r.message, /Invalid API Key/);
});

// ---- qBittorrent client ----
function fakeQb({ torrents = [] } = {}) {
  const calls = [];
  const resp = (text, { json, status = 200, cookie } = {}) => ({
    ok: status >= 200 && status < 300, status,
    text: async () => text,
    json: async () => (json !== undefined ? json : JSON.parse(text)),
    arrayBuffer: async () => Buffer.from(text),
    headers: { get: (h) => (h.toLowerCase() === 'set-cookie' ? (cookie || null) : null) },
  });
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url); calls.push({ url: u, method: opts.method || 'GET' });
    if (u.includes('/auth/login')) return resp('Ok.', { cookie: 'SID=sess; path=/' });
    if (u.includes('/torrents/add')) return resp('Ok.');
    if (u.includes('/torrents/delete')) return resp('');
    if (u.includes('/app/version')) return resp('v4.6.0');
    if (u.includes('/torrents/info')) return resp('', { json: torrents });
    return resp('', { status: 404 });
  };
  return { fetchImpl, calls };
}

test('qbBaseUrl builds from host/port/ssl', () => {
  assert.equal(qbBaseUrl({ qbHost: 'nas', qbPort: 8080 }), 'http://nas:8080');
  assert.equal(qbBaseUrl({ qbHost: 'nas', qbPort: 443, qbSsl: true }), 'https://nas:443');
  assert.equal(qbBaseUrl({ qbHost: '' }), '');
});

test('qb add: magnet → returns its infohash and logs in first', async () => {
  const { fetchImpl, calls } = fakeQb();
  const client = makeQbClient({ qbHost: 'h', qbPort: 8080 }, { fetchImpl });
  const hash = await client.add('magnet:?xt=urn:btih:ABCDEF0123456789ABCDEF0123456789ABCDEF01', { name: 'Saga 1', category: 'backissue' });
  assert.equal(hash, 'abcdef0123456789abcdef0123456789abcdef01');
  assert.ok(calls.some((c) => c.url.includes('/auth/login')));
  assert.ok(calls.some((c) => c.url.includes('/torrents/add') && c.method === 'POST'));
});

test('qb client: sends no Referer/Origin (reverse-proxy CSRF safe) and forwards the SID cookie', async () => {
  const seen = [];
  const fetchImpl = async (url, opts = {}) => {
    seen.push({ url: String(url), headers: opts.headers || {} });
    const cookieHdr = String(url).includes('/auth/login') ? 'SID=sess; HttpOnly; path=/' : null;
    return {
      ok: true, status: 200,
      text: async () => (String(url).includes('/auth/login') ? 'Ok.' : ''),
      json: async () => [],
      headers: { get: (h) => (h.toLowerCase() === 'set-cookie' ? cookieHdr : null) },
    };
  };
  const client = makeQbClient({ qbHost: 'h', qbPort: 8080, qbUser: 'admin', qbPass: 'pw' }, { fetchImpl });
  await client.listByCategory('backissue');
  for (const c of seen) {
    assert.equal(c.headers.Referer, undefined); // never set — would trip qB's CSRF host check behind a proxy
    assert.equal(c.headers.Origin, undefined);
  }
  const info = seen.find((c) => c.url.includes('/torrents/info'));
  assert.equal(info.headers.Cookie, 'SID=sess'); // session cookie forwarded to the authed call
});

test('qb status/list: maps state, progress, and remaps content path', () => {
  const cfg = { qbHost: 'h', qbPort: 8080, torrentCompleteDirRemote: '/downloads', torrentCompleteDir: '\\\\NAS\\dl' };
  const torrents = [
    { hash: 'AAAA', name: 'done', state: 'stalledUP', progress: 1, content_path: '/downloads/done/x.cbz', num_complete: 12 },
    { hash: 'bbbb', name: 'dl', state: 'downloading', progress: 0.5, content_path: '/downloads/dl', num_complete: 30 },
    { hash: 'cccc', name: 'bad', state: 'error', progress: 0.1 },
  ];
  const { fetchImpl } = fakeQb({ torrents });
  const client = makeQbClient(cfg, { fetchImpl });
  return client.listByCategory('backissue').then((list) => {
    const byId = Object.fromEntries(list.map((t) => [t.id, t]));
    assert.equal(byId.aaaa.state, 'done');
    assert.equal(byId.aaaa.path, '//NAS/dl/done/x.cbz'); // remote→local remap, normalized slashes
    assert.equal(byId.bbbb.state, 'downloading');
    assert.equal(byId.bbbb.progress, 50);
    assert.equal(byId.bbbb.seeders, 30); // swarm seeders surfaced for the queue
    assert.equal(byId.cccc.state, 'failed');
  });
});

// ---- torrent source ----
test('torrent source: disabled unless enabled + indexers + qb host', () => {
  assert.equal(torrent.isEnabled({ torrentEnabled: true, torznabIndexers: 'j|http://j|k', qbHost: 'h' }), true);
  assert.equal(torrent.isEnabled({ torrentEnabled: false, torznabIndexers: 'j|http://j|k', qbHost: 'h' }), false);
  assert.equal(torrent.isEnabled({ torrentEnabled: true, torznabIndexers: '', qbHost: 'h' }), false);
  assert.equal(torrent.isEnabled({ torrentEnabled: true, torznabIndexers: 'j|http://j|k', qbHost: '' }), false);
});

test('torrent source find: picks the right issue, best-seeded', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, text: async () => JSON.stringify({ item: [
    { title: 'Saga 002 (2012)', link: 'magnet:?xt=urn:btih:wrong', 'torznab:attr': [{ '@attributes': { name: 'seeders', value: '100' } }] }, // wrong number
    { title: 'Saga 001 (2012)', link: 'magnet:?xt=urn:btih:low', 'torznab:attr': [{ '@attributes': { name: 'seeders', value: '2' } }] },
    { title: 'Saga 001 (2012)', link: 'magnet:?xt=urn:btih:high', 'torznab:attr': [{ '@attributes': { name: 'seeders', value: '80' } }] },
  ] }) });
  try {
    const ctx = {
      config: { torznabIndexers: 'j | http://j | k', qbHost: 'h' },
      seriesTitle: 'Saga', seriesYear: '2012', seriesNames: ['Saga'],
      issue: { issue_number: '1' },
    };
    const c = await torrent.find(ctx);
    assert.equal(c.source, 'torrent');
    assert.equal(c.downloadUrl, 'magnet:?xt=urn:btih:high'); // right number, most seeders
  } finally { globalThis.fetch = orig; }
});

test('download monitor: captures torrent progress + seeders into the queue snapshot', async () => {
  const db = openDb(':memory:');
  const sid = upsertSeries(db, { title: 'Saga', url: 'cv:1' });
  const iid = upsertIssue(db, { seriesId: sid, title: 'Saga #1', issueNumber: '1', url: 'cvissue:1' });
  const hash = 'abcdef0123456789abcdef0123456789abcdef01';
  recordGrab(db, { issueId: iid, source: 'torrent', client: 'qbittorrent', downloadId: hash, category: 'bc', title: 'Saga 1' });

  const saved = { host: config.qbHost, port: config.qbPort, cat: config.torrentCategory, tc: config.torrentClient };
  Object.assign(config, { qbHost: 'h', qbPort: 8080, torrentClient: 'qbittorrent', torrentCategory: 'bc' });
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    const resp = (text, json) => ({ ok: true, status: 200, text: async () => text, json: async () => json, headers: { get: () => 'SID=s' } });
    if (u.includes('/auth/login')) return resp('Ok.');
    if (u.includes('/torrents/info')) return resp('', [{ hash, name: 'Saga 1', state: 'downloading', progress: 0.4, num_complete: 20 }]);
    return resp('', {});
  };
  try {
    const mon = createDownloadMonitor({ db });
    await mon.tick();
    const snap = mon.getProgress();
    assert.equal(snap[iid].source, 'torrent');
    assert.equal(snap[iid].progress, 40);
    assert.equal(snap[iid].seeders, 20);
  } finally {
    globalThis.fetch = origFetch;
    Object.assign(config, { qbHost: saved.host, qbPort: saved.port, torrentCategory: saved.cat, torrentClient: saved.tc });
  }
});

function qbTestFetch({ loginCookie = 'SID=s; path=/', loginStatus = 200, loginText = 'Ok.', versionStatus = 200, versionText = 'v4.6.0' } = {}) {
  const mk = (status, text, cookie) => ({
    ok: status >= 200 && status < 300, status,
    text: async () => text, json: async () => [],
    headers: { get: (h) => (h.toLowerCase() === 'set-cookie' ? (cookie || null) : null) },
  });
  return async (url) => {
    const u = String(url);
    if (u.includes('/auth/login')) return mk(loginStatus, loginText, loginCookie);
    if (u.includes('/app/version')) return mk(versionStatus, versionText);
    return mk(200, '');
  };
}

test('testTorrentClient: success reports the version', async () => {
  const r = await testTorrentClient({ qbHost: 'h', qbPort: 8080 }, { fetchImpl: qbTestFetch() });
  assert.equal(r.ok, true);
  assert.match(r.message, /v4\.6\.0/);
});

test('testTorrentClient: 403 after a good login → host-validation hint', async () => {
  const r = await testTorrentClient({ qbHost: 'h', qbPort: 8080 }, { fetchImpl: qbTestFetch({ versionStatus: 403 }) });
  assert.equal(r.ok, false);
  assert.match(r.message, /Host header validation/i);
});

test('testTorrentClient: login ok but no cookie + 403 → proxy-stripping hint', async () => {
  const r = await testTorrentClient({ qbHost: 'h', qbPort: 8080 }, { fetchImpl: qbTestFetch({ loginCookie: null, versionStatus: 403 }) });
  assert.equal(r.ok, false);
  assert.match(r.message, /stripping|cookie/i);
});

test('testTorrentClient: wrong password is reported clearly', async () => {
  const r = await testTorrentClient({ qbHost: 'h', qbPort: 8080 }, { fetchImpl: qbTestFetch({ loginText: 'Fails.' }) });
  assert.equal(r.ok, false);
  assert.match(r.message, /password/i);
});

test('testTorrentClient: a login redirect that drops the cookie is diagnosed', async () => {
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes('/auth/login')) return { ok: true, status: 200, redirected: true, url: 'https://qb/api/v2/auth/login', text: async () => 'Ok.', headers: { get: () => null, getSetCookie: () => [] } };
    return { ok: true, status: 200, text: async () => 'v4', headers: { get: () => null } };
  };
  const r = await testTorrentClient({ qbHost: 'qb', qbSsl: false }, { fetchImpl });
  assert.equal(r.ok, false);
  assert.match(r.message, /redirect|HTTPS/i);
});

test('qb client: captures the qBittorrent 5.x QBT_SID_<port> cookie and forwards it', async () => {
  const seen = [];
  const fetchImpl = async (url, opts = {}) => {
    seen.push({ url: String(url), headers: opts.headers || {} });
    const cookie = String(url).includes('/auth/login') ? 'QBT_SID_8080=WGtx1PAot7; secure; HttpOnly; SameSite=None; path=/' : null;
    return {
      ok: true, status: String(url).includes('/torrents/info') ? 200 : 204,
      text: async () => '', json: async () => [],
      headers: { get: (h) => (h.toLowerCase() === 'set-cookie' ? cookie : null), getSetCookie: () => (cookie ? [cookie] : []) },
    };
  };
  const client = makeQbClient({ qbHost: 'h', qbPort: 8080, qbUser: 'seed', qbPass: 'pw' }, { fetchImpl });
  await client.listByCategory('backissue');
  const info = seen.find((c) => c.url.includes('/torrents/info'));
  assert.equal(info.headers.Cookie, 'QBT_SID_8080=WGtx1PAot7'); // qB 5.x cookie name, forwarded verbatim
});

test('torrent source find: rejects a suspiciously tiny release despite big seeders (fake guard)', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, text: async () => JSON.stringify({ item: [
    { title: 'Saga 001 (2012)', link: 'magnet:?xt=urn:btih:fake', size: 5 * 1024, 'torznab:attr': [{ '@attributes': { name: 'seeders', value: '999' } }] },   // 5KB fake, huge seeders
    { title: 'Saga 001 (2012)', link: 'magnet:?xt=urn:btih:real', size: 40 * 1024 * 1024, 'torznab:attr': [{ '@attributes': { name: 'seeders', value: '4' } }] }, // 40MB real
    { title: 'Saga 001 (2012)', link: 'magnet:?xt=urn:btih:unsized', 'torznab:attr': [{ '@attributes': { name: 'seeders', value: '2' } }] },                  // size unknown → allowed
  ] }) });
  try {
    const ctx = { config: { torznabIndexers: 'j | http://j | k', qbHost: 'h' }, seriesTitle: 'Saga', seriesNames: ['Saga'], issue: { issue_number: '1' } };
    const c = await torrent.find(ctx);
    assert.equal(c.downloadUrl, 'magnet:?xt=urn:btih:real'); // fake filtered despite 999 seeders
  } finally { globalThis.fetch = orig; }
});

test('qb add: a .torrent proxy URL that redirects to a magnet takes the magnet path', async () => {
  const seen = [];
  const fetchImpl = async (url, opts = {}) => {
    seen.push({ url: String(url), redirect: opts.redirect });
    const u = String(url);
    if (u.includes('/auth/login')) return { ok: true, status: 200, text: async () => 'Ok.', headers: { get: () => 'SID=s', getSetCookie: () => ['SID=s'] } };
    if (u.includes('/torrents/add')) return { ok: true, status: 200, text: async () => 'Ok.', headers: { get: () => null } };
    if (u.includes('prowlarr/download')) return { ok: false, status: 302, headers: { get: (h) => (h.toLowerCase() === 'location' ? 'magnet:?xt=urn:btih:ABCDEF0123456789ABCDEF0123456789ABCDEF01' : null) }, text: async () => '' };
    return { ok: true, status: 200, text: async () => '', headers: { get: () => null } };
  };
  const client = makeQbClient({ qbHost: 'h', qbPort: 8080 }, { fetchImpl });
  const hash = await client.add('http://prowlarr/download?id=1', { name: 'X', category: 'bc' });
  assert.equal(hash, 'abcdef0123456789abcdef0123456789abcdef01'); // hash from the redirect target
  assert.equal(seen.filter((s) => s.url.includes('prowlarr/download')).length, 1); // fetched ONCE (hit-counted links)
});
