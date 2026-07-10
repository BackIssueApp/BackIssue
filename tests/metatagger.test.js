import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { buildComicInfoXml, stripHtml, mapCredits, tagCbzBuffer, writeComicInfo, ensureCvIssueDetail, tagFileFromCv, fetchAllIssueMetadata } from '../src/metatagger.js';
import { openDb, upsertSeries, upsertCvSeries, upsertCvIssue, upsertLibraryFile, linkLibraryFile, linkFileCvIssue, getLibraryFile } from '../src/db.js';

const SERIES = { comicvine_id: 46568, name: 'Saga', publisher: 'Image', start_year: '2012', count_of_issues: 72, site_detail_url: 'https://cv/saga' };
const ISSUE = {
  comicvine_id: 3003, issue_number: '3', name: 'Chapter Three',
  cover_date: '2012-05-16', description: '<p>Marko &amp; Alana <em>flee</em>.</p>',
  credits: JSON.stringify([{ name: 'Brian K. Vaughan', role: 'writer' }, { name: 'Fiona Staples', role: 'penciler, cover' }]),
  site_detail_url: 'https://cv/saga-3',
};

test('stripHtml flattens ComicVine HTML descriptions', () => {
  assert.equal(stripHtml('<p>Marko &amp; Alana <em>flee</em>.</p>'), 'Marko & Alana flee.');
  assert.equal(stripHtml('a<br>b<br/>c'), 'a\nb\nc');
  assert.equal(stripHtml(null), '');
});

test('mapCredits maps CV roles onto ComicInfo elements (multi-role, dedup)', () => {
  const out = mapCredits([
    { name: 'W', role: 'writer' },
    { name: 'P', role: 'penciler, cover' },
    { name: 'P', role: 'cover' }, // dup
    { name: 'E', role: 'editor' },
    { name: 'X', role: 'translator' }, // unmapped role dropped
  ]);
  assert.equal(out.Writer, 'W');
  assert.equal(out.Penciller, 'P');
  assert.equal(out.CoverArtist, 'P');
  assert.equal(out.Editor, 'E');
  assert.equal(out.Inker, undefined);
});

test('buildComicInfoXml writes the standard fields, escaped', () => {
  const xml = buildComicInfoXml({ series: SERIES, issue: ISSUE });
  assert.match(xml, /^<\?xml version="1.0" encoding="utf-8"\?>/);
  assert.match(xml, /<Title>Chapter Three<\/Title>/);
  assert.match(xml, /<Series>Saga<\/Series>/);
  assert.match(xml, /<Number>3<\/Number>/);
  assert.match(xml, /<Count>72<\/Count>/);
  assert.match(xml, /<Volume>2012<\/Volume>/);
  assert.match(xml, /<Summary>Marko &amp; Alana flee.<\/Summary>/); // stripped + re-escaped
  assert.match(xml, /<Year>2012<\/Year>/);
  assert.match(xml, /<Month>5<\/Month>/);
  assert.match(xml, /<Day>16<\/Day>/);
  assert.match(xml, /<Writer>Brian K. Vaughan<\/Writer>/);
  assert.match(xml, /<Penciller>Fiona Staples<\/Penciller>/);
  assert.match(xml, /<CoverArtist>Fiona Staples<\/CoverArtist>/);
  assert.match(xml, /<Publisher>Image<\/Publisher>/);
  assert.match(xml, /<Web>https:\/\/cv\/saga-3<\/Web>/);
  assert.match(xml, /<Notes>Tagged by BackIssue from ComicVine issue 3003.<\/Notes>/);
});

test('buildComicInfoXml handles a bare stub (no detail) gracefully', () => {
  const xml = buildComicInfoXml({ series: { name: 'S', start_year: '1999' }, issue: { comicvine_id: 1, issue_number: '1', name: null } });
  assert.match(xml, /<Series>S<\/Series>/);
  assert.match(xml, /<Year>1999<\/Year>/); // falls back to series year when no cover date
  assert.ok(!/<Title>/.test(xml));
  assert.ok(!/<Summary>/.test(xml));
});

async function makeCbz(extra = {}) {
  const z = new JSZip();
  z.file('001.jpg', Buffer.from([1, 2, 3]));
  for (const [n, c] of Object.entries(extra)) z.file(n, c);
  return z.generateAsync({ type: 'nodebuffer' });
}

test('tagCbzBuffer inserts ComicInfo.xml and replaces any existing one', async () => {
  const buf = await makeCbz({ 'ComicInfo.xml': '<ComicInfo><Series>Old</Series></ComicInfo>' });
  const out = await tagCbzBuffer(buf, buildComicInfoXml({ series: SERIES, issue: ISSUE }));
  const zip = await JSZip.loadAsync(out);
  const infos = Object.keys(zip.files).filter((n) => /comicinfo\.xml$/i.test(n));
  assert.equal(infos.length, 1);
  const xml = await zip.file('ComicInfo.xml').async('string');
  assert.match(xml, /<Series>Saga<\/Series>/); // old tag gone, CV data in
  assert.ok(zip.file('001.jpg')); // pages preserved
});

test('writeComicInfo rewrites a CBZ on disk in place', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tag-'));
  const p = path.join(dir, 'saga3.cbz');
  await fs.writeFile(p, await makeCbz());
  await writeComicInfo(p, buildComicInfoXml({ series: SERIES, issue: ISSUE }));
  const zip = await JSZip.loadAsync(await fs.readFile(p));
  assert.match(await zip.file('ComicInfo.xml').async('string'), /<Series>Saga<\/Series>/);
  await assert.rejects(() => writeComicInfo(path.join(dir, 'x.cbr'), '<x/>'), /only tag .cbz/);
  await fs.rm(dir, { recursive: true, force: true });
});

test('ensureCvIssueDetail fetches once and caches', async () => {
  const db = openDb(':memory:');
  upsertCvSeries(db, { id: 46568, name: 'Saga' });
  upsertCvIssue(db, { id: 3003, cv_series_id: 46568, number: '3', name: 'Chapter Three' });
  let calls = 0;
  const client = { async issue(id) { calls++; return { id, name: 'Chapter Three', issue_number: '3', cover_date: '2012-05-16', store_date: null, description: '<p>d</p>', credits: [{ name: 'W', role: 'writer' }], site_detail_url: 'https://cv/saga-3' }; } };
  const a = await ensureCvIssueDetail(db, client, 3003);
  assert.equal(a.has_detail, 1);
  assert.equal(a.cover_date, '2012-05-16');
  assert.deepEqual(JSON.parse(a.credits), [{ name: 'W', role: 'writer' }]);
  await ensureCvIssueDetail(db, client, 3003);
  assert.equal(calls, 1); // cached — one API call per issue, ever
});

test('fetchAllIssueMetadata fetches only issues missing detail, and converges', async () => {
  const db = openDb(':memory:');
  upsertCvSeries(db, { id: 100, name: 'Test' });
  // Three issues with no detail, plus one already detailed.
  upsertCvIssue(db, { id: 1, cv_series_id: 100, number: '1' });
  upsertCvIssue(db, { id: 2, cv_series_id: 100, number: '2' });
  upsertCvIssue(db, { id: 3, cv_series_id: 100, number: '3' });
  const alreadyClient = { async issue(id) { return { id, issue_number: '4', name: 'Four', description: 'd', credits: [] }; } };
  upsertCvIssue(db, { id: 4, cv_series_id: 100, number: '4' });
  await ensureCvIssueDetail(db, alreadyClient, 4); // #4 now has_detail=1

  const seen = [];
  const progress = [];
  const client = { async issue(id) { seen.push(id); return { id, issue_number: String(id), name: `Issue ${id}`, cover_date: '2020-01-01', description: 'x', credits: [] }; } };
  const r = await fetchAllIssueMetadata(db, client, (p) => progress.push(p));

  assert.deepEqual(seen.sort((a, b) => a - b), [1, 2, 3], 'only the undetailed issues were fetched (not #4)');
  assert.deepEqual(r, { fetched: 3, failed: 0 });
  assert.equal(progress[0].total, 3, 'progress reports the count to do');
  // Converges: a second run has nothing left.
  const r2 = await fetchAllIssueMetadata(db, client, () => {});
  assert.deepEqual(r2, { fetched: 0, failed: 0 });
});

test('fetchAllIssueMetadata stops cleanly on a rate limit and reports remaining', async () => {
  const db = openDb(':memory:');
  upsertCvSeries(db, { id: 200, name: 'RL' });
  for (const n of [1, 2, 3]) upsertCvIssue(db, { id: n, cv_series_id: 200, number: String(n) });
  let calls = 0;
  const client = { async issue(id) {
    calls++;
    if (calls === 2) { const e = new Error('rate limited'); e.rateLimited = true; throw e; }
    return { id, issue_number: String(id), name: `I${id}`, description: 'd', credits: [] };
  } };
  const r = await fetchAllIssueMetadata(db, client, () => {});
  assert.equal(r.fetched, 1, 'the first issue was fetched before the limit hit');
  assert.equal(r.remaining, 2, 'the rest remain for a re-run');
});

test('tagFileFromCv tags a linked file end-to-end and logs it', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tag-'));
  const p = path.join(dir, 'Saga V2012 #003.cbz');
  await fs.writeFile(p, await makeCbz());
  const db = openDb(':memory:');
  const sid = upsertSeries(db, { title: 'Saga (2012)', url: '/c/saga' });
  upsertCvSeries(db, { id: 46568, name: 'Saga', publisher: 'Image', start_year: '2012', count_of_issues: 72 });
  upsertCvIssue(db, { id: 3003, cv_series_id: 46568, number: '3', name: 'Chapter Three' });
  const st = await fs.stat(p);
  upsertLibraryFile(db, { path: p, dir, name: path.basename(p), size: st.size, mtime: Math.floor(st.mtimeMs), valid: 1, has_metadata: 0 });
  linkLibraryFile(db, p, sid, null);
  linkFileCvIssue(db, p, 3003);

  const client = { async issue(id) { return { id, name: 'Chapter Three', issue_number: '3', cover_date: '2012-05-16', store_date: null, description: 'd', credits: [], site_detail_url: null }; } };
  const r = await tagFileFromCv(db, client, p);
  assert.equal(r.outcome, 'tagged');
  const zip = await JSZip.loadAsync(await fs.readFile(p));
  assert.match(await zip.file('ComicInfo.xml').async('string'), /<Series>Saga<\/Series>/);
  const row = getLibraryFile(db, p);
  assert.equal(row.has_metadata, 1);
  assert.equal(row.ci_series, 'Saga');
  assert.equal(row.ci_number, '3');

  // Unlinked file → no-match outcome, file untouched.
  const p2 = path.join(dir, 'other.cbz');
  await fs.writeFile(p2, await makeCbz());
  upsertLibraryFile(db, { path: p2, dir, name: 'other.cbz', size: 1, mtime: 1, valid: 1 });
  assert.equal((await tagFileFromCv(db, client, p2)).outcome, 'no-match');
  await fs.rm(dir, { recursive: true, force: true });
});

test('tagFileFromCv: a rate-limit error propagates and leaves the file untagged', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tag-'));
  const p = path.join(dir, 'Saga V2012 #003.cbz');
  await fs.writeFile(p, await makeCbz());
  const db = openDb(':memory:');
  const sid = upsertSeries(db, { title: 'Saga (2012)', url: '/c/saga' });
  upsertCvSeries(db, { id: 46568, name: 'Saga', publisher: 'Image', start_year: '2012', count_of_issues: 72 });
  upsertCvIssue(db, { id: 3003, cv_series_id: 46568, number: '3', name: 'Chapter Three' }); // stub, no detail → forces an API call
  upsertLibraryFile(db, { path: p, dir, name: path.basename(p), size: 1, mtime: 1, valid: 1, has_metadata: 0 });
  linkLibraryFile(db, p, sid, null);
  linkFileCvIssue(db, p, 3003);

  const rlClient = { async issue() { const e = new Error('rate limited'); e.rateLimited = true; throw e; } };
  await assert.rejects(() => tagFileFromCv(db, rlClient, p), (e) => e.rateLimited === true);
  const row = getLibraryFile(db, p);
  assert.equal(row.has_metadata, 0); // NOT marked tagged — retried on a later run
  const zip = await JSZip.loadAsync(await fs.readFile(p));
  assert.equal(zip.file('ComicInfo.xml'), null); // nothing written
  await fs.rm(dir, { recursive: true, force: true });
});

test('tagFileFromCv converts a .cbr to .cbz, then tags it', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tag-'));
  const cbr = path.join(dir, 'Saga V2012 #003.cbr');
  await fs.copyFile('tests/fixtures/sample.cbr', cbr);
  const db = openDb(':memory:');
  const sid = upsertSeries(db, { title: 'Saga (2012)', url: 'cv:46568' });
  upsertCvSeries(db, { id: 46568, name: 'Saga', publisher: 'Image', start_year: '2012', count_of_issues: 72 });
  upsertCvIssue(db, { id: 3003, cv_series_id: 46568, number: '3', name: 'Chapter Three' });
  upsertLibraryFile(db, { path: cbr, dir, name: path.basename(cbr), size: 1, mtime: 1, valid: 1, has_metadata: 0, series_id: sid });
  linkFileCvIssue(db, cbr, 3003);

  const client = { async issue(id) { return { id, name: 'Chapter Three', issue_number: '3', cover_date: '2012-05-16', store_date: null, description: 'd', credits: [], site_detail_url: null }; } };
  const r = await tagFileFromCv(db, client, cbr);
  assert.equal(r.outcome, 'tagged');
  // the .cbr is gone, a tagged .cbz exists, and the index row moved with it
  const cbz = cbr.replace(/\.cbr$/, '.cbz');
  assert.equal(await fs.access(cbr).then(() => true, () => false), false);
  assert.ok(await fs.access(cbz).then(() => true, () => false));
  assert.equal(getLibraryFile(db, cbr), undefined);
  const row = getLibraryFile(db, cbz);
  assert.equal(row.has_metadata, 1);
  assert.equal(row.cv_issue_id, 3003); // link preserved across the conversion
  const zip = await JSZip.loadAsync(await fs.readFile(cbz));
  assert.match(await zip.file('ComicInfo.xml').async('string'), /<Series>Saga<\/Series>/);
  await fs.rm(dir, { recursive: true, force: true });
});
