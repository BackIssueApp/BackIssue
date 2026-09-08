import { test } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { openDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { registeredRoutes } from '../src/plugins.js';
import { buildSupportPackage, redactSecrets, redactText, redactValue, describeIndexers } from '../src/support.js';
import { sendSupportPackage } from '../src/cv.js';

test('redaction: secret-named settings keep only their length, plain ones pass through', () => {
  assert.equal(redactValue('comicvineKeys', 'abcdef0123456789'), '[redacted 16 chars]');
  assert.equal(redactValue('qbPass', 'hunter2'), '[redacted 7 chars]');
  assert.equal(redactValue('nzbClientApiKey', 'k'), '[redacted 1 chars]');
  assert.equal(redactValue('metadataInstanceKey', 'inst-123'), '[redacted 8 chars]');
  assert.equal(redactValue('comicvineKeys', ''), '');            // empty stays empty: "not set" is the diagnosis
  assert.equal(redactValue('qbHost', 'nas.local'), 'nas.local');   // a host is not a secret
  assert.equal(redactValue('passwordLoginDisabled', 'yes'), 'yes');
  assert.equal(redactValue('cvBaseUrl', 'https://data.example'), 'https://data.example');
  assert.equal(redactValue('authorName', 'Jane'), 'Jane');         // "auth" inside "author" is not a credential
  assert.equal(redactValue('trustProxy', true), true);
  // Indexer lists carry the key as the third field of each line.
  assert.equal(redactValue('newznabIndexers', 'NZBGeek|https://api.nzbgeek.info|abcd1234\n# note\nOther|https://o.example|'),
    'NZBGeek|https://api.nzbgeek.info| [redacted 8 chars]\n# note\nOther|https://o.example|');
  assert.deepEqual(describeIndexers('NZBGeek|https://api.nzbgeek.info|abcd1234\nOther|https://o.example|'),
    [{ name: 'NZBGeek', url: 'https://api.nzbgeek.info', keyLength: 8 }, { name: 'Other', url: 'https://o.example', keyLength: 0 }]);
});

test('redaction: secrets inside strings are blanked wherever they appear', () => {
  assert.equal(redactText('GET https://idx.example/api?t=search&apikey=SECRET123&q=batman'), 'GET https://idx.example/api?t=search&apikey=[redacted]&q=batman');
  assert.equal(redactText('token=abc123 failed'), 'token=abc123 failed'); // no ?/& before it: not a query parameter
  assert.equal(redactText('https://user:pw@sab.local:8080/api'), 'https://[redacted]@sab.local:8080/api');
  assert.equal(redactText('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc'), 'Authorization: Bearer [redacted]');
  const deep = redactSecrets({ a: { apiKey: 'zzz', url: 'http://x/?api_key=k1&x=1' }, list: [{ password: 'p' }] });
  assert.deepEqual(deep, { a: { apiKey: '[redacted 3 chars]', url: 'http://x/?api_key=[redacted]&x=1' }, list: [{ password: '[redacted 1 chars]' }] });
});

test('buildSupportPackage: every section lands in the zip, secrets are gone, failures are noted not fatal', async () => {
  const db = openDb(':memory:');
  const { buffer, filename, manifest } = await buildSupportPackage({
    db,
    config: { disabledPlugins: 'foo, bar', usenetEnabled: true, newznabIndexers: 'Geek|https://api.geek.example|KEY-ABC-123' },
    settings: () => ({ comicvineKeys: 'cvkey-000000', qbHost: 'nas', qbPass: 'pw', cvBaseUrl: 'https://data.example', newznabIndexers: 'Geek|https://api.geek.example|KEY-ABC-123' }),
    version: '9.9.9',
    build: { version: '9.9.9', commit: 'abcdef1234567890', channel: 'release', built_at: '2026-09-07T00:00:00Z', sig: 'x' },
    dataDir: process.cwd(), dbPath: ':memory:', pluginsDir: 'plugins',
    plugins: () => [{ name: 'reader', version: '1.8.2', enabled: true, loaded: true, error: null, pending: null, counts: { routes: 3 } }],
    jobs: () => [{ id: 'h1', type: 'scan', status: 'done', message: 'ok' }],
    schedules: () => [{ key: 'scan', cron: '0 9 * * *', enabled: true }],
    logs: () => ({ logs: [
      { ts: 1, level: 'info', category: 'download', message: 'grabbed via https://idx/api?apikey=TOPSECRET&t=get' },
      { ts: 2, level: 'warn', category: 'app', message: 'memory: rss 913 MB, heap 78 MB of 4144 MB limit' },
    ] }),
    sources: () => [{ id: 'usenet', label: 'Usenet', isEnabled: () => true }],
    notifiers: () => [{ id: 'discord', label: 'Discord' }],
    libraries: () => [{ id: 1, name: 'Comics', type: 'comic', root_folder: process.cwd() }],
    libraryStats: () => { throw new Error('boom'); }, // one broken section must not sink the package
    state: { queue: { running: false }, crawl: null },
    now: () => new Date('2026-09-07T12:34:56Z'),
  });
  assert.equal(filename, 'backissue-support-9.9.9-20260907-123456Z.zip');
  const zip = await JSZip.loadAsync(buffer);
  for (const f of ['README.txt', 'summary.json', 'settings.json', 'plugins.json', 'libraries.json', 'sources.json', 'jobs.json', 'queue.json', 'history.json', 'logs.txt']) {
    assert.ok(zip.file(f), `${f} present`);
  }
  const summary = JSON.parse(await zip.file('summary.json').async('string'));
  assert.equal(summary.app.version, '9.9.9');
  assert.equal(summary.app.commit, 'abcdef1234567890');
  assert.equal(summary.app.attested, true);
  assert.equal(summary.runtime.node, process.version);
  assert.ok(summary.runtime.memory.rssMb > 0);
  assert.ok(Array.isArray(summary.counts.seriesByType));
  assert.ok(summary.errors.some((e) => e.startsWith('libraryStats: boom')), 'the failed section is recorded');
  assert.equal(summary.counts.files, null);
  assert.ok(manifest.errors.length >= 1);
  const settings = JSON.parse(await zip.file('settings.json').async('string'));
  assert.equal(settings.comicvineKeys, '[redacted 12 chars]');
  assert.equal(settings.qbPass, '[redacted 2 chars]');
  assert.equal(settings.qbHost, 'nas');
  const plugins = JSON.parse(await zip.file('plugins.json').async('string'));
  assert.deepEqual(plugins.disabled, ['foo', 'bar']);
  assert.equal(plugins.installed[0].version, '1.8.2');
  const sources = JSON.parse(await zip.file('sources.json').async('string'));
  assert.deepEqual(sources.newznab.indexers, [{ name: 'Geek', url: 'https://api.geek.example', keyLength: 11 }]);
  assert.equal(settings.newznabIndexers, 'Geek|https://api.geek.example| [redacted 11 chars]');
  const logs = await zip.file('logs.txt').async('string');
  assert.ok(logs.includes('apikey=[redacted]'), 'query-string key blanked in logs');
  assert.ok(!logs.includes('TOPSECRET'));
  assert.ok(logs.includes('memory: rss 913 MB'));
  // Nothing anywhere in the zip carries the raw secrets.
  for (const name of Object.keys(zip.files)) {
    const text = await zip.file(name).async('string');
    assert.ok(!text.includes('cvkey-000000') && !text.includes('TOPSECRET') && !text.includes('KEY-ABC-123'), `${name} leaks no secret`);
  }
});

test('GET /api/support/package answers a zip with a filename, and needs settings.manage', async () => {
  const db = openDb(':memory:');
  const app = createApp({
    db, state: { queue: {} },
    getSettings: () => ({ comicvineKeys: 'k' }), saveSettings: (b) => b,
    prepareRedownload: async () => {}, runDownloads: async () => {},
    pluginRoutes: registeredRoutes(),
    supportPackage: () => buildSupportPackage({ db, version: '1.2.3', settings: () => ({ comicvineKeys: 'k' }) }),
  });
  const s = await new Promise((res) => { const x = app.listen(0, () => res(x)); });
  const base = `http://localhost:${s.address().port}`;
  try {
    // Open mode (no users yet) grants everything, so the route answers.
    const r = await fetch(`${base}/api/support/package`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/zip');
    assert.match(r.headers.get('content-disposition') || '', /attachment; filename="backissue-support-1\.2\.3-.*\.zip"/);
    const buf = Buffer.from(await r.arrayBuffer());
    assert.equal(buf.subarray(0, 2).toString(), 'PK');
    const zip = await JSZip.loadAsync(buf);
    assert.ok(zip.file('summary.json'));
  } finally { s.close(); }
});

test('sendSupportPackage: posts the zip with the instance key and returns the code, or the service reason', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/api/register')) return { ok: true, status: 200, json: async () => ({ key: 'inst-key-1' }) };
    if (url.includes('/support/upload')) {
      if (init.headers['x-api-key'] !== 'inst-key-1') return { ok: false, status: 401, json: async () => ({ error: 'a registered instance key is required' }) };
      return { ok: true, status: 200, json: async () => ({ code: '7K3M-9Q2X', expires_in_days: 60 }) };
    }
    throw new Error('unexpected ' + url);
  };
  process.env.METADATA_BASE_OVERRIDE = 'https://svc.example/api';
  try {
    const config = { metadataInstanceKey: 'inst-key-1' };
    const r = await sendSupportPackage(config, Buffer.from('PKzip'), { version: '0.8.0', note: 'covers missing', fetchImpl });
    assert.deepEqual(r, { code: '7K3M-9Q2X', expiresInDays: 60 });
    const up = calls.find((c) => c.url.includes('/support/upload'));
    assert.equal(up.url, 'https://svc.example/api/support/upload?version=0.8.0&note=covers+missing');
    assert.equal(up.init.method, 'POST');
    assert.equal(up.init.headers['content-type'], 'application/zip');
    assert.equal(up.init.body.toString(), 'PKzip');
    // A refusal surfaces the service's reason.
    await assert.rejects(() => sendSupportPackage({ metadataInstanceKey: 'wrong' }, Buffer.from('PK'), { fetchImpl }), /did not accept the package: a registered instance key is required/);
  } finally { delete process.env.METADATA_BASE_OVERRIDE; }
});

test('lite package: no settings, folders, indexers, history or log; extra files ride along', async () => {
  const db = openDb(':memory:');
  const { buffer } = await buildSupportPackage({
    db, version: '1.0.0', lite: true,
    settings: () => ({ comicvineKeys: 'cvkey-000000' }),
    libraries: () => [{ id: 1, name: 'Comics', type: 'comic', series_count: 3, root_folder: '/srv/private/comics' }],
    logs: () => ({ logs: [{ ts: 1, level: 'error', category: 'x', message: 'private path /srv/private/comics' }] }),
    extraFiles: { 'mobile.json': JSON.stringify({ platform: 'ios', app: '1.0 (18)' }), '../evil': 'nope' },
  });
  const zip = await JSZip.loadAsync(buffer);
  for (const absent of ['settings.json', 'sources.json', 'history.json', 'logs.txt', '../evil']) assert.equal(zip.file(absent), null, `${absent} absent`);
  assert.ok(zip.file('mobile.json'));
  const summary = JSON.parse(await zip.file('summary.json').async('string'));
  assert.equal(summary.lite, true);
  assert.equal(summary.paths, null);
  assert.equal(summary.runtime.env, undefined);
  const libs = JSON.parse(await zip.file('libraries.json').async('string'));
  assert.deepEqual(libs, [{ id: 1, name: 'Comics', type: 'comic', series_count: 3 }]);
  for (const name of Object.keys(zip.files)) {
    const text = await zip.file(name).async('string');
    assert.ok(!text.includes('/srv/private') && !text.includes('cvkey-000000'), `${name} carries nothing private`);
  }
  assert.match(await zip.file('README.txt').async('string'), /lite: sent by a non-admin/);
});

test('POST /api/support/mobile sends a lite package for a viewer and a full one for an admin', async () => {
  const db = openDb(':memory:');
  const sent = [];
  const app = createApp({
    db, state: { queue: {} },
    getSettings: () => ({}), saveSettings: (b) => b,
    prepareRedownload: async () => {}, runDownloads: async () => {},
    pluginRoutes: registeredRoutes(),
    supportSendMobile: async ({ report, full, user }) => { sent.push({ report, full, user }); return { code: 'AAAA-2222', expiresInDays: 60 }; },
  });
  const s = await new Promise((res) => { const x = app.listen(0, () => res(x)); });
  const base = `http://localhost:${s.address().port}`;
  try {
    // Open mode: the implicit local admin.
    const r = await fetch(`${base}/api/support/mobile`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ platform: 'android', app: '0.5.1', events: [] }) });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { code: 'AAAA-2222', expiresInDays: 60 });
    assert.equal(sent[0].report.platform, 'android');
    assert.equal(sent[0].full, true, 'the open-mode local user is an admin');
    const big = await fetch(`${base}/api/support/mobile`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ blob: 'x'.repeat(400 * 1024) }) });
    assert.equal(big.status, 413);
  } finally { s.close(); }
});
