// The JSON body cap. A KOReader device uploads up to 2,000 page events in one
// request (about 127 KB), which Express's 100 KB default would reject on every
// sync, so the cap is 1 MB; anything past it is still a clean 413, not a 500.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { registeredRoutes } from '../src/plugins.js';

function makeApp() {
  const db = openDb(':memory:');
  return createApp({
    db, state: { queue: {} },
    getSettings: () => ({}), saveSettings: (b) => b,
    prepareRedownload: async () => {}, runDownloads: async () => {},
    pluginRoutes: registeredRoutes(),
  });
}
const listen = (app) => new Promise((res) => { const s = app.listen(0, () => res(s)); });

// The body is parsed before auth, so a pre-auth route shows whether it was
// accepted: anything but 413 means the parser let it through.
async function post(base, bytes) {
  const events = [];
  while (JSON.stringify(events).length < bytes) {
    events.push({ start_time: 1761700000 + events.length * 60, duration: 45, page: events.length, pages: 300 });
  }
  const r = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'x', password: 'y', events }),
  });
  return r.status;
}

test('a full KOReader event batch fits under the JSON body cap; far larger bodies are a 413', async () => {
  const s = await listen(makeApp());
  const base = `http://localhost:${s.address().port}`;
  try {
    assert.notEqual(await post(base, 130 * 1024), 413, '2,000 page events (~127 KB) must be accepted');
    assert.notEqual(await post(base, 900 * 1024), 413, 'the cap is 1 MB');
    assert.equal(await post(base, 1200 * 1024), 413, 'past the cap is rejected with 413');
  } finally {
    s.close();
  }
});
