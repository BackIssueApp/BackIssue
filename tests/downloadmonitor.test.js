import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordGrab, activeGrabs, setGrabStatus } from '../src/db.js';

// The monitor's tick pulls a lot of collaborators (client, CV, import). Rather
// than stand all that up, these tests exercise the persisted grab bookkeeping the
// monitor depends on — the piece that makes it survive restarts.

import { openDb } from '../src/db.js';

test('recordGrab persists a grab; activeGrabs returns it', () => {
  const db = openDb(':memory:');
  const id = recordGrab(db, { issueId: 7, source: 'usenet', client: 'sabnzbd', downloadId: 'SAB_1', category: 'backissue', title: 'Saga 001' });
  assert.ok(id > 0);
  const active = activeGrabs(db);
  assert.equal(active.length, 1);
  assert.equal(active[0].issue_id, 7);
  assert.equal(active[0].download_id, 'SAB_1');
  assert.equal(active[0].status, 'active');
});

test('setGrabStatus removes a grab from the active set', () => {
  const db = openDb(':memory:');
  const id = recordGrab(db, { issueId: 1, source: 'usenet', downloadId: '9' });
  setGrabStatus(db, id, 'imported', { importedAt: '2026-07-01T00:00:00Z' });
  assert.equal(activeGrabs(db).length, 0);
  const row = db.prepare('SELECT * FROM grabs WHERE id=?').get(id);
  assert.equal(row.status, 'imported');
  assert.equal(row.imported_at, '2026-07-01T00:00:00Z');
});

test('download_id is coerced to text (client ids may be numeric)', () => {
  const db = openDb(':memory:');
  recordGrab(db, { issueId: 1, source: 'usenet', downloadId: 42 });
  assert.equal(activeGrabs(db)[0].download_id, '42');
});
