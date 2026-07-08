import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIssueFromFilename, groupSeries, findMissing, findComicFiles, matchCatalogSeries, scanLibrary, issueKey, issueLabel, relinkScanEntry } from '../src/scanner.js';

test('scanLibrary honors a saved match override over the fuzzy match', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lib-'));
  const sdir = path.join(root, 'IDW', 'Godzilla (2023)');
  await fs.mkdir(sdir, { recursive: true });
  await fs.writeFile(path.join(sdir, 'Godzilla V2023 #001.cbz'), 'x');
  const db = openDb(':memory:');
  const wrong = upsertSeries(db, { title: 'Godzilla (2023)', url: '/c/wrong', publisher: 'IDW', coverUrl: '' });
  upsertIssue(db, { seriesId: wrong, title: 'Godzilla #1', issueNumber: '1', url: '/i/w1' });
  const right = upsertSeries(db, { title: 'Godzilla Rivals (2023)', url: '/c/right', publisher: 'IDW', coverUrl: '' });
  for (const n of ['1', '2', '3']) upsertIssue(db, { seriesId: right, title: `Rivals #${n}`, issueNumber: n, url: `/i/r${n}` });
  setScanOverride(db, sdir, right); // user re-linked this folder to 'right'
  const report = await scanLibrary({ db, dir: root });
  const s = report.series.find((x) => x.seriesName === 'Godzilla (2023)');
  assert.ok(s);
  assert.equal(s.matched.id, right); // override wins over the same-name fuzzy match
  assert.equal(s.confidence, 'manual');
  assert.equal(s.total, 3);
  await fs.rm(root, { recursive: true, force: true });
});

test('relinkScanEntry recomputes an entry against a manually chosen series', () => {
  const db = openDb(':memory:');
  const bId = upsertSeries(db, { title: 'Correct Series (2010)', url: '/c/b', publisher: 'DC', coverUrl: '' });
  for (const n of ['1', '2', '3', '4']) upsertIssue(db, { seriesId: bId, title: `Correct #${n}`, issueNumber: n, url: `/i/b${n}` });
  const entry = { seriesName: 'X', dir: '/lib/X', present: ['1', '2'], have: 2, total: 99, matchedTitle: 'Wrong', confidence: 'low', unmatched: false, matched: { id: 999 }, missing: [] };
  const out = relinkScanEntry(db, entry, bId);
  assert.equal(out.matchedTitle, 'Correct Series (2010)');
  assert.equal(out.confidence, 'manual');
  assert.equal(out.total, 4);
  assert.equal(out.matched.id, bId);
  assert.deepEqual(out.missing.map((m) => m.number).sort(), ['3', '4']); // have #1,#2 -> missing #3,#4
  assert.equal(relinkScanEntry(db, entry, 123456), null); // unknown series
});
import { openDb, upsertSeries, upsertIssue, setScanOverride } from '../src/db.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('scanLibrary reports missing catalog issues per series', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lib-'));
  const sdir = path.join(root, 'Marvel', 'Earth X (1999)');
  await fs.mkdir(sdir, { recursive: true });
  await fs.writeFile(path.join(sdir, 'Earth X V1999 #001.cbz'), 'x');
  await fs.writeFile(path.join(sdir, 'Earth X V1999 #003.cbz'), 'x');
  await fs.writeFile(path.join(sdir, 'cover.jpg'), 'x'); // ignored

  const db = openDb(':memory:');
  const sid = upsertSeries(db, { title: 'Earth X (1999)', url: '/c/ex', publisher: 'Marvel', coverUrl: '' });
  for (const n of ['0', '1', '2', '3']) upsertIssue(db, { seriesId: sid, title: `Earth X #${n}`, issueNumber: n, url: `/i/${n}` });

  const files = await findComicFiles(root);
  assert.equal(files.length, 2); // only the 2 cbz
  assert.ok(matchCatalogSeries(db, 'Earth X (1999)', '1999'));

  const report = await scanLibrary({ db, dir: root });
  assert.equal(report.series.length, 1);
  const s = report.series[0];
  assert.equal(s.matchedTitle, 'Earth X (1999)');
  assert.equal(s.unmatched, false);
  assert.equal(s.total, 4);
  assert.equal(s.have, 2);
  assert.deepEqual(s.missing.map((m) => m.number).sort(), ['0', '2']); // missing #0 and #2
  assert.equal(s.matched.id, sid);      // links back to the catalog series
  assert.equal(s.matched.url, '/c/ex');
  assert.match(s.dir.replaceAll('\\', '/'), /Earth X \(1999\)$/); // the folder path
  await fs.rm(root, { recursive: true, force: true });
});

test('scanLibrary marks a series with no catalog match as unmatched', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lib-'));
  const sdir = path.join(root, 'Indie', 'Totally Unknown Book (2099)');
  await fs.mkdir(sdir, { recursive: true });
  await fs.writeFile(path.join(sdir, 'Totally Unknown Book #001.cbz'), 'x');
  const db = openDb(':memory:');
  const report = await scanLibrary({ db, dir: root });
  assert.equal(report.series[0].unmatched, true);
  assert.equal(report.series[0].missing.length, 0);
  await fs.rm(root, { recursive: true, force: true });
});

test('parseIssueFromFilename reads the number from common library names', () => {
  assert.equal(parseIssueFromFilename('Earth X V1999 #001 (January 2000).cbz'), '001');
  assert.equal(parseIssueFromFilename('Earth X #½.cbz'), '½');
  assert.equal(parseIssueFromFilename('Batman 012.cbr'), '012');
  assert.equal(parseIssueFromFilename('cover.jpg'), null);
  // scene-style names with the number before the (year) + trailing tags
  assert.equal(parseIssueFromFilename('Batman 005 (2016) (Digital) (Group).cbz'), '005');
  // decimal / half-issue numbers survive (dot between digits kept)
  assert.equal(parseIssueFromFilename('Spider-Man 000.5 (1998) (Marvel-Wizard) (c2c) (Raven-DCP).cbz'), '000.5');
  assert.equal(parseIssueFromFilename('Amazing Spider-Man 001.1 (2014).cbz'), '001.1');
  assert.equal(parseIssueFromFilename('Earth X Issue #1/2.cbz'), '½');
});

test('groupSeries groups by folder, deriving series + publisher + present numbers', () => {
  const files = [
    { path: '/lib/Marvel/Earth X (1999)/Earth X V1999 #001.cbz', dir: '/lib/Marvel/Earth X (1999)', name: 'Earth X V1999 #001.cbz' },
    { path: '/lib/Marvel/Earth X (1999)/Earth X V1999 #003.cbz', dir: '/lib/Marvel/Earth X (1999)', name: 'Earth X V1999 #003.cbz' },
    { path: '/lib/DC/Batman (2025)/Batman V2025 #001.cbz', dir: '/lib/DC/Batman (2025)', name: 'Batman V2025 #001.cbz' },
  ];
  const groups = groupSeries(files).sort((a, b) => a.seriesName.localeCompare(b.seriesName));
  assert.equal(groups.length, 2);
  const ex = groups.find((g) => g.seriesName === 'Earth X (1999)');
  assert.equal(ex.publisher, 'Marvel');
  assert.deepEqual([...ex.present].sort(), ['1', '3']);
});

test('issueKey namespaces editions so they do not collide with regular issues', () => {
  assert.equal(issueKey('Earth X #1', '1'), '1');
  assert.equal(issueKey('The Shadow (1987) Annual 1', '1'), 'annual:1');
  assert.equal(issueKey('Morning Glories _TPB 2', '2'), 'tpb:2');
  assert.equal(issueLabel('The Shadow (1987) Annual 1', '1'), 'Annual 1');
  assert.equal(issueLabel('Earth X #12', '12'), '12');
});

test('numberless issues (e.g. "TPB 1 (Part 1)") get a title key + label, and count as missing', () => {
  assert.equal(issueKey('Godzilla Library Collection TPB 1 (Part 1)', null), 'name:godzilla library collection tpb 1 part 1');
  assert.notEqual(issueKey('Godzilla Library Collection TPB 1 (Part 1)', null), issueKey('Godzilla Library Collection TPB 1 (Part 2)', null)); // parts stay distinct
  assert.equal(issueLabel('Godzilla Library Collection TPB 1 (Part 1)', null), 'Godzilla Library Collection TPB 1 (Part 1)');
  const issues = [
    { id: 1, issue_number: null, title: 'Godzilla Library Collection TPB 1 (Part 1)' },
    { id: 2, issue_number: null, title: 'Godzilla Library Collection TPB 1 (Part 2)' },
  ];
  assert.equal(findMissing(issues, new Set()).length, 2); // empty folder -> both missing (was 0)
});

test('findMissing tracks editions separately from regular issues', () => {
  const issues = [
    { id: 1, issue_number: '1', title: 'Series #1' },
    { id: 2, issue_number: '1', title: 'Series Annual 1' },
    { id: 3, issue_number: '2', title: 'Series TPB 2' },
  ];
  // On disk: regular #1 only (key "1"). Annual 1 and TPB 2 must still be missing.
  const presentRegularOnly = new Set(['1']);
  assert.deepEqual(findMissing(issues, presentRegularOnly).map((m) => m.label).sort(), ['Annual 1', 'TPB 2']);
  // On disk: the Annual present (key "annual:1") must NOT satisfy regular #1.
  const presentAnnualOnly = new Set(['annual:1']);
  assert.deepEqual(findMissing(issues, presentAnnualOnly).map((m) => m.id).sort(), [1, 3]);
});

test('groupSeries gives an Annual file a namespaced key, not a regular number', () => {
  const dir = '/lib/Marvel/The Shadow (1987)';
  const files = [
    { path: dir + '/a.cbz', dir, name: 'The Shadow V1987 #001.cbz' },
    { path: dir + '/b.cbz', dir, name: 'The Shadow V1987 Annual #001.cbz' },
  ];
  const [g] = groupSeries(files);
  assert.deepEqual([...g.present].sort(), ['1', 'annual:1']);
});

test('groupSeries includes empty series folders (no comic files) with 0 present', () => {
  const files = [{ path: '/lib/Marvel/Earth X (1999)/a.cbz', dir: '/lib/Marvel/Earth X (1999)', name: 'Earth X V1999 #001.cbz' }];
  const folders = ['/lib/Marvel/Earth X (1999)', '/lib/DC/Empty Series (2020)'];
  const groups = groupSeries(files, folders).sort((a, b) => a.seriesName.localeCompare(b.seriesName));
  assert.equal(groups.length, 2); // the non-empty one is not duplicated
  const empty = groups.find((g) => g.seriesName === 'Empty Series (2020)');
  assert.ok(empty);
  assert.equal(empty.publisher, 'DC');
  assert.equal(empty.present.size, 0);
});

test('scanLibrary reports an empty series folder as all issues missing', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lib-'));
  // a populated series establishes the series-folder depth...
  await fs.mkdir(path.join(root, 'Marvel', 'Populated (2000)'), { recursive: true });
  await fs.writeFile(path.join(root, 'Marvel', 'Populated (2000)', 'p.cbz'), 'x');
  // ...and its empty sibling must still be reported.
  await fs.mkdir(path.join(root, 'Marvel', 'Earth X (1999)'), { recursive: true });
  const db = openDb(':memory:');
  const sid = upsertSeries(db, { title: 'Earth X (1999)', url: '/c/ex', publisher: 'Marvel', coverUrl: '' });
  for (const n of ['0', '1', '2']) upsertIssue(db, { seriesId: sid, title: `Earth X #${n}`, issueNumber: n, url: `/i/${n}` });
  const report = await scanLibrary({ db, dir: root });
  const s = report.series.find((x) => x.seriesName === 'Earth X (1999)');
  assert.ok(s);
  assert.equal(s.unmatched, false);
  assert.equal(s.have, 0);
  assert.equal(s.total, 3);
  assert.equal(s.missing.length, 3); // the whole run is missing
  await fs.rm(root, { recursive: true, force: true });
});

test('scanLibrary finds empty folders when scanDir is a single publisher (depth-1)', async () => {
  const pub = await fs.mkdtemp(path.join(os.tmpdir(), 'pub-')); // scanDir = a publisher folder
  await fs.mkdir(path.join(pub, 'Vampirella (2019)'), { recursive: true });
  await fs.writeFile(path.join(pub, 'Vampirella (2019)', 'Vampirella V2019 #001.cbz'), 'x');
  await fs.mkdir(path.join(pub, 'The Twilight Zone (2013)'), { recursive: true }); // empty sibling
  const db = openDb(':memory:');
  const sid = upsertSeries(db, { title: 'The Twilight Zone (2013)', url: '/c/tz', publisher: 'Dynamite', coverUrl: '' });
  for (const n of ['1', '2', '3']) upsertIssue(db, { seriesId: sid, title: `The Twilight Zone #${n}`, issueNumber: n, url: `/i/tz${n}` });
  const report = await scanLibrary({ db, dir: pub });
  const s = report.series.find((x) => x.seriesName === 'The Twilight Zone (2013)');
  assert.ok(s, 'empty depth-1 series should be reported');
  assert.equal(s.have, 0);
  assert.equal(s.total, 3);
  assert.equal(s.missing.length, 3);
  await fs.rm(pub, { recursive: true, force: true });
});

test('findMissing returns catalog issues whose normalized number is absent', () => {
  const issues = [
    { id: 10, issue_number: '1', title: 'A #1' },
    { id: 11, issue_number: '002', title: 'A #2' },
    { id: 12, issue_number: '3', title: 'A #3' },
  ];
  const present = new Set(['1', '3']); // have #1 and #3
  const missing = findMissing(issues, present);
  assert.deepEqual(missing.map((m) => m.id), [11]); // #2 missing
});
