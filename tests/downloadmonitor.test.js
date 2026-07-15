import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordGrab, activeGrabs, setGrabStatus, blacklistRelease, loadReleaseBlacklist, normReleaseTitle, listBlacklist, deleteBlacklistEntry, clearBlacklist } from '../src/db.js';

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

test('recordGrab stores the release guid so a failure can blacklist it', () => {
  const db = openDb(':memory:');
  recordGrab(db, { issueId: 1, source: 'usenet', downloadId: 'x', title: 'Saga 001', releaseGuid: 'guid-abc' });
  assert.equal(activeGrabs(db)[0].release_guid, 'guid-abc');
});

test('recordGrab survives a non-string guid (malformed indexer response)', () => {
  // A plain object among positional binds is read by better-sqlite3 as a
  // named-parameter bag → "Too few parameter values were provided". The guid is
  // sanitized to a string or dropped, never bound raw.
  const db = openDb(':memory:');
  recordGrab(db, { issueId: 1, source: 'usenet', downloadId: 'x', title: 'T', releaseGuid: { rel: 'permalink' } });
  assert.equal(activeGrabs(db)[0].release_guid, null);
  blacklistRelease(db, { source: 'usenet', guid: { rel: 'permalink' }, title: 'T', reason: 'r' });
  const bl = loadReleaseBlacklist(db, 'usenet');
  assert.equal(bl.guids.size, 0); // object guid dropped…
  assert.ok(bl.titles.has(normReleaseTitle('T'))); // …but the title still blocks it
});

test('blacklistRelease + loadReleaseBlacklist round-trips by guid and normalized title', () => {
  const db = openDb(':memory:');
  blacklistRelease(db, { source: 'usenet', guid: 'guid-1', title: 'Series 005 (2020).cbz', issueId: 3, reason: 'par2 failed' });
  const bl = loadReleaseBlacklist(db, 'usenet');
  assert.ok(bl.guids.has('guid-1'));
  // Stored under the normalized key, so a differently-punctuated repost matches.
  assert.ok(bl.titles.has(normReleaseTitle('Series.005.2020')));
  // Scoped per source: a torrent search sees an empty blacklist.
  const other = loadReleaseBlacklist(db, 'torrent');
  assert.equal(other.guids.size, 0);
  assert.equal(other.titles.size, 0);
});

test('blacklistRelease dedupes the same failed release', () => {
  const db = openDb(':memory:');
  blacklistRelease(db, { source: 'usenet', guid: 'g', title: 'Hulk 001' });
  blacklistRelease(db, { source: 'usenet', guid: 'g', title: 'Hulk 001' });
  const n = db.prepare('SELECT COUNT(*) c FROM release_blacklist').get().c;
  assert.equal(n, 1);
});

test('blacklistRelease with neither guid nor title records nothing', () => {
  const db = openDb(':memory:');
  blacklistRelease(db, { source: 'usenet' });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM release_blacklist').get().c, 0);
});

test('listBlacklist paginates newest-first; delete and clear remove entries', () => {
  const db = openDb(':memory:');
  blacklistRelease(db, { source: 'usenet', guid: 'g1', title: 'Alpha 001', reason: 'par2' });
  blacklistRelease(db, { source: 'usenet', guid: 'g2', title: 'Beta 002', reason: 'articles' });
  const { rows, total } = listBlacklist(db, {});
  assert.equal(total, 2);
  assert.equal(rows[0].title_norm, normReleaseTitle('Beta 002')); // newest first
  assert.equal(rows[0].reason, 'articles');

  assert.equal(deleteBlacklistEntry(db, rows[0].id), 1);
  assert.equal(listBlacklist(db, {}).total, 1);
  // The just-removed release is no longer filtered out of searches.
  assert.ok(!loadReleaseBlacklist(db, 'usenet').guids.has('g2'));

  assert.equal(clearBlacklist(db), 1);
  assert.equal(listBlacklist(db, {}).total, 0);
});
