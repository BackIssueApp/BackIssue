import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeMetronClient, mintId, unmintId, isMintedId, MINTED_BASE, splitListName,
  shapeSeriesRow, shapeSeries, shapeIssue, shapeIssueRow, issueSidecar, nameOf,
} from '../src/metron.js';

// A fetch stub answering by URL substring, recording each call.
function stubFetch(routes) {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, auth: opts?.headers?.Authorization || '' });
    for (const [needle, body] of routes) {
      if (!url.includes(needle)) continue;
      const r = typeof body === 'function' ? body(url) : body;
      return { ok: (r.status || 200) < 400, status: r.status || 200, headers: { get: (k) => r.headers?.[k] ?? null }, json: async () => r.json };
    }
    return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}) };
  };
  impl.calls = calls;
  return impl;
}
const cfg = { metronUser: 'reader', metronPass: 'hunter2' };
const client = (routes) => makeMetronClient(cfg, { fetchImpl: stubFetch(routes), politeMs: 0 });

test('metron ids are minted into a range no ComicVine id reaches', () => {
  assert.equal(mintId(42), MINTED_BASE + 42);
  assert.equal(unmintId(mintId(42)), 42);
  assert.ok(isMintedId(mintId(1)));
  assert.ok(!isMintedId(1_200_000)); // a current ComicVine issue id
  assert.ok(!isMintedId(4050)); // a ComicVine volume id
});

test('splitListName parses the "Title (Year)" display name', () => {
  assert.deepEqual(splitListName('Batman (2016)'), { name: 'Batman', year: '2016' });
  assert.deepEqual(splitListName('Saga'), { name: 'Saga', year: null });
  assert.deepEqual(splitListName('Nothing (2024) Special (1999)'), { name: 'Nothing (2024) Special', year: '1999' });
});

test('nameOf accepts the object and string forms Metron mixes', () => {
  assert.equal(nameOf({ id: 1, name: 'Ongoing' }), 'Ongoing');
  assert.equal(nameOf('Ongoing'), 'Ongoing');
  assert.equal(nameOf(null), null);
  assert.equal(nameOf(''), null);
});

test('shapeSeriesRow is a sparse candidate the ranker can score', () => {
  const v = shapeSeriesRow({ id: 7, series: 'Saga (2012)', year_began: 2012, issue_count: 66, modified: 'x' });
  assert.equal(v.id, mintId(7));
  assert.equal(v.name, 'Saga');
  assert.equal(v.start_year, '2012');
  assert.equal(v.count_of_issues, 66);
  assert.equal(v.publisher, null);
  assert.equal(v.image_url, null);
  assert.equal(shapeSeriesRow({ series: 'x' }), null);
});

test('shapeSeries carries the enrichment sidecar and minted issue stubs', () => {
  const d = {
    id: 7, name: 'Saga', sort_name: 'Saga', volume: 1, series_type: { id: 2, name: 'Ongoing Series' }, status: 'Ongoing',
    publisher: { id: 3, name: 'Image Comics' }, imprint: null, year_began: 2012, year_end: null, desc: 'Space opera.',
    issue_count: 2, genres: [{ id: 1, name: 'Science Fiction' }], associated: [], cv_id: 50000, gcd_id: 123, resource_url: 'https://metron.cloud/series/7/',
  };
  const stubs = [{ id: 100, issue: 'Saga (2012) #1', number: '1', cover_date: '2012-03-01', image: 'https://img/1.jpg' }, { id: 101, number: '2', cover_date: '2012-04-01', image: 'https://img/2.jpg' }];
  const v = shapeSeries(d, stubs);
  assert.equal(v.id, mintId(7));
  assert.equal(v.publisher, 'Image Comics');
  assert.equal(v.start_year, '2012');
  assert.equal(v.image_url, 'https://img/1.jpg');
  assert.equal(v.description, 'Space opera.');
  assert.deepEqual(v.issues, [{ id: mintId(100), number: '1', name: null }, { id: mintId(101), number: '2', name: null }]);
  assert.equal(v.metron.series_type, 'Ongoing Series');
  assert.equal(v.metron.status, 'Ongoing');
  assert.deepEqual(v.metron.genres, ['Science Fiction']);
  assert.equal(v.metron.cv_id, 50000);
  assert.equal(v.metron.gcd_id, 123);
});

test('shapeIssue maps credits, story titles, variants and the sidecar', () => {
  const d = {
    id: 100, publisher: { id: 3, name: 'Image Comics' }, imprint: null, series: { id: 7, name: 'Saga', volume: 1, year_began: 2012 },
    number: '1', alt_number: '', title: '', name: ['Chapter One'], cover_date: '2012-03-01', store_date: '2012-03-14', foc_date: '2012-02-20',
    price: '2.99', rating: { id: 4, name: 'Mature' }, sku: 'JAN120001', isbn: '', upc: '70985301234500111', page: 44, desc: 'Hazel is born.',
    image: 'https://img/1.jpg', cover_hash: 'abc', arcs: [{ id: 9, name: 'Volume One' }],
    credits: [{ id: 1, creator: 'Brian K. Vaughan', role: [{ id: 1, name: 'Writer' }] }, { id: 2, creator: 'Fiona Staples', role: [{ id: 2, name: 'Artist' }, { id: 3, name: 'Cover' }] }],
    characters: [{ id: 11, name: 'Hazel' }], teams: [], universes: [], reprints: [], variants: [{ image: 'https://img/1b.jpg', name: 'Second printing', sku: '', upc: '' }],
    cv_id: 300000, gcd_id: null, resource_url: 'https://metron.cloud/issue/100/', modified: '2024-01-01T00:00:00Z',
  };
  const i = shapeIssue(d);
  assert.equal(i.id, mintId(100));
  assert.equal(i.name, 'Chapter One'); // story title stands in for a missing collection title
  assert.deepEqual(i.volume, { id: mintId(7), name: 'Saga' });
  assert.deepEqual(i.credits, [{ name: 'Brian K. Vaughan', role: 'Writer' }, { name: 'Fiona Staples', role: 'Artist, Cover' }]);
  assert.deepEqual(i.character_credits, [{ id: 11, name: 'Hazel' }]);
  assert.equal(i.team_credits, null);
  assert.deepEqual(i.story_arc_credits, [{ id: 9, name: 'Volume One' }]);
  assert.deepEqual(i.associated_images, [{ original_url: 'https://img/1b.jpg', caption: 'Second printing' }]);
  assert.equal(i.store_date, '2012-03-14');
  const m = i.metron;
  assert.equal(m.rating, 'Mature');
  assert.equal(m.price, '2.99');
  assert.equal(m.upc, '70985301234500111');
  assert.deepEqual(m.story_titles, ['Chapter One']);
  assert.equal(m.page_count, 44);
  assert.equal(m.cv_id, 300000);
  assert.equal(m.publisher.name, 'Image Comics');
  // An issue with a collection title keeps it as the name.
  assert.equal(shapeIssue({ ...d, title: 'Saga, Vol. 1' }).name, 'Saga, Vol. 1');
  assert.equal(issueSidecar({ id: 1, price: 4 }).price, '4');
});

test('shapeIssueRow carries the owning series when the row has one', () => {
  const r = shapeIssueRow({ id: 5, number: '12', cover_date: '2020-01-01', image: 'u', series: { id: 7, name: 'Saga' } });
  assert.deepEqual(r, { id: mintId(5), name: null, issue_number: '12', cover_date: '2020-01-01', image_url: 'u', volume: { id: mintId(7), name: 'Saga' } });
});

test('client needs an account and sends it as Basic auth', async () => {
  assert.throws(() => makeMetronClient({}, { politeMs: 0 }), /username and password/);
  const c = client([['/series/?name=saga', { json: { count: 1, next: null, results: [{ id: 7, series: 'Saga (2012)', year_began: 2012, issue_count: 66 }] } }]]);
  const r = await c.search('saga');
  assert.equal(r.length, 1);
  assert.equal(r[0].id, mintId(7));
  const f = c.search; // the stub recorded the Authorization header
  assert.ok(f);
});

test('search encodes the query and parses the list page', async () => {
  const fetchImpl = stubFetch([['/series/?name=', { json: { count: 2, next: null, results: [{ id: 1, series: 'X-Men (1991)', year_began: 1991, issue_count: 275 }, { id: 2, series: 'X-Men (2019)', year_began: 2019, issue_count: 21 }] } }]]);
  const c = makeMetronClient(cfg, { fetchImpl, politeMs: 0 });
  const r = await c.search('x-men & co');
  assert.equal(r.length, 2);
  assert.ok(fetchImpl.calls[0].url.endsWith('/series/?name=x-men%20%26%20co'));
  assert.equal(fetchImpl.calls[0].auth, 'Basic ' + Buffer.from('reader:hunter2').toString('base64'));
});

test('volume walks every issue_list page and unmints the id on the way out', async () => {
  const fetchImpl = stubFetch([
    ['/series/7/issue_list/?page=1', { json: { count: 3, next: 'https://metron.cloud/api/series/7/issue_list/?page=2', results: [{ id: 100, number: '1', image: 'a' }, { id: 101, number: '2', image: 'b' }] } }],
    ['/series/7/issue_list/?page=2', { json: { count: 3, next: null, results: [{ id: 102, number: '3', image: 'c' }] } }],
    ['/series/7/', { json: { id: 7, name: 'Saga', publisher: { name: 'Image Comics' }, year_began: 2012, issue_count: 3, status: 'Ongoing' } }],
  ]);
  const c = makeMetronClient(cfg, { fetchImpl, politeMs: 0 });
  const v = await c.volume(mintId(7));
  assert.equal(v.name, 'Saga');
  assert.equal(v.issues.length, 3);
  assert.equal(v.issues[2].id, mintId(102));
  assert.equal(v.image_url, 'a');
  assert.ok(fetchImpl.calls.some((x) => x.url.endsWith('/series/7/')));
  await assert.rejects(c.volume(7), /not in that metadata source/); // a raw ComicVine-range id is looked up by cv_id, never mistaken for a Metron id
});

test('a ComicVine-keyed series resolves through cv_id and keeps the id it was asked for', async () => {
  const fetchImpl = stubFetch([
    ['/series/?cv_id=46568', { json: { count: 1, results: [{ id: 7, series: 'Saga (2012)', year_began: 2012 }] } }],
    ['/series/7/issue_list/', { json: { count: 2, next: null, results: [{ id: 100, number: '1', image: 'a' }, { id: 101, number: '2', image: 'b' }] } }],
    ['/series/7/', { json: { id: 7, name: 'Saga', publisher: { name: 'Image Comics' }, year_began: 2012, issue_count: 2 } }],
  ]);
  const c = makeMetronClient(cfg, { fetchImpl, politeMs: 0 });
  const v = await c.volume(46568);
  assert.equal(v.id, 46568);            // the library's key is untouched
  assert.equal(v.metron.id, 7);         // the sidecar still names the Metron row
  assert.equal(v.issues[0].id, mintId(100)); // stubs are Metron's; the cache step pairs them by number
  assert.equal(fetchImpl.calls[0].url.includes('/series/?cv_id=46568'), true);
});

test('a ComicVine-keyed issue resolves through cv_id; one Metron lacks is a clear miss', async () => {
  const c = client([
    ['/issue/?cv_id=555', { json: { count: 1, results: [{ id: 9 }] } }],
    ['/issue/?cv_id=556', { json: { count: 0, results: [] } }],
    ['/issue/9/', { json: { id: 9, number: '1', name: ['Chapter One'], series: { id: 7, name: 'Saga' }, credits: [] } }],
  ]);
  const i = await c.issue(555);
  assert.equal(i.id, 555);
  assert.equal(i.name, 'Chapter One');
  await assert.rejects(c.issue(556), /not in that metadata source/);
  assert.deepEqual((await c.issuesByIds([555, 556])).map((x) => x.id), [555]);
});

test('a 404 detail is a clear error, a 401 never echoes the password', async () => {
  const c = client([['/issue/5/', { status: 404, json: {} }], ['/issue/6/', { status: 401, json: {} }]]);
  await assert.rejects(c.issue(mintId(5)), /no issue with that id/);
  await assert.rejects(c.issue(mintId(6)), (e) => /username or password/.test(e.message) && !e.message.includes('hunter2'));
});

test('a host that never answers times out with a reason, after one retry', async () => {
  let calls = 0;
  const hang = (url, opts) => new Promise((_, reject) => {
    calls++;
    opts.signal.addEventListener('abort', () => reject(opts.signal.reason));
  });
  const c = makeMetronClient(cfg, { fetchImpl: hang, politeMs: 0, timeoutMs: 20 });
  // AbortSignal.timeout's timer does not hold the event loop open; a server
  // always has other work, a bare test does not.
  const keepAlive = setInterval(() => {}, 10);
  const t0 = Date.now();
  try {
    await assert.rejects(c.test(), /Could not reach the metadata service \(timed out/);
  } finally { clearInterval(keepAlive); }
  assert.equal(calls, 2);
  assert.ok(Date.now() - t0 < 2000);
});

test('a connection refused is reported with its code, not "fetch failed"', async () => {
  const refuse = () => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));
  const c = makeMetronClient(cfg, { fetchImpl: refuse, politeMs: 0 });
  await assert.rejects(c.test(), /Could not reach the metadata service \(ECONNREFUSED\)/);
});

test('a persistent 429 surfaces as rateLimited after the waits', async () => {
  const c = client([['/series/', { status: 429, headers: { 'retry-after': '0' }, json: {} }]]);
  await assert.rejects(c.search('batman'), (e) => e.rateLimited === true && /rate limit/.test(e.message));
});

test('findIssue filters the series issue list by number and prefers the exact one', async () => {
  const c = client([['/issue/?series_id=7&number=1', { json: { results: [{ id: 110, number: '1.1', series: { id: 7, name: 'Saga' } }, { id: 100, number: '1', series: { id: 7, name: 'Saga' } }] } }]]);
  const r = await c.findIssue(mintId(7), '1');
  assert.equal(r.id, mintId(100));
  assert.equal(await c.findIssue(7, '1'), null); // not ours
});

test('issuesByIds hydrates one by one and skips ids Metron does not know', async () => {
  const c = client([
    ['/issue/100/', { json: { id: 100, number: '1', series: { id: 7, name: 'Saga' }, image: 'a' } }],
    ['/issue/101/', { status: 404, json: {} }],
  ]);
  const r = await c.issuesByIds([mintId(100), mintId(101), 55]);
  assert.deepEqual(r.map((x) => x.id), [mintId(100)]);
});

test('story arcs search and hydrate through the arc issue_list', async () => {
  const c = client([
    ['/arc/?name=', { json: { results: [{ id: 9, name: 'Knightfall' }] } }],
    ['/arc/9/issue_list/', { json: { next: null, results: [{ id: 500, number: '492', series: { id: 3, name: 'Batman' } }] } }],
    ['/arc/9/', { json: { id: 9, name: 'Knightfall' } }],
  ]);
  const arcs = await c.searchArcs('knightfall');
  assert.equal(arcs[0].id, mintId(9));
  const r = await c.storyArcIssues(mintId(9));
  assert.equal(r.arc.name, 'Knightfall');
  assert.deepEqual(r.issues.map((i) => i.id), [mintId(500)]);
});

test('the Test round trip reports the catalog count', async () => {
  const c = client([['/series/?name=batman', { json: { count: 180, next: 'x', results: [] } }]]);
  assert.deepEqual(await c.test(), { ok: true, message: 'Signed in. A test search found 180 series.' });
});
