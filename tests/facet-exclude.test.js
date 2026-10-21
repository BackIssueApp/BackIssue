// A collection filter may answer { excludeIds } ("everything in scope except
// these") instead of listing every match; the grid, its total and the A-Z
// rail all honour it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A real file: the A-Z rail is answered by the count worker, which opens the
// configured database itself.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bi-facet-'));
const { openDb, upsertSeries, setFollowed, collectionPage } = await import('../src/db.js');
const { createApp } = await import('../src/server.js');
const { pluginApi } = await import('../src/plugins.js');
const { default: config } = await import('../src/config.js');

let n = 0;
function seed() {
  const db = n++ ? openDb(':memory:') : openDb(config.dbPath);
  const ids = ['Akira', 'Bone', 'Cerebus'].map((t) => { const id = upsertSeries(db, { title: t, url: '/c/' + t }); setFollowed(db, id, true); return id; });
  return { db, ids };
}

test('a resolver returning { excludeIds } narrows /api/collection', async () => {
  const { db, ids } = seed();
  pluginApi.registerCollectionFilter({
    id: 'test-exclude',
    resolve: (sel, ctx) => (sel?.status === 'unread' && ctx.canExclude ? { excludeIds: [ids[1]] } : null),
  });
  const app = createApp({ db, openApiBeforeSetup: true });
  const s = await new Promise((r) => { const x = app.listen(0, () => r(x)); });
  try {
    const base = `http://127.0.0.1:${s.address().port}`;
    const facet = encodeURIComponent(JSON.stringify({ status: 'unread' }));
    const r = await (await fetch(`${base}/api/collection?limit=50&offset=0&facet=${facet}`)).json();
    assert.deepEqual(r.rows.map((x) => x.id), [ids[0], ids[2]]);
    const jump = await (await fetch(`${base}/api/collection/jump?letter=C&facet=${facet}`)).json();
    assert.equal(jump.offset, 1); // Bone is excluded, so Cerebus follows Akira directly
  } finally { s.close(); }
});

test('collectionPage honours excludeIds on the fast and the rollup path', () => {
  const { db, ids } = seed();
  const page = (o) => collectionPage(db, { userId: 1, keys: ['all'], limit: 50, offset: 0, ...o }).rows.map((r) => r.id);
  assert.deepEqual(page({ excludeIds: [ids[1]] }), [ids[0], ids[2]]);
  assert.deepEqual(page({ excludeIds: [ids[1]], sort: 'missing' }).sort(), [ids[0], ids[2]].sort());
  assert.equal(collectionPage(db, { userId: 1, keys: ['all'], limit: 50, offset: 0, excludeIds: [ids[0]] }).total, 2);
});

test('/api/collection?native=1 marks its reply so an app can tell the server honoured it', async () => {
  const { db, ids } = seed();
  const app = createApp({ db, openApiBeforeSetup: true });
  const s = await new Promise((r) => { const x = app.listen(0, () => r(x)); });
  try {
    const base = `http://127.0.0.1:${s.address().port}`;
    const r = await (await fetch(`${base}/api/collection?limit=2&offset=0&native=1`)).json();
    assert.equal(r.native, true);
    assert.equal(r.total, 3);
    assert.deepEqual(r.rows.map((x) => x.id), ids.slice(0, 2));
    const more = await (await fetch(`${base}/api/collection?limit=2&offset=2&native=1&counts=0`)).json();
    assert.equal(more.native, true);
    assert.deepEqual(more.rows.map((x) => x.id), [ids[2]]);
    const plain = await (await fetch(`${base}/api/collection?limit=2&offset=0`)).json();
    assert.equal('native' in plain, false, 'the web app\'s reply is unchanged');
  } finally { s.close(); }
});
