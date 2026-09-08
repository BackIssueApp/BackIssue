import { test } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { openDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { registeredRoutes } from '../src/plugins.js';
import { buildSupportPackage, redactSecrets, redactText, redactValue } from '../src/support.js';

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
    config: { disabledPlugins: 'foo, bar' },
    settings: () => ({ comicvineKeys: 'cvkey-000000', qbHost: 'nas', qbPass: 'pw', cvBaseUrl: 'https://data.example' }),
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
  const logs = await zip.file('logs.txt').async('string');
  assert.ok(logs.includes('apikey=[redacted]'), 'query-string key blanked in logs');
  assert.ok(!logs.includes('TOPSECRET'));
  assert.ok(logs.includes('memory: rss 913 MB'));
  // Nothing anywhere in the zip carries the raw secrets.
  for (const name of Object.keys(zip.files)) {
    const text = await zip.file(name).async('string');
    assert.ok(!text.includes('cvkey-000000') && !text.includes('TOPSECRET'), `${name} leaks no secret`);
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
