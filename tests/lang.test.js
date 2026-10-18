// Per-user UI language: saved through /api/auth/lang, echoed by /api/auth/me
// and the profile, and inlined into the served shell so the first paint is
// already translated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { setLang, LANG_RE } from '../src/users.js';
import { registeredRoutes } from '../src/plugins.js';

function makeApp() {
  const db = openDb(':memory:');
  const app = createApp({ openApiBeforeSetup: true,
    db, state: { queue: {} },
    getSettings: () => ({}), saveSettings: (b) => b,
    prepareRedownload: async () => {}, runDownloads: async () => {},
    pluginRoutes: registeredRoutes(),
  });
  return { app, db };
}
const listen = (app) => new Promise((res) => { const s = app.listen(0, () => res(s)); });
const cookieOf = (r) => (r.headers.get('set-cookie') || '').split(';')[0];
const json = { 'content-type': 'application/json' };

test('LANG_RE accepts language tags and nothing else', () => {
  for (const ok of ['fr', 'pt-BR', 'zh-Hant', 'sr-Latn-RS', 'EN']) assert.ok(LANG_RE.test(ok), ok);
  for (const bad of ['', 'f', 'french', 'fr_FR', '<script>', 'en-"', 'a'.repeat(20)]) assert.ok(!LANG_RE.test(bad), bad);
});

test('setLang stores a tag, clears on null, rejects junk', () => {
  const { db } = makeApp();
  db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('u', 'x', 'viewer')").run();
  const id = db.prepare("SELECT id FROM users WHERE username='u'").get().id;
  assert.equal(setLang(db, id, 'fr'), 'fr');
  assert.equal(db.prepare('SELECT lang FROM users WHERE id=?').get(id).lang, 'fr');
  assert.equal(setLang(db, id, ''), null);
  assert.equal(db.prepare('SELECT lang FROM users WHERE id=?').get(id).lang, null);
  assert.throws(() => setLang(db, id, 'not a tag'), /unsupported language/);
});

test('/api/auth/lang round-trips through me, profile and the served shell', async () => {
  // Served from frontend/dist like the shell-injection test in auth.test.js.
  const { app } = makeApp();
  const s = await listen(app);
  const base = `http://localhost:${s.address().port}`;
  try {
    const reg = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: json, body: JSON.stringify({ username: 'admin1', password: 'a-strong-one' }) });
    const cookie = cookieOf(reg);
    const headers = { ...json, cookie };

    let me = await (await fetch(`${base}/api/auth/me`, { headers })).json();
    assert.equal(me.user.lang, null);

    let r = await fetch(`${base}/api/auth/lang`, { method: 'POST', headers, body: JSON.stringify({ lang: 'fr' }) });
    assert.deepEqual(await r.json(), { lang: 'fr' });
    me = await (await fetch(`${base}/api/auth/me`, { headers })).json();
    assert.equal(me.user.lang, 'fr');
    const prof = await (await fetch(`${base}/api/auth/profile`, { headers })).json();
    assert.equal(prof.user.lang, 'fr');

    // The shell carries the language for the bundle and the document.
    const html = await (await fetch(`${base}/`, { headers: { cookie } })).text();
    assert.match(html, /window\.__BI_LANG__="fr"/);
    assert.match(html, /<html lang="fr">/);
    // Anonymous visitors get the untouched shell.
    const anon = await (await fetch(`${base}/`)).text();
    assert.doesNotMatch(anon, /__BI_LANG__/);
    assert.match(anon, /<html lang="en">/);

    // Bad values are refused and leave the setting alone.
    r = await fetch(`${base}/api/auth/lang`, { method: 'POST', headers, body: JSON.stringify({ lang: 'fr"><script>' }) });
    assert.equal(r.status, 400);
    me = await (await fetch(`${base}/api/auth/me`, { headers })).json();
    assert.equal(me.user.lang, 'fr');

    // Clearing goes back to "follow the browser".
    r = await fetch(`${base}/api/auth/lang`, { method: 'POST', headers, body: JSON.stringify({ lang: null }) });
    assert.deepEqual(await r.json(), { lang: null });
    const back = await (await fetch(`${base}/`, { headers: { cookie } })).text();
    assert.doesNotMatch(back, /__BI_LANG__/);
  } finally { s.close(); }
});
