// Express routes ignore case and a trailing slash, so the auth guard and the
// permission rules must too: /API/users and /api/restart/ reach the same
// handlers as /api/users and /api/restart, and must be refused the same way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import * as users from '../src/users.js';
import { registeredRoutes } from '../src/plugins.js';

const J = { 'content-type': 'application/json' };

async function start() {
  const db = openDb(':memory:');
  const app = createApp({
    db, state: { queue: {} },
    getSettings: () => ({}), saveSettings: (b) => b,
    prepareRedownload: async () => {}, runDownloads: async () => {},
    pluginRoutes: registeredRoutes(), requestRestart: () => ({ restarting: true }),
    listLogs: () => ({ logs: [] }),
  });
  const s = await new Promise((r) => { const x = app.listen(0, () => r(x)); });
  const base = `http://127.0.0.1:${s.address().port}`;
  users.createUser(db, { username: 'admin', password: 'admin-pass-1', role: 'admin' });
  users.createUser(db, { username: 'trust', password: 'trust-pass-1', role: 'trusted' });
  const login = async (username, password) => (await fetch(base + '/api/auth/login', { method: 'POST', headers: J, body: JSON.stringify({ username, password }) }))
    .headers.get('set-cookie').split(';')[0];
  return { s, db, base, login };
}

test('signed-out requests are refused whatever the path case or trailing slash', async () => {
  const { s, db, base } = await start();
  try {
    for (const p of ['/API/users', '/Api/settings', '/api/users/', '/API/LOGS', '/PLUGINS/x', '/api/settings//']) {
      assert.equal((await fetch(base + p)).status, 401, `GET ${p}`);
    }
    const r = await fetch(base + '/API/users', { method: 'POST', headers: J, body: JSON.stringify({ username: 'evil', password: 'evil-pass-1', role: 'admin' }) });
    assert.equal(r.status, 401);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM users WHERE username='evil'").get().n, 0);
  } finally { s.close(); }
});

test('admin-only rules hold for a lower role whatever the path case or trailing slash', async () => {
  const { s, base, login } = await start();
  try {
    const H = { ...J, cookie: await login('trust', 'trust-pass-1') };
    for (const p of ['/api/restart', '/api/restart/', '/API/RESTART', '/api/clients/test/', '/api/torznab/TEST', '/api/sources/install/', '/api/users/']) {
      assert.equal((await fetch(base + p, { method: 'POST', headers: H, body: '{}' })).status, 403, `POST ${p}`);
    }
    // The canonical paths still work for the role that holds the permission.
    const A = { ...J, cookie: await login('admin', 'admin-pass-1') };
    assert.equal((await fetch(base + '/api/users', { headers: A })).status, 200);
    assert.equal((await fetch(base + '/api/users/', { headers: A })).status, 200);
  } finally { s.close(); }
});
