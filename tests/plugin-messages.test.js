// Plugin translations: a plugin ships locales/<lang>.json (keys under its own
// namespace) or calls api.registerMessages(); core merges them, inlines
// English plus the account's language into the served shell, and serves any
// language on request for the no-reload sign-in path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { pluginApi, loadPluginsFromDir, registeredMessages, registeredRoutes, _resetMessagesForTests } from '../src/plugins.js';

const listen = (app) => new Promise((res) => { const s = app.listen(0, () => res(s)); });
const cookieOf = (r) => (r.headers.get('set-cookie') || '').split(';')[0];
const json = { 'content-type': 'application/json' };

test('registerMessages merges per language and namespace; bad shapes are ignored', () => {
  _resetMessagesForTests();
  pluginApi.registerMessages({ en: { demo: { hello: 'Hello' } }, fr: { demo: { hello: 'Bonjour' } } });
  pluginApi.registerMessages({ en: { demo: { bye: 'Bye' }, other: { x: 'X' } }, de: 'nope', es: { demo: null } });
  const all = registeredMessages();
  assert.deepEqual(all.en, { demo: { hello: 'Hello', bye: 'Bye' }, other: { x: 'X' } });
  assert.deepEqual(all.fr, { demo: { hello: 'Bonjour' } });
  assert.equal(all.de, undefined);
  assert.equal(all.es, undefined);
  _resetMessagesForTests();
});

test('a plugin\'s locales/<lang>.json files are picked up under its own namespace', async () => {
  _resetMessagesForTests();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bi-plugins-'));
  const pdir = path.join(dir, 'greeter');
  fs.mkdirSync(path.join(pdir, 'locales'), { recursive: true });
  fs.writeFileSync(path.join(pdir, 'index.js'), 'export default function register() {}\n');
  fs.writeFileSync(path.join(pdir, 'locales', 'en.json'), JSON.stringify({
    title: 'Greeter', n: { one: '{count} hi', other: '{count} his' },
    // Entries for namespaces the core UI reads land outside the plugin's own.
    _shared: { permissions: { greeter: { use: { label: 'Use greeter' } } }, jobs: { 'greeter-wave': { label: 'Wave' } } },
  }));
  fs.writeFileSync(path.join(pdir, 'locales', 'fr.json'), JSON.stringify({ title: 'Salueur' }));
  fs.writeFileSync(path.join(pdir, 'locales', 'broken.json'), '{ not json');
  fs.writeFileSync(path.join(pdir, 'locales', 'README.md'), 'ignored');
  try {
    const warn = console.warn; const warned = []; console.warn = (...a) => warned.push(a.join(' '));
    try { await loadPluginsFromDir(dir); } finally { console.warn = warn; }
    const all = registeredMessages();
    assert.deepEqual(all.en.greeter, { title: 'Greeter', n: { one: '{count} hi', other: '{count} his' } });
    assert.deepEqual(all.en.permissions, { greeter: { use: { label: 'Use greeter' } } });
    assert.deepEqual(all.en.jobs, { 'greeter-wave': { label: 'Wave' } });
    assert.equal(all.en.greeter._shared, undefined);
    assert.deepEqual(all.fr.greeter, { title: 'Salueur' });
    assert.equal(all.broken, undefined);
    assert.ok(warned.some((w) => /broken\.json/.test(w)), 'a broken catalog is reported');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    _resetMessagesForTests();
  }
});

test('the shell inlines English plus the account language; the API serves any language', async () => {
  const db = openDb(':memory:');
  const pluginMessages = { en: { demo: { hello: 'Hello' } }, fr: { demo: { hello: 'Bonjour' } }, de: { demo: { hello: 'Hallo' } } };
  const app = createApp({ openApiBeforeSetup: true,
    db, state: { queue: {} }, getSettings: () => ({}), saveSettings: (b) => b,
    prepareRedownload: async () => {}, runDownloads: async () => {},
    pluginRoutes: registeredRoutes(), pluginMessages,
  });
  const s = await listen(app);
  const base = `http://localhost:${s.address().port}`;
  try {
    // Open mode: English only is inlined (no account, no saved language).
    let html = await (await fetch(`${base}/`)).text();
    let m = html.match(/window\.__BI_PLUGIN_MESSAGES__=(\{.*?\});<\/script>/);
    assert.ok(m, 'inline messages present in open mode');
    assert.deepEqual(JSON.parse(m[1]), { en: pluginMessages.en });

    const reg = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: json, body: JSON.stringify({ username: 'admin1', password: 'a-strong-one' }) });
    const cookie = cookieOf(reg);
    const headers = { ...json, cookie };
    await fetch(`${base}/api/auth/lang`, { method: 'POST', headers, body: JSON.stringify({ lang: 'fr' }) });
    html = await (await fetch(`${base}/`, { headers: { cookie } })).text();
    m = html.match(/window\.__BI_PLUGIN_MESSAGES__=(\{.*?\});<\/script>/);
    assert.deepEqual(JSON.parse(m[1]), { en: pluginMessages.en, fr: pluginMessages.fr });
    // Anonymous shell carries nothing (no plugins run on the login page).
    const anon = await (await fetch(`${base}/`)).text();
    assert.doesNotMatch(anon, /__BI_PLUGIN_MESSAGES__/);

    // Any language on request, English always included; unknown ones are just absent.
    let r = await (await fetch(`${base}/api/i18n/plugins?lang=de`, { headers })).json();
    assert.deepEqual(r, { en: pluginMessages.en, de: pluginMessages.de });
    r = await (await fetch(`${base}/api/i18n/plugins?lang=xx`, { headers })).json();
    assert.deepEqual(r, { en: pluginMessages.en });
    r = await (await fetch(`${base}/api/i18n/plugins?lang=<b>`, { headers })).json();
    assert.deepEqual(r, { en: pluginMessages.en });
  } finally { s.close(); }
});
