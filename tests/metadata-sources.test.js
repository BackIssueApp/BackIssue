// Several metadata providers at once: the ordered `metadataSources` list,
// id-range routing and merged searches.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  registerMetadataProvider, _resetMetadataProviders, selectedMetadataProvider, activeMetadataProvider,
  metadataProviderList, metadataSourceOrder, enabledMetadataProviders, mergeSearchResults,
  makeCompositeClient, parseMetadataSources,
} from '../src/metadata.js';
import { makeCvClient } from '../src/cv.js';
import { validateSettings } from '../src/settings.js';

afterEach(() => _resetMetadataProviders());

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
  registerMetadataProvider(ranged('beta', 2.1e9, 2.2e9, { resolves: (id) => id < 1e9 }));
  const cfg = { metadataSources: 'alpha,beta' };
  const c = makeCvClient(cfg);
  assert.equal(c.provider, undefined); // the composite, not either client
  assert.equal(typeof c.list, 'undefined'); // nobody enabled offers a feed
  assert.equal((await c.volume(2e9 + 5)).from, 'alpha');
  assert.equal((await c.issue(2.1e9 + 5)).from, 'beta');
  assert.equal((await c.findIssue(2.1e9 + 5, '3')).from, 'beta');
  assert.equal((await c.storyArcIssues(2e9 + 1)).arc.from, 'alpha');
  // A foreign id goes to the provider that says it can resolve it.
  assert.equal((await c.volume(42)).from, 'beta');
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

test('Metron answers for ComicVine ids only when no ComicVine-backed source is enabled', () => {
  registerMetadataProvider(ranged('alpha', 2e9, 2.1e9));
  const creds = { metronUser: 'u', metronPass: 'p' };
  assert.equal(makeCvClient({ metadataSources: 'metron,alpha', ...creds }).provider, undefined);
  const owner = (cfg, id) => enabledMetadataProviders(cfg).find((p) => p.owns(id)) || enabledMetadataProviders(cfg).find((p) => p.resolves(id));
  assert.equal(owner({ metadataSources: 'metron,alpha', ...creds }, 12345).id, 'metron');
  assert.equal(owner({ metadataSources: 'metron,hosted', ...creds }, 12345).id, 'hosted');
  assert.equal(owner({ metadataSources: 'metron,hosted', ...creds }, 1e9 + 7).id, 'metron');
  assert.equal(owner({ metadataSources: 'hosted,alpha' }, 1e9 + 7), undefined);
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
