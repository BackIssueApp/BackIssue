// The boot sweep that decides which series keep their library. A series the
// user added on purpose must survive a restart however it was added: monitored,
// with files, personally followed with monitor "none" and no files yet (the
// add-cv + monitor:none case), or with issue picks. Catalog rows nobody added
// are stripped, and unassigned members join the first comic library.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, upsertSeries, createLibrary, assignSeriesLibrary, setMonitor, setUserFollow, reconcileLibraryMembers } from '../src/db.js';

function seed() {
  const db = openDb(':memory:');
  const manga = { id: createLibrary(db, { name: 'Manga', type: 'manga', rootFolder: '/manga' }) };
  const comics = { id: createLibrary(db, { name: 'Comics', type: 'comic', rootFolder: '/comics' }) };
  const series = (title, lib) => {
    const id = upsertSeries(db, { title, url: 'cv:' + title.toLowerCase() });
    if (lib) assignSeriesLibrary(db, id, lib.id);
    return id;
  };
  return { db, manga, comics, series };
}
const libOf = (db, id) => db.prepare('SELECT library_id FROM series WHERE id=?').get(id).library_id;

test('a series added with monitor "none" and no files keeps its library across a restart', () => {
  const { db, manga, series } = seed();
  const id = series('Oshi No Ko', manga);
  setUserFollow(db, 1, id, true);          // what add-cv records for the adder
  setMonitor(db, id, 'none');              // followed=0, no files yet
  const r = reconcileLibraryMembers(db);
  assert.equal(r.stripped, 0, 'nothing is stripped');
  assert.equal(libOf(db, id), manga.id, 'the manga library is kept');
});

test('a series with issue picks is a member too', () => {
  const { db, manga, series } = seed();
  const id = series('Picked', manga);
  setMonitor(db, id, 'none');
  db.prepare('INSERT INTO issue_picks (cv_issue_id, series_id, want) VALUES (?, ?, 1)').run(99, id);
  reconcileLibraryMembers(db);
  assert.equal(libOf(db, id), manga.id);
});

test('catalog rows nobody added are stripped; unassigned members join the first comic library', () => {
  const { db, manga, comics, series } = seed();
  const ghost = series('Looked Up Once', manga);          // never followed, no files, no picks
  const orphan = series('Followed But Homeless', null);
  db.prepare('UPDATE series SET followed=1 WHERE id=?').run(orphan);
  const r = reconcileLibraryMembers(db);
  assert.equal(r.stripped, 1);
  assert.equal(libOf(db, ghost), null, 'the catalog row leaves the library');
  assert.equal(r.adopted, 1);
  assert.equal(libOf(db, orphan), comics.id, 'the comic library adopts it, not the manga one');
});
