// Books and audiobooks on the download sources: the book matcher and queries
// (src/sources/books.js), the media grab bookkeeping, and the media download
// helpers that turn a finished download into something a plugin can file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scoreBookRelease, bookQueries, bookTarget, isBookContext, findBookRelease, bookTooSmall, bookCategory } from '../src/sources/books.js';
import { bookContext, sniffMediaExt, mediaFilesIn, fileMedia, emitMedia } from '../src/mediadownload.js';
import { openDb, recordGrab, activeGrabs, grabPayload, grabsByRef } from '../src/db.js';
import { pluginApi } from '../src/plugins.js';
import { usenet } from '../src/sources/usenet.js';

const KINGS = { type: 'ebook', title: 'The Way of Kings', author: 'Brandon Sanderson', year: '2010' };

test('scoreBookRelease: accepts the many ways a book release is named', () => {
  for (const t of [
    'Brandon Sanderson - The Way of Kings (2010) [EPUB]',
    'The Way of Kings by Brandon Sanderson (epub)',
    'Brandon.Sanderson.The.Way.of.Kings.2010.Retail.EPUB-GRP',
    'Sanderson, Brandon - Way of Kings (Stormlight Archive 1) [MOBI]',
  ]) assert.ok(scoreBookRelease(t, KINGS) > 100, t);
});

test('scoreBookRelease: rejects the wrong book, the wrong order and the wrong kind of file', () => {
  assert.equal(scoreBookRelease('Brandon Sanderson - Words of Radiance (2014) EPUB', KINGS), null, 'another book');
  assert.equal(scoreBookRelease('Kings of the Way - Brandon Sanderson EPUB', KINGS), null, 'words out of order');
  assert.equal(scoreBookRelease('Brandon Sanderson - The Way of Kings [M4B] Unabridged', KINGS), null, 'an audiobook for an ebook wanted');
  assert.equal(scoreBookRelease('Brandon Sanderson - The Way of Kings [EPUB]', { ...KINGS, type: 'audiobook' }), null, 'an ebook for an audiobook wanted');
  assert.equal(scoreBookRelease('', KINGS), null);
});

test('scoreBookRelease: a short title needs its author; a long one only prefers it', () => {
  const dune = { type: 'ebook', title: 'Dune', author: 'Frank Herbert', year: '1965' };
  assert.equal(scoreBookRelease('Dune (2021) 1080p BluRay x264', dune), null, 'a one-word title without the author is anyone\'s');
  assert.ok(scoreBookRelease('Frank Herbert - Dune (1965) EPUB', dune) > 100);
  assert.ok(scoreBookRelease('Herbert - Dune EPUB', dune) > 100, 'the surname is enough');
  const long = scoreBookRelease('The Way of Kings (2010) EPUB', KINGS);
  const withAuthor = scoreBookRelease('Brandon Sanderson - The Way of Kings (2010) EPUB', KINGS);
  assert.ok(long != null && withAuthor > long, 'the author-named release ranks first');
});

test('scoreBookRelease: ranks epub over other ebook formats, m4b over mp3, unabridged over abridged', () => {
  const epub = scoreBookRelease('Brandon Sanderson - The Way of Kings EPUB', KINGS);
  const mobi = scoreBookRelease('Brandon Sanderson - The Way of Kings MOBI', KINGS);
  assert.ok(epub > mobi);
  const audio = { ...KINGS, type: 'audiobook' };
  const m4b = scoreBookRelease('Brandon Sanderson - The Way of Kings [M4B] Unabridged', audio);
  const mp3 = scoreBookRelease('Brandon Sanderson - The Way of Kings [MP3] Unabridged', audio);
  const abridged = scoreBookRelease('Brandon Sanderson - The Way of Kings [M4B] Abridged', audio);
  assert.ok(m4b > mp3 && mp3 > abridged);
});

test('bookQueries, bookTarget, bookCategory and isBookContext', () => {
  const ctx = bookContext(null, KINGS);
  assert.ok(isBookContext(ctx));
  assert.ok(!isBookContext({ series: { type: 'comic' }, seriesTitle: 'Saga' }));
  assert.deepEqual(bookQueries(ctx), ['Brandon Sanderson The Way of Kings', 'The Way of Kings']);
  assert.deepEqual(bookQueries(bookContext(null, { type: 'ebook', title: 'Dune' })), ['Dune']);
  assert.deepEqual(bookTarget(ctx), { type: 'ebook', title: 'The Way of Kings', author: 'Brandon Sanderson', year: '2010' });
  assert.equal(bookCategory('ebook'), '7020');
  assert.equal(bookCategory('audiobook'), '3030');
  // The comic fields a source reads are there too, so an unpatched source
  // still gets a sane (if fruitless) search.
  assert.equal(ctx.seriesTitle, 'The Way of Kings');
  assert.deepEqual(ctx.seriesNames, ['The Way of Kings', 'Brandon Sanderson The Way of Kings']);
  assert.equal(ctx.issue.issue_number, '');
});

test('bookTooSmall: an ebook may be small, an audiobook may not', () => {
  assert.equal(bookTooSmall('ebook', 300 * 1024), false);
  assert.equal(bookTooSmall('ebook', 10 * 1024), true);
  assert.equal(bookTooSmall('audiobook', 300 * 1024), true);
  assert.equal(bookTooSmall('audiobook', 0), false, 'unknown size is not evidence');
});

test('findBookRelease: searches the book category first, falls back uncategorised, ranks and blocks', async () => {
  const ctx = bookContext(null, KINGS);
  const calls = [];
  const rows = [
    { title: 'Brandon Sanderson - The Way of Kings (2010) EPUB', nzbUrl: 'u1', size: 5e6, guid: 'g1' },
    { title: 'Brandon Sanderson - The Way of Kings (2010) MOBI', nzbUrl: 'u2', size: 5e6, guid: 'g2' },
    { title: 'Brandon Sanderson - Elantris EPUB', nzbUrl: 'u3', size: 5e6, guid: 'g3' },
    { title: 'Brandon Sanderson - The Way of Kings EPUB', nzbUrl: 'u4', size: 2000, guid: 'g4' },
  ];
  const search = async (q, cat) => { calls.push([q, cat]); return cat === '7020' ? rows : []; };
  const best = await findBookRelease(ctx, search, { urlOf: (r) => r.nzbUrl });
  assert.equal(best.nzbUrl, 'u1');
  assert.deepEqual(calls.map((c) => c[1]), ['7020', '7020'], 'category search found rows, so no uncategorised pass');
  // Blocked release → next best.
  const next = await findBookRelease(ctx, search, { urlOf: (r) => r.nzbUrl, isBlocked: (r) => r.guid === 'g1' });
  assert.equal(next.nzbUrl, 'u2');
  // Nothing in the category → uncategorised pass.
  calls.length = 0;
  const loose = await findBookRelease(ctx, async (_q, cat) => { calls.push(cat); return cat === '' ? rows : []; }, { urlOf: (r) => r.nzbUrl });
  assert.equal(loose.nzbUrl, 'u1');
  assert.deepEqual(calls, ['7020', '7020', '', '']);
});

test('usenet.find with a book context takes the book branch (no indexers → null, no comic parsing)', async () => {
  const ctx = bookContext(null, { ...KINGS, config: {} });
  assert.equal(await usenet.find({ ...ctx, config: {} }), null);
});

test('recordGrab: a media grab keeps its payload and ref; grabsByRef finds it', () => {
  const db = openDb(':memory:');
  const id = recordGrab(db, { issueId: 0, kind: 'media', source: 'usenet', client: 'sabnzbd', downloadId: 'SAB_9', title: 'Way of Kings EPUB', ref: 'requests:12', payload: { type: 'ebook', libraryId: 3, hint: { title: 'The Way of Kings' } } });
  const g = activeGrabs(db).find((x) => x.id === id);
  assert.equal(g.kind, 'media');
  assert.equal(g.ref, 'requests:12');
  assert.deepEqual(grabPayload(g), { type: 'ebook', libraryId: 3, hint: { title: 'The Way of Kings' } });
  assert.deepEqual(grabPayload({ payload: 'not json' }), {});
  assert.equal(grabsByRef(db, 'requests:12')[0].id, id);
  assert.deepEqual(grabsByRef(db, 'requests:13'), []);
});

test('sniffMediaExt: epub, pdf, m4b/m4a, mp3, else the url extension', () => {
  const epub = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(26), Buffer.from('mimetypeapplication/epub+zip')]);
  assert.equal(sniffMediaExt(epub), '.epub');
  assert.equal(sniffMediaExt(Buffer.from('%PDF-1.4 ...')), '.pdf');
  const m4b = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypM4B ')]);
  assert.equal(sniffMediaExt(m4b), '.m4b');
  const m4a = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypM4A ')]);
  assert.equal(sniffMediaExt(m4a), '.m4a');
  assert.equal(sniffMediaExt(Buffer.from('ID3\x03\x00\x00')), '.mp3');
  assert.equal(sniffMediaExt(Buffer.from('PK\x03\x04junk'), 'https://x/y/book.epub?dl=1'), '.epub', 'a plain zip named .epub');
  assert.equal(sniffMediaExt(Buffer.from('hello'), 'https://x/file'), '');
});

test('mediaFilesIn + fileMedia: the handler gets the right files and the listeners hear the outcome', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-'));
  try {
    fs.mkdirSync(path.join(dir, 'rel', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'rel', 'book.pdf'), Buffer.alloc(300));
    fs.writeFileSync(path.join(dir, 'rel', 'sub', 'book.epub'), Buffer.alloc(100));
    fs.writeFileSync(path.join(dir, 'rel', 'readme.nfo'), 'x');
    const files = await mediaFilesIn(path.join(dir, 'rel'), ['.epub', '.pdf']);
    assert.deepEqual(files.map((f) => path.basename(f)), ['book.epub', 'book.pdf'], 'handler format order beats size');
    assert.deepEqual(await mediaFilesIn(path.join(dir, 'rel', 'sub', 'book.epub'), ['.epub']), [path.join(dir, 'rel', 'sub', 'book.epub')]);
    // A mangled name still finds the job folder it stands for — and only that.
    assert.equal((await mediaFilesIn(path.join(dir, 'rël'), ['.epub', '.pdf'])).length, 2);
    assert.deepEqual(await mediaFilesIn(path.join(dir, 'nothing-here'), ['.epub', '.pdf']), []);

    const seen = [];
    const events = [];
    pluginApi.registerMediaHandler({ type: 'ebook', exts: ['.epub', '.pdf'], file: async ({ files: f, libraryId, hint }) => { seen.push({ f: f.map((x) => path.basename(x)), libraryId, hint }); return { issueId: 77, seriesId: 8 }; } });
    pluginApi.onMediaDownload((e) => events.push(e));
    const db = openDb(':memory:');
    const r = await fileMedia(db, { type: 'ebook', libraryId: 3, path: path.join(dir, 'rel'), hint: { title: 'Dune' }, source: 'usenet', ref: 'requests:1' });
    assert.deepEqual(r, { ok: true, issueId: 77, seriesId: 8 });
    assert.deepEqual(seen, [{ f: ['book.epub', 'book.pdf'], libraryId: 3, hint: { title: 'Dune' } }]);
    assert.equal(events.at(-1).event, 'imported');
    assert.equal(events.at(-1).ref, 'requests:1');
    assert.equal(events.at(-1).issueId, 77);

    const bad = await fileMedia(db, { type: 'ebook', libraryId: 3, path: path.join(dir, 'nothing-here'), source: 'usenet', ref: 'requests:2' });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /nothing usable/);
    assert.equal(events.at(-1).event, 'failed');
    const none = await fileMedia(db, { type: 'audiobook', libraryId: 3, path: path.join(dir, 'rel'), ref: 'requests:3' });
    assert.match(none.error, /no plugin files audiobook/);
    // A listener that throws does not break the others.
    pluginApi.onMediaDownload(() => { throw new Error('boom'); });
    emitMedia({ event: 'failed', ref: 'x' });
    assert.equal(events.at(-1).ref, 'x');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
