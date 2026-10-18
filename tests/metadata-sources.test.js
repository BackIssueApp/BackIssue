// Several metadata providers at once: the ordered `metadataSources` list,
// id-range routing and merged searches.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  registerMetadataProvider, _resetMetadataProviders, selectedMetadataProvider, activeMetadataProvider,
  metadataProviderList, metadataSourceOrder, enabledMetadataProviders, mergeSearchResults,
  makeCompositeClient, parseMetadataSources, setCatalogLookup, classifyId, catalogOf,
} from '../src/metadata.js';
import { openDb, upsertCvSeries, upsertCvIssue, recordedCatalog, backfillCatalogs, updateLibrary } from '../src/db.js';
import { buildComicInfoXml } from '../src/metatagger.js';
import { makeCvClient } from '../src/cv.js';
import { validateSettings } from '../src/settings.js';

afterEach(() => { _resetMetadataProviders(); setCatalogLookup(null); });

const ranged = (id, lo, hi, extra = {}) => ({
  id, label: id, idRange: [lo, hi], isConfigured: () => true,
  makeClient: () => ({
    provider: id,
    async search(q) { return [{ id: lo + 1, name: `${q} ${id}`, start_year: 2000 }, { id: lo + 2, name: 'Shared Title', start_year: 1999 }]; },
    async volume(v) { return { id: v, from: id }; },
    async issue(v) { return { id: v, from: id }; },
    async issuesByIds(ids) { return ids.map((x) => ({ id: x, from: id })); },
    async findIssue(v, n) { return { volume: v, number: n, from: id }; },
    async searchArcs() { return [{ id: lo + 7, name: 'Arc ' + id }]; },
    async storyArcIssues(a) { return { arc: { id: a, from: id }, issues: [] }; },
  }),
  ...extra,
});

test('metadataSources is an ordered list; the old single setting reads as one entry', () => {
  registerMetadataProvider(ranged('alpha', 2e9, 2.1e9));
  assert.deepEqual(parseMetadataSources(' Alpha ,hosted,alpha,nope,'), ['alpha', 'hosted']);
  assert.deepEqual(metadataSourceOrder({ metadataSources: 'alpha,metron' }), ['alpha', 'metron']);
  assert.deepEqual(metadataSourceOrder({ metadataSource: 'metron' }), ['metron']);
  assert.deepEqual(metadataSourceOrder({ metadataSource: 'nope' }), ['hosted']);
  assert.deepEqual(metadataSourceOrder({}), ['hosted']);
  // Unconfigured entries are skipped; nothing usable means the hosted service.
  assert.deepEqual(enabledMetadataProviders({ metadataSources: 'metron,alpha' }).map((p) => p.id), ['alpha']);
  assert.deepEqual(enabledMetadataProviders({ metadataSources: 'metron,comicvine' }).map((p) => p.id), ['hosted']);
  assert.equal(activeMetadataProvider({ metadataSources: 'metron,alpha' }).id, 'alpha');
  assert.equal(selectedMetadataProvider({ metadataSources: 'metron,alpha' }).id, 'metron');
});

test('validateSettings keeps the list and the single value in step', () => {
  registerMetadataProvider(ranged('alpha', 2e9, 2.1e9));
  let v = validateSettings({ metadataSources: 'alpha, hosted,alpha' });
  assert.equal(v.metadataSources, 'alpha,hosted');
  assert.equal(v.metadataSource, 'alpha');
  // An id for a plugin that is not loaded right now stays in the list but
  // never becomes the single value.
  v = validateSettings({ metadataSources: 'ghost,metron' });
  assert.equal(v.metadataSources, 'ghost,metron');
  assert.equal(v.metadataSource, 'metron');
  v = validateSettings({ metadataSources: '' });
  assert.equal(v.metadataSources, '');
  assert.equal(v.metadataSource, 'hosted');
  // The single value alone (an older client) becomes a one-entry list.
  v = validateSettings({ metadataSource: 'metron' });
  assert.equal(v.metadataSources, 'metron');
  // Both given: the list wins.
  v = validateSettings({ metadataSource: 'hosted', metadataSources: 'metron' });
  assert.equal(v.metadataSource, 'metron');
});

test('metadataProviderList comes back in priority order with enabled flags', () => {
  registerMetadataProvider(ranged('alpha', 2e9, 2.1e9));
  const list = metadataProviderList({ metadataSources: 'alpha,hosted', metronUser: '', metronPass: '' });
  assert.deepEqual(list.map((p) => p.id), ['alpha', 'hosted', 'comicvine', 'metron']);
  assert.deepEqual(list.map((p) => p.enabled), [true, true, false, false]);
  assert.deepEqual(list.map((p) => p.active), [true, true, false, false]);
  assert.equal(list[0].selected, true);
  // Enabled but unconfigured: listed, not active.
  const l2 = metadataProviderList({ metadataSources: 'metron,alpha' });
  assert.equal(l2[0].id, 'metron');
  assert.equal(l2[0].enabled, true);
  assert.equal(l2[0].active, false);
});

test('mergeSearchResults folds the same id or the same title and year, best source first', () => {
  const merged = mergeSearchResults([
    [{ id: 1, name: 'Blacksad', start_year: 2000 }, { id: 2, name: 'Other', start_year: 2001 }],
    [{ id: 1, name: 'Blacksad again', start_year: 2000 }, { id: 9, name: 'BLACKSAD', start_year: 2000 }, { id: 10, name: 'Other', start_year: 2010 }, { id: 11, name: 'New', start_year: null }],
    null,
  ]);
  assert.deepEqual(merged.map((v) => v.id), [1, 2, 10, 11]);
});

test('with several providers enabled, lookups route by id and searches merge', async () => {
  registerMetadataProvider(ranged('alpha', 2e9, 2.1e9));
  registerMetadataProvider(ranged('beta', 2.1e9, 2.2e9, { alsoServes: ['comicvine'] }));
  const cfg = { metadataSources: 'alpha,beta' };
  const c = makeCvClient(cfg);
  assert.equal(c.provider, undefined); // the composite, not either client
  assert.equal(typeof c.list, 'undefined'); // nobody enabled offers a feed
  assert.equal((await c.volume(2e9 + 5)).from, 'alpha');
  assert.equal((await c.issue(2.1e9 + 5)).from, 'beta');
  assert.equal((await c.findIssue(2.1e9 + 5, '3')).from, 'beta');
  assert.equal((await c.storyArcIssues(2e9 + 1)).arc.from, 'alpha');
  // A ComicVine record goes to the provider that serves ComicVine through a
  // cross-reference, since nothing enabled serves it natively.
  assert.equal((await c.volume(42)).from, 'beta');
  // Results say where they came from.
  const v = await c.volume(2e9 + 5);
  assert.equal(v.meta_source, 'alpha');
  await assert.rejects(() => c.volume(3e9), /None of the enabled metadata sources/);
  const found = await c.search('q');
  assert.deepEqual(found.map((v) => [v.id, v.name]), [[2e9 + 1, 'q alpha'], [2e9 + 2, 'Shared Title'], [2.1e9 + 1, 'q beta']]);
  assert.deepEqual((await c.searchArcs('x')).map((a) => a.name), ['Arc alpha', 'Arc beta']);
  const rows = await c.issuesByIds([2.1e9 + 1, 2e9 + 1, 3e9, 2.1e9 + 2]);
  assert.deepEqual(rows.map((r) => [r.id, r.from]), [[2.1e9 + 1, 'beta'], [2.1e9 + 2, 'beta'], [2e9 + 1, 'alpha']]);
  // Enabled alongside the hosted service, the composite still offers a list feed.
  assert.equal(typeof makeCvClient({ metadataSources: 'alpha,hosted' }).list, 'function');
  // One enabled provider gets everything, as before.
  assert.equal(makeCvClient({ metadataSources: 'alpha' }).provider, 'alpha');
  assert.equal(makeCvClient({ metadataSources: 'alpha,metron' }).provider, 'alpha'); // metron unconfigured
});

test('a provider that fails a search is left out; all failing rethrows', async () => {
  registerMetadataProvider(ranged('alpha', 2e9, 2.1e9));
  registerMetadataProvider(ranged('beta', 2.1e9, 2.2e9, { makeClient: () => ({ async search() { throw new Error('beta down'); } }) }));
  const warn = console.warn; console.warn = () => {};
  try {
    const c = makeCompositeClient({ metadataSources: 'beta,alpha' });
    assert.deepEqual((await c.search('q')).map((v) => v.id), [2e9 + 1, 2e9 + 2]);
    registerMetadataProvider(ranged('gamma', 2.2e9, 2.3e9, { makeClient: () => ({ async search() { throw new Error('gamma down'); } }) }));
    await assert.rejects(() => makeCompositeClient({ metadataSources: 'beta,gamma' }).search('q'), /beta down/);
  } finally { console.warn = warn; }
});

test('built-in providers declare the catalogs they serve', () => {
  const creds = { metronUser: 'u', metronPass: 'p' };
  const byId = Object.fromEntries(enabledMetadataProviders({ metadataSources: 'hosted,metron', ...creds }).map((p) => [p.id, p]));
  assert.deepEqual(byId.hosted.serves, ['comicvine', 'mangadex']);
  assert.deepEqual(byId.metron.serves, ['metron']);
  assert.deepEqual(byId.metron.alsoServes, ['comicvine']);
  assert.equal(classifyId(12345), 'comicvine');
  assert.equal(classifyId(10_000_152), 'mangadex');
  assert.equal(classifyId(1e9 + 7), 'metron');
  assert.equal(classifyId(0), null);
});

// Fake providers standing in for the built-ins, so routing is observable.
const fake = (id, serves, extra = {}) => ({
  id, label: id, serves, isConfigured: () => true,
  makeClient: () => ({
    async volume(v, hint) { return { id: v, from: id, hint, issues: [{ id: v + 1, number: '1' }] }; },
    async issue(v) { return { id: v, from: id }; },
    async issuesByIds(ids) { return ids.map((x) => ({ id: x, from: id })); },
    async search() { return []; },
  }),
  ...extra,
});

test('a native provider beats a cross-reference; the hint names the catalog', async () => {
  registerMetadataProvider(fake('cvd', ['comicvine']));
  registerMetadataProvider(fake('xref', ['xrefcat'], { alsoServes: ['comicvine'] }));
  let c = makeCompositeClient({ metadataSources: 'xref,cvd' });
  const v = await c.volume(42);
  assert.equal(v.from, 'cvd'); // native wins even though xref is first in the list
  assert.deepEqual(v.hint, { catalog: 'comicvine' });
  c = makeCompositeClient({ metadataSources: 'xref' });
  assert.equal((await c.volume(42)).from, 'xref');
});

test('manga is never handed to a provider that cannot read it', async () => {
  registerMetadataProvider(fake('cvd', ['comicvine']));
  registerMetadataProvider(fake('xref', ['xrefcat'], { alsoServes: ['comicvine'] }));
  const c = makeCompositeClient({ metadataSources: 'cvd,xref' });
  await assert.rejects(() => c.volume(10_000_152), /manga catalogue.*built-in metadata service/s);
  // issuesByIds leaves unreachable records out instead of failing the batch.
  assert.deepEqual((await c.issuesByIds([42, 10_000_200])).map((r) => r.id), [42]);
});

test('the recorded catalog decides, not the number', async () => {
  registerMetadataProvider(fake('cvd', ['comicvine']));
  registerMetadataProvider(fake('mx', ['mangadex']));
  const recorded = new Map([['volume:5', 'mangadex']]);
  setCatalogLookup((kind, id) => recorded.get(`${kind}:${id}`) || null);
  assert.equal(catalogOf('volume', 5), 'mangadex');
  assert.equal(catalogOf('volume', 6), 'comicvine');
  const c = makeCompositeClient({ metadataSources: 'cvd,mx' });
  assert.equal((await c.volume(5)).from, 'mx');
  assert.equal((await c.volume(6)).from, 'cvd');
});

test('a single provider is still wrapped: extras kept, routing and stamping applied', async () => {
  registerMetadataProvider(fake('cvd', ['comicvine']));
  const c = makeCompositeClient({ metadataSources: 'cvd' });
  assert.equal(typeof c.search, 'function');
  const v = await c.volume(42);
  assert.equal(v.meta_source, 'comicvine');
  assert.equal(v.issues[0].meta_source, 'comicvine');
  await assert.rejects(() => c.volume(10_000_152), /manga catalogue/);
});

test('the cache records each row\'s catalog; old rows are backfilled once', () => {
  const db = openDb(':memory:');
  upsertCvSeries(db, { id: 7, name: 'CV', meta_source: 'comicvine', meta_ref: '7' });
  upsertCvIssue(db, { id: 70, cv_series_id: 7, number: '1' }); // inherits its series' catalog
  assert.equal(recordedCatalog(db, 'volume', 7), 'comicvine');
  assert.equal(recordedCatalog(db, 'issue', 70), 'comicvine');
  // The first record wins: a later answer through a cross-reference keeps it.
  upsertCvSeries(db, { id: 7, name: 'CV', meta_source: 'metron' });
  assert.equal(recordedCatalog(db, 'volume', 7), 'comicvine');
  // Rows from before the column: built-ins by block at open, plugins after load.
  db.exec("INSERT INTO cv_series (comicvine_id, name) VALUES (10000152, 'Manga'), (1000000042, 'Metron'), (2000000003, 'Plugin')");
  db.exec('UPDATE cv_series SET meta_source=NULL, meta_ref=NULL WHERE comicvine_id > 7');
  registerMetadataProvider(fake('plug', ['plug'], { idRange: [2e9, 2.1e9] }));
  const n = backfillCatalogs(db, classifyId);
  assert.equal(n, 3);
  assert.equal(recordedCatalog(db, 'volume', 10000152), 'mangadex');
  assert.equal(recordedCatalog(db, 'volume', 1000000042), 'metron');
  assert.equal(recordedCatalog(db, 'volume', 2000000003), 'plug');
});

test('tags name a ComicVine issue only for a ComicVine record', () => {
  const series = { name: 'S', publisher: 'P' };
  const notes = (issue, s = series) => buildComicInfoXml({ series: s, issue }).match(/<Notes>(.*?)<\/Notes>/)?.[1];
  assert.match(notes({ comicvine_id: 70, issue_number: '1', meta_source: 'comicvine', meta_ref: '70' }), /ComicVine issue 70/);
  assert.equal(notes({ comicvine_id: 10000200, issue_number: '1', meta_source: 'mangadex' }), 'Tagged by BackIssue.');
  // A row from before catalogs were recorded: the manga block is not ComicVine.
  assert.equal(notes({ comicvine_id: 10000200, issue_number: '1' }), 'Tagged by BackIssue.');
  assert.match(notes({ comicvine_id: 70, issue_number: '1' }), /ComicVine issue 70/);
});

test('a provider that declares no id range answers for ids nobody else claims', async () => {
  registerMetadataProvider(ranged('alpha', 2e9, 2.1e9));
  registerMetadataProvider({ id: 'legacy', label: 'Legacy', makeClient: () => ({ provider: 'legacy', async volume(v) { return { id: v, from: 'legacy' }; }, async search() { return []; } }) });
  const c = makeCompositeClient({ metadataSources: 'alpha,legacy,hosted' });
  assert.equal((await c.volume(2e9 + 1)).from, 'alpha');
  assert.equal((await c.volume(5e9)).from, 'legacy');
  // A ComicVine id still goes to the hosted service, which declares that range.
  assert.equal(typeof c.list, 'function');
});

test('a library with its own sources uses them; others use the app-wide list', async () => {
  const { setLibraryResolver } = await import('../src/metadata.js');
  registerMetadataProvider(fake('cvd', ['comicvine']));
  registerMetadataProvider(fake('xref', ['xrefcat'], { alsoServes: ['comicvine'] }));
  // Library 2 keeps its records on xref; series 42 lives in library 2.
  setLibraryResolver({
    ofRecord: (kind, id) => (kind === 'volume' && id === 42 ? 2 : null),
    sourcesOf: (lib) => (lib === 2 ? 'xref' : null),
  });
  try {
    const c = makeCompositeClient({ metadataSources: 'cvd' });
    assert.equal((await c.volume(42)).from, 'xref');      // stored record follows its library
    assert.equal((await c.volume(43)).from, 'cvd');       // unstored, no library: app-wide list
    assert.equal((await c.forLibrary(2).volume(43)).from, 'xref'); // a new add for library 2
    assert.equal((await c.forLibrary(1).volume(43)).from, 'cvd');  // a library without its own list
  } finally { setLibraryResolver(null); }
});

test('a library list is stored validated, and cleared back to the default', () => {
  const db = openDb(':memory:');
  const id = db.prepare("INSERT INTO libraries (name, type) VALUES ('Comics', 'comic')").run().lastInsertRowid;
  const get = () => db.prepare('SELECT metadata_sources s FROM libraries WHERE id=?').get(id).s;
  updateLibrary(db, id, { metadataSources: ' BNF, hosted ,bnf, bad id!' });
  assert.equal(get(), 'bnf,hosted');
  updateLibrary(db, id, { name: 'Renamed' }); // untouched when not sent
  assert.equal(get(), 'bnf,hosted');
  updateLibrary(db, id, { metadataSources: null });
  assert.equal(get(), null);
});
