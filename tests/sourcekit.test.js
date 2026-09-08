// The site-source toolkit: HTTP guard + pacing, byte sniffing, page assembly,
// and defineSource end to end against a local fake site (network-free).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import JSZip from 'jszip';
import { assertPublicUrl, pace, resetPacing, fetchHtml, fetchJson, downloadToBuffer } from '../src/sourcekit/http.js';
import { sniffBuffer, normalizeArchive, describeBody } from '../src/sourcekit/bytes.js';
import { fetchPages, pagesToArchive } from '../src/sourcekit/pages.js';
import { defineSource, scoreCandidate, pickBest, siteQueries } from '../src/sourcekit/define.js';
import { testKit } from '../src/sourcekit/testing.js';
import { pluginApi, registeredSourceCards, registeredSettings } from '../src/plugins.js';
import { orderedSources } from '../src/sources/index.js';

process.env.BACKISSUE_ALLOW_INTERNAL_FETCH = '1';

// A 1x1 JPEG and PNG, enough for the sniffer.
const JPG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

async function fakeSite() {
  const zip = new JSZip(); zip.file('001.jpg', JPG);
  const cbz = await zip.generateAsync({ type: 'nodebuffer' });
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/search') {
      const q = u.searchParams.get('q') || '';
      const rows = q.toLowerCase().startsWith('saga')
        ? '<article><a class="t" href="/post/saga-12">Saga #12 (2013)</a><span class="s">40 MB</span></article>'
          + '<article><a class="t" href="/post/saga-1-6">Saga Vol. 1 (#1-6)</a></article>'
        : '';
      res.setHeader('content-type', 'text/html'); return res.end(`<html><body>${rows}</body></html>`);
    }
    if (u.pathname === '/post/saga-12') { res.setHeader('content-type', 'text/html'); return res.end('<html><a class="dl" href="/dl/saga-12">Download</a></html>'); }
    if (u.pathname === '/dl/saga-12') { res.statusCode = 302; res.setHeader('location', '/file/saga-12.cbz'); return res.end(); }
    if (u.pathname === '/file/saga-12.cbz') { res.setHeader('content-disposition', 'attachment; filename="Saga 012.cbz"'); return res.end(cbz); }
    if (u.pathname === '/chapter/7') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ pages: ['/img/1.jpg', '/img/2.png'] })); }
    if (u.pathname === '/img/1.jpg') return res.end(JPG);
    if (u.pathname === '/img/2.png') return res.end(PNG);
    if (u.pathname === '/img/blocked.jpg') { res.setHeader('content-type', 'text/html'); return res.end('<html><title>Hotlink blocked</title></html>'); }
    if (u.pathname === '/cf') { res.statusCode = 503; return res.end('<html><title>Just a moment...</title></html>'); }
    res.statusCode = 404; res.end('nope');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, hits, close: () => new Promise((r) => server.close(r)) };
}

test('assertPublicUrl refuses internal addresses and non-http schemes', () => {
  const prev = process.env.BACKISSUE_ALLOW_INTERNAL_FETCH;
  delete process.env.BACKISSUE_ALLOW_INTERNAL_FETCH;
  try {
    for (const u of ['http://127.0.0.1/x', 'http://localhost/x', 'http://10.1.2.3/', 'http://192.168.1.5/', 'http://172.16.0.1/', 'http://169.254.169.254/latest', 'http://[::1]/'])
      assert.throws(() => assertPublicUrl(u), /internal/, u);
    assert.throws(() => assertPublicUrl('ftp://example.com/a'), /non-http/);
    assert.throws(() => assertPublicUrl('not a url'), /invalid/);
    assert.ok(assertPublicUrl('https://example.com/comic.cbz'));
  } finally { process.env.BACKISSUE_ALLOW_INTERNAL_FETCH = prev; }
});

test('pace spaces requests to one host and leaves other hosts alone', async () => {
  resetPacing();
  const t0 = Date.now();
  await pace('a.example', 120);
  await pace('a.example');
  await pace('a.example');
  const a = Date.now() - t0;
  assert.ok(a >= 220, `three paced calls took ${a}ms`);
  const t1 = Date.now();
  await pace('b.example', 500);
  assert.ok(Date.now() - t1 < 100, 'the first call to a host is immediate');
  resetPacing();
});

test('sniffBuffer, describeBody and normalizeArchive', async () => {
  assert.equal(sniffBuffer(JPG), 'jpg');
  assert.equal(sniffBuffer(PNG), 'png');
  assert.equal(sniffBuffer(Buffer.from('%PDF-1.4 ...')), 'pdf');
  assert.equal(sniffBuffer(Buffer.from('Rar!\x1a\x07')), 'cbr');
  assert.equal(sniffBuffer(Buffer.from('hello')), null);
  const zip = new JSZip(); zip.file('a.jpg', JPG);
  const cbz = await zip.generateAsync({ type: 'nodebuffer' });
  assert.equal(sniffBuffer(cbz), 'cbz');
  assert.deepEqual(await normalizeArchive(cbz), { buffer: cbz, format: 'cbz' });
  const page = Buffer.from('<!doctype html><html><head><title>Just a moment...</title></head></html>');
  assert.deepEqual(describeBody(page), { html: true, title: 'Just a moment...', cloudHost: null });
  await assert.rejects(normalizeArchive(page, { label: 'Host' }), /Host sent a web page instead of the file \("Just a moment\.\.\."\)/);
  const mega = Buffer.from('<html><body>Please open this in mega.nz</body></html>');
  await assert.rejects(normalizeArchive(mega), (e) => /MEGA/.test(e.message) && e.noRetry === true);
  await assert.rejects(normalizeArchive(Buffer.from('tiny')), /suspiciously small/);
});

test('fetchHtml/fetchJson/downloadToBuffer against a local site; a challenge is named', async () => {
  const site = await fakeSite();
  try {
    resetPacing();
    const html = await fetchHtml(`${site.base}/search?q=saga`, { rateMs: 0 });
    assert.match(html, /Saga #12/);
    const j = await fetchJson(`${site.base}/chapter/7`, { rateMs: 0 });
    assert.deepEqual(j.pages, ['/img/1.jpg', '/img/2.png']);
    const d = await downloadToBuffer(`${site.base}/dl/saga-12`, { rateMs: 0 });
    assert.equal(d.filename, 'Saga 012.cbz');
    assert.equal(sniffBuffer(d.buffer), 'cbz');
    await assert.rejects(fetchHtml(`${site.base}/cf`, { rateMs: 0, settingsHint: 'Settings → Sources → X' }), (e) => e.challenged === true && /FlareSolverr URL in Settings → Sources → X/.test(e.message));
  } finally { await site.close(); }
});

test('fetchPages downloads in order, names pages for sorting, and names a hotlink block', async () => {
  const site = await fakeSite();
  try {
    resetPacing();
    const seen = [];
    const pages = await fetchPages({ pages: [`${site.base}/img/1.jpg`, { url: `${site.base}/img/2.png` }], concurrency: 2, rateMs: 0, onPage: (p) => seen.push(p.done) });
    assert.deepEqual(pages.map((p) => p.name), ['001.jpg', '002.png']);
    assert.deepEqual(seen.sort(), [1, 2]);
    const out = await pagesToArchive(pages);
    assert.equal(out.format, 'cbz');
    const names = Object.keys((await JSZip.loadAsync(out.buffer)).files);
    assert.deepEqual(names, ['001.jpg', '002.png']);
    await assert.rejects(fetchPages({ pages: [`${site.base}/img/blocked.jpg`], rateMs: 0, label: 'Site' }),
      (e) => /page 1: Site sent a web page instead of page 1 \("Hotlink blocked"\)/.test(e.message) && e.noRetry === true);
    await assert.rejects(fetchPages({ pages: [] }), /no pages/);
  } finally { await site.close(); }
});

test('siteQueries, scoreCandidate and pickBest', () => {
  const ctx = { seriesTitle: 'Poison Ivy', seriesNames: ['Poison Ivy'], issue: { issue_number: '046' } };
  assert.deepEqual(siteQueries('Poison Ivy', ctx), ['Poison Ivy 46']);
  assert.deepEqual(siteQueries('One-Shot', { ...ctx, issue: { issue_number: null } }), ['One-Shot']);
  const target = { series: 'Saga', names: ['Saga'], number: '12', year: '2013' };
  assert.equal(scoreCandidate({ title: 'Saga #12 (2013)' }, target), 120);
  assert.equal(scoreCandidate({ title: 'Saga #12 (2013)', size: 10 }, target), null, 'tiny → fake');
  assert.equal(scoreCandidate({ series: 'Saga', number: '12', year: 2013 }, target), 120, 'structured result');
  assert.equal(scoreCandidate({ series: 'Saga', number: '13' }, target), null);
  assert.equal(scoreCandidate({ title: 'Paper Girls #12' }, target), null);
  const best = pickBest([{ title: 'Saga Vol. 1 (#1-6)' }, { title: 'Saga #12 (2013)' }, { title: 'Saga #12' }], target);
  assert.equal(best.r.title, 'Saga #12 (2013)');
});

// A complete archive-kind definition, exercised through the registered source
// against the fake site: find → fetch → a CBZ, manualSearch, test, the card.
const archiveDef = (base) => ({
  id: 'fakesite', label: 'Fake Site', description: 'Direct downloads from a test site. Nothing real.',
  baseUrl: base, rateMs: 0, cloudflare: true,
  settings: { fakesiteMirror: { type: 'string', label: 'Mirror', placeholder: 'main', note: 'Which mirror.' } },
  async search(query, ctx, kit) {
    const $ = kit.load(await kit.http.html(`${kit.siteUrl}/search?q=${encodeURIComponent(query)}`));
    return $('article').map((_, el) => ({ title: $(el).find('a.t').text(), url: kit.url($(el).find('a.t').attr('href')), size: /(\d+) MB/.test($(el).find('.s').text()) ? Number(RegExp.$1) * 1048576 : 0 })).get();
  },
  async resolve(candidate, ctx, kit) {
    const $ = kit.load(await kit.http.html(candidate.url));
    return { url: kit.url($('a.dl').attr('href')), referer: candidate.url };
  },
});

test('defineSource (archive kind): find, fetch, manualSearch, test, card and settings', async () => {
  const site = await fakeSite();
  try {
    resetPacing();
    const src = defineSource(archiveDef(site.base));
    assert.equal(src.kind, 'immediate');
    assert.equal(src.isEnabled({}), false);
    assert.equal(src.isEnabled({ fakesiteEnabled: true }), true);
    assert.deepEqual(Object.keys(src.settingsFields), ['fakesiteEnabled', 'fakesiteUrl', 'fakesiteFlaresolverrUrl', 'fakesiteMirror']);
    // The card never asks for FlareSolverr: one shared setting serves them all.
    assert.deepEqual(src.card.fields.map((f) => f.key), ['fakesiteUrl', 'fakesiteMirror']);
    assert.equal(src.card.cloudflare, true);
    assert.equal(src.card.testable, true);

    const ctx = { config: { fakesiteEnabled: true }, series: { type: 'comic' }, seriesTitle: 'Saga', seriesNames: ['Saga'], seriesYear: 2013, issue: { issue_number: '12', title: 'Saga #12' } };
    const found = await src.find(ctx);
    assert.equal(found.source, 'fakesite');
    assert.equal(found.title, 'Saga #12 (2013)');
    assert.equal(await src.find({ ...ctx, series: { type: 'audiobook' } }), null, 'only comic-like series');
    assert.equal(await src.find({ ...ctx, seriesTitle: 'Nothing', seriesNames: ['Nothing'] }), null);

    const phases = [];
    const fetched = await src.fetch(found, ctx, (p) => phases.push(p.phase));
    assert.equal(fetched.format, 'cbz');
    assert.equal(sniffBuffer(fetched.buffer), 'cbz');
    assert.ok(phases.includes('connecting') && phases.includes('download'));

    const m = await src.manualSearch({ ...ctx, query: '' });
    assert.deepEqual(m.searched, ['Saga 12']);
    assert.equal(m.results[0].source, 'fakesite');
    assert.equal(m.results[0].score, 120);
    assert.equal(m.results[1].score, null, 'a pack scores null but is still listed');

    const t = await src.test({ fakesiteUrl: site.base });
    assert.equal(t.ok, false, 'the default probe searches "batman", which this site has no rows for');
    assert.match(t.message, /parsed no results/);
    const t2 = await defineSource({ ...archiveDef(site.base), testQuery: 'saga' }).test({});
    assert.equal(t2.ok, true);
  } finally { await site.close(); }
});

test('defineSource (pages kind) with a custom find builds a CBZ from page images', async () => {
  const site = await fakeSite();
  try {
    resetPacing();
    const src = defineSource({
      id: 'fakemanga', label: 'Fake Manga', kind: 'pages', types: ['manga'], baseUrl: site.base, rateMs: 0,
      async find(ctx, kit) { return ctx.issue.issue_number === '7' ? { chapterId: 7, title: 'Ch. 7', url: `${kit.siteUrl}/chapter/7` } : null; },
      async resolve(c, ctx, kit) { const j = await kit.http.json(c.url); return { pages: j.pages.map(kit.url), referer: c.url }; },
    });
    const ctx = { config: {}, series: { type: 'manga' }, seriesTitle: 'X', seriesNames: ['X'], issue: { issue_number: '7', title: 'X Ch. 7' } };
    assert.equal(await src.find({ ...ctx, series: { type: 'comic' } }), null, 'declared manga-only');
    const found = await src.find(ctx);
    assert.equal(found.chapterId, 7);
    const out = await src.fetch(found, ctx);
    assert.equal(out.format, 'cbz');
    assert.deepEqual(Object.keys((await JSZip.loadAsync(out.buffer)).files), ['001.jpg', '002.png']);
    assert.equal(src.card.testable, false, 'no search() and no test() → nothing to probe');
  } finally { await site.close(); }
});

test('api.defineSource registers the source, its settings fields and its card', () => {
  const src = pluginApi.defineSource({ id: 'kitreg', label: 'Kit Reg', description: 'Registered through the api.', baseUrl: 'https://example.com', search: async () => [] });
  assert.ok(orderedSources({ kitregEnabled: true }).some((s) => s.id === 'kitreg'));
  assert.equal(registeredSettings().kitregEnabled.type, 'bool');
  assert.equal(registeredSettings().kitregUrl.allowEmpty, true);
  const card = registeredSourceCards().find((c) => c.id === 'kitreg');
  assert.equal(card.label, 'Kit Reg');
  assert.deepEqual(card.fields.map((f) => f.key), ['kitregUrl']);
  pluginApi.defineSource({ id: 'kitreg', search: async () => [] }); // idempotent
  assert.equal(registeredSourceCards().filter((c) => c.id === 'kitreg').length, 1);
  assert.equal(src.id, 'kitreg');
});

test('testKit serves fixtures to a definition offline', async () => {
  const def = archiveDef('https://fake.example');
  const kit = testKit(def, {
    're:/search\\?q=saga': '<article><a class="t" href="/post/saga-12">Saga #12 (2013)</a><span class="s">40 MB</span></article>',
    '/post/saga-12': '<a class="dl" href="/dl/saga-12">Download</a>',
  });
  const rows = await def.search('saga 12', {}, kit);
  assert.equal(rows[0].url, 'https://fake.example/post/saga-12');
  assert.equal(rows[0].size, 40 * 1048576);
  const r = await def.resolve(rows[0], {}, kit);
  assert.equal(r.url, 'https://fake.example/dl/saga-12');
  assert.equal(kit.calls.length, 2);
  await assert.rejects(kit.http.html('https://fake.example/missing'), /no fixture/);
});

// ---- the declarative path: a site described with selectors, no functions ----

test('parseSize, parseYear, fillTemplate and the selector syntax', async () => {
  const { pick, pickAll, parseSize, parseYear, fillTemplate } = await import('../src/sourcekit/declarative.js');
  const { load } = await import('cheerio');
  assert.equal(parseSize('Year: 2013 - 38 MB'), 38 * 1048576);
  assert.equal(parseSize('1.4GB'), Math.round(1.4 * 1024 ** 3));
  assert.equal(parseSize('no size here'), 0);
  assert.equal(parseYear('Saga #12 (2013)'), '2013');
  assert.equal(parseYear('nothing'), null);
  assert.equal(fillTemplate('/?s={query}&p={page}', { query: 'a b', page: 2 }), '/?s=a%20b&p=2');
  assert.equal(fillTemplate('/search/{query:raw}', { query: 'a/b' }), '/search/a/b');

  const $ = load('<article><h2><a href="/post/1">Saga #12 (2013)</a></h2><span class="m">Year 2013 - 38 MB</span></article>');
  const row = $('article').get()[0];
  assert.equal(pick($, row, 'h2 a'), 'Saga #12 (2013)');
  assert.equal(pick($, row, 'h2 a@href', 'https://s.example/x/'), 'https://s.example/post/1');
  assert.equal(pick($, row, '.m|([0-9.]+ *MB)'), '38 MB');
  assert.equal(pick($, row, '.missing'), null);
  assert.deepEqual(pickAll($, 'h2 a@href', 'https://s.example/'), ['https://s.example/post/1']);
});

test('a selector-only definition searches and resolves with no code', async () => {
  const site = await fakeSite();
  try {
    resetPacing();
    const src = defineSource({
      id: 'seltest', label: 'Selector Site', baseUrl: site.base, rateMs: 0,
      searchPath: '/search?q={query}',
      select: { row: 'article', title: 'a.t', url: 'a.t@href', size: '.s', link: 'a.dl@href' },
    });
    const ctx = { config: {}, series: { type: 'comic' }, seriesTitle: 'Saga', seriesNames: ['Saga'], seriesYear: 2013, issue: { issue_number: '12' } };
    const found = await src.find(ctx);
    assert.equal(found.title, 'Saga #12 (2013)');
    assert.equal(found.size, 40 * 1048576);
    assert.equal(found.year, '2013', 'the year falls back to the title when no selector names it');
    const out = await src.fetch(found, ctx);
    assert.equal(out.format, 'cbz');
    assert.equal(sniffBuffer(out.buffer), 'cbz');
  } finally { await site.close(); }
});

test('a selector-only pages definition builds the chapter from <img> tags', async () => {
  const site = await fakeSite();
  try {
    resetPacing();
    const src = defineSource({
      id: 'selmanga', label: 'Selector Manga', kind: 'pages', types: ['manga'], baseUrl: site.base, rateMs: 0,
      searchPath: '/search?q={query}',
      select: { row: 'article', title: 'a.t', url: 'a.t@href', pages: '#reader img@src' },
    });
    const kit = testKit(src.definition, { '/reader/1': `<div id="reader"><img src="${site.base}/img/1.jpg"><img src="${site.base}/img/2.png"></div>` });
    const r = await src.definition.resolve({ url: 'https://x.example/reader/1' }, {}, kit);
    assert.deepEqual(r.pages, [`${site.base}/img/1.jpg`, `${site.base}/img/2.png`]);
    const empty = testKit(src.definition, { '/reader/2': '<div id="reader"></div>' });
    await assert.rejects(src.definition.resolve({ url: 'https://x.example/reader/2' }, {}, empty), (e) => /no page images/.test(e.message) && e.noRetry === true);
  } finally { await site.close(); }
});

test('one plugin can define several sites, each with its own card and settings', () => {
  for (const id of ['siteone', 'sitetwo']) {
    pluginApi.defineSource({ id, label: id, baseUrl: `https://${id}.example`, searchPath: '/?s={query}', select: { row: 'article', title: 'a', url: 'a@href', link: 'a.dl@href' } });
  }
  const ids = orderedSources({ siteoneEnabled: true, sitetwoEnabled: true }).map((s) => s.id);
  assert.ok(ids.includes('siteone') && ids.includes('sitetwo'));
  const cards = registeredSourceCards().map((c) => c.id);
  assert.ok(cards.includes('siteone') && cards.includes('sitetwo'));
  assert.equal(registeredSettings().siteoneEnabled.type, 'bool');
  assert.equal(registeredSettings().sitetwoUrl.allowEmpty, true);
});

test('defineSource rejects a definition with no way to search', () => {
  assert.throws(() => defineSource({ id: 'nope' }), /needs search\(\), find\(\), or a select\.row selector/);
  assert.throws(() => defineSource({ search: async () => [] }), /needs an id/);
});

// ---- the browser is the last resort, and must be declared ------------------

test('a source that requires a browser stays off, and says why, where there is none', async () => {
  const { setBrowserAvailable } = await import('../src/sourcekit/browser.js');
  const def = { id: 'browsersite', label: 'Browser Site', browser: 'required', baseUrl: 'https://b.example', search: async () => [] };
  try {
    setBrowserAvailable(false);
    let src = defineSource(def);
    assert.equal(src.isEnabled({ browsersiteEnabled: true }), false, 'never enabled without a browser');
    assert.match(src.card.unavailable, /needs the browser build/);
    assert.ok(!orderedSources({ browsersiteEnabled: true }).some((s) => s.id === 'browsersite'), 'the queue never tries it');

    setBrowserAvailable(true);
    src = defineSource(def);
    assert.equal(src.isEnabled({ browsersiteEnabled: true }), true);
    assert.equal(src.card.unavailable, null);
  } finally { setBrowserAvailable(null); }
});

test('a fallback source runs on the lean image: HTTP first, browser never touched', async () => {
  const { setBrowserAvailable } = await import('../src/sourcekit/browser.js');
  const site = await fakeSite();
  try {
    setBrowserAvailable(false);
    resetPacing();
    const src = defineSource({
      id: 'fallbacksite', label: 'Fallback Site', browser: 'fallback', cloudflare: true, baseUrl: site.base, rateMs: 0,
      searchPath: '/search?q={query}',
      select: { row: 'article', title: 'a.t', url: 'a.t@href', link: 'a.dl@href' },
    });
    assert.equal(src.browser, 'fallback');
    assert.equal(src.isEnabled({ fallbacksiteEnabled: true }), true, 'a fallback source is fine with no browser');
    assert.equal(src.card.unavailable, null);
    const ctx = { config: {}, series: { type: 'comic' }, seriesTitle: 'Saga', seriesNames: ['Saga'], seriesYear: 2013, issue: { issue_number: '12' } };
    const found = await src.find(ctx);
    assert.equal(found.title, 'Saga #12 (2013)', 'plain HTTP served it');

    // With no browser installed, a challenged site reports the challenge
    // rather than pretending a browser could have saved it.
    const gated = defineSource({
      id: 'gatedsite', label: 'Gated Site', browser: 'fallback', cloudflare: true, baseUrl: site.base, rateMs: 0,
      searchPath: '/cf', select: { row: 'article', title: 'a', url: 'a@href', link: 'a@href' },
    });
    await assert.rejects(gated.find(ctx), /Cloudflare challenge/);
  } finally { setBrowserAvailable(null); await site.close(); }
});

test('searchNames: a few names to search, while matching still accepts them all', async () => {
  const { searchNames } = await import('../src/sourcekit/define.js');
  const ctx = {
    seriesTitle: 'One Piece',
    seriesNames: ['One Piece', 'one-piece', 'ONE PIECE', 'Wan Pisu', 'ワンピース', 'Ван Піс', 'وان پیس', '海贼王', 'Đảo Hải Tặc', '원피스', 'Budak Getah'],
  };
  const names = searchNames(ctx);
  assert.equal(names.length, 4, 'capped, not one request per alias');
  assert.equal(names[0], 'One Piece', 'the volume title leads');
  assert.ok(!names.includes('one-piece') && !names.includes('ONE PIECE'), 'punctuation/case variants return the same results');
  assert.deepEqual(names, ['One Piece', 'Wan Pisu', 'Đảo Hải Tặc', 'Budak Getah'], 'scripts the site cannot index are dropped');
  assert.equal(searchNames(ctx, { max: 2 }).length, 2);
  assert.ok(searchNames(ctx, { script: 'any' }).includes('ワンピース'), 'a site indexed in its own language can ask for every script');
  // The title is kept even when it is not Latin, so a Japanese volume is searchable.
  assert.deepEqual(searchNames({ seriesTitle: 'ワンピース', seriesNames: ['ワンピース', '海贼王'] })[0], 'ワンピース');
  assert.deepEqual(searchNames({ seriesTitle: 'Solo Leveling' }), ['Solo Leveling']);
});

test('a definition can widen or narrow how many names are searched', async () => {
  const site = await fakeSite();
  try {
    resetPacing();
    const seen = [];
    const def = {
      id: 'namecap', label: 'Name Cap', baseUrl: site.base, rateMs: 0, maxSearchNames: 2,
      async search(q, ctx, kit) { seen.push(q); return []; },
    };
    const src = defineSource(def);
    await src.find({ config: {}, series: { type: 'comic' }, seriesTitle: 'Alpha', seriesNames: ['Alpha', 'Beta', 'Gamma', 'Delta'], issue: { issue_number: '1' } });
    // Two names, each as "<name> <number>", then the bare-name retry when the
    // numbered form found nothing. Gamma and Delta are never searched.
    assert.deepEqual(seen, ['Alpha 1', 'Beta 1', 'Alpha', 'Beta']);
  } finally { await site.close(); }
});

test('one shared FlareSolverr serves every source, with a per-source override', async () => {
  const { makeKit } = await import('../src/sourcekit/define.js');
  const def = { id: 'cfsite', label: 'CF Site', cloudflare: true, baseUrl: 'https://cf.example', search: async () => [] };
  const shared = 'http://flaresolverr.lan:8191/v1';
  assert.equal(makeKit(def, { config: {} }).flareUrl, '', 'nothing configured');
  assert.equal(makeKit(def, { config: { flaresolverrUrl: shared } }).flareUrl, shared, 'the shared setting reaches every source');
  assert.equal(makeKit(def, { config: { flaresolverrUrl: shared, cfsiteFlaresolverrUrl: 'http://other:8191' } }).flareUrl, 'http://other:8191', 'a per-source value still wins');
  // A source that never meets Cloudflare does not get one, shared or not.
  assert.equal(makeKit({ ...def, cloudflare: false }, { config: { flaresolverrUrl: shared } }).flareUrl, '');
});

test('an existing per-source FlareSolverr is carried into the shared setting', async () => {
  const { SETTING_FIELDS } = await import('../src/settings.js');
  assert.equal(SETTING_FIELDS.flaresolverrUrl.type, 'string', 'it is a core setting now');
  assert.equal(SETTING_FIELDS.flaresolverrUrl.allowEmpty, true);
});
