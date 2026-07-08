import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, recordImport, listImportHistory } from '../src/db.js';
import { createApp } from '../src/server.js';

function seed() {
  const db = openDb(':memory:');
  recordImport(db, { seriesId: 1, seriesTitle: 'Saga', issueTitle: 'Saga #1', issueNumber: '1', cvIssueId: 11, source: 'usenet', path: '/x/saga1.cbz' });
  recordImport(db, { seriesId: 1, seriesTitle: 'Saga', issueTitle: 'Saga #2', issueNumber: '2', cvIssueId: 12, source: 'torrent', path: '/x/saga2.cbz' });
  recordImport(db, { seriesId: 2, seriesTitle: 'X-Men', issueTitle: 'X-Men #5', issueNumber: '5', cvIssueId: 25, source: 'torrent', path: '/x/xm5.cbz' });
  return db;
}

test('recordImport/listImportHistory: newest first, with distinct sources for the filter', () => {
  const db = seed();
  const h = listImportHistory(db);
  assert.equal(h.total, 3);
  assert.equal(h.items[0].issue_title, 'X-Men #5'); // newest first
  assert.deepEqual(h.sources, ['torrent', 'usenet']);
  assert.equal(h.items[0].path, '/x/xm5.cbz');
});

test('listImportHistory: filters by source and pages', () => {
  const db = seed();
  const t = listImportHistory(db, { source: 'torrent' });
  assert.equal(t.total, 2);
  assert.ok(t.items.every((i) => i.source === 'torrent'));
  const page = listImportHistory(db, { limit: 1, offset: 1 });
  assert.equal(page.items.length, 1);
  assert.equal(page.total, 3);
  assert.equal(page.items[0].issue_title, 'Saga #2'); // second-newest
});

test('GET /api/history serves the paged history', async () => {
  const db = seed();
  const app = createApp({ db, state: { queue: {} } });
  const s = await new Promise((res) => { const x = app.listen(0, () => res(x)); });
  const base = `http://localhost:${s.address().port}`;
  const all = await (await fetch(`${base}/api/history`)).json();
  assert.equal(all.total, 3);
  assert.deepEqual(all.sources, ['torrent', 'usenet']);
  const filtered = await (await fetch(`${base}/api/history?source=usenet&limit=10`)).json();
  assert.equal(filtered.total, 1);
  assert.equal(filtered.items[0].source, 'usenet');
  s.close();
});
