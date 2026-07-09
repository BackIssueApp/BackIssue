// Plugin registry + loader.
//
// The app is distributed with a set of built-in capabilities (currently the
// usenet download source). Additional capabilities can be dropped in as external
// plugins under plugins/<name>/index.js — used to keep private, non-distributable
// features (e.g. a private catalog/reader source) out of the public tree. A plugin's
// default export is `register(api)`, called with the same API the built-ins use.
//
// The plugins/ directory is OPTIONAL. Its absence is the normal state for the
// public distribution; the app runs fully without any external plugin.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import config from './config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGINS_DIR = process.env.PLUGINS_DIR || path.join(root, 'plugins');

// Let plugins that live OUTSIDE the app tree (e.g. Docker's
// PLUGINS_DIR=/data/plugins) reach core. Plugins reach it two ways, both of
// which assume the plugin sits at <appRoot>/plugins/<name> — so `../..` is the
// app root:
//   • relative imports:   import config from '../../src/config.js'
//   • bare shared deps:    import Database from 'better-sqlite3'
// When PLUGINS_DIR is elsewhere, `../..` points at the plugins dir's parent
// (/data), not /app. Recreate the app root there by symlinking the app's src/
// and node_modules/ beside the plugins dir. No-op in dev, where the plugins dir
// already sits under the app root and both are present.
function linkCoreModules(dir) {
  const parent = path.dirname(dir); // '../..' from a plugin resolves here
  for (const item of ['src', 'node_modules']) {
    try {
      const target = path.join(root, item);
      const link = path.join(parent, item);
      if (!fs.existsSync(target) || fs.existsSync(link)) continue;
      fs.symlinkSync(target, link, 'junction'); // junction on Windows; plain symlink on posix
      console.log(`Linked ${item} beside ${dir} for plugin resolution`);
    } catch (e) { console.warn(`plugin resolution link (${item}) failed:`, e?.message || e); }
  }
}

// A plugin's OWN dependencies (its package.json "dependencies") aren't in the
// app's node_modules and aren't shipped in the source-only catalog bundle, so
// install them into the plugin folder once. Prebuilt-binary deps (sharp,
// better-sqlite3) install without a compiler, so this works on the slim image.
// Best-effort: a failure is logged and the plugin still loads (a dep it needs
// will surface its own clear error).
function ensurePluginDeps(dir, name) {
  try {
    const pkgPath = path.join(dir, name, 'package.json');
    if (!fs.existsSync(pkgPath)) return;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (!pkg.dependencies || !Object.keys(pkg.dependencies).length) return;
    if (fs.existsSync(path.join(dir, name, 'node_modules'))) return; // already installed
    console.log(`Installing dependencies for plugin "${name}"…`);
    const r = spawnSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'],
      { cwd: path.join(dir, name), stdio: 'inherit', shell: process.platform === 'win32' });
    if (r.status !== 0) console.warn(`plugin "${name}": dependency install exited ${r.status}`);
  } catch (e) { console.warn(`plugin "${name}" dependency install failed:`, e?.message || e); }
}

const sources = [];
const settings = [];   // { key: spec } objects, merged into SETTING_FIELDS
const startups = [];   // async ({ db, config }) => optional handle; run once at boot
const routes = [];     // { method, path, handler } express routes
const jobs = [];       // { id, label, run, scheduleKey, defaultHours } schedulable jobs
const clientAssets = []; // { name, js?, css? } — front-end files served + injected
const permissions = []; // { key, label, description, tier, plugin } — role-assignable perms
const authProviders = []; // { id, label, loginPath } — external login (SSO/OIDC) buttons
const credentialProviders = []; // async (username, password) => identity | null — external password backends

// Per-plugin catalog for the management page: everything discovered on disk,
// loaded or not. name → { name, version, description, enabled, loaded, error, counts }.
const catalog = new Map();

function bump(kind) {
  const info = catalog.get(currentLoadingPlugin);
  if (info) info.counts[kind]++;
}

// The API surface handed to every register() function — built-in and external
// alike. A plugin uses only the hooks it needs.
export const pluginApi = {
  // A download source (find/fetch or find/grab). See src/sources/usenet.js.
  registerSource(source) {
    if (!source?.id) throw new Error('registerSource: a source needs an id');
    if (sources.some((s) => s.id === source.id)) return; // idempotent — ignore dupes
    sources.push(source);
    bump('sources');
  },
  // Settings field specs (same shape as SETTING_FIELDS), merged so the plugin's
  // config keys survive validation and persist. e.g. { myKey: { type: 'bool' } }.
  registerSettings(fields) {
    if (fields && typeof fields === 'object') { settings.push(fields); bump('settings'); }
  },
  // A startup task run once after the DB and config are ready. May be async and
  // may return a handle the plugin keeps (e.g. a browser context).
  registerStartup(fn) {
    if (typeof fn === 'function') { startups.push(fn); bump('startups'); }
  },
  // A named permission this plugin's routes can require and admins can grant
  // to roles. tier decides which BUILT-IN roles get it ('viewer' | 'trusted' |
  // 'admin'); custom roles pick it from the catalog explicitly.
  registerPermission(perm) {
    if (!perm?.key || permissions.some((p) => p.key === perm.key)) return;
    permissions.push({
      key: String(perm.key),
      label: perm.label || String(perm.key),
      description: perm.description || '',
      tier: ['viewer', 'trusted', 'admin'].includes(perm.tier) ? perm.tier : 'trusted',
      plugin: currentLoadingPlugin,
    });
    bump('permissions');
  },
  // An Express route. handler is (req, res). Registered after core routes.
  // opts.access declares what the route needs: 'public', a role tier
  // ('viewer' | 'trusted' | 'admin'), or a permission key the plugin
  // registered via registerPermission. Default: GET → viewer, else trusted.
  registerRoute(method, routePath, handler, opts = {}) {
    if (typeof handler === 'function') {
      const m = String(method).toLowerCase();
      const access = (typeof opts.access === 'string' && opts.access)
        ? opts.access
        : (m === 'get' ? 'viewer' : 'trusted');
      // basicAuth: on a 401, advertise WWW-Authenticate so machine clients
      // (OPDS readers) know to send HTTP Basic. The browser SPA leaves this
      // off so it never triggers a native Basic dialog.
      routes.push({ method: m, path: routePath, handler, access, basicAuth: !!opts.basicAuth });
      bump('routes');
    }
  },
  // A schedulable background job. `run(ctx)` is async and receives
  // { db, startDownloads } — the live core DB connection and a kick for the
  // download queue — so a job can queue issues without importing core
  // internals. `scheduleKey` is the legacy '<x>Hours' config key whose
  // '<x>Cron'/'<x>Enabled' twins drive it on the Jobs page.
  registerJob(job) {
    if (job?.id && typeof job.run === 'function') { jobs.push(job); bump('jobs'); }
  },
  // Front-end assets: js/css paths relative to the plugin's own directory. Core
  // serves them at /plugins/<name>/<path> and injects them into the page, where
  // the script wires its UI via window.BackIssue.
  registerClientAsset(asset) {
    if (asset && (asset.js || asset.css)) {
      clientAssets.push({ name: asset.name || currentLoadingPlugin, js: asset.js || null, css: asset.css || null });
      bump('assets');
    }
  },
  // An external login method (SSO/OIDC). The login page shows a "Sign in with
  // <label>" button that sends the browser to loginPath (a public plugin route
  // that starts the provider's flow). After the provider verifies the user, the
  // plugin's callback route calls req.app.locals.issueSession(...) to sign them
  // in. { id, label, loginPath }.
  registerAuthProvider(provider) {
    if (!provider?.id || !provider?.loginPath) return;
    if (authProviders.some((p) => p.id === provider.id)) return;
    authProviders.push({
      id: String(provider.id),
      label: provider.label || String(provider.id),
      loginPath: String(provider.loginPath),
      plugin: currentLoadingPlugin,
    });
  },
  // A password backend for the standard login form. `fn(username, password)`
  // resolves to a VERIFIED identity ({ provider, subject, email?, name?,
  // defaultRole? }) or null (not this backend's user / bad credentials). Core
  // tries these only after local password auth fails, then issues the session.
  // Used for e.g. WHMCS or LDAP where the password is checked against a remote.
  registerCredentialProvider(fn) {
    if (typeof fn === 'function') credentialProviders.push(fn);
  },
};

// The plugin currently running its register() — so registerClientAsset can stamp
// the owning plugin name without the plugin passing it explicitly.
let currentLoadingPlugin = null;

// Live views of what plugins (and built-ins) have registered.
export function registeredAuthProviders() { return authProviders; }
export function registeredCredentialProviders() { return credentialProviders; }
export function registeredSources() { return sources; }
export function registeredSettings() { return Object.assign({}, ...settings); }
export function registeredStartups() { return startups; }
export function registeredRoutes() { return routes; }
export function registeredJobs() { return jobs; }
export function registeredClientAssets() { return clientAssets; }
export function registeredPermissions() { return permissions; }
// Absolute path to the plugins directory (for serving plugin client files).
export function pluginsDir() { return PLUGINS_DIR; }

// Optional plugin metadata from plugins/<name>/package.json.
function readMeta(dir, name) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, name, 'package.json'), 'utf8'));
    return { version: pkg.version || null, description: pkg.description || null };
  } catch {
    return { version: null, description: null };
  }
}

// Scan one directory for plugins/<name>/index.js and run each default export as
// register(api) — except names in `disabled`, which are cataloged but never
// imported. Not memoized — the caller controls invocation. A plugin that
// throws is logged, cataloged with its error, and skipped, never fatal.
// Returns the names loaded.
export async function loadPluginsFromDir(dir, api = pluginApi, disabled = []) {
  const loaded = [];
  if (!dir || !fs.existsSync(dir)) return loaded;
  linkCoreModules(dir); // shared core deps resolvable from plugins outside the app tree
  // Sweep updater leftovers: replaced installs renamed aside (Windows can't
  // delete a dir whose native DLL the old process had loaded) and dead staging
  // dirs. At boot nothing holds them, so removal succeeds now.
  for (const name of fs.readdirSync(dir)) {
    if (/^\..+\.(old-\d+|installing)$/.test(name)) {
      try { fs.rmSync(path.join(dir, name), { recursive: true, force: true }); }
      catch { /* still held? next boot */ }
    }
  }
  for (const name of fs.readdirSync(dir).sort()) {
    if (name.startsWith('.') || name === 'node_modules') continue;
    const entry = path.join(dir, name, 'index.js');
    if (!fs.existsSync(entry)) continue;
    if (!disabled.includes(name)) ensurePluginDeps(dir, name); // plugin's own deps (once)
    const info = {
      name,
      ...readMeta(dir, name),
      enabled: !disabled.includes(name),
      loaded: false,
      error: null,
      counts: { sources: 0, settings: 0, startups: 0, routes: 0, jobs: 0, assets: 0, permissions: 0 },
    };
    catalog.set(name, info);
    if (!info.enabled) {
      console.log(`Plugin disabled (skipped): ${name}`);
      continue;
    }
    try {
      const mod = await import(pathToFileURL(entry).href);
      const register = mod.default || mod.register;
      if (typeof register !== 'function') {
        info.error = 'index.js has no default export function';
        console.warn(`plugin "${name}": ${info.error}`);
        continue;
      }
      currentLoadingPlugin = name;
      try { await register(api); } finally { currentLoadingPlugin = null; }
      info.loaded = true;
      loaded.push(name);
      console.log(`Loaded plugin: ${name}`);
    } catch (e) {
      info.error = String(e?.message || e);
      console.warn(`plugin "${name}" failed to load:`, info.error);
    }
  }
  return loaded;
}

/// The management page's view: every plugin found on disk, with load state and
/// what it registered. A plugin whose enabled flag differs from its loaded
/// state needs a restart to apply.
export function pluginCatalog() {
  return [...catalog.values()].map((p) => ({
    ...p,
    restartRequired: p.enabled !== p.loaded && !(p.enabled && p.error),
  }));
}

/// Flip a plugin's desired state in the catalog (persistence is the caller's
/// job — the loaded state only changes on restart).
export function setPluginEnabled(name, enabled) {
  const info = catalog.get(name);
  if (info) info.enabled = !!enabled;
  return info || null;
}

/// The disabled list as persisted in settings.json, read directly (the settings
/// MODULE imports this one so we can't import it back — but config.js is
/// cycle-free) from the data dir, where settings.json actually lives. This used
/// to read the app root, which equals the data dir in dev but not in Docker
/// (DATA_DIR=/data) — so disabling a plugin never survived a container restart.
export function disabledPluginNames() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(config.dataDir, 'settings.json'), 'utf8'));
    return String(s.disabledPlugins || '').split(',').map((n) => n.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

let loadPromise = null;

// Discover and register external plugins from the configured PLUGINS_DIR.
// Idempotent — safe to await from multiple entry points (startup, queue).
export function loadPlugins() {
  if (!loadPromise) loadPromise = loadPluginsFromDir(PLUGINS_DIR, pluginApi, disabledPluginNames());
  return loadPromise;
}
