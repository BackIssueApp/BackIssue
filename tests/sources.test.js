import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderedSources, allSources } from '../src/sources/index.js';
import { pluginApi } from '../src/plugins.js';
import { matchesIssue, buildQuery, parseReleaseName, normalizeSeries, scoreRelease, importCompleted, suspiciouslySmall } from '../src/sources/usenet.js';
import { openDb, upsertSeries, ensureCvIssueRow } from '../src/db.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';

// A fake immediate source stands in for an external source plugin (a real
// catalog source lives in its own plugin and is tested there).
const fake = { id: 'fake', label: 'fake', isEnabled: (c) => c?.fakeEnabled !== false, find: async () => null, fetch: async () => ({}) };
pluginApi.registerSource(fake);
const ids = (config) => orderedSources(config).map((s) => s.id);

test('ensureCvIssueRow: creates a synthetic queue row, idempotent by cv issue id', () => {
  const db = openDb(':memory:');
  const sid = upsertSeries(db, { title: 'X', url: 'cv:1' });
  const a = ensureCvIssueRow(db, { seriesId: sid, cvIssueId: 555, number: '1', title: 'X #1' });
  const b = ensureCvIssueRow(db, { seriesId: sid, cvIssueId: 555, number: '1', title: 'X #1' });
  assert.equal(a, b); // same row reused
  const row = db.prepare('SELECT * FROM issues WHERE id=?').get(a);
  assert.equal(row.url, 'cvissue:555');
  assert.equal(row.issue_number, '1');
});

test('orderedSources: only enabled sources appear', () => {
  assert.ok(ids({}).includes('fake'));    // enabled by default
  assert.ok(!ids({}).includes('usenet')); // usenet needs config
});

test('orderedSources: a source can be disabled', () => {
  assert.ok(!ids({ fakeEnabled: false }).includes('fake'));
});

test('orderedSources: usenet enabled requires indexers + client url', () => {
  assert.ok(!ids({ usenetEnabled: true }).includes('usenet')); // no indexers
  const full = { usenetEnabled: true, newznabIndexers: 'nz | https://nz/ | key', nzbClientUrl: 'http://sab:8080' };
  assert.ok(ids(full).includes('usenet'));
});

test('orderedSources: priority setting reorders enabled sources', () => {
  const full = { usenetEnabled: true, newznabIndexers: 'nz | https://nz/ | key', nzbClientUrl: 'http://sab:8080', fakeEnabled: true, sourcePriority: 'usenet,fake' };
  const ranked = ids(full).filter((id) => id === 'usenet' || id === 'fake');
  assert.deepEqual(ranked, ['usenet', 'fake']);
});

test('all sources implement the interface', () => {
  for (const s of allSources) {
    assert.equal(typeof s.id, 'string');
    assert.equal(typeof s.isEnabled, 'function');
    assert.equal(typeof s.find, 'function');
    // Immediate sources fetch a file; deferred sources grab and hand off.
    if (s.kind === 'deferred') assert.equal(typeof s.grab, 'function');
    else assert.equal(typeof s.fetch, 'function');
  }
});

test('usenet matchesIssue: exact series + issue number', () => {
  assert.equal(matchesIssue('Invincible 001 (2003) (digital)', 'Invincible', '1'), true);
  assert.equal(matchesIssue('Invincible 012 (2004)', 'Invincible', '12'), true);
  assert.equal(matchesIssue('Invincible 012 (2004)', 'Invincible', '1'), false); // 12 != 1
  assert.equal(matchesIssue('Saga 001', 'Invincible', '1'), false);              // wrong series
  assert.equal(matchesIssue('Invincible 001 (2003)', 'Invincible', ''), true);   // no number wanted → series match
  // The reported bug: a different Spider-Man volume must NOT match "Spider-Man".
  assert.equal(matchesIssue('Amazing Spider-Man - Peter Parker The One And Only 001 (2014) (digital) (Marika-Empire)', 'Spider-Man', '1'), false);
  assert.equal(matchesIssue('Spider-Man 001 (1990) (digital)', 'Spider-Man', '1'), true);
});

test('importCompleted: packs a loose-images release into an ordered CBZ', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usimport-'));
  const sub = path.join(dir, '2000AD 1127'); fs.mkdirSync(sub);
  // Out-of-lexical-order names to prove natural sort (page 2 before page 10).
  for (const n of ['page10.jpg', 'page2.jpg', 'page1.jpg']) fs.writeFileSync(path.join(sub, n), Buffer.from('img-' + n));
  fs.writeFileSync(path.join(sub, 'info.nfo'), 'ignore me'); // non-image is skipped
  const r = await importCompleted(dir, '2000AD 1127');
  assert.equal(r.format, 'cbz');
  const zip = await JSZip.loadAsync(r.buffer);
  const names = Object.keys(zip.files).sort();
  assert.deepEqual(names, ['001.jpg', '002.jpg', '003.jpg']); // renamed, padded, ordered
  assert.equal(await zip.file('001.jpg').async('string'), 'img-page1.jpg'); // page1 → 001 (natural order)
  fs.rmSync(dir, { recursive: true, force: true });
});

test('importCompleted: a single-file path (single-file torrent) imports that file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usimport-'));
  const cbz = path.join(dir, '2000AD 1234.cbz');
  const zip = new JSZip(); zip.file('001.jpg', Buffer.from([0xff, 0xd8, 0xff, 1]));
  fs.writeFileSync(cbz, await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' }));
  const r = await importCompleted(cbz, '2000AD 1234'); // path is the file itself, not a dir
  assert.equal(r.format, 'cbz');
  assert.equal(r.srcPath, cbz);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('importCompleted: no archive and no images → clear error', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usimport-'));
  fs.writeFileSync(path.join(dir, 'readme.txt'), 'x');
  await assert.rejects(() => importCompleted(dir, 'X'), /no comic archive or page images/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('importCompleted: a damaged extra archive next to the real comic is skipped', async () => {
  // The reported failure: two files in the finished folder; the walk happened to
  // hit the broken one first and the whole import failed. Candidates are now
  // ranked (comic extensions before generic .rar leftovers) and tried in order.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usimport-'));
  fs.writeFileSync(path.join(dir, 'aaa-leftover.rar'), Buffer.from('Rar!\x1a\x07\x00garbage-not-a-real-archive'));
  const zip = new JSZip(); zip.file('001.jpg', Buffer.from([0xff, 0xd8, 0xff, 1]));
  const cbz = path.join(dir, 'zzz-comic.cbz');
  fs.writeFileSync(cbz, await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' }));
  const r = await importCompleted(dir, 'X');
  assert.equal(r.format, 'cbz');
  assert.equal(r.srcPath, cbz); // the real comic won despite sorting after the .rar
  fs.rmSync(dir, { recursive: true, force: true });
});

test('importCompleted: a ZIP mislabeled as .cbr is imported by its real format', async () => {
  // Feeding ZIP bytes to the RAR extractor is a guaranteed "damaged archive"
  // error — the format must come from the bytes, not the extension.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usimport-'));
  const zip = new JSZip(); zip.file('001.jpg', Buffer.from([0xff, 0xd8, 0xff, 1]));
  const cbr = path.join(dir, 'comic.cbr');
  fs.writeFileSync(cbr, await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' }));
  const r = await importCompleted(dir, 'X');
  assert.equal(r.format, 'cbz');
  assert.equal(r.srcPath, cbr); // returned as-is (ZIP bytes), not run through RAR
  fs.rmSync(dir, { recursive: true, force: true });
});

test('importCompleted: every archive damaged but loose pages present → pages win', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usimport-'));
  fs.writeFileSync(path.join(dir, 'broken.cbr'), Buffer.from('Rar!\x1a\x07\x00garbage'));
  fs.writeFileSync(path.join(dir, 'page1.jpg'), Buffer.from('img'));
  const r = await importCompleted(dir, 'X');
  assert.equal(r.format, 'cbz'); // packed from the loose page
  fs.rmSync(dir, { recursive: true, force: true });
});

test('usenet scoreRelease: matches an alias (2000AD ↔ 2000 AD), still rejects others', () => {
  const target = { series: '2000 AD', names: ['2000 AD', '2000AD'], number: '1' };
  assert.notEqual(scoreRelease('2000AD 001 (2016)', target), null); // indexer name → matches via alias
  assert.notEqual(scoreRelease('2000 AD 001 (2016)', target), null); // canonical name → still matches
  assert.equal(scoreRelease('2000 AD Sci-Fi Special 001', target), null); // different series → rejected
});

test('usenet normalizeSeries: leading "the" and & handled, distinct names differ', () => {
  assert.equal(normalizeSeries('The Amazing Spider-Man'), normalizeSeries('Amazing Spider-Man'));
  assert.equal(normalizeSeries('Spider-Man') === normalizeSeries('Amazing Spider-Man'), false);
  assert.equal(normalizeSeries('Hawkeye & Mockingbird'), normalizeSeries('Hawkeye and Mockingbird'));
});

test('usenet parseReleaseName: series / number / year', () => {
  assert.deepEqual(parseReleaseName('Spider-Man 001 (1990) (digital) (Group)'), { series: 'Spider-Man', number: '1', year: '1990' });
  assert.deepEqual(parseReleaseName('Amazing Spider-Man 700 (2013)'), { series: 'Amazing Spider-Man', number: '700', year: '2013' });
  assert.deepEqual(parseReleaseName('Batman 05 (of 12) (2016)'), { series: 'Batman', number: '5', year: '2016' });
  assert.deepEqual(parseReleaseName('Spider-Man 2099 001 (1992)'), { series: 'Spider-Man 2099', number: '1', year: '1992' }); // volume number stays in series
  // decimal issue numbers survive (the ½ promo / point-ones): dot between digits kept
  assert.deepEqual(parseReleaseName('Spider-Man 000.5 (1998) (Marvel-Wizard)'), { series: 'Spider-Man', number: '0.5', year: '1998' });
  assert.deepEqual(parseReleaseName('Amazing Spider-Man 001.1 (2014)'), { series: 'Amazing Spider-Man', number: '1.1', year: '2014' });
  // "-1" (Marvel Flashback) issues: the leading minus is the issue number...
  assert.deepEqual(parseReleaseName('X-Men -1 (1997)'), { series: 'X-Men', number: '-1', year: '1997' });
  // ...but a hyphen inside a series name (X-23) is NOT mistaken for a negative.
  assert.deepEqual(parseReleaseName('X-23 5 (2010)'), { series: 'X-23', number: '5', year: '2010' });
});

test('usenet: "-1" (Flashback) issues are searchable and matched, not confused with #1', () => {
  // the query carries the literal -1, not just the broad series name
  assert.equal(buildQuery({ seriesTitle: 'X-Men', issue: { issue_number: '-1' } }), 'X-Men -1');
  const want = { series: 'X-Men', names: ['X-Men'], number: '-1', year: '1991' };
  assert.notEqual(scoreRelease('X-Men -1 (1997) (Digital)', want), null); // the -1 release matches
  assert.equal(scoreRelease('X-Men 001 (1991)', want), null);             // #1 is not #-1
  // and a want for #1 is NOT satisfied by the -1 release
  assert.equal(scoreRelease('X-Men -1 (1997)', { series: 'X-Men', names: ['X-Men'], number: '1' }), null);
});

test('usenet scoreRelease: fractional issue numbers match (½ / 1/2 / 0.5 / 000.5)', () => {
  const title = 'Spider-Man 000.5 (1998) (Marvel-Wizard) (c2c) (Raven-DCP)';
  for (const number of ['½', '1/2', '0.5', '.5', '000.5']) {
    assert.notEqual(scoreRelease(title, { series: 'Spider-Man', number }), null, `expected ${number} to match 000.5`);
  }
  assert.equal(scoreRelease(title, { series: 'Spider-Man', number: '12' }), null); // not the ½ issue
  assert.equal(scoreRelease(title, { series: 'Spider-Man', number: '5' }), null);  // 000.5 is 0.5, not 5
});

test('usenet scoreRelease: year ranks matches, mismatched series rejected', () => {
  // Same series + number, matching volume year scores higher than a mismatch.
  const want = { series: 'Spider-Man', number: '1', year: '1990' };
  const right = scoreRelease('Spider-Man 001 (1990)', want);
  const wrongYear = scoreRelease('Spider-Man 001 (2016)', want);
  assert.ok(right > wrongYear);          // prefer the 1990 volume
  assert.ok(wrongYear != null);          // but a same-series mismatch is still a candidate
  assert.equal(scoreRelease('Web of Spider-Man 001 (1990)', want), null); // different series → rejected
});

test('usenet buildQuery: series + zero-padded number', () => {
  assert.equal(buildQuery({ seriesTitle: 'Invincible', issue: { issue_number: '5' } }), 'Invincible 005');
  assert.equal(buildQuery({ seriesTitle: 'Saga', issue: { issue_number: '' } }), 'Saga');
});

test('suspiciouslySmall: tiny known sizes rejected, unknown and real sizes pass', () => {
  assert.equal(suspiciouslySmall(5 * 1024), true);       // 5KB fake
  assert.equal(suspiciouslySmall(1024 * 1024 - 1), true);
  assert.equal(suspiciouslySmall(3 * 1024 * 1024), false); // real comic
  assert.equal(suspiciouslySmall(0), false);             // unknown ≠ fake
  assert.equal(suspiciouslySmall(undefined), false);
});
