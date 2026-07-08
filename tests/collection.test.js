import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, upsertSeries, upsertIssue } from '../src/db.js';
import { linkFile } from '../src/collection.js';

function seed() {
  const db = openDb(':memory:');
  const sid = upsertSeries(db, { title: 'Earth X (1999)', url: '/c/ex', publisher: 'Marvel', coverUrl: '' });
  const iid = upsertIssue(db, { seriesId: sid, title: 'Earth X #1', issueNumber: '1', url: '/i/1' });
  upsertIssue(db, { seriesId: sid, title: 'Earth X #2', issueNumber: '2', url: '/i/2' });
  return { db, sid, iid };
}

test('linkFile: tagged file matches by ComicInfo metadata + issue number', () => {
  const { db, sid, iid } = seed();
  const r = linkFile(db, { path: '/x/Whatever/Earth X V1999 #001.cbz', dir: '/x/Whatever', name: 'Earth X V1999 #001.cbz', ci_series: 'Earth X', ci_volume: '1999', ci_number: '1', has_metadata: 1 });
  assert.equal(r.seriesId, sid);
  assert.equal(r.issueId, iid);
});

test('linkFile: untagged file falls back to folder-name match', () => {
  const { db, sid } = seed();
  const r = linkFile(db, { path: '/lib/Marvel/Earth X (1999)/Earth X V1999 #002.cbz', dir: '/lib/Marvel/Earth X (1999)', name: 'Earth X V1999 #002.cbz', has_metadata: 0 });
  assert.equal(r.seriesId, sid);
  assert.ok(r.issueId);
});

test('linkFile: no match -> null', () => {
  const { db } = seed();
  const r = linkFile(db, { path: '/x/Totally Unknown (2099)/a.cbz', dir: '/x/Totally Unknown (2099)', name: 'a.cbz', has_metadata: 0 });
  assert.equal(r.seriesId, null);
});
