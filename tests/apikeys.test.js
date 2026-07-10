// Personal API keys: one per user, generated from the profile, sent as
// X-Api-Key or Bearer. A key resolves to its user, so role permissions clamp
// what it can reach — including plugin-registered routes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import * as users from '../src/users.js';
import { pluginApi, registeredRoutes } from '../src/plugins.js';

function makeApp() {
  const db = openDb(':memory:');
  const app = createApp({
    db, state: { queue: {} },
    getSettings: () => ({}), saveSettings: (b) => b,
    prepareRedownload: async () => {}, runDownloads: async () => {},
    pluginRoutes: registeredRoutes(),
  });
  return { app, db };
}
async function listen(app) {
  return new Promise((res) => { const s = app.listen(0, () => res(s)); });
}

test('api key unit: one per user, regenerate replaces, disabled/revoked stop resolving', () => {
  const { db } = makeApp();
  const u = users.createUser(db, { username: 'kay', password: 'long-enough-pw', role: 'viewer' });

  const k1 = users.createApiKey(db, u.id);
  assert.match(k1, /^bi_[0-9a-f]{40}$/);
  assert.equal(users.apiKeyUser(db, k1)?.id, u.id);
  assert.equal(users.apiKeyInfo(db, u.id).prefix, k1.slice(0, 8));

  // Regenerating replaces the old key (one per user).
  const k2 = users.createApiKey(db, u.id);
  assert.equal(users.apiKeyUser(db, k1), null, 'old key is dead');
  assert.equal(users.apiKeyUser(db, k2)?.id, u.id);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM api_keys WHERE user_id=?').get(u.id).n, 1);

  // last_used stamps on use.
  assert.ok(users.apiKeyInfo(db, u.id).last_used, 'use stamped last_used');

  // Disabled account: key stops resolving; re-enable brings it back.
  users.setDisabled(db, u.id, true);
  assert.equal(users.apiKeyUser(db, k2), null);
  users.setDisabled(db, u.id, false);
  assert.equal(users.apiKeyUser(db, k2)?.id, u.id);

  // Revoke, and garbage never resolves.
  users.revokeApiKey(db, u.id);
  assert.equal(users.apiKeyUser(db, k2), null);
  assert.equal(users.apiKeyUser(db, 'bi_' + '0'.repeat(40)), null);
  assert.equal(users.apiKeyUser(db, 'not-a-key'), null);
});

test('api keys authenticate requests, clamped to the user role — plugin routes included', async () => {
  // A plugin route registered like the reader's file endpoints would be —
  // BEFORE the app mounts (routes are wired at construction).
  pluginApi.registerRoute('get', '/api/keytest/thing', (req, res) => res.json({ as: req.user.username }));
  const { app, db } = makeApp();
  users.createUser(db, { username: 'boss', password: 'long-enough-pw', role: 'admin' }); // closes open mode
  const viewer = users.createUser(db, { username: 'vic', password: 'long-enough-pw', role: 'viewer' });

  const s = await listen(app);
  const base = `http://localhost:${s.address().port}`;
  try {
    // Self-service lifecycle over HTTP, as the viewer (via Basic to bootstrap).
    const basic = { authorization: 'Basic ' + Buffer.from('vic:long-enough-pw').toString('base64') };
    assert.equal((await (await fetch(`${base}/api/auth/apikey`, { headers: basic })).json()).key, null, 'no key yet');
    const { key } = await (await fetch(`${base}/api/auth/apikey`, { method: 'POST', headers: basic })).json();
    assert.match(key, /^bi_/);
    const info = (await (await fetch(`${base}/api/auth/apikey`, { headers: basic })).json()).key;
    assert.equal(info.prefix, key.slice(0, 8), 'GET shows only the prefix');

    // Both header forms authenticate; identity is the key's user.
    const viaX = await (await fetch(`${base}/api/auth/me`, { headers: { 'x-api-key': key } })).json();
    assert.equal(viaX.user.username, 'vic');
    const viaBearer = await (await fetch(`${base}/api/keytest/thing`, { headers: { authorization: `Bearer ${key}` } })).json();
    assert.equal(viaBearer.as, 'vic', 'plugin route reachable with the key');

    // Clamped to the role: viewer can read the library but not manage settings.
    assert.equal((await fetch(`${base}/api/series`, { headers: { 'x-api-key': key } })).status, 200);
    assert.equal((await fetch(`${base}/api/settings`, { headers: { 'x-api-key': key } })).status, 403,
      'viewer key is denied admin surface');

    // Bad key = 401, not an error.
    assert.equal((await fetch(`${base}/api/series`, { headers: { 'x-api-key': 'bi_' + 'f'.repeat(40) } })).status, 401);

    // Revoke over HTTP: key stops working.
    await fetch(`${base}/api/auth/apikey`, { method: 'DELETE', headers: basic });
    assert.equal((await fetch(`${base}/api/series`, { headers: { 'x-api-key': key } })).status, 401);

    // Deleting the user cleans the key row up.
    users.createApiKey(db, viewer.id);
    users.deleteUser(db, viewer.id);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM api_keys WHERE user_id=?').get(viewer.id).n, 0);
  } finally { s.close(); }
});
