// Metadata providers: where series and issue data comes from.
//
// A provider turns the instance config into a client with the ComicVine
// client's method surface (search, volume, issue, issuesByIds, findIssue, and
// optionally list, searchArcs, storyArcIssues). Three are built in: the hosted
// BackIssue metadata service (the default), ComicVine with the user's own key,
// and Metron with the user's own account. Plugins add more through
// api.registerMetadataProvider.
//
// `metadataSources` in settings is an ordered list of the providers in use,
// like `sourcePriority` for downloads. With several enabled, lookups go
// through a composite client: a series or issue id is answered by the provider
// that owns its id range (each provider mints ids into its own range), a
// search asks every enabled provider and merges the answers in priority order,
// and Discover uses the first provider that offers it. A provider in the list
// that is not configured (no key, no account) is skipped rather than failing
// every lookup; with nothing usable the hosted service answers.
//
// Every caller still builds its client through makeCvClient (plugins import
// it), so the switch lives in a dispatcher installed into cv.js: makeCvClient
// hands the config here and gets the right client back. Nothing downstream
// knows which provider answered.
import { makeCvClient, installMetadataDispatcher, cvKey } from './cv.js';
import { makeMetronClient, MINTED_BASE as METRON_BASE } from './metron.js';
import { normalizeTitle } from './matcher.js';

const SLUG = /^[a-z0-9][a-z0-9_-]{0,31}$/;
// ComicVine's own ids (and the hosted service's, which mirrors them) all sit
// below one billion; other providers mint above it, each in its own range.
const CV_LIMIT = METRON_BASE;
const METRON_LIMIT = METRON_BASE + 100_000_000;
const isCvId = (id) => Number(id) > 0 && Number(id) < CV_LIMIT;

const providers = [
  {
    id: 'hosted',
    label: 'BackIssue metadata service (built-in, no setup)',
    builtin: true,
    fields: [],
    isConfigured: () => true,
    owns: isCvId,
    resolves: () => false,
    makeClient: (cfg, opts) => makeCvClient(cfg, { ...opts, noDispatch: true, source: 'hosted' }),
  },
  {
    id: 'comicvine',
    label: 'ComicVine directly (your own API key)',
    builtin: true,
    note: "ComicVine's API is rate-limited (about 200 requests per resource per hour, with velocity checks on top). Big imports, library scans and release matching will pause when the limit is hit and can take much longer.",
    fields: [{ key: 'comicvineKeys', label: 'ComicVine API key', type: 'text', placeholder: 'Free at comicvine.gamespot.com' }],
    isConfigured: (cfg) => !!cvKey(cfg?.comicvineKeys),
    owns: isCvId,
    resolves: () => false,
    makeClient: (cfg, opts) => makeCvClient(cfg, { ...opts, noDispatch: true, source: 'comicvine' }),
    async test(cfg) {
      const key = cvKey(cfg?.comicvineKeys);
      if (!key) return { ok: false, message: 'Enter an API key.' };
      const client = makeCvClient({ ...cfg, metadataSource: 'comicvine' }, { key, politeMs: 0, noDispatch: true, source: 'comicvine' });
      const results = await client.search('batman');
      return { ok: true, message: `Key valid. A test search returned ${results.length} volumes.` };
    },
  },
  {
    id: 'metron',
    label: 'Metron directly (your own account)',
    builtin: true,
    note: 'Metron allows about 20 requests a minute per account, so imports, scans and release matching run slowly. Search results show no cover or publisher until a series is added.',
    fields: [
      { key: 'metronUser', label: 'Metron username', type: 'text', placeholder: 'Your metron.cloud username' },
      { key: 'metronPass', label: 'Metron password', type: 'password', placeholder: '' },
    ],
    isConfigured: (cfg) => !!(String(cfg?.metronUser || '').trim() && cfg?.metronPass),
    owns: (id) => Number(id) >= METRON_BASE && Number(id) < METRON_LIMIT,
    // Metron records ComicVine's ids on its own rows, so it can answer for a
    // ComicVine-keyed series when no ComicVine-backed source is enabled.
    resolves: isCvId,
    makeClient: (cfg, opts) => makeMetronClient(cfg, opts),
    test: (cfg) => makeMetronClient(cfg, { politeMs: 0 }).test(),
  },
];

/**
 * Add a provider: { id, label, fields?, note?, isConfigured?(config), makeClient(config, opts), test?(config), owns?(id) | idRange?, resolves?(id) }.
 *   id        a slug; this is what `metadataSources` holds when the provider is enabled
 *   fields    the settings the provider needs, rendered on Settings → Metadata:
 *             [{ key, label, type: 'text' | 'password', placeholder? }]. The keys
 *             must also be registered through api.registerSettings so they persist.
 *   makeClient(config, { fetchImpl?, politeMs? }) → the client (see cv.js makeCvClient
 *             for the method contract; `list` is optional and ComicVine-specific).
 *   isConfigured(config) → false means "skip this provider" (default: true).
 *   test(config) → { ok, message } for the Settings Test button (default: a search).
 *   owns(id) → true for the ids this provider minted; or idRange: [low, high)
 *             (default: nothing). With several providers enabled, a series or
 *             issue is looked up through the provider that owns its id.
 *   resolves(id) → true when the provider can also answer for a foreign id it
 *             knows about (default: nothing); tried after every owner.
 * Idempotent per id; a built-in id cannot be replaced.
 */
export function registerMetadataProvider(p, plugin = null) {
  const id = String(p?.id || '').toLowerCase();
  if (!SLUG.test(id) || !p?.label || typeof p.makeClient !== 'function') return false;
  if (providers.some((x) => x.id === id)) return false;
  const fields = (Array.isArray(p.fields) ? p.fields : [])
    .filter((f) => f?.key && /^[A-Za-z][A-Za-z0-9_]*$/.test(String(f.key)))
    .map((f) => ({ key: String(f.key), label: String(f.label || f.key), type: f.type === 'password' ? 'password' : 'text', placeholder: f.placeholder ? String(f.placeholder) : '' }));
  // A provider that declares no range is assumed to own whatever id no
  // declared provider claims, so a plugin written before ranges existed still
  // answers for its own series when enabled alongside others.
  let owns = null;
  if (typeof p.owns === 'function') owns = (id) => !!p.owns(Number(id));
  else if (Array.isArray(p.idRange) && p.idRange.length === 2) {
    const [lo, hi] = p.idRange.map(Number);
    owns = (id) => Number(id) >= lo && Number(id) < hi;
  }
  providers.push({
    id, label: String(p.label), note: p.note ? String(p.note) : '', fields, plugin, builtin: false,
    isConfigured: typeof p.isConfigured === 'function' ? p.isConfigured : () => true,
    owns,
    resolves: typeof p.resolves === 'function' ? (id) => !!p.resolves(Number(id)) : () => false,
    makeClient: p.makeClient,
    test: typeof p.test === 'function' ? p.test : null,
  });
  return true;
}

// Test seam: drop everything a test registered.
export function _resetMetadataProviders() {
  for (let i = providers.length - 1; i >= 0; i--) if (!providers[i].builtin) providers.splice(i, 1);
}

export const metadataSourceIds = () => providers.map((p) => p.id);

const hosted = () => providers[0];
const byId = (id) => providers.find((p) => p.id === id) || null;

/** Parse a `metadataSources` value ("hosted,bnf") into known, distinct ids.
 *  Unknown ids are kept out of the result but never out of the setting: a
 *  plugin that is not installed right now may be again later. */
export function parseMetadataSources(value) {
  const out = [];
  for (const raw of String(value || '').split(',')) {
    const id = raw.trim().toLowerCase();
    if (id && byId(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/** The providers in use, in priority order. An install that only ever set
 *  the old single `metadataSource` reads as a one-entry list. */
export function metadataSourceOrder(config) {
  const list = parseMetadataSources(config?.metadataSources);
  if (list.length) return list;
  const single = String(config?.metadataSource || '').trim().toLowerCase();
  return [byId(single) ? single : 'hosted'];
}

/** The providers lookups actually go to: the enabled ones that are
 *  configured, in order; the hosted service when none is. */
export function enabledMetadataProviders(config) {
  const usable = metadataSourceOrder(config).map(byId).filter((p) => p && p.isConfigured(config));
  return usable.length ? usable : [hosted()];
}

/** The first provider in the list (what the old single setting named). */
export function selectedMetadataProvider(config) {
  return byId(metadataSourceOrder(config)[0]) || hosted();
}

/** The provider that answers first: the top usable one. */
export function activeMetadataProvider(config) {
  return enabledMetadataProviders(config)[0];
}

/** What Settings → Metadata renders, in priority order with the unused
 *  providers after. Never includes field values. */
export function metadataProviderList(config) {
  const order = metadataSourceOrder(config);
  const active = new Set(enabledMetadataProviders(config).map((p) => p.id));
  const rank = (p) => { const i = order.indexOf(p.id); return i < 0 ? order.length + providers.indexOf(p) : i; };
  return [...providers].sort((a, b) => rank(a) - rank(b)).map((p) => ({
    id: p.id, label: p.label, note: p.note || '', fields: p.fields, builtin: !!p.builtin, plugin: p.plugin || null,
    configured: !!p.isConfigured(config), enabled: order.includes(p.id), active: active.has(p.id), selected: order[0] === p.id,
  }));
}

const titleKey = (v) => `${normalizeTitle(String(v?.name || ''))}|${v?.start_year ?? ''}`;

/** Merge candidate lists from several providers, best provider first: the
 *  same id, or the same title and start year, is listed once. */
export function mergeSearchResults(lists) {
  const seenId = new Set();
  const seenTitle = new Set();
  const out = [];
  for (const list of lists) {
    for (const v of Array.isArray(list) ? list : []) {
      if (!v) continue;
      const id = v.id != null ? String(v.id) : null;
      const key = titleKey(v);
      if ((id && seenId.has(id)) || (key !== '|' && seenTitle.has(key))) continue;
      if (id) seenId.add(id);
      if (key !== '|') seenTitle.add(key);
      out.push(v);
    }
  }
  return out;
}

/** One client over every enabled provider. A single enabled provider gets
 *  everything, as it always did; several are routed per call. */
export function makeCompositeClient(config, opts = {}) {
  const enabled = enabledMetadataProviders(config);
  if (enabled.length === 1) return enabled[0].makeClient(config, opts);
  const clients = enabled.map((p) => ({ p, c: p.makeClient(config, opts) }));
  const ownerOf = (id) => clients.find((x) => x.p.owns && x.p.owns(id))
    || clients.find((x) => x.p.resolves(id))
    || clients.find((x) => !x.p.owns)
    || null;
  const route = (id) => {
    const hit = ownerOf(id);
    if (!hit) throw new Error('None of the enabled metadata sources knows this id');
    return hit.c;
  };
  // Ask everyone; a source that fails is left out unless they all fail.
  async function fanOut(method, ...args) {
    const able = clients.filter((x) => typeof x.c[method] === 'function');
    const settled = await Promise.allSettled(able.map((x) => x.c[method](...args)));
    const lists = [];
    let firstErr = null;
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') lists.push(r.value);
      else { firstErr ??= r.reason; console.warn(`metadata ${method} failed on ${able[i].p.id}:`, r.reason?.message || r.reason); }
    });
    if (!lists.length && firstErr) throw firstErr;
    return mergeSearchResults(lists);
  }
  const composite = {
    search: (q, o) => fanOut('search', q, o),
    volume: async (id) => route(id).volume(id),
    issue: async (id) => route(id).issue(id),
    findIssue: async (volumeId, number) => route(volumeId).findIssue(volumeId, number),
    storyArcIssues: async (arcId) => route(arcId).storyArcIssues(arcId),
    searchArcs: (q) => fanOut('searchArcs', q),
    async issuesByIds(ids) {
      const groups = new Map();
      for (const id of ids || []) {
        const hit = ownerOf(id);
        if (!hit) continue; // an id nobody enabled can answer for is simply absent
        if (!groups.has(hit)) groups.set(hit, []);
        groups.get(hit).push(id);
      }
      const out = [];
      for (const [hit, group] of groups) out.push(...(await hit.c.issuesByIds(group)));
      return out;
    },
  };
  // Discover and other list-driven features need a ComicVine-shaped feed;
  // the first enabled provider that has one serves it.
  const lister = clients.find((x) => typeof x.c.list === 'function');
  if (lister) composite.list = (...args) => lister.c.list(...args);
  return composite;
}

/** A client for the enabled providers. */
export function makeMetadataClient(config, opts = {}) {
  return makeCompositeClient(config, opts);
}

/** The Settings Test button: prove a provider with the values from the form
 *  (unsaved), restricted to the fields the provider declares. */
export async function testMetadataProvider(config, { provider, values = {} } = {}) {
  const p = providers.find((x) => x.id === String(provider || ''));
  if (!p) return { ok: false, message: 'Unknown metadata provider.' };
  const overlay = {};
  for (const f of p.fields) if (values && values[f.key] != null) overlay[f.key] = String(values[f.key]);
  // The hosted service has no fields and provisions its key into the live
  // config on first use; hand it the live object so that persists.
  const cfg = p.fields.length ? { ...config, ...overlay, metadataSource: p.id } : config;
  try {
    if (p.test) return await p.test(cfg);
    const client = p.makeClient(cfg, { politeMs: 0 });
    const results = await client.search('batman');
    return { ok: true, message: `Responding. A test search returned ${Array.isArray(results) ? results.length : 0} results.` };
  } catch (e) {
    return { ok: false, message: String(e?.message || e) };
  }
}

// makeCvClient asks here first; the answer is the client for the enabled
// providers (the hosted service's own client when that is all there is).
installMetadataDispatcher((config, opts) => {
  if (opts?.noDispatch) return null;
  return makeCompositeClient(config, opts);
});
