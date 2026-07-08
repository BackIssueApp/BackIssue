// Reading lists: CRUD, ordering guarantees, per-user isolation, and the
// story-arc import (stub upserts must never clobber cached CV data).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { initListTables, listLists, getList, createList, renameList, deleteList, addItems, removeItem, reorderList, importArcAsList } from '../src/lists.js';

function makeDb() {
  const db = openDb(':memory:');
  initListTables(db);
  return db;
}

test('lists: create, add, reorder, remove — order is exact and per-user', () => {
  const db = makeDb();
  const id = createList(db, 1, 'Weekend stack');
  assert.equal(addItems(db, 1, id, [101, 102, 103]), 3);
  assert.equal(addItems(db, 1, id, [102, 104]), 1, 'dupes are skipped');

  let l = getList(db, 1, id);
  assert.deepEqual(l.items.map((i) => i.cv_issue_id), [101, 102, 103, 104]);

  reorderList(db, 1, id, [104, 101, 103, 102]);
  l = getList(db, 1, id);
  assert.deepEqual(l.items.map((i) => i.cv_issue_id), [104, 101, 103, 102]);

  // a stale reorder (missing an item) is rejected outright
  assert.throws(() => reorderList(db, 1, id, [104, 101]), /every item exactly once/);

  removeItem(db, 1, id, 103);
  assert.equal(getList(db, 1, id).items.length, 3);

  // another user can't see or touch it
  assert.equal(getList(db, 2, id), null);
  assert.throws(() => renameList(db, 2, id, 'mine now'), /no such list/);
  assert.equal(listLists(db, 2).length, 0);

  renameList(db, 1, id, 'Renamed');
  assert.equal(listLists(db, 1)[0].name, 'Renamed');
  deleteList(db, 1, id);
  assert.equal(listLists(db, 1).length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM reading_list_items').get().n, 0, 'items go with the list');
});

test('lists: ownership joins — owned counts come from valid library files', () => {
  const db = makeDb();
  db.exec(`
    INSERT INTO cv_series (comicvine_id, name) VALUES (900, 'Saga');
    INSERT INTO cv_issues (comicvine_id, cv_series_id, issue_number, name) VALUES
      (101, 900, '1', 'Chapter One'), (102, 900, '2', 'Chapter Two');
    INSERT INTO library_files (path, cv_issue_id, valid) VALUES ('/x/saga1.cbz', 101, 1);
  `);
  const id = createList(db, 1, 'Saga');
  addItems(db, 1, id, [101, 102]);
  const overview = listLists(db, 1)[0];
  assert.equal(overview.items, 2);
  assert.equal(overview.owned, 1);
  const l = getList(db, 1, id);
  assert.equal(l.items[0].owned, 1);
  assert.equal(l.items[0].series_title, 'Saga');
  assert.equal(l.items[1].owned, 0);
});

test('arc import: cover-date order, stub rows inserted, cached rows untouched', () => {
  const db = makeDb();
  // one issue already richly cached — the import must not overwrite it
  db.exec(`
    INSERT INTO cv_series (comicvine_id, name) VALUES (500, 'Infinity Gauntlet (cached name)');
    INSERT INTO cv_issues (comicvine_id, cv_series_id, issue_number, name, description)
      VALUES (7, 500, '1', 'Cached Title', 'precious cached description');
  `);
  const issues = [
    { id: 9, name: 'Later', issue_number: '3', cover_date: '1991-09-01', volume: { id: 500, name: 'IG' } },
    { id: 7, name: 'Fresh Title', issue_number: '1', cover_date: '1991-07-01', volume: { id: 500, name: 'IG' } },
    { id: 8, name: 'Tie-in', issue_number: '50', cover_date: '1991-08-01', volume: { id: 501, name: 'Silver Surfer' } },
  ];
  const listId = importArcAsList(db, 1, { id: 4045, name: 'The Infinity Gauntlet' }, issues);

  const l = getList(db, 1, listId);
  assert.equal(l.arc_cv_id, 4045);
  assert.deepEqual(l.items.map((i) => i.cv_issue_id), [7, 8, 9], 'cover-date order, not input order');
  assert.equal(l.items[1].series_title, 'Silver Surfer', 'stub series inserted');
  // the cached row survived untouched
  const cached = db.prepare('SELECT name, description FROM cv_issues WHERE comicvine_id = 7').get();
  assert.equal(cached.name, 'Cached Title');
  assert.equal(cached.description, 'precious cached description');
  const series = db.prepare('SELECT name FROM cv_series WHERE comicvine_id = 500').get();
  assert.equal(series.name, 'Infinity Gauntlet (cached name)');
});
