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

test('explicit libraries: CRUD, assignment types the series, delete unassigns', async () => {
  const { openDb, upsertSeries, getSeriesById, createLibrary, listLibraries, updateLibrary, deleteLibrary, assignSeriesLibrary, collectionSeries } = await import('../src/db.js');
  const db = openDb(':memory:');
  const sid = upsertSeries(db, { title: 'Berserk', url: 'cv:1', publisher: 'Dark Horse' });
  db.prepare('UPDATE series SET followed=1 WHERE id=?').run(sid); // collection member
  const lid = createLibrary(db, { name: 'Manga', type: 'manga' });
  assert.equal(listLibraries(db)[0].name, 'Manga');

  // Assignment sets membership AND behavior type.
  assignSeriesLibrary(db, sid, lid);
  const s = getSeriesById(db, sid);
  assert.equal(s.library_id, lid);
  assert.equal(s.type, 'manga');

  // ?library= lane returns only members.
  assert.equal(collectionSeries(db, { library: lid }).length, 1);
  assert.equal(collectionSeries(db, { library: 999 }).length, 0);

  // Changing the library's type re-types members.
  updateLibrary(db, lid, { type: 'comic' });
  assert.equal(getSeriesById(db, sid).type, 'comic');

  // Delete unassigns, never deletes.
  deleteLibrary(db, lid);
  assert.equal(getSeriesById(db, sid).library_id, null);
  assert.ok(getSeriesById(db, sid)); // series survives
  assert.equal(listLibraries(db).length, 0);

  // Guards.
  assert.throws(() => createLibrary(db, { name: '', type: 'comic' }), /needs a name/);
  assert.throws(() => createLibrary(db, { name: 'X', type: 'novel' }), /unknown series type/);
  assert.throws(() => assignSeriesLibrary(db, sid, 12345), /unknown library/);
});

test('a library root folder drives filing for its members', async () => {
  const { openDb, upsertSeries, createLibrary, assignSeriesLibrary } = await import('../src/db.js');
  const { resolveSeriesDir } = await import('../src/paths.js');
  const db = openDb(':memory:');
  const sid = upsertSeries(db, { title: 'Berserk', url: 'cv:1', publisher: 'Dark Horse' });
  const lid = createLibrary(db, { name: 'Manga', type: 'manga', rootFolder: '/data/manga' });
  assignSeriesLibrary(db, sid, lid);
  const series = db.prepare('SELECT * FROM series WHERE id=?').get(sid);
  const dir = resolveSeriesDir(db, series).split(String.fromCharCode(92)).join('/');
  assert.ok(dir.startsWith('/data/manga/'), dir); // filed under the library root
});

test('restricted library flags its members via the mature-content machinery', async () => {
  const { openDb, upsertSeries, getSeriesById, createLibrary, updateLibrary, assignSeriesLibrary } = await import('../src/db.js');
  const db = openDb(':memory:');
  const sid = upsertSeries(db, { title: 'Adult Series', url: 'cv:2' });
  const lid = createLibrary(db, { name: 'Mature', type: 'comic', restricted: true });
  assignSeriesLibrary(db, sid, lid);
  assert.equal(getSeriesById(db, sid).restricted, 1); // inherited on assignment
  // Moving out of the restricted library clears the inherited flag.
  assignSeriesLibrary(db, sid, null);
  assert.equal(getSeriesById(db, sid).restricted, 0);
  // Flipping the library flag re-flags current members.
  assignSeriesLibrary(db, sid, lid);
  updateLibrary(db, lid, { restricted: false });
  assert.equal(getSeriesById(db, sid).restricted, 0);
  updateLibrary(db, lid, { restricted: true });
  assert.equal(getSeriesById(db, sid).restricted, 1);
});

test('a library folder pattern overrides the global one for filing', async () => {
  const { openDb, upsertSeries, createLibrary, assignSeriesLibrary } = await import('../src/db.js');
  const { resolveSeriesDir } = await import('../src/paths.js');
  const db = openDb(':memory:');
  const sid = upsertSeries(db, { title: 'Berserk', url: 'cv:3', publisher: 'Dark Horse' });
  const lid = createLibrary(db, { name: 'Manga', type: 'manga', rootFolder: '/data/manga', folderPattern: '{series}' });
  assignSeriesLibrary(db, sid, lid);
  const series = db.prepare('SELECT * FROM series WHERE id=?').get(sid);
  const dir = resolveSeriesDir(db, series).split(String.fromCharCode(92)).join('/');
  assert.equal(dir, '/data/manga/Berserk'); // no Publisher level — the library's pattern
});

test('deleting a library moves its members to a surviving library', async () => {
  const { openDb, upsertSeries, getSeriesById, createLibrary, deleteLibrary, assignSeriesLibrary } = await import('../src/db.js');
  const db = openDb(':memory:');
  const sid = upsertSeries(db, { title: 'Berserk', url: 'cv:9' });
  const comics = createLibrary(db, { name: 'Comics', type: 'comic' });
  const manga = createLibrary(db, { name: 'Manga', type: 'manga' });
  assignSeriesLibrary(db, sid, manga);
  deleteLibrary(db, manga);
  const s = getSeriesById(db, sid);
  assert.equal(s.library_id, comics); // re-homed, not left in limbo
  assert.equal(s.type, 'comic');      // takes the new library's type
});
