import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeNzbClient, normalizeStorage, testClient, clientBaseUrl } from '../src/nzbclients.js';

// A tiny fetch stub that dispatches on the request URL/body to canned JSON.
function stub(routes) {
  return async (url, opts) => {
    for (const [match, body] of routes) {
      const hay = match.body ? (opts?.body || '') : url;
      if (hay.includes(match.contains)) return { ok: true, status: 200, json: async () => (typeof body === 'function' ? body(url, opts) : body) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

test('normalizeStorage: maps client path prefix onto the app-visible path', () => {
  const config = { usenetCompleteDir: '\\\\NAS\\dl\\complete', usenetCompleteDirRemote: '/downloads/complete' };
  assert.equal(normalizeStorage('/downloads/complete/Invincible 001', config), '//NAS/dl/complete/Invincible 001');
  assert.equal(normalizeStorage('/elsewhere/x', config), '/elsewhere/x'); // no prefix match → unchanged
  assert.equal(normalizeStorage(null, config), null);
});

test('sabnzbd: add returns nzo id, status transitions queue → history', async () => {
  const fetchImpl = stub([
    [{ contains: 'mode=addurl' }, { status: true, nzo_ids: ['SABnzbd_nzo_abc'] }],
    [{ contains: 'mode=queue' }, { queue: { slots: [{ nzo_id: 'SABnzbd_nzo_abc', percentage: '42', filename: 'Invincible 001' }] } }],
  ]);
  const c = makeNzbClient({ nzbClient: 'sabnzbd', nzbClientUrl: 'http://sab', nzbClientApiKey: 'k' }, { fetchImpl });
  const id = await c.add('https://nz/nzb/1', { name: 'Invincible 001', category: 'comics' });
  assert.equal(id, 'SABnzbd_nzo_abc');
  const st = await c.status(id);
  assert.equal(st.state, 'downloading');
  assert.equal(st.progress, 42);
});

test('sabnzbd: completed history entry → done with mapped path', async () => {
  const fetchImpl = stub([
    [{ contains: 'mode=queue' }, { queue: { slots: [] } }],
    [{ contains: 'mode=history' }, { history: { slots: [{ nzo_id: 'x', status: 'Completed', name: 'Saga 001', storage: '/dl/complete/Saga 001' }] } }],
  ]);
  const c = makeNzbClient({ nzbClient: 'sabnzbd', nzbClientUrl: 'http://sab', nzbClientApiKey: 'k', usenetCompleteDir: 'Z:/comics', usenetCompleteDirRemote: '/dl/complete' }, { fetchImpl });
  const st = await c.status('x');
  assert.equal(st.state, 'done');
  assert.equal(st.progress, 100);
  assert.equal(st.path, 'Z:/comics/Saga 001');
});

test('sabnzbd: failed history entry → failed', async () => {
  const fetchImpl = stub([
    [{ contains: 'mode=queue' }, { queue: { slots: [] } }],
    [{ contains: 'mode=history' }, { history: { slots: [{ nzo_id: 'x', status: 'Failed', name: 'Bad', fail_message: 'no articles' }] } }],
  ]);
  const c = makeNzbClient({ nzbClient: 'sabnzbd', nzbClientUrl: 'http://sab', nzbClientApiKey: 'k' }, { fetchImpl });
  const st = await c.status('x');
  assert.equal(st.state, 'failed');
  assert.equal(st.error, 'no articles');
});

test('sabnzbd: unknown id → queued', async () => {
  const fetchImpl = stub([
    [{ contains: 'mode=queue' }, { queue: { slots: [] } }],
    [{ contains: 'mode=history' }, { history: { slots: [] } }],
  ]);
  const c = makeNzbClient({ nzbClient: 'sabnzbd', nzbClientUrl: 'http://sab', nzbClientApiKey: 'k' }, { fetchImpl });
  assert.equal((await c.status('nope')).state, 'queued');
});

test('nzbget: append returns NZBID, listgroups reports progress', async () => {
  let appendBody;
  const fetchImpl = async (_url, opts) => {
    const body = opts?.body || '';
    if (body.includes('append')) { appendBody = JSON.parse(body); return { ok: true, json: async () => ({ result: 7 }) }; }
    return { ok: true, json: async () => ({ result: [{ NZBID: 7, NZBName: 'Invincible 001', FileSizeMB: 100, RemainingSizeMB: 25 }] }) };
  };
  const c = makeNzbClient({ nzbClient: 'nzbget', nzbClientUrl: 'http://ng', nzbClientUser: 'u', nzbClientPass: 'p' }, { fetchImpl });
  const id = await c.add('https://nz/nzb/1', { name: 'Invincible 001', category: 'comics' });
  assert.equal(id, 7);
  // append must send all 10 params incl. the trailing PPParameters array,
  // else NZBGet rejects with "Invalid parameter (Parameters)".
  assert.equal(appendBody.params.length, 10);
  assert.deepEqual(appendBody.params[9], []);
  const st = await c.status(7);
  assert.equal(st.state, 'downloading');
  assert.equal(st.progress, 75); // (100-25)/100
});

test('nzbget: success history → done with mapped DestDir', async () => {
  const fetchImpl = stub([
    [{ contains: 'listgroups', body: true }, { result: [] }],
    [{ contains: 'history', body: true }, { result: [{ NZBID: 7, NZBName: 'Saga 001', Status: 'SUCCESS/ALL', DestDir: '/downloads/complete/Saga 001' }] }],
  ]);
  const c = makeNzbClient({ nzbClient: 'nzbget', nzbClientUrl: 'http://ng', usenetCompleteDir: 'Z:/comics', usenetCompleteDirRemote: '/downloads/complete' }, { fetchImpl });
  const st = await c.status(7);
  assert.equal(st.state, 'done');
  assert.equal(st.path, 'Z:/comics/Saga 001');
});

test('nzbget: rpc error surfaces', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ error: { message: 'bad method' } }) });
  const c = makeNzbClient({ nzbClient: 'nzbget', nzbClientUrl: 'http://ng' }, { fetchImpl });
  await assert.rejects(() => c.status(1), /bad method/);
});

test('makeNzbClient: unknown client throws', () => {
  assert.throws(() => makeNzbClient({ nzbClient: 'transmission' }), /unknown nzbClient/);
});

test('testClient: requires a host', async () => {
  const r = await testClient({ nzbClient: 'sabnzbd' });
  assert.equal(r.ok, false);
  assert.match(r.message, /host is required/i);
});

test('clientBaseUrl: builds from host + port (+ ssl), with legacy fallback', () => {
  assert.equal(clientBaseUrl({ nzbClientHost: 'nas', nzbClientPort: 8080 }), 'http://nas:8080');
  assert.equal(clientBaseUrl({ nzbClientHost: 'nas', nzbClientPort: 6789, nzbClientSsl: true }), 'https://nas:6789');
  assert.equal(clientBaseUrl({ nzbClientHost: '192.168.1.5:9000' }), 'http://192.168.1.5:9000'); // host already has a port
  assert.equal(clientBaseUrl({ nzbClientHost: 'http://nas/', nzbClientPort: 8080 }), 'http://nas:8080'); // scheme/slash stripped
  assert.equal(clientBaseUrl({ nzbClientUrl: 'http://legacy:8080' }), 'http://legacy:8080'); // legacy fallback
  assert.equal(clientBaseUrl({}), '');
});

test('testClient sabnzbd: works with host + port', async () => {
  const fetchImpl = async (url) => {
    assert.match(url, /^http:\/\/nas:8080\/api\?/);
    return { ok: true, json: async () => ({ queue: { version: '4.2.0', slots: [] } }) };
  };
  const r = await testClient({ nzbClient: 'sabnzbd', nzbClientHost: 'nas', nzbClientPort: 8080, nzbClientApiKey: 'k' }, { fetchImpl });
  assert.equal(r.ok, true);
});

test('testClient sabnzbd: ok reports version', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ queue: { version: '4.2.0', slots: [] } }) });
  const r = await testClient({ nzbClient: 'sabnzbd', nzbClientUrl: 'http://sab', nzbClientApiKey: 'k' }, { fetchImpl });
  assert.equal(r.ok, true);
  assert.match(r.message, /SABnzbd 4\.2\.0/);
});

test('testClient sabnzbd: bad api key surfaces error', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ status: false, error: 'API Key Incorrect' }) });
  const r = await testClient({ nzbClient: 'sabnzbd', nzbClientUrl: 'http://sab', nzbClientApiKey: 'bad' }, { fetchImpl });
  assert.equal(r.ok, false);
  assert.match(r.message, /API Key Incorrect/);
});

test('testClient nzbget: ok reports version', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ result: '21.1' }) });
  const r = await testClient({ nzbClient: 'nzbget', nzbClientUrl: 'http://ng', nzbClientUser: 'u', nzbClientPass: 'p' }, { fetchImpl });
  assert.equal(r.ok, true);
  assert.match(r.message, /NZBGet 21\.1/);
});

test('testClient nzbget: 401 → auth failed', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401 });
  const r = await testClient({ nzbClient: 'nzbget', nzbClientUrl: 'http://ng', nzbClientUser: 'u', nzbClientPass: 'wrong' }, { fetchImpl });
  assert.equal(r.ok, false);
  assert.match(r.message, /Authentication failed/i);
});

test('sabnzbd listByCategory: merges queue + history, filters by category', async () => {
  const fetchImpl = stub([
    [{ contains: 'mode=queue' }, { queue: { slots: [
      { nzo_id: 'a', cat: 'backissue', filename: 'A', percentage: '30' },
      { nzo_id: 'b', cat: 'other', filename: 'B', percentage: '10' },
    ] } }],
    [{ contains: 'mode=history' }, { history: { slots: [
      { nzo_id: 'c', category: 'backissue', status: 'Completed', name: 'C', storage: '/dl/C' },
      { nzo_id: 'd', category: 'movies', status: 'Completed', name: 'D', storage: '/dl/D' },
    ] } }],
  ]);
  const c = makeNzbClient({ nzbClient: 'sabnzbd', nzbClientUrl: 'http://sab', nzbClientApiKey: 'k' }, { fetchImpl });
  const items = await c.listByCategory('backissue');
  assert.deepEqual(items.map((i) => i.id).sort(), ['a', 'c']);
  assert.equal(items.find((i) => i.id === 'a').state, 'downloading');
  assert.equal(items.find((i) => i.id === 'c').state, 'done');
});

test('sabnzbd remove: deletes from queue and history', async () => {
  const calls = [];
  const fetchImpl = async (url) => { calls.push(url); return { ok: true, json: async () => ({ status: true }) }; };
  const c = makeNzbClient({ nzbClient: 'sabnzbd', nzbClientUrl: 'http://sab', nzbClientApiKey: 'k' }, { fetchImpl });
  await c.remove('a', { deleteFiles: true });
  assert.ok(calls.some((u) => u.includes('mode=queue') && u.includes('name=delete') && u.includes('del_files=1')));
  assert.ok(calls.some((u) => u.includes('mode=history') && u.includes('name=delete')));
});

test('nzbget listByCategory: merges listgroups + history by Category', async () => {
  const fetchImpl = stub([
    [{ contains: 'listgroups', body: true }, { result: [
      { NZBID: 1, Category: 'backissue', NZBName: 'A', FileSizeMB: 100, RemainingSizeMB: 50 },
      { NZBID: 2, Category: 'tv', NZBName: 'B', FileSizeMB: 100, RemainingSizeMB: 0 },
    ] }],
    [{ contains: 'history', body: true }, { result: [
      { NZBID: 3, Category: 'backissue', Status: 'SUCCESS/ALL', NZBName: 'C', DestDir: '/dl/C' },
    ] }],
  ]);
  const c = makeNzbClient({ nzbClient: 'nzbget', nzbClientUrl: 'http://ng' }, { fetchImpl });
  const items = await c.listByCategory('backissue');
  assert.deepEqual(items.map((i) => i.id).sort(), [1, 3]);
  assert.equal(items.find((i) => i.id === 1).progress, 50);
  assert.equal(items.find((i) => i.id === 3).state, 'done');
});

test('nzbget remove: HistoryFinalDelete when deleting files', async () => {
  let body;
  const fetchImpl = async (_url, opts) => { body = opts.body; return { ok: true, json: async () => ({ result: true }) }; };
  const c = makeNzbClient({ nzbClient: 'nzbget', nzbClientUrl: 'http://ng' }, { fetchImpl });
  await c.remove(5, { deleteFiles: true });
  assert.match(body, /HistoryFinalDelete/);
  assert.match(body, /\[5\]/);
});

test('testClient: connection failure is caught', async () => {
  const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  const r = await testClient({ nzbClient: 'sabnzbd', nzbClientUrl: 'http://sab' }, { fetchImpl });
  assert.equal(r.ok, false);
  assert.match(r.message, /Connection failed/i);
});
