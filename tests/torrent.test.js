import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { magnetInfohash, torrentInfohash } from '../src/torrenthash.js';
import { parseTorznabJson, parseTorznab, searchTorznab, testTorznabIndexer } from '../src/torznab.js';
import { makeQbClient, makeTransmissionClient, makeDelugeClient, makeTorrentClient, qbBaseUrl, trBaseUrl, delugeBaseUrl, testTorrentClient } from '../src/torrentclients.js';
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

// ---- Transmission client ----
// One RPC endpoint; any request without the current session id gets a 409
// carrying it. `rotateAfter` expires the id after N successful calls.
function fakeTransmission({ torrents = [], addResult, labelError = false, rotateAfter = Infinity, session = { version: '4.0.5', 'rpc-version': 17 } } = {}) {
  const calls = [];
  let sid = 'sid-1', okCalls = 0, handshakes = 0;
  const fetchImpl = async (url, opts = {}) => {
    const body = JSON.parse(opts.body);
    if ((opts.headers || {})['X-Transmission-Session-Id'] !== sid) {
      handshakes++;
      const cur = sid;
      return { ok: false, status: 409, headers: { get: (h) => (h.toLowerCase() === 'x-transmission-session-id' ? cur : null) }, json: async () => ({}), text: async () => '' };
    }
    calls.push({ method: body.method, args: body.arguments, headers: opts.headers });
    if (++okCalls >= rotateAfter) { rotateAfter = Infinity; sid = 'sid-2'; }
    const reply = (args, result = 'success') => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ result, arguments: args }) });
    if (body.method === 'torrent-add') return reply(addResult !== undefined ? addResult : { 'torrent-added': { id: 7, hashString: 'ABCDEF0123456789ABCDEF0123456789ABCDEF01' } });
    if (body.method === 'torrent-set') return reply({}, labelError ? 'unrecognized argument' : 'success');
    if (body.method === 'torrent-get') return reply({ torrents });
    if (body.method === 'torrent-remove') return reply({});
    if (body.method === 'session-get') return reply(session);
    return reply({}, 'method not found');
  };
  return { fetchImpl, calls, handshakes: () => handshakes };
}

test('trBaseUrl/delugeBaseUrl build from their own host/port/ssl', () => {
  assert.equal(trBaseUrl({ trHost: 'nas', trPort: 9091 }), 'http://nas:9091');
  assert.equal(trBaseUrl({ trHost: '' }), '');
  assert.equal(delugeBaseUrl({ delugeHost: 'nas', delugePort: 8112, delugeSsl: true }), 'https://nas:8112');
});

test('transmission add: 409 handshake, magnet hash lowercased, category applied as a label', async () => {
  const { fetchImpl, calls, handshakes } = fakeTransmission();
  const client = makeTransmissionClient({ trHost: 'h', trPort: 9091, trUser: 'u', trPass: 'p' }, { fetchImpl });
  const hash = await client.add('magnet:?xt=urn:btih:ABCDEF0123456789ABCDEF0123456789ABCDEF01', { name: 'Saga 1', category: 'bc' });
  assert.equal(hash, 'abcdef0123456789abcdef0123456789abcdef01');
  const add = calls.find((c) => c.method === 'torrent-add');
  assert.equal(add.args.filename, 'magnet:?xt=urn:btih:ABCDEF0123456789ABCDEF0123456789ABCDEF01');
  assert.match(add.headers.Authorization, /^Basic /); // credentials ride HTTP Basic
  assert.deepEqual(calls.find((c) => c.method === 'torrent-set').args, { ids: [7], labels: ['bc'] });
  assert.equal(handshakes(), 1); // one 409 handshake, then the session id is cached
});

test('transmission add: a duplicate still yields its hash; label errors are skipped (old RPC)', async () => {
  const { fetchImpl } = fakeTransmission({ addResult: { 'torrent-duplicate': { id: 3, hashString: 'AAAA' } }, labelError: true });
  const client = makeTransmissionClient({ trHost: 'h' }, { fetchImpl });
  assert.equal(await client.add('magnet:?xt=urn:btih:aaaa', { category: 'bc' }), 'aaaa');
});

test('transmission add: a response without hashString falls back to the magnet infohash', async () => {
  const { fetchImpl } = fakeTransmission({ addResult: { 'torrent-added': { id: 4 } } });
  const client = makeTransmissionClient({ trHost: 'h' }, { fetchImpl });
  assert.equal(await client.add('magnet:?xt=urn:btih:ABCDEF0123456789ABCDEF0123456789ABCDEF01', {}),
    'abcdef0123456789abcdef0123456789abcdef01');
});

test('transmission status/list: maps state, appends the name to downloadDir, filters by label', async () => {
  const cfg = { trHost: 'h', trPort: 9091, torrentCompleteDirRemote: '/downloads', torrentCompleteDir: '\\\\NAS\\dl' };
  const torrents = [
    { hashString: 'AAAA', name: 'done', percentDone: 1, error: 0, downloadDir: '/downloads', labels: ['bc'], trackerStats: [{ seederCount: 3 }, { seederCount: 12 }] },
    { hashString: 'bbbb', name: 'dl', percentDone: 0.5, error: 0, downloadDir: '/downloads', labels: ['bc'] },
    { hashString: 'cccc', name: 'bad', percentDone: 0.1, error: 3, errorString: 'tracker down', labels: ['bc'] },
    { hashString: 'dddd', name: 'other', percentDone: 1, error: 0, downloadDir: '/downloads', labels: ['movies'] },
    { hashString: 'eeee', name: 'old', percentDone: 1, error: 0, downloadDir: '/downloads' }, // pre-labels RPC — kept
  ];
  const { fetchImpl } = fakeTransmission({ torrents });
  const client = makeTransmissionClient(cfg, { fetchImpl });
  const list = await client.listByCategory('bc');
  const byId = Object.fromEntries(list.map((t) => [t.id, t]));
  assert.equal(list.length, 4);
  assert.equal(byId.dddd, undefined);            // other label filtered out
  assert.equal(byId.aaaa.state, 'done');
  assert.equal(byId.aaaa.path, '//NAS/dl/done'); // downloadDir + name, remapped
  assert.equal(byId.aaaa.seeders, 12);           // best tracker seeder count
  assert.equal(byId.bbbb.state, 'downloading');
  assert.equal(byId.bbbb.progress, 50);
  assert.equal(byId.cccc.state, 'failed');
  assert.equal(byId.cccc.error, 'tracker down');
  assert.equal(byId.eeee.state, 'done');         // no labels array → kept, matched by hash later
});

test('transmission status: queries by hash; an unknown hash reads as queued', async () => {
  const { fetchImpl, calls } = fakeTransmission({ torrents: [{ hashString: 'AAAA', name: 'x', percentDone: 0.25, error: 0 }] });
  const client = makeTransmissionClient({ trHost: 'h' }, { fetchImpl });
  assert.equal((await client.status('aaaa')).progress, 25);
  assert.deepEqual(calls.find((c) => c.method === 'torrent-get').args.ids, ['aaaa']);
  const empty = makeTransmissionClient({ trHost: 'h' }, { fetchImpl: fakeTransmission({ torrents: [] }).fetchImpl });
  assert.equal((await empty.status('aaaa')).state, 'queued');
});

test('transmission remove: passes ids and delete-local-data', async () => {
  const { fetchImpl, calls } = fakeTransmission();
  const client = makeTransmissionClient({ trHost: 'h' }, { fetchImpl });
  await client.remove('aaaa', { deleteFiles: true });
  assert.deepEqual(calls.find((c) => c.method === 'torrent-remove').args, { ids: ['aaaa'], 'delete-local-data': true });
});

test('transmission: a later 409 (rotated session id) re-handshakes transparently', async () => {
  const { fetchImpl, handshakes } = fakeTransmission({ rotateAfter: 1 });
  const client = makeTransmissionClient({ trHost: 'h' }, { fetchImpl });
  await client.listByCategory('bc'); // handshake 1; the ok call then rotates the id
  await client.listByCategory('bc'); // stale id → 409 → handshake 2 → retried ok
  assert.equal(handshakes(), 2);
});

test('testTorrentClient: transmission success reports version + RPC through the handshake', async () => {
  const { fetchImpl } = fakeTransmission();
  const r = await testTorrentClient({ torrentClient: 'transmission', trHost: 'h', trPort: 9091 }, { fetchImpl });
  assert.equal(r.ok, true);
  assert.match(r.message, /Transmission 4\.0\.5 \(RPC 17\)/);
});

test('testTorrentClient: transmission 401 → credentials hint; missing host reported', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, headers: { get: () => null }, json: async () => ({}) });
  const r = await testTorrentClient({ torrentClient: 'transmission', trHost: 'h' }, { fetchImpl });
  assert.equal(r.ok, false);
  assert.match(r.message, /username\/password/);
  const r2 = await testTorrentClient({ torrentClient: 'transmission' }, { fetchImpl });
  assert.match(r2.message, /host is required/i);
});

// ---- Deluge client ----
// Web-UI JSON-RPC: auth.login issues a session cookie, later calls without a
// valid one get a "Not authenticated" error. `expireAfter` kills the session
// after N authed calls; web.connect flips a disconnected UI to connected.
function fakeDeluge({ torrents = {}, addResult, password = 'pw', connected = true, hosts = [['h1', '127.0.0.1', 58846, 'Online']], labelError = false, version = '2.1.1', expireAfter = Infinity } = {}) {
  const calls = [];
  let sessions = 0, valid = null, authed = 0;
  const fetchImpl = async (url, opts = {}) => {
    const body = JSON.parse(opts.body);
    const cookie = (opts.headers || {}).Cookie || null;
    const reply = (result, error = null, setCookie = null) => ({
      ok: true, status: 200,
      json: async () => ({ result, error, id: body.id }),
      headers: { get: (h) => (h.toLowerCase() === 'set-cookie' ? setCookie : null), getSetCookie: () => (setCookie ? [setCookie] : []) },
    });
    calls.push({ method: body.method, params: body.params, cookie });
    if (body.method === 'auth.login') {
      if (body.params[0] !== password) return reply(false);
      valid = `_session_id=s${++sessions}`;
      return reply(true, null, `${valid}; Path=/json; HttpOnly`);
    }
    if (cookie !== valid) return reply(null, { message: 'Not authenticated', code: 1 });
    if (++authed >= expireAfter) { expireAfter = Infinity; valid = null; } // session dies after this call
    if (body.method === 'web.connected') return reply(connected);
    if (body.method === 'web.get_hosts') return reply(hosts);
    if (body.method === 'web.connect') { connected = true; return reply(null); }
    if (body.method === 'core.add_torrent_magnet' || body.method === 'core.add_torrent_url') return reply(addResult !== undefined ? addResult : 'abcdef0123456789abcdef0123456789abcdef01');
    if (body.method === 'label.add' || body.method === 'label.set_torrent') return reply(null, labelError ? { message: 'Unknown method' } : null);
    if (body.method === 'core.get_torrents_status') return reply(torrents);
    if (body.method === 'core.remove_torrent') return reply(true);
    if (body.method === 'daemon.get_version') return reply(version);
    return reply(null, { message: `Unknown method ${body.method}` });
  };
  return { fetchImpl, calls };
}

test('deluge add: cookie login, magnet add, category applied as a lowercase label', async () => {
  const { fetchImpl, calls } = fakeDeluge();
  const client = makeDelugeClient({ delugeHost: 'h', delugePort: 8112, delugePass: 'pw' }, { fetchImpl });
  const hash = await client.add('magnet:?xt=urn:btih:aaaa', { name: 'Saga 1', category: 'BackIssue' });
  assert.equal(hash, 'abcdef0123456789abcdef0123456789abcdef01');
  const add = calls.find((c) => c.method === 'core.add_torrent_magnet');
  assert.equal(add.params[0], 'magnet:?xt=urn:btih:aaaa');
  assert.equal(add.cookie, '_session_id=s1'); // session cookie echoed after login
  assert.deepEqual(calls.find((c) => c.method === 'label.add').params, ['backissue']);
  assert.deepEqual(calls.find((c) => c.method === 'label.set_torrent').params, [hash, 'backissue']);
});

test('deluge add: http links go through core.add_torrent_url', async () => {
  const { fetchImpl, calls } = fakeDeluge();
  const client = makeDelugeClient({ delugeHost: 'h', delugePass: 'pw' }, { fetchImpl });
  assert.equal(await client.add('http://prowlarr/download?id=1', {}), 'abcdef0123456789abcdef0123456789abcdef01');
  assert.equal(calls.find((c) => c.method === 'core.add_torrent_url').params[0], 'http://prowlarr/download?id=1');
});

test('deluge add: a duplicate (null result) falls back to the magnet infohash', async () => {
  const { fetchImpl } = fakeDeluge({ addResult: null });
  const client = makeDelugeClient({ delugeHost: 'h', delugePass: 'pw' }, { fetchImpl });
  assert.equal(await client.add('magnet:?xt=urn:btih:ABCDEF0123456789ABCDEF0123456789ABCDEF01', {}),
    'abcdef0123456789abcdef0123456789abcdef01');
});

test('deluge add: a missing Label plugin never fails the add', async () => {
  const { fetchImpl } = fakeDeluge({ labelError: true });
  const client = makeDelugeClient({ delugeHost: 'h', delugePass: 'pw' }, { fetchImpl });
  assert.equal(await client.add('magnet:?xt=urn:btih:aaaa', { category: 'bc' }), 'abcdef0123456789abcdef0123456789abcdef01');
});

test('deluge status/list: progress is already 0-100, save_path + name remapped, label-filtered', async () => {
  const cfg = { delugeHost: 'h', delugePass: 'pw', torrentCompleteDirRemote: '/downloads', torrentCompleteDir: '\\\\NAS\\dl' };
  const torrents = {
    aaaa: { name: 'done', progress: 100, state: 'Seeding', save_path: '/downloads', label: 'bc', total_seeds: 9 },
    bbbb: { name: 'dl', progress: 41.7, state: 'Downloading', label: 'bc' },
    cccc: { name: 'bad', progress: 10, state: 'Error', label: 'bc' },
    dddd: { name: 'other', progress: 100, state: 'Seeding', save_path: '/downloads', label: 'movies' },
    eeee: { name: 'unlabeled', progress: 50, state: 'Downloading' }, // Label plugin absent — kept
  };
  const { fetchImpl } = fakeDeluge({ torrents });
  const client = makeDelugeClient(cfg, { fetchImpl });
  const list = await client.listByCategory('BC'); // matched lowercase
  const byId = Object.fromEntries(list.map((t) => [t.id, t]));
  assert.equal(list.length, 4);
  assert.equal(byId.dddd, undefined);
  assert.equal(byId.aaaa.state, 'done');
  assert.equal(byId.aaaa.path, '//NAS/dl/done'); // save_path + name, remapped
  assert.equal(byId.aaaa.seeders, 9);
  assert.equal(byId.bbbb.state, 'downloading');
  assert.equal(byId.bbbb.progress, 42);
  assert.equal(byId.cccc.state, 'failed');
  assert.equal(byId.eeee.state, 'downloading');
});

test('deluge status: filters by id; an unknown hash reads as queued', async () => {
  const { fetchImpl, calls } = fakeDeluge({ torrents: {} });
  const client = makeDelugeClient({ delugeHost: 'h', delugePass: 'pw' }, { fetchImpl });
  assert.equal((await client.status('aaaa')).state, 'queued');
  assert.deepEqual(calls.find((c) => c.method === 'core.get_torrents_status').params[0], { id: ['aaaa'] });
});

test('deluge remove: core.remove_torrent gets the hash + delete flag', async () => {
  const { fetchImpl, calls } = fakeDeluge();
  const client = makeDelugeClient({ delugeHost: 'h', delugePass: 'pw' }, { fetchImpl });
  await client.remove('aaaa', { deleteFiles: true });
  assert.deepEqual(calls.find((c) => c.method === 'core.remove_torrent').params, ['aaaa', true]);
});

test('deluge: an expired web session re-logs-in and retries once', async () => {
  const torrents = { aaaa: { name: 'x', progress: 50, state: 'Downloading' } };
  const { fetchImpl, calls } = fakeDeluge({ torrents, expireAfter: 2 });
  const client = makeDelugeClient({ delugeHost: 'h', delugePass: 'pw' }, { fetchImpl });
  await client.listByCategory('bc');              // login s1 → connected → list (session then expires)
  const list = await client.listByCategory('bc'); // stale cookie → re-login s2 → retried
  assert.equal(list.length, 1);
  assert.equal(calls.filter((c) => c.method === 'auth.login').length, 2);
});

test('testTorrentClient: deluge success reports the daemon version', async () => {
  const { fetchImpl } = fakeDeluge();
  const r = await testTorrentClient({ torrentClient: 'deluge', delugeHost: 'h', delugePort: 8112, delugePass: 'pw' }, { fetchImpl });
  assert.equal(r.ok, true);
  assert.match(r.message, /Deluge 2\.1\.1/);
});

test('testTorrentClient: deluge wrong password / no daemon are reported clearly', async () => {
  const bad = await testTorrentClient({ torrentClient: 'deluge', delugeHost: 'h', delugePass: 'nope' }, { fetchImpl: fakeDeluge().fetchImpl });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /password/i);
  const off = await testTorrentClient({ torrentClient: 'deluge', delugeHost: 'h', delugePass: 'pw' }, { fetchImpl: fakeDeluge({ connected: false, hosts: [] }).fetchImpl });
  assert.equal(off.ok, false);
  assert.match(off.message, /daemon/i);
  // A disconnected UI with a known daemon host is attached automatically.
  const attach = await testTorrentClient({ torrentClient: 'deluge', delugeHost: 'h', delugePass: 'pw' }, { fetchImpl: fakeDeluge({ connected: false }).fetchImpl });
  assert.equal(attach.ok, true);
});

test('makeTorrentClient: dispatches on torrentClient', () => {
  assert.ok(makeTorrentClient({ torrentClient: 'transmission', trHost: 'h' }, {}).add);
  assert.ok(makeTorrentClient({ torrentClient: 'deluge', delugeHost: 'h' }, {}).add);
  assert.throws(() => makeTorrentClient({ torrentClient: 'rtorrent', qbHost: 'h' }, {}), /unknown torrentClient/);
});

test('torrent source: enablement follows the selected client\'s host', () => {
  const base = { torrentEnabled: true, torznabIndexers: 'j|http://j|k' };
  assert.equal(torrent.isEnabled({ ...base, torrentClient: 'transmission', trHost: 'h' }), true);
  assert.equal(torrent.isEnabled({ ...base, torrentClient: 'transmission', qbHost: 'h' }), false);
  assert.equal(torrent.isEnabled({ ...base, torrentClient: 'deluge', delugeHost: 'h' }), true);
  assert.equal(torrent.isEnabled({ ...base, torrentClient: 'deluge' }), false);
});
