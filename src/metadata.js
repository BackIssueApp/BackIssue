// Metadata providers: where series and issue data comes from.
//
// A provider turns the instance config into a client with the ComicVine
// client's method surface (search, volume, issue, issuesByIds, findIssue, and
// optionally list, searchArcs, storyArcIssues). Three are built in: the hosted
// BackIssue metadata service (the default), ComicVine with the user's own key,
// and Metron with the user's own account. Plugins add more through
// api.registerMetadataProvider. `metadataSource` in settings names the one in
// use; a selected provider that is not configured (no key, no account) falls
// back to the hosted service rather than failing every lookup.
//
// Every caller still builds its client through makeCvClient (plugins import
// it), so the switch lives in a dispatcher installed into cv.js: for a
// non-built-in source makeCvClient hands the config here and gets the
// provider's client back. Nothing downstream knows which provider answered.
import { makeCvClient, installMetadataDispatcher, cvKey } from './cv.js';
import { makeMetronClient } from './metron.js';

const SLUG = /^[a-z0-9][a-z0-9_-]{0,31}$/;

const providers = [
  {
    id: 'hosted',
    label: 'BackIssue metadata service (built-in, no setup)',
    builtin: true,
    fields: [],
    isConfigured: () => true,
    makeClient: (cfg, opts) => makeCvClient(cfg, { ...opts, noDispatch: true }),
  },
  {
    id: 'comicvine',
    label: 'ComicVine directly (your own API key)',
    builtin: true,
    note: "ComicVine's API is rate-limited (about 200 requests per resource per hour, with velocity checks on top). Big imports, library scans and release matching will pause when the limit is hit and can take much longer.",
    fields: [{ key: 'comicvineKeys', label: 'ComicVine API key', type: 'text', placeholder: 'Free at comicvine.gamespot.com' }],
    isConfigured: (cfg) => !!cvKey(cfg?.comicvineKeys),
    makeClient: (cfg, opts) => makeCvClient(cfg, { ...opts, noDispatch: true }),
    async test(cfg) {
      const key = cvKey(cfg?.comicvineKeys);
      if (!key) return { ok: false, message: 'Enter an API key.' };
      const client = makeCvClient({ ...cfg, metadataSource: 'comicvine' }, { key, politeMs: 0, noDispatch: true });
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
    makeClient: (cfg, opts) => makeMetronClient(cfg, opts),
    test: (cfg) => makeMetronClient(cfg, { politeMs: 0 }).test(),
  },
];

/**
 * Add a provider: { id, label, fields?, note?, isConfigured?(config), makeClient(config, opts), test?(config) }.
 *   id        a slug; this is what `metadataSource` holds when the provider is chosen
 *   fields    the settings the provider needs, rendered on Settings → Metadata:
 *             [{ key, label, type: 'text' | 'password', placeholder? }]. The keys
 *             must also be registered through api.registerSettings so they persist.
 *   makeClient(config, { fetchImpl?, politeMs? }) → the client (see cv.js makeCvClient
 *             for the method contract; `list` is optional and ComicVine-specific).
 *   isConfigured(config) → false means "fall back to the built-in service" (default: true).
 *   test(config) → { ok, message } for the Settings Test button (default: a search).
 * Idempotent per id; a built-in id cannot be replaced.
 */
export function registerMetadataProvider(p, plugin = null) {
  const id = String(p?.id || '').toLowerCase();
  if (!SLUG.test(id) || !p?.label || typeof p.makeClient !== 'function') return false;
  if (providers.some((x) => x.id === id)) return false;
  const fields = (Array.isArray(p.fields) ? p.fields : [])
    .filter((f) => f?.key && /^[A-Za-z][A-Za-z0-9_]*$/.test(String(f.key)))
    .map((f) => ({ key: String(f.key), label: String(f.label || f.key), type: f.type === 'password' ? 'password' : 'text', placeholder: f.placeholder ? String(f.placeholder) : '' }));
  providers.push({
    id, label: String(p.label), note: p.note ? String(p.note) : '', fields, plugin, builtin: false,
    isConfigured: typeof p.isConfigured === 'function' ? p.isConfigured : () => true,
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

/** The provider `metadataSource` names (hosted when it names none). */
export function selectedMetadataProvider(config) {
  return providers.find((p) => p.id === String(config?.metadataSource || '')) || hosted();
}

/** The provider lookups actually go to: the selected one when it is
 *  configured, else the hosted service. */
export function activeMetadataProvider(config) {
  const p = selectedMetadataProvider(config);
  return p.isConfigured(config) ? p : hosted();
}

/** What Settings → Metadata renders. Never includes field values. */
export function metadataProviderList(config) {
  const active = activeMetadataProvider(config).id;
  return providers.map((p) => ({
    id: p.id, label: p.label, note: p.note || '', fields: p.fields, builtin: !!p.builtin, plugin: p.plugin || null,
    configured: !!p.isConfigured(config), active: p.id === active, selected: selectedMetadataProvider(config).id === p.id,
  }));
}

/** A client for the active provider. */
export function makeMetadataClient(config, opts = {}) {
  return activeMetadataProvider(config).makeClient(config, opts);
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

// makeCvClient asks here first; null means "handle it yourself" (a built-in
// source, or a plugin provider that is not configured, which falls back to
// the hosted service exactly like ComicVine-direct without a key does).
installMetadataDispatcher((config, opts) => {
  if (opts?.noDispatch) return null;
  const p = selectedMetadataProvider(config);
  if (p.builtin && p.id !== 'metron') return null;
  if (!p.isConfigured(config)) return null;
  return p.makeClient(config, opts);
});
