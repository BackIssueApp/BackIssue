import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIssueFromFilename, groupSeries, issueKey } from '../src/scanner.js';
import { normalizeNumber } from '../src/matcher.js';

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('parseIssueFromFilename reads the number from common library names', () => {
  assert.equal(parseIssueFromFilename('Earth X V1999 #001 (January 2000).cbz'), '001');
  assert.equal(parseIssueFromFilename('Earth X #½.cbz'), '½');
  assert.equal(parseIssueFromFilename('Batman 012.cbr'), '012');
  assert.equal(parseIssueFromFilename('cover.jpg'), null);
  // scene-style names with the number before the (year) + trailing tags
  assert.equal(parseIssueFromFilename('Batman 005 (2016) (Digital) (Group).cbz'), '005');
  // "Series (Year) NNN (tags)" — the number comes AFTER the year (a common
  // convention for externally organised libraries); these used to parse to null
  assert.equal(parseIssueFromFilename('Batman (2016) 012 (Digital) (Zone-Empire).cbz'), '012');
  assert.equal(parseIssueFromFilename('Batman (2016) #012 (Digital).cbz'), '012');
  assert.equal(parseIssueFromFilename('Batman (2016) 001a (Digital).cbz'), '001');
  assert.equal(parseIssueFromFilename('Saga (2012) 001.5 (Digital).cbz'), '001.5');
  assert.equal(parseIssueFromFilename('Batman (2016) (Digital) (Group).cbz'), null);
  assert.equal(parseIssueFromFilename('Batman (2016) 44p c2c 012 (Digital).cbz'), '012'); // "44p"/"c2c" are not issue numbers
  // decimal / half-issue numbers survive (dot between digits kept)
  assert.equal(parseIssueFromFilename('Spider-Man 000.5 (1998) (Marvel-Wizard) (c2c) (Raven-DCP).cbz'), '000.5');
  assert.equal(parseIssueFromFilename('Amazing Spider-Man 001.1 (2014).cbz'), '001.1');
  assert.equal(parseIssueFromFilename('Earth X Issue #1/2.cbz'), '½');
  // "Series (Year) Volume NN Issue NNN" — an explicit issue marker wins, and
  // the volume number is never mistaken for the issue (it used to be).
  assert.equal(parseIssueFromFilename('Absolute Batman (2024) Volume 01 Issue 002.cbz'), '002');
  assert.equal(parseIssueFromFilename('Absolute Batman (2024) Volume 01 Issue 011 (Digital).cbz'), '011');
  assert.equal(parseIssueFromFilename('Absolute Batman Volume 01 Issue 002 (2024).cbz'), '002');
  assert.equal(parseIssueFromFilename('Absolute Batman (2024) Issue #3.cbz'), '3');
  assert.equal(parseIssueFromFilename('Absolute Batman (2024) No. 12.cbz'), '12');
  assert.equal(parseIssueFromFilename('Absolute Batman (2024) Vol. 1 007.cbz'), '007');
  assert.equal(parseIssueFromFilename('Absolute Batman (2024) v1 007.cbz'), '007');
  assert.equal(parseIssueFromFilename('Batman Vol. 3 012 (2016).cbz'), '012');
  // A volume marker that is the only number stays what it is (a trade).
  assert.equal(parseIssueFromFilename('Batman Vol. 3.cbz'), '3');
  // "V for Vendetta" is a name, not a volume marker.
  assert.equal(parseIssueFromFilename('V for Vendetta 004 (1988).cbz'), '004');
  // "Nova 5" is not "No. 5".
  assert.equal(parseIssueFromFilename('Nova 005 (2016).cbz'), '005');
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
});

test('numberless issues (e.g. "TPB 1 (Part 1)") get a title key of their own', () => {
  assert.equal(issueKey('Godzilla Library Collection TPB 1 (Part 1)', null), 'name:godzilla library collection tpb 1 part 1');
  assert.notEqual(issueKey('Godzilla Library Collection TPB 1 (Part 1)', null), issueKey('Godzilla Library Collection TPB 1 (Part 2)', null)); // parts stay distinct
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

test('groupSeries reads a Publisher/Series/Volume layout (Mylar-style)', () => {
  // The immediate parent is only a volume marker — the series name must come
  // from the folder above it (with the volume's year), publisher from the one
  // above that. Each volume folder stays its own group (own ComicVine volume).
  const files = [
    { path: '/lib/Marvel/X-Men/V2004 (2004)/X-Men 001.cbz', dir: '/lib/Marvel/X-Men/V2004 (2004)', name: 'X-Men 001.cbz' },
    { path: '/lib/Marvel/X-Men/v1963/X-Men 001.cbz', dir: '/lib/Marvel/X-Men/v1963', name: 'X-Men 001.cbz' },
    { path: '/lib/DC/Sandman/Vol. 2 (1989)/Sandman 001.cbz', dir: '/lib/DC/Sandman/Vol. 2 (1989)', name: 'Sandman 001.cbz' },
  ];
  const groups = groupSeries(files);
  assert.equal(groups.length, 3);
  const x04 = groups.find((g) => g.dir.endsWith('V2004 (2004)'));
  assert.equal(x04.seriesName, 'X-Men (2004)');
  assert.equal(x04.publisher, 'Marvel');
  const x63 = groups.find((g) => g.dir.endsWith('v1963'));
  assert.equal(x63.seriesName, 'X-Men (1963)'); // year lifted out of the marker itself
  const sandman = groups.find((g) => g.dir.endsWith('Vol. 2 (1989)'));
  assert.equal(sandman.seriesName, 'Sandman (1989)');
  assert.equal(sandman.publisher, 'DC');
});

test('groupSeries: series names starting with V are NOT mistaken for volume folders', () => {
  const files = [
    { path: '/lib/DC/V for Vendetta/V for Vendetta 001.cbz', dir: '/lib/DC/V for Vendetta', name: 'V for Vendetta 001.cbz' },
  ];
  const [g] = groupSeries(files);
  assert.equal(g.seriesName, 'V for Vendetta');
  assert.equal(g.publisher, 'DC');
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

// ---- importMetaForFolder (embedded ComicInfo.xml sniffing) ----------------
import JSZip from 'jszip';
import { importMetaForFolder } from '../src/scanner.js';

async function writeCbz(file, entries) {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(entries)) zip.file(name, content);
  await fs.writeFile(file, await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' }));
}
const CI_XML = (series, volume, publisher) => `<?xml version="1.0"?>
<ComicInfo><Series>${series}</Series><Number>1</Number><Volume>${volume}</Volume><Publisher>${publisher}</Publisher><Year>2010</Year></ComicInfo>`;

test('importMetaForFolder reads series/year/publisher from a tagged CBZ', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'imeta-'));
  const cbz = path.join(dir, 'X-Men 001.cbz');
  await writeCbz(cbz, { 'ComicInfo.xml': CI_XML('X-Men', '2004', 'Marvel'), '001.jpg': 'x' });
  const meta = await importMetaForFolder([cbz]);
  assert.deepEqual(meta, { series: 'X-Men', year: '2004', publisher: 'Marvel', type: null });
  await fs.rm(dir, { recursive: true, force: true });
});

test('importMetaForFolder: ordinal <Volume> is not mistaken for a year', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'imeta-'));
  const cbz = path.join(dir, 'Sandman 001.cbz');
  await writeCbz(cbz, { 'ComicInfo.xml': CI_XML('Sandman', '2', 'DC'), '001.jpg': 'x' });
  const meta = await importMetaForFolder([cbz]);
  assert.equal(meta.series, 'Sandman');
  assert.equal(meta.year, null); // Volume "2" is an ordinal, not a start year
  await fs.rm(dir, { recursive: true, force: true });
});

test('importMetaForFolder skips untagged files and finds a tagged one', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'imeta-'));
  const bare = path.join(dir, 'a-untagged.cbz');
  const tagged = path.join(dir, 'b-tagged.cbz');
  await writeCbz(bare, { '001.jpg': 'x' }); // no ComicInfo.xml
  await writeCbz(tagged, { 'ComicInfo.xml': CI_XML('Saga', '2012', 'Image'), '001.jpg': 'x' });
  const meta = await importMetaForFolder([bare, tagged]);
  assert.equal(meta.series, 'Saga');
  await fs.rm(dir, { recursive: true, force: true });
});

test('importMetaForFolder: CBR-only folders return null (no in-memory RAR reads)', async () => {
  const meta = await importMetaForFolder(['/lib/X/a.cbr', '/lib/X/b.cbr']);
  assert.equal(meta, null);
});

test('importMetaForFolder extracts ComicVine ids from Web and Notes tags', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'imeta-'));
  const mk = async (file, extra) => writeCbz(path.join(dir, file), {
    'ComicInfo.xml': `<?xml version="1.0"?><ComicInfo><Series>S</Series>${extra}</ComicInfo>`, '001.jpg': 'x',
  });
  // Volume URL in Web → direct volume id.
  await mk('a.cbz', '<Web>https://comicvine.gamespot.com/x-men/4050-2133/</Web>');
  assert.equal((await importMetaForFolder([path.join(dir, 'a.cbz')])).cvVolumeId, 2133);
  // Issue URL in Web → issue id.
  await mk('b.cbz', '<Web>https://comicvine.gamespot.com/x-men-1/4000-12345/</Web>');
  assert.equal((await importMetaForFolder([path.join(dir, 'b.cbz')])).cvIssueId, 12345);
  // ComicTagger-style Notes.
  await mk('c.cbz', '<Notes>Tagged with ComicTagger 1.6.0 using info from Comic Vine [CVDB98765]</Notes>');
  assert.equal((await importMetaForFolder([path.join(dir, 'c.cbz')])).cvIssueId, 98765);
  // Mylar/Kapowarr-style Notes.
  await mk('d.cbz', '<Notes>Tagged. Issue ID 55555</Notes>');
  assert.equal((await importMetaForFolder([path.join(dir, 'd.cbz')])).cvIssueId, 55555);
  // No breadcrumbs → no id fields, series still returned.
  await mk('e.cbz', '');
  const plain = await importMetaForFolder([path.join(dir, 'e.cbz')]);
  assert.equal(plain.series, 'S');
  assert.equal(plain.cvVolumeId, undefined);
  assert.equal(plain.cvIssueId, undefined);
  await fs.rm(dir, { recursive: true, force: true });
});

test('importMetaForFolder types a series from ComicInfo Manga tag', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'imeta-'));
  const cbz = path.join(dir, 'Berserk v03.cbz');
  await writeCbz(cbz, { 'ComicInfo.xml': '<?xml version="1.0"?><ComicInfo><Series>Berserk</Series><Manga>YesAndRightToLeft</Manga></ComicInfo>', '001.jpg': 'x' });
  const meta = await importMetaForFolder([cbz]);
  assert.equal(meta.series, 'Berserk');
  assert.equal(meta.type, 'manga');
  await fs.rm(dir, { recursive: true, force: true });
});

test('an explicit issue number wins over a story part in the same filename', () => {
  // Reported by a user: this file was landing as issue 5, because the parser
  // took the LAST number before the year and "Part 5" comes after "#23".
  assert.equal(parseIssueFromFilename('Absolute Batman - #23 - The Straw Man, Part 5 - (Volume.01) - (2024).cbz'), '23');
  assert.equal(parseIssueFromFilename('Series - #7 - A Title, Part 2 - (2023).cbz'), '7');
  assert.equal(parseIssueFromFilename('Series - #23 - Chapter 4 - (2024).cbz'), '23');
  // The same trap without a hash: a counter word is not the issue number.
  assert.equal(normalizeNumber(parseIssueFromFilename('Series 023 - Part 5 (2024).cbz')), '23');
  assert.equal(normalizeNumber(parseIssueFromFilename('Series 023 - Pt. 5 (2024).cbz')), '23');

  // Ordinary scene names must keep parsing exactly as before.
  assert.equal(normalizeNumber(parseIssueFromFilename('Series 012 (2013) (Digital) (Group).cbz')), '12');
  assert.equal(normalizeNumber(parseIssueFromFilename('Series (2016) 012 (Digital).cbz')), '12');
  assert.equal(parseIssueFromFilename('Series 000.5 (2013).cbz'), '000.5');
  assert.equal(parseIssueFromFilename('Series Annual 2 (2019).cbz'), '2');
  assert.equal(parseIssueFromFilename('Series 5 (2019).cbz'), '5');
  // A series whose own name ends in a counter word still reads its number.
  assert.equal(normalizeNumber(parseIssueFromFilename('Part Time Heroes 007 (2021).cbz')), '7');
});
