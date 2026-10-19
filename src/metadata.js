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
// like `sourcePriority` for downloads, and the default for every library; a
// library can carry its own list (libraries.metadata_sources). A lookup for a
// stored record uses the list of the library that holds it; a search or a new
// add uses the list of the library it is for. A provider in the list that is not
// configured (no key, no account) is skipped rather than failing every lookup;
// with nothing usable the hosted service answers.
//
// CATALOGS vs PROVIDERS. A catalog is where a record lives (ComicVine,
// MangaDex, Metron, the BnF catalogue, …); a provider is something that can
// fetch from one or more catalogs. The hosted service serves ComicVine and
// MangaDex; ComicVine-direct serves ComicVine; Metron serves Metron and can
// also answer for ComicVine records through its cross-reference. Every cached
// series and issue records its catalog (cv_series/cv_issues.meta_source) and
// the catalog's own id (meta_ref). A lookup reads the recorded catalog and
// goes to the first enabled provider, in the user's order, that serves it
// natively, then to one that serves it through a cross-reference. The integer
// id is only a key: each catalog still mints its new records into its own
// block of numbers so keys never collide, and that block is what classifies a
// brand-new id the library has not recorded yet (classifyId) — never a
// recorded one. Searches ask every enabled provider and merge the answers in
// priority order; Discover uses the first provider that offers a feed.
//
// Every caller still builds its client through makeCvClient (plugins import
// it), so the switch lives in a dispatcher installed into cv.js: makeCvClient
// hands the config here and gets the right client back. Nothing downstream
// knows which provider answered.
import { makeCvClient, installMetadataDispatcher, cvKey } from './cv.js';
import { makeMetronClient, MINTED_BASE as METRON_BASE } from './metron.js';
import { normalizeTitle } from './matcher.js';
import { BUILTIN_CATALOG_RANGES } from './db.js';

const SLUG = /^[a-z0-9][a-z0-9_-]{0,31}$/;

// Catalog id blocks, for classifying ids the library has not recorded yet.
// [name, test(id)] — first match wins. Built-ins first, then plugins'.
const catalogBlocks = BUILTIN_CATALOG_RANGES.map(([name, lo, hi]) => [name, (id) => id >= lo && id < hi, true]);
const GENERIC_CATALOG_NAMES = { mangadex: 'the manga catalogue' };

/** The catalog a fresh id was minted in, from the id blocks; null if none. */
export function classifyId(id) {
  const n = Number(id);
  if (!(n > 0)) return null;
  for (const [name, test] of catalogBlocks) if (test(n)) return name;
  return null;
}

// Recorded catalogs come from the database; index.js installs the reader.
let catalogLookup = null;
/** Install fn(kind: 'volume'|'issue', id) → recorded catalog | null. */
export function setCatalogLookup(fn) { catalogLookup = typeof fn === 'function' ? fn : null; }

/** A record's catalog: what the library recorded, else its id block. */
export function catalogOf(kind, id) {
  let rec = null;
  try { rec = catalogLookup ? catalogLookup(kind, id) : null; } catch { rec = null; }
  return rec || classifyId(id);
}

// The id a catalog itself uses for a record (meta_ref), when the answering
// provider can say.
const mangadexRef = (rec) => String(rec?.site_detail_url || '').match(/mangadex\.org\/(?:title|chapter)\/([0-9a-f-]{36})/i)?.[1] || null;

const providers = [
  {
    id: 'hosted',
    label: 'BackIssue metadata service (built-in, no setup)',
    builtin: true,
    fields: [],
    isConfigured: () => true,
    serves: ['comicvine', 'mangadex'],
    alsoServes: [],
    refOf: (catalog, id, rec) => (catalog === 'comicvine' ? String(id) : catalog === 'mangadex' ? mangadexRef(rec) : null),
    makeClient: (cfg, opts) => makeCvClient(cfg, { ...opts, noDispatch: true, source: 'hosted' }),
  },
  {
    id: 'comicvine',
    label: 'ComicVine directly (your own API key)',
    builtin: true,
    note: "ComicVine's API is rate-limited (about 200 requests per resource per hour, with velocity checks on top). Big imports, library scans and release matching will pause when the limit is hit and can take much longer.",
    fields: [{ key: 'comicvineKeys', label: 'ComicVine API key', type: 'text', placeholder: 'Free at comicvine.gamespot.com' }],
    isConfigured: (cfg) => !!cvKey(cfg?.comicvineKeys),
    serves: ['comicvine'],
    alsoServes: [],
    refOf: (catalog, id) => (catalog === 'comicvine' ? String(id) : null),
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
    serves: ['metron'],
    // Metron records ComicVine's ids on its own rows, so it can answer for a
    // ComicVine record when no provider serving ComicVine is enabled.
    alsoServes: ['comicvine'],
    refOf: (catalog, id) => (catalog === 'metron' ? String(Number(id) - METRON_BASE) : null),
    makeClient: (cfg, opts) => makeMetronClient(cfg, opts),
    test: (cfg) => makeMetronClient(cfg, { politeMs: 0 }).test(),
  },
];

/**
 * Add a provider: { id, label, fields?, note?, isConfigured?(config), makeClient(config, opts), test?(config),
 *                   catalog?, idRange? | owns?(id), serves?, alsoServes?, refOf?(catalog, id, record) }.
 *   id        a slug; this is what `metadataSources` holds when the provider is enabled
 *   fields    the settings the provider needs, rendered on Settings → Metadata:
 *             [{ key, label, type: 'text' | 'password', placeholder? }]. The keys
 *             must also be registered through api.registerSettings so they persist.
 *   makeClient(config, { fetchImpl?, politeMs? }) → the client (see cv.js makeCvClient
 *             for the method contract; `list` is optional and ComicVine-specific).
 *             volume/issue/findIssue receive a last argument { catalog } naming
 *             the catalog the record belongs to.
 *   isConfigured(config) → false means "skip this provider" (default: true).
 *   test(config) → { ok, message } for the Settings Test button (default: a search).
 *   catalog   the name of the catalog this provider mints records into
 *             (default: the provider id). With idRange: [low, high) or owns(id),
 *             ids in that block are classified as this catalog before the
 *             library has recorded them; keep the block clear of every other.
 *   serves    catalogs answered natively (default: [catalog]).
 *   alsoServes catalogs answered through a cross-reference, tried only after
 *             every enabled provider that serves them natively (default: none).
 *   refOf(catalog, id, record) → the catalog's own id for a record, stored as
 *             meta_ref (default: none).
 *   A provider that declares no id block also answers for records whose
 *   catalog nothing enabled serves, so a plugin written before catalogs
 *   existed keeps answering for its own series.
 * Idempotent per id; a built-in id cannot be replaced.
 */
export function registerMetadataProvider(p, plugin = null) {
  const id = String(p?.id || '').toLowerCase();
  if (!SLUG.test(id) || !p?.label || typeof p.makeClient !== 'function') return false;
  if (providers.some((x) => x.id === id)) return false;
  const fields = (Array.isArray(p.fields) ? p.fields : [])
    .filter((f) => f?.key && /^[A-Za-z][A-Za-z0-9_]*$/.test(String(f.key)))
    .map((f) => ({ key: String(f.key), label: String(f.label || f.key), type: f.type === 'password' ? 'password' : 'text', placeholder: f.placeholder ? String(f.placeholder) : '' }));
  const catalog = SLUG.test(String(p.catalog || '').toLowerCase()) ? String(p.catalog).toLowerCase() : id;
  let block = null;
  if (typeof p.owns === 'function') block = (n) => !!p.owns(n);
  else if (Array.isArray(p.idRange) && p.idRange.length === 2) {
    const [lo, hi] = p.idRange.map(Number);
    block = (n) => n >= lo && n < hi;
  }
  // Plugin blocks go after the built-ins, so they can never claim a built-in id.
  if (block) catalogBlocks.push([catalog, block, false]);
  const list = (v, dflt) => (Array.isArray(v) ? v.map((x) => String(x).toLowerCase()).filter((x) => SLUG.test(x)) : dflt);
  providers.push({
    id, label: String(p.label), note: p.note ? String(p.note) : '', fields, plugin, builtin: false,
    isConfigured: typeof p.isConfigured === 'function' ? p.isConfigured : () => true,
    serves: list(p.serves, [catalog]),
    alsoServes: list(p.alsoServes, []),
    fallback: !block && !Array.isArray(p.serves),
    refOf: typeof p.refOf === 'function' ? (c, i, r) => { try { const v = p.refOf(c, i, r); return v == null ? null : String(v); } catch { return null; } } : () => null,
    makeClient: p.makeClient,
    test: typeof p.test === 'function' ? p.test : null,
  });
  return true;
}

// Test seam: drop everything a test registered.
export function _resetMetadataProviders() {
  for (let i = providers.length - 1; i >= 0; i--) if (!providers[i].builtin) providers.splice(i, 1);
  for (let i = catalogBlocks.length - 1; i >= 0; i--) if (!catalogBlocks[i][2]) catalogBlocks.splice(i, 1);
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
 *  configured, in order; the hosted service when none is. `sources` is a
 *  library's own list; without one the app-wide list applies. */
export function enabledMetadataProviders(config, sources = null) {
  const own = sources ? parseMetadataSources(sources) : [];
  const order = own.length ? own : metadataSourceOrder(config);
  const usable = order.map(byId).filter((p) => p && p.isConfigured(config));
  return usable.length ? usable : [hosted()];
}

// Libraries come from the database; index.js installs the readers.
let libraryResolver = { ofRecord: () => null, sourcesOf: () => null };
/** Install { ofRecord(kind, id) → libraryId|null, sourcesOf(libraryId) → list|null }. */
export function setLibraryResolver(r) {
  libraryResolver = {
    ofRecord: typeof r?.ofRecord === 'function' ? r.ofRecord : () => null,
    sourcesOf: typeof r?.sourcesOf === 'function' ? r.sourcesOf : () => null,
  };
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


/** One client over the enabled providers: each lookup goes to the provider
 *  that serves the record's catalog; searches ask everyone and merge. */
export function makeCompositeClient(config, opts = {}) {
  const { libraryId: boundLibrary = null, ...clientOpts } = opts;
  // One client set per distinct source list (the app-wide one, or a
  // library's own), built on first use.
  const sets = new Map();
  const setFor = (libraryId) => {
    let src = null;
    try { src = libraryId != null ? libraryResolver.sourcesOf(libraryId) : null; } catch { src = null; }
    const key = src ? parseMetadataSources(src).join(',') : '';
    if (!sets.has(key)) sets.set(key, enabledMetadataProviders(config, key || null).map((p) => ({ p, c: p.makeClient(config, clientOpts) })));
    return sets.get(key);
  };
  const libraryFor = (kind, id) => {
    let lib = null;
    try { lib = libraryResolver.ofRecord(kind, id); } catch { lib = null; }
    return lib ?? boundLibrary;
  };
  const clients = setFor(boundLibrary);

  // Native first, in the library's order; then a cross-reference; then a
  // provider from before catalogs existed (see registerMetadataProvider).
  const providerFor = (set, catalog) => (catalog && set.find((x) => x.p.serves.includes(catalog)))
    || (catalog && set.find((x) => x.p.alsoServes.includes(catalog)))
    || set.find((x) => x.p.fallback)
    || (!catalog && set.length === 1 ? set[0] : null);
  const route = (kind, id) => {
    const catalog = catalogOf(kind, id);
    const hit = providerFor(kind === 'arc' ? clients : setFor(libraryFor(kind, id)), catalog);
    if (!hit) {
      // People without the admin console see this, and they never see source
      // names: only a generic description of the catalog may appear.
      const where = GENERIC_CATALOG_NAMES[catalog] ? ` (it comes from ${GENERIC_CATALOG_NAMES[catalog]})` : '';
      const hint = catalog === 'mangadex' ? ' Manga comes through the built-in metadata service; turn it on under Settings → Metadata.' : '';
      throw new Error(`None of the enabled metadata sources can look this up${where}.${hint}`);
    }
    return { ...hit, catalog };
  };
  // Results carry where they came from, so the cache records it.
  const stamp = (rec, hit, id) => {
    if (!rec || typeof rec !== 'object') return rec;
    const out = { ...rec, meta_source: rec.meta_source ?? hit.catalog };
    if (out.meta_ref == null && hit.p.serves.includes(hit.catalog)) out.meta_ref = hit.p.refOf(hit.catalog, id, rec) ?? null;
    if (Array.isArray(rec.issues)) {
      // Stubs are fresh records minted by whoever answered: their own block
      // says which catalog they belong to (a provider answering through a
      // cross-reference hands back stubs from its own catalog).
      out.issues = rec.issues.map((iss) => (iss && typeof iss === 'object' ? { ...iss, meta_source: iss.meta_source ?? classifyId(iss.id) ?? hit.catalog } : iss));
    }
    return out;
  };
  const nativeCatalog = (x) => x.p.serves[0] || null;
  // Ask everyone in the library's list; a source that fails is left out
  // unless they all fail.
  async function fanOut(method, libraryId, ...args) {
    const able = setFor(libraryId).filter((x) => typeof x.c[method] === 'function');
    const settled = await Promise.allSettled(able.map((x) => x.c[method](...args)));
    const lists = [];
    let firstErr = null;
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        const x = able[i];
        lists.push((Array.isArray(r.value) ? r.value : []).map((v) => (v && typeof v === 'object' ? { ...v, meta_source: v.meta_source ?? classifyId(v.id) ?? nativeCatalog(x) } : v)));
      } else { firstErr ??= r.reason; console.warn(`metadata ${method} failed on ${able[i].p.id}:`, r.reason?.message || r.reason); }
    });
    if (!lists.length && firstErr) throw firstErr;
    return mergeSearchResults(lists);
  }
  // Error messages people see are source-neutral; the server log (admins
  // only) records which source failed.
  const logged = (method, h, call) => Promise.resolve().then(call).catch((e) => {
    console.warn(`metadata ${method} failed on ${h.p.id}:`, e?.message || e);
    throw e;
  });
  const composite = {
    search: (q, o) => { const { libraryId, ...rest } = o || {}; return fanOut('search', libraryId ?? boundLibrary, q, rest); },
    async volume(id) { const h = route('volume', id); return stamp(await logged('volume', h, () => h.c.volume(id, { catalog: h.catalog })), h, id); },
    async issue(id) { const h = route('issue', id); return stamp(await logged('issue', h, () => h.c.issue(id, { catalog: h.catalog })), h, id); },
    async findIssue(volumeId, number) { const h = route('volume', volumeId); return stamp(await logged('findIssue', h, () => h.c.findIssue(volumeId, number, { catalog: h.catalog })), h, null); },
    async storyArcIssues(arcId) { const h = route('arc', arcId); return logged('storyArcIssues', h, () => h.c.storyArcIssues(arcId, { catalog: h.catalog })); },
    searchArcs: (q) => fanOut('searchArcs', boundLibrary, q),
    // The same client, for one library's list (searches and new adds made
    // on that library's behalf).
    forLibrary: (libraryId) => (libraryId == null || libraryId === boundLibrary ? composite : makeCompositeClient(config, { ...opts, libraryId })),
    async issuesByIds(ids) {
      const groups = new Map();
      for (const id of ids || []) {
        let h;
        try { h = route('issue', id); } catch { continue; } // nobody enabled can answer: simply absent
        const key = h.p.id + '|' + h.catalog;
        if (!groups.has(key)) groups.set(key, { h, ids: [] });
        groups.get(key).ids.push(id);
      }
      const out = [];
      for (const { h, ids: group } of groups.values()) {
        for (const r of await logged('issuesByIds', h, () => h.c.issuesByIds(group))) out.push(stamp(r, h, r?.id));
      }
      return out;
    },
  };
  // Discover and other list-driven features need a ComicVine-shaped feed;
  // the first enabled provider that has one serves it.
  const lister = clients.find((x) => typeof x.c.list === 'function');
  if (lister) composite.list = (...args) => lister.c.list(...args);
  // One provider: keep whatever else its client offers (its name, extras),
  // with the routed methods on top.
  if (clients.length === 1) return { ...clients[0].c, ...composite };
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
