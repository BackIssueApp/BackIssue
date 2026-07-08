import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parseRootFolders, safeSegment, seriesFolderName, resolveSeriesDir } from '../src/paths.js';
import config from '../src/config.js';
import { openDb, upsertSeries, upsertLibraryFile, linkLibraryFile, setSeriesPath, getSeriesById, upsertCvSeries, setSeriesCv } from '../src/db.js';
import { targetPath } from '../src/downloader.js';

test('parseRootFolders splits on newlines and commas', () => {
  assert.deepEqual(parseRootFolders('a\nb , c'), ['a', 'b', 'c']);
  assert.deepEqual(parseRootFolders(''), []);
});

test('safeSegment strips path-illegal characters', () => {
  assert.equal(safeSegment('Bat/man: Year? *One*'), 'Bat man Year One');
});

test('seriesFolderName builds Publisher/Title (Year)', () => {
  assert.equal(seriesFolderName({ title: 'Saga', publisher: 'Image', year: '2012' }), path.join('Image', 'Saga (2012)'));
  // doesn't double up a year already in the title
  assert.equal(seriesFolderName({ title: 'Saga (2012)', publisher: 'Image', year: '2012' }), path.join('Image', 'Saga (2012)'));
  // no publisher
  assert.equal(seriesFolderName({ title: 'Saga', year: '2012' }), 'Saga (2012)');
});

test('seriesFolderName strips ongoing/range year markers', () => {
  // an ongoing marker "(2022-)" -> "(2022)"
  assert.equal(seriesFolderName({ title: '20th Century Men (2022-)', publisher: 'Image' }), path.join('Image', '20th Century Men (2022)'));
  // range -> start year
  assert.equal(seriesFolderName({ title: 'Something (2015-2019)' }), 'Something (2015)');
  // "-present"
  assert.equal(seriesFolderName({ title: 'Ongoing (2020-present)' }), 'Ongoing (2020)');
  // a "2022-" year value also normalizes when appended
  assert.equal(seriesFolderName({ title: 'Book', year: '2022-' }), 'Book (2022)');
});

test('resolveSeriesDir prefers explicit path, then files, then root, then downloads', () => {
  const db = openDb(':memory:');
  const id = upsertSeries(db, { title: 'Saga', url: '/c/saga', publisher: 'Image' });
  db.prepare('UPDATE series SET year=? WHERE id=?').run('2012', id);

  // 4. no path, no files, no root → downloads/<Title>
  const prevRoots = config.rootFolders;
  config.rootFolders = '';
  assert.equal(resolveSeriesDir(db, getSeriesById(db, id)), path.join(config.downloadsDir, 'Saga'));

  // 3. root folder configured → root/Publisher/Title (Year)
  config.rootFolders = '/lib/root';
  assert.equal(resolveSeriesDir(db, getSeriesById(db, id)), path.join('/lib/root', 'Image', 'Saga (2012)'));

  // 2. existing files win over the root default
  upsertLibraryFile(db, { path: '/real/Saga (2012)/s1.cbz', dir: '/real/Saga (2012)', name: 's1.cbz', size: 1, mtime: 1, valid: 1 });
  linkLibraryFile(db, '/real/Saga (2012)/s1.cbz', id, null);
  assert.equal(resolveSeriesDir(db, getSeriesById(db, id)), '/real/Saga (2012)');

  // 1. an explicit path wins over everything
  setSeriesPath(db, id, '/custom/here');
  assert.equal(resolveSeriesDir(db, getSeriesById(db, id)), '/custom/here');

  config.rootFolders = prevRoots;
});

test('resolveSeriesDir uses clean ComicVine metadata over an ongoing source title', () => {
  const db = openDb(':memory:');
  const id = upsertSeries(db, { title: '20th Century Men (2022-)', url: '/c/20cm' });
  upsertCvSeries(db, { id: 555, name: '20th Century Men', publisher: 'Image Comics', start_year: '2022' });
  setSeriesCv(db, id, 555, { locked: 0 });
  const prev = config.rootFolders;
  config.rootFolders = '/watched';
  assert.equal(resolveSeriesDir(db, getSeriesById(db, id)), path.join('/watched', 'Image Comics', '20th Century Men (2022)'));
  config.rootFolders = prev;
});

test('setSeriesPath stores a path and clears it with blank', () => {
  const db = openDb(':memory:');
  const id = upsertSeries(db, { title: 'X', url: '/c/x' });
  setSeriesPath(db, id, '/a/b');
  assert.equal(getSeriesById(db, id).path, '/a/b');
  setSeriesPath(db, id, '   ');
  assert.equal(getSeriesById(db, id).path, null);
});

test('targetPath saves into a provided base folder', () => {
  const dest = targetPath('Saga', { issue_number: '1', title: 'Saga #1' }, 'cbz', '2012', '/lib/Image/Saga (2012)');
  assert.equal(path.dirname(dest), path.normalize('/lib/Image/Saga (2012)'));
  assert.match(path.basename(dest), /\.cbz$/);
});

test('targetPath without a base folder falls back to downloads/<Series>', () => {
  const dest = targetPath('Saga', { issue_number: '1', title: 'Saga #1' }, 'cbz', '2012');
  assert.equal(path.dirname(dest), path.join(config.downloadsDir, 'Saga'));
});
