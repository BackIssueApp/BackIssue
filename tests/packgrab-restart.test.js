// A pack an in-app source was downloading dies with the process; after a
// restart it is failed rather than left "active" forever. Client-backed packs
// and issue grabs are the monitor's to resume.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, recordGrab, failInterruptedPackGrabs } from '../src/db.js';
import { CLIENT_SOURCES } from '../src/downloadmonitor.js';

test('boot fails interrupted in-app pack grabs only', () => {
  const db = openDb(':memory:');
  const inApp = recordGrab(db, { source: 'some-ddl', title: 'Pack A', kind: 'pack', seriesId: 1 });
  const viaClient = recordGrab(db, { source: 'torrent', title: 'Pack B', kind: 'pack', seriesId: 1 });
  const issue = recordGrab(db, { issueId: 5, source: 'usenet', title: 'Issue' });
  assert.equal(failInterruptedPackGrabs(db, CLIENT_SOURCES), 1);
  const st = (id) => db.prepare('SELECT status, error FROM grabs WHERE id=?').get(id);
  assert.equal(st(inApp).status, 'failed');
  assert.match(st(inApp).error, /restarted/);
  assert.equal(st(viaClient).status, 'active');
  assert.equal(st(issue).status, 'active');
});
