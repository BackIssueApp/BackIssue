import express from 'express';
import compression from 'compression';
import path from 'node:path';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import fssync from 'node:fs';
import { fileURLToPath } from 'node:url';
import config from './config.js';
import { listSeries, listIssues, queueIssues, countByStatus, requeueFailed, clearFailed, setFollowed, listQueue, cancelQueued, cancelIssue, collectionSeries, seriesCollectionDetail, setSeriesPath, getSeriesById, getCvIssue, ensureCvIssueRow, clearIssuesForRedownload, listImportHistory, listFailedGrabs, listWantedIssues, activePackGrabs, listCvIssues, setSeriesRestricted, isSeriesRestricted, restrictedSeriesIds, isCvIssueRestricted, setUserFollow, updateCvSeriesUser, updateCvIssueUser, resetCvSeriesUser, resetCvIssueUser } from './db.js';
import { resolveSeriesDir, defaultRootedDir } from './paths.js';
import { planSeries, refileSeries, planLibrary, canRefile } from './refile.js';
import { seriesFolderFromPattern, fileStemFromPattern } from './naming.js';
import { normalizeNumber } from './matcher.js';
import { testIndexer } from './newznab.js';
import { testClient } from './nzbclients.js';
import { testTorznabIndexer } from './torznab.js';
import { testTorrentClient } from './torrentclients.js';
import { pluginsDir, pluginCatalog, setPluginEnabled, registeredRoutes, registeredPermissions, registeredAuthProviders, registeredCredentialProviders } from './plugins.js';
import { fetchCatalog, installPlugin, uninstallPlugin } from './plugincatalog.js';
import * as users from './users.js';
import * as lists from './lists.js';
import * as notifications from './notifications.js';
import { createEventHub } from './events.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The UI is a built Svelte app — `npm run build` writes it to frontend/dist.
const publicDir = path.join(repoRoot, 'frontend', 'dist');
// App version for the UI (About) — read once from package.json. Dev/nightly
// images stamp BUILD_CHANNEL (+ short BUILD_SHA) at image build, so a rolling
// build identifies itself ("0.5.0-dev.a1b2c3d") instead of masquerading as the
// release it was cut from.
let APP_VERSION = '0.0.0';
try { APP_VERSION = JSON.parse(fssync.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version || APP_VERSION; } catch { /* dev */ }
if (process.env.BUILD_CHANNEL && process.env.BUILD_CHANNEL !== 'release') {
  const sha = String(process.env.BUILD_SHA || '').slice(0, 7);
  APP_VERSION += `-${process.env.BUILD_CHANNEL}${sha ? '.' + sha : ''}`;
}

export function createApp({ db, runDownloads, prepareRedownload, runCvMatch, cvSearch, cvVolumeInfo, cvIssueInfo, arcSearch, arcIssues, cleanupSeriesFiles, runImportScan, runImport, importState, runTool, toolsState, runLibraryRefile, refileState, stats, listSources, queueProgress, packProgress, cancelGrab, testCvKeys, usenetSearch, usenetGrab, torrentSearch, torrentGrabPack, searchSources, manualGrabResult, grabSourcePack, searchPacks, grabPack, setAliases, pluginRoutes = [], pluginClientAssets = [], matchImportCandidate, confirmImportCandidate, skipImportCandidate, cvSetManual, addFromCv, scanSeriesFolder, deleteComic, refreshVolume, tagSeriesFiles, checkReleases, listJobs, clearJobs, listLogs, clearLogs, listSchedules, setScheduleCron, runScheduleNow, getSettings, saveSettings, requestRestart, state }) {
  const startDownloads = (arg) => {
    if (!state.queue.running) {
      state.queue.running = true;
      Promise.resolve(runDownloads(arg))
        .catch((e) => { state.queue.error = String(e); })
        .finally(() => { state.queue.running = false; });
    }
  };
  const app = express();
  // Behind a reverse proxy (the intended deployment), trust it so req.ip is
  // the real client — makes per-client rate limiting and the Secure-cookie
  // decision correct. Off by default so a DIRECT deploy never trusts a
  // spoofed X-Forwarded-For. Set trustProxy to true / a hop count / a subnet.
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);
  app.use(express.json()); // 100kb default body cap — fine for this API

  // gzip responses — a 2,000-issue volume detail is ~1MB of JSON raw, ~10x
  // smaller compressed, which matters on WiFi tablets. SSE must stay
  // unbuffered, and reader/OPDS page images + downloads are already-compressed
  // bytes (compression's type filter skips those).
  app.use(compression({ filter: (req, res) => req.path !== '/api/events' && compression.filter(req, res) }));

  // Security headers on every response. The UI is a same-origin SPA that
  // loads only its own assets + inline plugin bootstrap, so a strict CSP is
  // safe and shuts down clickjacking + MIME sniffing across the admin surface.
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    // Images come from the R2/ComicVine mirror and the reader's own routes;
    // scripts/styles are self + the inline bootstrap (needs 'unsafe-inline').
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; "
      + "script-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    next();
  });

  // Plugins can queue download rows themselves (db.js is importable) but the
  // worker kick is a closure — expose it so plugin route handlers can start
  // the queue via req.app.locals.startDownloads().
  app.locals.startDownloads = () => startDownloads();

  // ---- Users, sessions, and role-gated access -----------------------------
  // Roles: viewer < trusted < admin (src/users.js). The UI shell and assets
  // are public (the login page needs them); /api/* and /plugins/* require a
  // session cookie or HTTP Basic credentials verified against the users table.
  users.initUserTables(db);
  lists.initListTables(db);
  notifications.initNotificationTables(db);
  // Plugins (and core call sites) raise notifications through this — the
  // module owns persistence + webhook dispatch.
  app.locals.notify = (event) => notifications.notify(db, event);
  // One-time migration: the legacy single-account basic auth (Settings →
  // Server) becomes the first admin user, so existing installs keep their
  // credentials working — now against the users table.
  if (users.userCount(db) === 0 && config.authUser && config.authPass) {
    try {
      users.createUser(db, { username: config.authUser, password: config.authPass, role: 'admin' });
      console.log(`migrated legacy basic-auth credentials to admin user "${config.authUser}"`);
      // The plaintext password has no business staying in settings.json once
      // it lives (hashed) in the users table.
      if (typeof saveSettings === 'function') saveSettings({ authUser: '', authPass: '' });
    } catch (e) { console.warn('legacy auth migration failed:', e?.message || e); }
  }
  setInterval(() => { try { users.pruneSessions(db); } catch { /* next sweep */ } }, 6 * 3600 * 1000).unref();

  const COOKIE = 'bi_session';
  const NOBASIC = 'bi_nobasic'; // set on logout: "ignore my browser's cached Basic credentials"
  const readCookie = (req, name = COOKIE) => {
    const raw = String(req.headers.cookie || '');
    for (const part of raw.split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === name) return v.join('=');
    }
    return null;
  };
  const setSessionCookie = (req, res, token) => {
    const secure = req.secure || String(req.headers['x-forwarded-proto'] || '').includes('https');
    res.setHeader('Set-Cookie', [
      `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}${secure ? '; Secure' : ''}`,
      // an explicit sign-in re-enables Basic for this browser
      `${NOBASIC}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
    ]);
  };
  const clearSessionCookie = (res) => {
    res.setHeader('Set-Cookie', [
      `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
      // Browsers cache Basic credentials (from the pre-user-system era) and
      // silently re-send them forever — without this marker, logging out
      // would instantly re-authenticate the browser via Basic.
      `${NOBASIC}=1; Path=/; HttpOnly; SameSite=Lax; Max-Age=${365 * 86400}`,
    ]);
  };

  // Brute-force throttle key: source ip + claimed username. Applied to login,
  // register, AND failed Basic attempts — Basic hits the same password check.
  const authKey = (req, username) => `${req.ip || '?'}|${String(username || '').toLowerCase()}`;

  const resolveUser = (req) => {
    const token = readCookie(req);
    if (token) {
      const u = users.sessionUser(db, token);
      if (u) return u;
    }
    // Personal API key (third-party clients): `X-Api-Key: bi_…` or
    // `Authorization: Bearer bi_…`. Resolves to the key's user, so the normal
    // role/permission checks below clamp exactly like an interactive session.
    // Browsers never attach these headers on their own, so no CSRF exposure.
    const hdr = String(req.headers.authorization || '');
    const apiKey = String(req.headers['x-api-key'] || (hdr.startsWith('Bearer ') ? hdr.slice(7) : '')).trim();
    if (apiKey) return users.apiKeyUser(db, apiKey);
    if (readCookie(req, NOBASIC) === '1') return null; // logged out: ignore cached Basic
    if (hdr.startsWith('Basic ')) {
      const [name, ...rest] = Buffer.from(hdr.slice(6), 'base64').toString().split(':');
      const key = authKey(req, name);
      if (users.authBlockedFor(key)) return null; // locked out → plain 401, no scrypt spend
      const u = users.verifyBasicCached(db, name, rest.join(':'));
      if (u) users.authSucceeded(key); else users.authFailed(key);
      return u;
    }
    return null;
  };

  // External credential backends (a WHMCS/LDAP plugin) also verify HTTP Basic
  // credentials — so an OPDS reader, or any Basic client, signs in with the
  // very same account it uses on the web login form. This runs ONLY after
  // local Basic verification has already missed (resolveUser returned null)
  // and a provider is registered. The verified pair is cached for a few
  // minutes so we don't call the backend on every request (Basic is re-sent on
  // each one) — mirroring verifyBasicCached for local passwords.
  const providerBasicCache = new Map(); // name+passwordHash -> { user, until }
  const verifyBasicViaProviders = async (username, password) => {
    const ck = `${String(username).toLowerCase()}:${crypto.createHash('sha256').update(String(password)).digest('hex')}`;
    const hit = providerBasicCache.get(ck);
    if (hit && hit.until > Date.now()) return hit.user;
    for (const provider of registeredCredentialProviders()) {
      let identity = null;
      try { identity = await provider(String(username || ''), String(password || '')); }
      catch { /* the provider logs its own errors; treat as no match */ }
      if (identity && identity.subject) {
        // Matched this backend: provision/link the local account (same path as
        // the login form's issueSession, minus the session cookie).
        let user = null;
        try { user = users.resolveExternalUser(db, { defaultRole: 'viewer', ...identity }); }
        catch { user = null; }
        if (!user || user.disabled) return null;
        providerBasicCache.set(ck, { user, until: Date.now() + 5 * 60_000 });
        if (providerBasicCache.size > 500) providerBasicCache.clear(); // crude cap
        return user;
      }
    }
    return null;
  };
  const resolveUserViaProviders = async (req) => {
    const hdr = String(req.headers.authorization || '');
    if (!hdr.startsWith('Basic ')) return null;         // only Basic falls through
    if (readCookie(req, NOBASIC) === '1') return null;   // logged out: ignore cached Basic
    if (!registeredCredentialProviders().length) return null;
    const [name, ...rest] = Buffer.from(hdr.slice(6), 'base64').toString().split(':');
    const key = authKey(req, name);
    if (users.authBlockedFor(key)) return null;          // respect the lockout; don't probe the backend
    const user = await verifyBasicViaProviders(name, rest.join(':'));
    // resolveUser already recorded this key's local-Basic miss for the request;
    // only a provider SUCCESS needs to clear it. A miss leaves that one failure.
    if (user) users.authSucceeded(key);
    return user;
  };

  // ---- permission catalog + per-request resolution -------------------------
  // Every gated action is a named permission (users.CORE_PERMISSIONS plus
  // whatever loaded plugins registered). Roles grant permission sets: the
  // built-ins by tier, custom roles by explicit list (see src/users.js).
  const permCatalog = new Map(
    [...users.CORE_PERMISSIONS, ...registeredPermissions()].map((p) => [p.key, p]),
  );
  // May this request see mature/restricted series? Drives content filtering on
  // every surface that lists or opens series/issues.
  const canRestricted = (req) => users.roleGrants(db, req.user.role, 'library.restricted', permCatalog);
  // The notification categories whose BROADCASTS this user may see: each
  // category requires one of its mapped permissions (open mode sees all;
  // targeted rows always reach their user regardless).
  const notifCategories = (req) => {
    if (!req.user || req.user.id === 0) return Object.keys(notifications.CATEGORIES); // open mode
    return Object.keys(notifications.CATEGORIES).filter((c) =>
      (notifications.CATEGORY_VISIBILITY[c] || []).some((p) => users.roleGrants(db, req.user.role, p, permCatalog)));
  };
  // Permission required for a request. Specific rules first, then the default:
  // reads are library.view, mutations are library.manage. Downloads are
  // deliberately their own permission (policy: a role may queue downloads
  // without being able to reshape the library).
  const PERM_RULES = [
    [/^\/api\/settings/, 'settings.manage'], [/^\/api\/indexers/, 'settings.manage'],
    // Connection tests reach arbitrary hosts with credentials (SSRF + probing)
    // — admin only. Routes are named <thing>/test, so match /test at the end.
    [/\/test$/, 'settings.manage'],
    [/^\/api\/users/, 'users.manage'], [/^\/api\/roles/, 'users.manage'], [/^\/api\/permissions$/, 'users.manage'],
    [/^\/api\/plugins(?!\/client)/, 'plugins.manage'], [/^\/api\/restart$/, 'plugins.manage'],
    [/^\/api\/jobs/, 'system.jobs'], [/^\/api\/schedules/, 'system.jobs'], [/^\/api\/tools/, 'system.jobs'],
    [/^\/api\/logs/, 'system.logs'],
    // Import (candidate file paths, scan dirs) is a library-management feature.
    [/^\/api\/import/, 'library.manage'],
    // Library-wide reorganize is a maintenance tool (admin); naming preview is
    // part of settings.
    [/^\/api\/library\//, 'system.jobs'],
    [/^\/api\/naming\//, 'settings.manage'],
    // Reading lists are personal curation (no files touched) — any signed-in
    // user manages their own, including non-GET verbs.
    [/^\/api\/lists/, 'library.view'],
    // Personal follows likewise: each user curates their own pull list.
    [/^\/api\/collection\/\d+\/follow$/, 'library.view'],
    // The download queue is download-pipeline visibility, not general library
    // data — a read-only viewer shouldn't see what others are grabbing. Reading
    // the queue needs downloads.grab, same as the /queue view in the web UI.
    // ($-anchored so it gates only the GET list, not queue/cancel|retry|pause…)
    [/^\/api\/queue$/, 'downloads.grab'],
    // Import/download history exposes the download source (e.g. which indexer or
    // client fetched each issue) — download-pipeline detail a read-only viewer
    // shouldn't see. Covers /api/history and /api/history/failed. The web UI
    // already gates its /history view behind the same permission.
    [/^\/api\/history/, 'downloads.grab'],
  ];
  const DOWNLOAD_RULES = [
    /^\/api\/collection\/\d+\/(download|redownload)$/,
    /^\/api\/redownload$/,
    /^\/api\/download$/,                  // bulk download-by-issue-id
    /^\/api\/wanted\/download-all$/,
    /^\/api\/releases\/download$/,
    /^\/api\/queue\/cancel\//,
    /^\/api\/queue\/retry\//,
    /^\/api\/grabs\/\d+\/cancel$/,
    /^\/api\/search(\/grab)?$/,          // multi-source manual search + grab
    /^\/api\/usenet\/(search|grab)$/,
    /^\/api\/torrent\/(search|grab-pack)$/,
    /^\/api\/packs\/(search|grab)$/,
  ];
  // Plugin routes declare access as a tier name or a registered permission
  // key; tiers map onto the core permission of the same weight.
  const TIER_PERMS = { viewer: 'library.view', trusted: 'library.manage', admin: 'plugins.manage' };
  const pluginAccess = (() => {
    let table = null;
    return (req) => {
      if (!table) {
        table = registeredRoutes().map((r) => ({
          method: r.method,
          access: r.access || (r.method === 'get' ? 'viewer' : 'trusted'),
          re: new RegExp('^' + r.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            .replace(/\\\{[^}]+\\\}/g, '[^/]+').replace(/:[A-Za-z_]+/g, '[^/]+') + '/?$'),
        }));
      }
      const m = req.method.toLowerCase();
      const hit = table.find((r) => r.method === m && r.re.test(req.path));
      return hit ? hit.access : null;
    };
  })();
  const requiredPermission = (req) => {
    const p = req.path;
    if (p.startsWith('/api/auth/')) return 'authed'; // self-service: logout, password — any signed-in user
    for (const [re, perm] of PERM_RULES) if (re.test(p)) return perm;
    const plug = pluginAccess(req);
    if (plug) return plug === 'public' ? 'public' : (TIER_PERMS[plug] || plug);
    if (req.method === 'GET') return 'library.view';
    return DOWNLOAD_RULES.some((re) => re.test(p)) ? 'downloads.grab' : 'library.manage';
  };

  // CSRF defense for HTTP Basic: browsers auto-attach cached Basic credentials
  // to cross-site requests, so a state-changing POST could ride them. Session
  // cookies are SameSite=Lax (already safe). A non-browser tool sends Basic
  // with NO Origin header; a cross-site browser attack sends Basic WITH a
  // foreign Origin. So: reject an unsafe Basic-authed request whose Origin (or
  // Referer) is present and cross-origin. Same-origin and header-less pass.
  const SAFE_METHOD = /^(GET|HEAD|OPTIONS)$/;
  const basicCsrfBlocked = (req) => {
    if (SAFE_METHOD.test(req.method)) return false;
    if (!String(req.headers.authorization || '').startsWith('Basic ')) return false;
    const origin = req.headers.origin || (req.headers.referer ? new URL(req.headers.referer).origin : '');
    if (!origin) return false; // scripts/tools: no Origin → allow
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    try { return new URL(origin).host !== host; } catch { return true; }
  };

  // Routes that opted into a Basic challenge (machine catalogs like OPDS). On a
  // 401 for one of these we advertise WWW-Authenticate: Basic so external
  // clients send credentials; core/SPA routes stay silent so the browser never
  // gets a native Basic popup. Each opted-in path is reduced to its prefix
  // before the first :param, then matched by segment boundary.
  const basicChallengePrefixes = pluginRoutes
    .filter((r) => r.basicAuth)
    .map((r) => String(r.path).split('/:')[0].replace(/\/+$/, ''));
  const wantsBasicChallenge = (req) => basicChallengePrefixes.some(
    (p) => p && (req.path === p || req.path.startsWith(p + '/')),
  );

  // Unauthenticated liveness probe (Docker/Unraid HEALTHCHECK, uptime monitors).
  // Registered before the auth guard and the SPA catch-all so it always answers.
  app.get('/healthz', (req, res) => res.json({ ok: true }));

  const anyUsers = db.prepare('SELECT EXISTS(SELECT 1 FROM users) e');
  app.use(async (req, res, next) => {
    // This middleware is async (external credential backends verify Basic
    // asynchronously), so a thrown error becomes a rejected promise Express 4
    // won't catch — wrap the body and hand any error to next() ourselves.
    try {
    // The SPA shell, its assets, and auth endpoints are public — everything
    // under /api and /plugins requires an authenticated user.
    if (!req.path.startsWith('/api') && !req.path.startsWith('/plugins')) return next();
    if (/^\/api\/auth\/(login|register|me|providers)$/.test(req.path)) return next();
    if (basicCsrfBlocked(req)) return res.status(403).json({ error: 'cross-origin request refused' });
    // Resolve the route's required access BEFORE authenticating: a route
    // explicitly marked public (e.g. an SSO plugin's login/callback) needs no
    // session — the browser reaches it while signed out.
    const need = requiredPermission(req);
    if (need === 'public') return next();
    // Zero accounts = open single-user mode (the appliance default, same as
    // the old unset-basic-auth state). Creating the first account — which
    // becomes the admin — activates authentication for everything.
    if (!anyUsers.get().e) {
      req.user = { id: 0, username: 'local', role: 'admin' };
      return next();
    }
    // Session cookie / API key / local-password Basic first (synchronous); an
    // unmatched Basic request then falls through to external credential
    // backends (WHMCS/LDAP) so those users reach the API and OPDS too.
    let user = resolveUser(req);
    if (!user) user = await resolveUserViaProviders(req);
    if (!user) {
      if (wantsBasicChallenge(req)) res.set('WWW-Authenticate', 'Basic realm="BackIssue"');
      return res.status(401).json({ error: 'authentication required' });
    }
    req.user = user;
    if (need !== 'authed' && !users.roleGrants(db, user.role, need, permCatalog)) {
      const label = permCatalog.get(need)?.label || need;
      return res.status(403).json({ error: `your role doesn't include the permission: ${label}` });
    }
    next();
    } catch (err) { next(err); }
  });

  // ---- auth endpoints ----
  // /api/auth/me is public by design: it tells the UI whether to show the
  // login screen, the open-mode banner, or the app.
  // The client's can(perm) checks are driven by the resolved permission list
  // returned here ('*' = everything). UI hiding is courtesy; the middleware
  // above is the enforcement.
  const publicUser = (u) => u
    ? { id: u.id, username: u.username, role: u.role, permissions: users.rolePermissions(db, u.role, permCatalog) }
    : null;
  app.get('/api/auth/me', (req, res) => {
    if (!anyUsers.get().e) {
      return res.json({ openMode: true, user: { id: 0, username: 'local', role: 'admin', permissions: ['*'] } });
    }
    const u = resolveUser(req);
    res.json({
      openMode: false,
      registration: !!config.allowRegistration,
      user: publicUser(u),
    });
  });
  // Public: what the sign-in page should offer — external SSO buttons (from
  // auth-provider plugins) and whether the password form is enabled.
  app.get('/api/auth/providers', (req, res) => {
    res.json({
      providers: registeredAuthProviders().map((p) => ({ id: p.id, label: p.label, loginPath: p.loginPath })),
      // The password form is also needed by credential backends (e.g. WHMCS),
      // so keep it visible whenever one is registered.
      passwordLogin: !config.passwordLoginDisabled || registeredCredentialProviders().length > 0,
    });
  });
  // Sign in a user from an ALREADY-VERIFIED external identity. SSO/OIDC plugins
  // call this from their callback route AFTER validating the provider's token.
  // Returns the public user; throws { status } on a disabled account.
  app.locals.issueSession = (req, res, identity) => {
    const user = users.resolveExternalUser(db, identity);
    if (user.disabled) { const e = new Error('this account is disabled'); e.status = 403; throw e; }
    const token = users.createSession(db, user.id);
    setSessionCookie(req, res, token);
    return publicUser(user);
  };
  app.post('/api/auth/register', (req, res) => {
    const { username, password } = req.body || {};
    const first = users.userCount(db) === 0;
    // First account ever = the admin (setup); afterwards the admin toggle governs.
    if (!first && !config.allowRegistration) {
      return res.status(403).json({ error: 'registration is disabled — ask an admin for an account' });
    }
    const key = authKey(req, 'register');
    const wait = users.authBlockedFor(key);
    if (wait) return res.status(429).json({ error: `too many attempts — try again in ${wait}s` });
    try {
      const u = users.createUser(db, { username, password, role: first ? 'admin' : 'viewer' });
      users.authSucceeded(key);
      const token = users.createSession(db, u.id);
      setSessionCookie(req, res, token);
      res.json({ user: publicUser(u) });
    } catch (e) {
      users.authFailed(key); // hammering registration burns the same lock
      res.status(400).json({ error: String(e?.message || e) });
    }
  });
  app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body || {};
    const key = authKey(req, username);
    const wait = users.authBlockedFor(key);
    if (wait) return res.status(429).json({ error: `too many attempts — try again in ${wait}s` });
    const u = users.verifyCredentials(db, username, password);
    if (u) {
      // Password login can be disabled (SSO-only), but admins keep a password
      // escape hatch so a broken IdP can't lock everyone out.
      if (config.passwordLoginDisabled && u.role !== 'admin') {
        return res.status(403).json({ error: 'password login is disabled — sign in with SSO' });
      }
      users.authSucceeded(key);
      const token = users.createSession(db, u.id);
      setSessionCookie(req, res, token);
      return res.json({ user: publicUser(u) });
    }
    // Local password failed — try external credential backends (e.g. WHMCS,
    // LDAP). Each verifies the password against its own system; the first to
    // return a VERIFIED identity signs the user in via the external-identity
    // link/provision path.
    for (const provider of registeredCredentialProviders()) {
      let identity = null;
      try { identity = await provider(String(username || ''), String(password || '')); }
      catch { /* the provider logs its own errors; treat as no-match */ }
      if (identity && identity.subject) {
        users.authSucceeded(key);
        try {
          return res.json({ user: app.locals.issueSession(req, res, { defaultRole: 'viewer', ...identity }) });
        } catch (e) {
          return res.status(e?.status || 403).json({ error: String(e?.message || e) });
        }
      }
    }
    users.authFailed(key);
    return res.status(401).json({ error: 'wrong username or password' });
  });
  app.post('/api/auth/logout', (req, res) => {
    users.destroySession(db, readCookie(req));
    clearSessionCookie(res);
    res.json({ ok: true });
  });
  app.post('/api/auth/password', (req, res) => {
    if (!req.user || req.user.id === 0) return res.status(403).json({ error: 'sign in with a real account first' });
    // External-login accounts have no local password to change, and setting one
    // would defeat the provider's access control — say so plainly.
    if (users.hasExternalIdentity(db, req.user.id)) {
      return res.status(403).json({ error: 'this account signs in through an external service — its password is managed there' });
    }
    const { current, next: nextPw } = req.body || {};
    if (!users.verifyCredentials(db, req.user.username, current)) {
      return res.status(400).json({ error: 'current password is wrong' });
    }
    try {
      users.setPassword(db, req.user.id, nextPw);
      users.clearBasicCache();
      const token = users.createSession(db, req.user.id); // keep THIS session alive
      setSessionCookie(req, res, token);
      res.json({ ok: true });
    } catch (e) { res.status(400).json({ error: String(e?.message || e) }); }
  });
  // The signed-in user's own profile (self-service — any authed user).
  app.get('/api/auth/profile', (req, res) => {
    if (!req.user || req.user.id === 0) {
      return res.json({ user: { username: req.user?.username || 'local', role: req.user?.role || 'admin', email: null, created_at: null, last_seen: null, providers: [] } });
    }
    res.json({ user: users.userProfile(db, req.user.id) });
  });
  app.post('/api/auth/email', (req, res) => {
    if (!req.user || req.user.id === 0) return res.status(403).json({ error: 'sign in with a real account first' });
    try { res.json({ email: users.updateEmail(db, req.user.id, (req.body || {}).email) }); }
    catch (e) { res.status(400).json({ error: String(e?.message || e) }); }
  });
  app.post('/api/auth/logout-others', (req, res) => {
    if (!req.user || req.user.id === 0) return res.status(403).json({ error: 'sign in with a real account first' });
    res.json({ cleared: users.destroyOtherSessions(db, req.user.id, readCookie(req)) });
  });
  // ---- personal API key (self-service — any signed-in user) ----
  // One key per user, for third-party clients. Requests made with it act as
  // this user, permission-clamped by their role like any session. The raw key
  // is returned ONCE from POST; GET only ever shows the prefix.
  app.get('/api/auth/apikey', (req, res) => {
    if (!req.user || req.user.id === 0) return res.json({ key: null });
    res.json({ key: users.apiKeyInfo(db, req.user.id) });
  });
  app.post('/api/auth/apikey', (req, res) => {
    if (!req.user || req.user.id === 0) return res.status(403).json({ error: 'sign in with a real account first' });
    res.json({ key: users.createApiKey(db, req.user.id) });
  });
  app.delete('/api/auth/apikey', (req, res) => {
    if (!req.user || req.user.id === 0) return res.status(403).json({ error: 'sign in with a real account first' });
    res.json({ revoked: users.revokeApiKey(db, req.user.id) });
  });

  // ---- user administration (needs users.manage via PERM_RULES) ----
  // "Admin" for the can't-lock-yourself-out guards means anyone who can manage
  // users — the built-in admin OR a custom role granting users.manage — so a
  // custom admin-equivalent role counts toward the "≥1 must remain" invariant.
  const managesUsers = (role) => { try { return users.roleGrants(db, role, 'users.manage', permCatalog); } catch { return false; } };
  const activeManagers = () => users.listUsers(db).filter((u) => !u.disabled && managesUsers(u.role));

  app.get('/api/users', (req, res) => res.json({ users: users.listUsers(db) }));
  app.post('/api/users', (req, res) => {
    const { username, password, role } = req.body || {};
    try { res.json({ user: users.createUser(db, { username, password, role: role || 'viewer' }) }); }
    catch (e) { res.status(400).json({ error: String(e?.message || e) }); }
  });
  app.patch('/api/users/:id', (req, res) => {
    const id = Number(req.params.id);
    const target = users.getUser(db, id);
    if (!target) return res.status(404).json({ error: 'no such user' });
    const { role, disabled, password } = req.body || {};
    // Would this change strip the target's user-management ability?
    const losesManage = disabled === true || (role && !managesUsers(role));
    const managers = activeManagers();
    const lastManager = managers.length === 1 && managers[0].id === id && managesUsers(target.role);
    if (id === req.user.id && losesManage) {
      return res.status(400).json({ error: 'you cannot demote or disable your own account' });
    }
    if (lastManager && losesManage) {
      return res.status(400).json({ error: 'there must always be at least one active admin' });
    }
    try {
      if (role) users.setRole(db, id, role);
      if (disabled !== undefined) users.setDisabled(db, id, !!disabled);
      if (password) users.setPassword(db, id, password);
      users.clearBasicCache();
      res.json({ user: users.getUser(db, id) });
    } catch (e) { res.status(400).json({ error: String(e?.message || e) }); }
  });
  app.delete('/api/users/:id', (req, res) => {
    const id = Number(req.params.id);
    if (id === req.user.id) return res.status(400).json({ error: 'you cannot delete your own account' });
    const target = users.getUser(db, id);
    const managers = activeManagers();
    if (target && managesUsers(target.role) && managers.length === 1 && managers[0].id === id) {
      return res.status(400).json({ error: 'there must always be at least one active admin' });
    }
    users.deleteUser(db, id);
    users.clearBasicCache();
    res.json({ ok: true });
  });

  // ---- roles & permissions (users.manage) ----
  // The catalog is everything grantable: core permissions plus what loaded
  // plugins registered. Grouped for the role editor's checkbox list.
  app.get('/api/permissions', (req, res) => {
    res.json({ permissions: [...permCatalog.values()] });
  });
  app.get('/api/roles', (req, res) => res.json({ roles: users.listRoles(db, permCatalog) }));
  app.post('/api/roles', (req, res) => {
    const { name, label, permissions } = req.body || {};
    try {
      users.createRole(db, { name, label, permissions }, permCatalog);
      res.json({ roles: users.listRoles(db, permCatalog) });
    } catch (e) { res.status(400).json({ error: String(e?.message || e) }); }
  });
  app.patch('/api/roles/:name', (req, res) => {
    const { label, permissions } = req.body || {};
    try {
      users.updateRole(db, req.params.name, { label, permissions }, permCatalog);
      users.clearBasicCache(); // permission changes apply on the next request
      res.json({ roles: users.listRoles(db, permCatalog) });
    } catch (e) { res.status(400).json({ error: String(e?.message || e) }); }
  });
  app.delete('/api/roles/:name', (req, res) => {
    try {
      users.deleteRole(db, req.params.name);
      res.json({ roles: users.listRoles(db, permCatalog) });
    } catch (e) { res.status(400).json({ error: String(e?.message || e) }); }
  });

  // ---- notifications (per-user feed; broadcasts filtered to the categories
  // this user's permissions allow, targeted rows always their own) ----
  app.get('/api/notifications', (req, res) => {
    res.json(notifications.listNotifications(db, req.user.id, {
      limit: Number(req.query.limit) || 30, categories: notifCategories(req), includeRestricted: canRestricted(req),
    }));
  });
  app.post('/api/notifications/read', (req, res) => {
    const { ids, all } = req.body || {};
    res.json({ unread: notifications.markRead(db, req.user.id, { ids, all: !!all, categories: notifCategories(req), includeRestricted: canRestricted(req) }) });
  });

  // ---- reading lists (personal, per-user) ----
  const listErr = (res, e) => res.status(400).json({ error: String(e?.message || e) });
  app.get('/api/lists', (req, res) => res.json({ lists: lists.listLists(db, req.user.id) }));
  app.post('/api/lists', (req, res) => {
    try { res.json({ id: lists.createList(db, req.user.id, (req.body || {}).name) }); }
    catch (e) { listErr(res, e); }
  });
  app.get('/api/lists/:id', (req, res) => {
    const l = lists.getList(db, req.user.id, Number(req.params.id));
    if (!l) return res.status(404).json({ error: 'no such list' });
    res.json(l);
  });
  app.patch('/api/lists/:id', (req, res) => {
    const { name, order } = req.body || {};
    try {
      if (name !== undefined) lists.renameList(db, req.user.id, Number(req.params.id), name);
      if (order !== undefined) lists.reorderList(db, req.user.id, Number(req.params.id), order);
      res.json({ ok: true });
    } catch (e) { listErr(res, e); }
  });
  app.delete('/api/lists/:id', (req, res) => {
    try { lists.deleteList(db, req.user.id, Number(req.params.id)); res.json({ ok: true }); }
    catch (e) { listErr(res, e); }
  });
  app.post('/api/lists/:id/items', (req, res) => {
    try { res.json({ added: lists.addItems(db, req.user.id, Number(req.params.id), (req.body || {}).cvIssueIds) }); }
    catch (e) { listErr(res, e); }
  });
  app.delete('/api/lists/:id/items/:cvIssueId', (req, res) => {
    try { lists.removeItem(db, req.user.id, Number(req.params.id), req.params.cvIssueId); res.json({ ok: true }); }
    catch (e) { listErr(res, e); }
  });
  // Story-arc search + import (official CV API — see arcCvClient in index.js).
  app.get('/api/cv/arcs', async (req, res) => {
    try { res.json({ arcs: await arcSearch(String(req.query.q || '')) }); }
    catch (e) { listErr(res, e); }
  });
  app.post('/api/lists/import-arc', async (req, res) => {
    try {
      const { arc, issues } = await arcIssues(Number((req.body || {}).arcId));
      if (!issues.length) return res.status(400).json({ error: 'that arc has no issues on ComicVine' });
      res.json({ id: lists.importArcAsList(db, req.user.id, arc, issues), issues: issues.length });
    } catch (e) { listErr(res, e); }
  });
  // Vite emits content-hashed files under /assets — safe to cache forever. The
  // shell (index.html) stays no-cache so a new build is picked up on reload.
  // index:false — the shell is served by the injector below, never statically.
  app.use(express.static(publicDir, {
    etag: true,
    index: false,
    setHeaders: (res, filePath) => res.setHeader('Cache-Control',
      /[\\/]assets[\\/]/.test(filePath) ? 'public, max-age=31536000, immutable' : 'no-cache'),
  }));
  // Serve each plugin's client/ dir (only — never its server-side source) at
  // /plugins/<name>/client/…, and list the assets the client injects on boot.
  for (const name of new Set(pluginClientAssets.map((a) => a.name).filter(Boolean))) {
    app.use(`/plugins/${name}/client`, express.static(path.join(pluginsDir(), name, 'client'), { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));
  }
  // Stamp a per-boot version so the client can cache-bust plugin assets: they're
  // served no-cache, but browsers still serve a dynamically-inserted <script>/<link>
  // from cache on a soft reload. A ?v that changes every restart (we restart on
  // every plugin change) forces a fresh fetch. Uses each file's mtime so an
  // unchanged asset keeps its URL across restarts (only changed files re-download).
  const stampedAssets = () => pluginClientAssets.map((a) => {
    const ver = ['js', 'css'].map((k) => {
      if (!a[k]) return '';
      try { return String(fssync.statSync(path.join(pluginsDir(), a.name, a[k])).mtimeMs | 0); } catch { return ''; }
    }).join('-');
    return { ...a, v: ver };
  });
  app.get('/api/plugins/client', (req, res) => res.json(stampedAssets()));

  // The served shell embeds each plugin's <script>/<link> tags directly, so
  // plugin assets load in parallel with the app bundle — the sidebar's plugin
  // entries render with the rest of the menu, with no list fetch and no
  // client-side cache. A stub queues BackIssue.registerClient calls in case
  // a plugin script ever executes before the bundle. Injection is session-
  // gated: the login page's shell stays plugin-free (the asset files under
  // /plugins are authenticated anyway); a session that signs in without a
  // full reload falls back to the client-side loader.
  function shellHtml(req) {
    const file = path.join(publicDir, 'index.html');
    if (!fssync.existsSync(file)) return null;
    let html = fssync.readFileSync(file, 'utf8');
    const authed = !anyUsers.get().e || !!resolveUser(req);
    if (authed) {
      const tags = ['<script>window.BackIssue={_q:[],registerClient(fn){this._q.push(fn)}};window.__BI_PLUGINS_INLINE__=1;</script>'];
      for (const a of stampedAssets()) {
        const v = a.v ? `?v=${a.v}` : '';
        if (a.css) tags.push(`<link rel="stylesheet" href="/plugins/${a.name}/${a.css}${v}">`);
        if (a.js) tags.push(`<script defer src="/plugins/${a.name}/${a.js}${v}"></script>`);
      }
      html = html.replace('</head>', `${tags.join('\n')}\n</head>`);
    }
    return html;
  }

  // Plugin management: what's installed, what each registered, and per-plugin
  // enable/disable (persisted; a changed state applies on the next restart —
  // plugins register routes/jobs/sources at boot and can't be hot-unloaded).
  app.get('/api/plugins', (req, res) => {
    const plugins = pluginCatalog();
    res.json({ plugins, restartRequired: plugins.some((p) => p.restartRequired) });
  });
  // Restart the app process (plugin toggles apply at boot). Under Docker the
  // restart policy revives the container; bare processes re-exec themselves.
  app.post('/api/restart', (req, res) => {
    if (typeof requestRestart !== 'function') return res.status(501).json({ error: 'restart not available' });
    res.json(requestRestart());
  });
  app.post('/api/plugins/:name/enabled', (req, res) => {
    const name = String(req.params.name);
    const enabled = !!(req.body || {}).enabled;
    if (!setPluginEnabled(name, enabled)) return res.status(404).json({ error: 'no such plugin' });
    const disabled = new Set(String(config.disabledPlugins || '').split(',').map((n) => n.trim()).filter(Boolean));
    if (enabled) disabled.delete(name); else disabled.add(name);
    saveSettings({ disabledPlugins: [...disabled].join(',') });
    const plugins = pluginCatalog();
    res.json({ plugins, restartRequired: plugins.some((p) => p.restartRequired) });
  });

  // Plugin catalog: the installable first-party plugins offered by the remote
  // manifest, cross-referenced with what's already on disk.
  app.get('/api/plugins/catalog', async (req, res) => {
    let available;
    try { available = await fetchCatalog(); }
    catch (e) { return res.status(502).json({ error: 'could not reach the plugin catalog: ' + String(e?.message || e) }); }
    const installed = new Map(pluginCatalog().map((p) => [p.name, p]));
    const plugins = available.map((a) => {
      const inst = installed.get(a.id);
      return {
        id: a.id, name: a.name || a.id, description: a.description || '', version: a.version || null,
        installed: !!inst,
        installedVersion: inst?.version || null,
        updateAvailable: !!(inst && a.version && inst.version && a.version !== inst.version),
      };
    });
    res.json({ plugins });
  });
  app.post('/api/plugins/install', async (req, res) => {
    const id = String((req.body || {}).id || '');
    let available;
    try { available = await fetchCatalog(); }
    catch { return res.status(502).json({ error: 'plugin catalog unreachable' }); }
    const entry = available.find((p) => p.id === id);
    if (!entry) return res.status(404).json({ error: 'plugin not found in the catalog' });
    try {
      const r = await installPlugin(entry);
      res.json({ installed: r.id, version: r.version, restartRequired: true });
    } catch (e) {
      res.status(400).json({ error: 'install failed: ' + String(e?.message || e) });
    }
  });
  app.post('/api/plugins/uninstall', (req, res) => {
    const id = String((req.body || {}).id || '');
    try {
      const r = uninstallPlugin(id);
      res.json({ removed: r.removed, restartRequired: true });
    } catch (e) {
      res.status(400).json({ error: String(e?.message || e) });
    }
  });

  app.get('/api/series', (req, res) => {
    res.json(listSeries(db, { search: req.query.search, includeRestricted: canRestricted(req) }));
  });

  app.get('/api/series/:id/issues', (req, res) => {
    // Don't leak a restricted series' issue list to a role that can't see it.
    if (!canRestricted(req) && isSeriesRestricted(db, Number(req.params.id))) return res.json([]);
    res.json(listIssues(db, { seriesId: Number(req.params.id) }));
  });

  app.get('/api/status', (req, res) => {
    const followedCount = db.prepare('SELECT COUNT(*) n FROM series WHERE followed=1').get().n;
    res.json({ counts: countByStatus(db), followedCount, version: APP_VERSION, crawl: state.crawl, queue: state.queue, follow: state.follow || { running: false } });
  });

  // Live updates: one SSE stream tells the UI which domains changed so it can
  // re-fetch just those endpoints — replaces its fixed polling loops. Each
  // signature mirrors what the matching GET endpoint serves.
  const hub = createEventHub({
    status: () => ({ c: countByStatus(db), crawl: state.crawl, q: state.queue }),
    queue: () => ({
      // state.queue carries the in-flight download's page/pages — without it,
      // an immediate-source download never ticks the drawer.
      q: listQueue(db), p: activePackGrabs(db), s: state.queue,
      live: queueProgress ? queueProgress() : null, pk: packProgress ? packProgress() : null,
    }),
    jobs: () => (listJobs ? listJobs() : null),
    schedules: () => (listSchedules ? listSchedules() : null),
    logs: () => {
      if (!listLogs) return null;
      const l = listLogs({ level: 'all', category: 'all' });
      return { counts: l.counts, n: l.logs.length, last: l.logs[0]?.ts };
    },
    tools: () => (toolsState ? toolsState() : null),
    import: () => (importState ? importState() : null),
    cv: () => state.cv,
    scanFolder: () => state.scanFolder,
    tagFiles: () => state.tagFiles,
    releases: () => state.releases,
    notifications: () => notifications.notifyWatermark(db),
  });
  app.get('/api/events', hub.handler);

  app.post('/api/download', (req, res) => {
    const ids = Array.isArray(req.body.issueIds) ? req.body.issueIds.map(Number) : [];
    queueIssues(db, ids);
    startDownloads(ids);
    res.json({ queued: ids.length });
  });

  // Download ComicVine issues of a collection series. We create a synthetic queue
  // row per CV issue and queue it; the worker resolves a download source on demand.
  app.post('/api/collection/:id/download', (req, res) => {
    const seriesId = Number(req.params.id);
    const cvIssueIds = Array.isArray(req.body.cvIssueIds) ? req.body.cvIssueIds.map(Number) : [];
    const ids = [];
    for (const cvid of cvIssueIds) {
      const ci = getCvIssue(db, cvid);
      if (!ci) continue;
      ids.push(ensureCvIssueRow(db, { seriesId, cvIssueId: cvid, number: ci.issue_number, title: ci.name }));
    }
    // A row can claim 'done' while its file is gone (deleted on disk, or an
    // earlier redownload that removed the file but failed to queue). The
    // queueIssues guard would silently skip those, stranding the issue as
    // undownloadable. Trust the disk: done + no file at file_path = stale.
    const staleDone = ids.filter((id) => {
      const row = db.prepare('SELECT status, file_path FROM issues WHERE id=?').get(id);
      return row && row.status === 'done' && (!row.file_path || !fssync.existsSync(row.file_path));
    });
    if (staleDone.length) clearIssuesForRedownload(db, staleDone);
    queueIssues(db, ids);
    startDownloads(ids);
    res.json({ queued: ids.length });
  });

  // Re-download CV issues: delete their current file(s) on disk (e.g. a corrupt
  // copy) so the fresh grab isn't dedupe-suffixed, then queue them.
  app.post('/api/collection/:id/redownload', async (req, res) => {
    const seriesId = Number(req.params.id);
    const cvIssueIds = Array.isArray(req.body.cvIssueIds) ? req.body.cvIssueIds.map(Number) : [];
    const ids = [];
    for (const cvid of cvIssueIds) {
      for (const f of db.prepare('SELECT path FROM library_files WHERE cv_issue_id=?').all(cvid)) {
        try { await fsp.unlink(f.path); } catch { /* already gone */ }
      }
      db.prepare('DELETE FROM library_files WHERE cv_issue_id=?').run(cvid);
      const ci = getCvIssue(db, cvid);
      if (!ci) continue;
      ids.push(ensureCvIssueRow(db, { seriesId, cvIssueId: cvid, number: ci.issue_number, title: ci.name }));
    }
    // A previously downloaded row is 'done' — and queueIssues refuses to queue
    // done rows, which would strand the issue with its files already deleted.
    // Reset status/file_path first (and delete that file too: a downloader-
    // written file may not have a library_files row yet).
    for (const p of clearIssuesForRedownload(db, ids)) {
      try { await fsp.unlink(p); } catch { /* already gone */ }
    }
    queueIssues(db, ids);
    startDownloads(ids);
    res.json({ queued: ids.length });
  });

  // Alternative search names for a volume (indexers that name it differently).
  app.post('/api/collection/:id/aliases', (req, res) => res.json(setAliases(Number(req.params.id), req.body?.aliases ?? '')));

  // Try ComicVine keys without saving them (the Settings Test button).
  app.post('/api/cv/test', async (req, res) => res.json(await testCvKeys(req.body?.keys)));

  // ---- Manual multi-source search + grab (per issue) ----
  // Queries every enabled source that supports it; a pick is pinned to the issue
  // and downloaded via that source's normal path.
  app.post('/api/search', async (req, res) => res.json(await searchSources(req.body || {})));
  app.post('/api/search/grab', (req, res) => {
    const b = req.body || {};
    if (!b.result || !b.seriesId || !b.cvIssueId) return res.status(400).json({ error: 'seriesId, cvIssueId and result required' });
    // A pack result (multi-issue) is downloaded + post-processed (import each
    // missing issue); a single issue is pinned and downloaded as one file.
    if (b.result.isPack) return res.json(grabSourcePack({ source: b.result.source, seriesId: b.seriesId, result: b.result }));
    const r = manualGrabResult(b);
    if (!r.error) startDownloads();
    res.json(r);
  });

  // ---- Manual usenet search + grab (per issue) — legacy, superseded by /api/search ----
  app.post('/api/usenet/search', async (req, res) => res.json(await usenetSearch(req.body || {})));
  app.post('/api/usenet/grab', async (req, res) => {
    const b = req.body || {};
    if (!b.nzbUrl || !b.seriesId || !b.cvIssueId) return res.status(400).json({ error: 'seriesId, cvIssueId and nzbUrl required' });
    res.json(await usenetGrab(b));
  });

  // ---- Manual torrent PACK search + grab (per series) ----
  app.post('/api/torrent/search', async (req, res) => res.json(await torrentSearch(req.body || {})));
  app.post('/api/torrent/grab-pack', async (req, res) => {
    const b = req.body || {};
    if (!b.downloadUrl || !b.seriesId) return res.status(400).json({ error: 'seriesId and downloadUrl required' });
    res.json(await torrentGrabPack(b));
  });

  // ---- Multi-source PACK search + grab (per series) ----
  app.post('/api/packs/search', async (req, res) => res.json(await searchPacks(req.body || {})));
  app.post('/api/packs/grab', async (req, res) => {
    const b = req.body || {};
    if (!b.result || !b.seriesId) return res.status(400).json({ error: 'seriesId and result required' });
    res.json(await grabPack({ source: b.result.source, seriesId: b.seriesId, result: b.result }));
  });

  // ---- Library tools ----
  app.get('/api/stats', (req, res) => res.json(stats({ includeRestricted: canRestricted(req) })));
  app.get('/api/sources', (req, res) => res.json({ sources: listSources ? listSources() : [] }));
  // Import history — what was added and from where (newest first, paged).
  app.get('/api/history', (req, res) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const source = req.query.source && req.query.source !== 'all' ? String(req.query.source) : null;
    const h = listImportHistory(db, { limit, offset, source });
    // The on-disk file path is a library-management detail — strip it for
    // viewers so a read-only account can't map the server's filesystem.
    if (!users.roleGrants(db, req.user.role, 'library.manage', permCatalog)) {
      h.items = h.items.map(({ path, ...rest }) => rest);
    }
    // Restricted series titles stay hidden from roles without the permission.
    if (!canRestricted(req)) {
      const rset = restrictedSeriesIds(db);
      h.items = h.items.filter((i) => !rset.has(i.series_id));
    }
    res.json(h);
  });
  // Failed downloads (durable — queue rows clear, this record doesn't).
  app.get('/api/history/failed', (req, res) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const r = listFailedGrabs(db, { limit, offset });
    if (!canRestricted(req)) {
      const rset = restrictedSeriesIds(db);
      r.rows = r.rows.filter((i) => i.series_id == null || !rset.has(i.series_id));
    }
    res.json(r);
  });
  // Wanted — every missing issue across the collection (paged, filterable).
  app.get('/api/wanted', (req, res) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    res.json(listWantedIssues(db, {
      limit, offset,
      followedOnly: req.query.followed === '1',
      hideUnreleased: req.query.hideUnreleased === '1',
      search: String(req.query.q || '').trim(),
      includeRestricted: canRestricted(req),
    }));
  });
  app.get('/api/tools', (req, res) => res.json(toolsState()));
  app.post('/api/tools/:tool', (req, res) => res.json(runTool(req.params.tool, req.body || {})));

  // ---- Library import ----
  app.get('/api/import', (req, res) => res.json(importState()));
  app.post('/api/import/scan', async (req, res) => res.json(await runImportScan({ fresh: !!req.body?.fresh })));
  app.post('/api/import/run', async (req, res) => res.json(await runImport()));
  app.post('/api/import/candidate/:id/match', (req, res) => {
    const { cvId, cvName, cvYear, cvImage } = req.body || {};
    if (!cvId) return res.status(400).json({ error: 'cvId required' });
    res.json(matchImportCandidate(Number(req.params.id), { cvId: Number(cvId), cvName, cvYear, cvImage }));
  });
  app.post('/api/import/candidate/:id/confirm', (req, res) => res.json(confirmImportCandidate(Number(req.params.id))));
  app.post('/api/import/candidate/:id/skip', (req, res) => res.json(skipImportCandidate(Number(req.params.id))));

  // Full info for one ComicVine issue (detail fetched on demand) + its file(s).
  app.get('/api/issue/:cvIssueId', async (req, res) => {
    try {
      // Direct-by-id lookup bypasses the filtered list surfaces — apply the
      // restricted check here too so ids can't be probed.
      if (!canRestricted(req) && isCvIssueRestricted(db, Number(req.params.cvIssueId))) {
        return res.status(404).json({ error: 'unknown issue' });
      }
      const info = await cvIssueInfo(Number(req.params.cvIssueId));
      if (!info) return res.status(404).json({ error: 'unknown issue' });
      res.json(info);
    } catch (e) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  app.get('/api/queue', (req, res) => {
    // Per-issue live status on each downloading row: the download monitor
    // (deferred torrent/usenet — progress + seeders) merged with the immediate
    // streaming map (state.queue.live — page/byte progress + speed). An issue is
    // only one or the other, so a simple per-id lookup across both suffices.
    const deferred = (queueProgress ? queueProgress() : {}) || {};
    const immediate = state.queue.live || {};
    const items = listQueue(db).map((it) => {
      const live = deferred[it.id] || immediate[it.id];
      return live ? { ...it, live } : it;
    });
    // Active pack grabs (0-day / per-series) — no issue rows, so they'd otherwise
    // be invisible here while downloading.
    const packLive = (packProgress ? packProgress() : {}) || {};
    const packs = activePackGrabs(db).map((g) => ({ ...g, live: packLive[g.id] || null }));
    // Restricted series stay invisible to roles without the permission.
    const rset = canRestricted(req) ? null : restrictedSeriesIds(db);
    res.json({
      items: rset ? items.filter((i) => !rset.has(i.series_id)) : items,
      packs: rset ? packs.filter((p) => p.series_id == null || !rset.has(p.series_id)) : packs,
      paused: !!state.queue.paused,
      running: !!state.queue.running,
      current: state.queue.current || null,
    });
  });

  // Cancel an in-flight grab (issue or pack): removed from the client, issue back
  // to pending.
  app.post('/api/grabs/:id/cancel', async (req, res) => {
    res.json(await cancelGrab(Number(req.params.id)));
  });

  // Bulk actions on collection series (rail multi-select): follow / unfollow /
  // download-missing / remove (keeps files — bulk file deletion is too sharp).
  app.post('/api/collection/bulk', async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
    const action = String(req.body?.action || '');
    if (!ids.length) return res.status(400).json({ error: 'ids required' });
    if (action === 'follow' || action === 'unfollow') {
      // Personal follows — the actor's own pull list, not the monitor flag.
      for (const id of ids) setUserFollow(db, req.user.id, id, action === 'follow');
      return res.json({ done: ids.length });
    }
    if (action === 'remove') {
      let n = 0;
      for (const id of ids) { try { await deleteComic(id, { deleteFiles: false }); n++; } catch { /* skip */ } }
      return res.json({ done: n });
    }
    if (action === 'download-missing') {
      const qids = [];
      for (const sid of ids) {
        const s = getSeriesById(db, sid);
        if (!s?.cv_id) continue;
        const missing = db.prepare(`SELECT ci.comicvine_id id, ci.issue_number, ci.name FROM cv_issues ci
          WHERE ci.cv_series_id=? AND NOT EXISTS (SELECT 1 FROM library_files lf WHERE lf.cv_issue_id=ci.comicvine_id AND lf.valid=1)`).all(s.cv_id);
        for (const m of missing) qids.push(ensureCvIssueRow(db, { seriesId: sid, cvIssueId: m.id, number: m.issue_number, title: m.name }));
      }
      queueIssues(db, qids);
      startDownloads(qids);
      return res.json({ queued: qids.length });
    }
    res.status(400).json({ error: 'unknown action' });
  });

  // Queue one tracked weekly release (series + issue number) straight from the
  // Releases drawer.
  app.post('/api/releases/download', (req, res) => {
    const seriesId = Number(req.body?.seriesId);
    const number = String(req.body?.number ?? '');
    const s = getSeriesById(db, seriesId);
    if (!s?.cv_id) return res.status(400).json({ error: 'series not matched to ComicVine' });
    const want = normalizeNumber(number);
    const ci = listCvIssues(db, s.cv_id).find((x) => normalizeNumber(x.issue_number) === want);
    if (!ci) return res.status(404).json({ error: `issue #${number} isn't in the ComicVine volume yet — Refresh the series first` });
    const id = ensureCvIssueRow(db, { seriesId, cvIssueId: ci.comicvine_id, number: ci.issue_number, title: ci.name });
    queueIssues(db, [id]);
    startDownloads([id]);
    res.json({ queued: 1 });
  });

  // Queue every wanted issue matching the CURRENT Wanted filters (bounded).
  app.post('/api/wanted/download-all', (req, res) => {
    const b = req.body || {};
    const { items } = listWantedIssues(db, {
      limit: 500, offset: 0,
      followedOnly: !!b.followed, hideUnreleased: !!b.hideUnreleased,
      search: String(b.q || '').trim(),
    });
    const ids = [];
    for (const it of items) {
      // Skip ones already moving through the pipeline.
      if (it.queue_status && ['queued', 'grabbed', 'downloading', 'tagging'].includes(it.queue_status)) continue;
      ids.push(ensureCvIssueRow(db, { seriesId: it.series_id, cvIssueId: it.cv_issue_id, number: it.issue_number, title: it.issue_name }));
    }
    queueIssues(db, ids);
    startDownloads(ids);
    res.json({ queued: ids.length });
  });

  app.post('/api/queue/pause', (req, res) => { state.queue.paused = true; res.json({ paused: true }); });
  app.post('/api/queue/resume', (req, res) => { state.queue.paused = false; res.json({ paused: false }); });
  app.post('/api/queue/clear', (req, res) => { res.json({ cleared: cancelQueued(db) }); });

  app.get('/api/collection', (req, res) => res.json(collectionSeries(db, { filter: req.query.filter, search: req.query.search, sort: req.query.sort, includeRestricted: canRestricted(req), userId: req.user.id })));
  app.get('/api/collection/:id', (req, res) => {
    // A restricted series is invisible to roles without the permission.
    if (!canRestricted(req) && isSeriesRestricted(db, Number(req.params.id))) return res.status(404).json({ error: 'not found' });
    const d = seriesCollectionDetail(db, Number(req.params.id), req.user.id);
    if (!d) return res.status(404).json({ error: 'not found' });
    const row = getSeriesById(db, Number(req.params.id));
    if (row) {
      // For an unmatched comic with no pinned path and no files, the fallback
      // would derive a folder from the source title — show "not set" instead.
      const derivable = d.source !== 'unmatched' || row.path || (d.files || []).length;
      d.location = derivable ? resolveSeriesDir(db, row) : null;
      d.defaultLocation = derivable ? defaultRootedDir(db, row) : null;
    }
    return res.json(d);
  });
  // Flag/unflag a series as mature/restricted (library.manage via the default).
  app.post('/api/collection/:id/restricted', (req, res) => {
    setSeriesRestricted(db, Number(req.params.id), !!(req.body || {}).restricted);
    res.json({ restricted: isSeriesRestricted(db, Number(req.params.id)) });
  });
  // Metadata editor (library.manage via the default POST rule). Edits write
  // to the display columns and lock those fields against refreshes; reset
  // drops the locks so the next refresh restores source values.
  app.post('/api/collection/:id/metadata', (req, res) => {
    const series = getSeriesById(db, Number(req.params.id));
    if (!series?.cv_id) return res.status(400).json({ error: 'not matched to ComicVine' });
    if (req.body?.reset) { resetCvSeriesUser(db, series.cv_id); return res.json({ reset: true }); }
    res.json(updateCvSeriesUser(db, series.cv_id, req.body?.fields || {}));
  });
  app.post('/api/issue/:cvId/metadata', (req, res) => {
    const id = Number(req.params.cvId);
    if (req.body?.reset) { resetCvIssueUser(db, id); return res.json({ reset: true }); }
    res.json(updateCvIssueUser(db, id, req.body?.fields || {}));
  });
  // Background jobs.
  app.get('/api/jobs', (req, res) => res.json(listJobs()));
  app.post('/api/jobs/clear', (req, res) => res.json({ remaining: clearJobs() }));
  // Application logs (recent warnings/errors, so users can see why things failed).
  app.get('/api/logs', (req, res) => res.json(listLogs({ level: req.query.level || 'all', category: req.query.category || 'all', limit: Number(req.query.limit) || 300 })));
  app.post('/api/logs/clear', (req, res) => res.json({ cleared: clearLogs() }));
  // Scheduled tasks: list, update ({ cron?, enabled? }), run now.
  app.get('/api/schedules', (req, res) => res.json(listSchedules()));
  app.post('/api/schedules/:key', (req, res) => {
    const { cron, enabled } = req.body || {};
    if (cron == null && enabled == null) return res.status(400).json({ error: 'cron or enabled required' });
    const r = setScheduleCron(req.params.key, { cron, enabled });
    if (r.error) return res.status(r.error === 'unknown task' ? 404 : 400).json(r);
    res.json(r);
  });
  app.post('/api/schedules/:key/run', (req, res) => {
    res.json({ started: !!runScheduleNow(req.params.key) });
  });
  // Weekly new-release check for tracked comics.
  app.post('/api/releases/check', (req, res) => {
    res.json(checkReleases(req.body || {}));
  });
  app.get('/api/releases', (req, res) => {
    let r = state.releases || { running: false };
    // Drop releases of tracked series the role can't see (mature/restricted).
    if (r.releases && !canRestricted(req)) {
      const restricted = new Set(db.prepare('SELECT id FROM series WHERE restricted=1').all().map((x) => x.id));
      if (restricted.size) r = { ...r, releases: r.releases.filter((it) => !(it.seriesId && restricted.has(it.seriesId))) };
    }
    res.json(r);
  });
  // (Re)write ComicVine metadata into every owned file of a comic.
  app.post('/api/collection/:id/tag', async (req, res) => {
    res.json(await tagSeriesFiles(Number(req.params.id), { onlyUntagged: !!req.body?.onlyUntagged }));
  });

  app.post('/api/collection/:id/cleanup', async (req, res) => {
    res.json(await cleanupSeriesFiles(Number(req.params.id)));
  });
  app.get('/api/tag-files', (req, res) => res.json(state.tagFiles || { running: false }));
  // Refresh a comic's metadata + issue list from ComicVine.
  app.post('/api/collection/:id/refresh', async (req, res) => {
    try { res.json(await refreshVolume(Number(req.params.id))); }
    catch (e) { res.status(502).json({ error: String(e?.message || e) }); }
  });
  // Remove a comic from the collection (optionally delete its files on disk).
  app.post('/api/collection/:id/delete', async (req, res) => {
    try { res.json(await deleteComic(Number(req.params.id), { deleteFiles: !!(req.body && req.body.deleteFiles) })); }
    catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
  });
  // Scan just this comic's folder to detect owned issues (per-volume index).
  app.post('/api/collection/:id/scan', async (req, res) => {
    res.json(await scanSeriesFolder(Number(req.params.id)));
  });
  // Rename/move THIS series' files to the configured folder/file patterns.
  // { dryRun:true } returns the planned moves; otherwise it performs them.
  app.post('/api/collection/:id/refile', (req, res) => {
    const row = getSeriesById(db, Number(req.params.id));
    if (!row) return res.status(404).json({ error: 'no such series' });
    if (!canRefile(row)) return res.status(400).json({ error: 'match this series to ComicVine first — its files can’t be organized without publisher/title/year' });
    try {
      if ((req.body || {}).dryRun) return res.json({ plan: planSeries(db, row) });
      res.json(refileSeries(db, row));
    } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
  });
  // Library-wide reorganize (a manual maintenance tool — never automatic).
  // Execution is a background job: the POST starts it, the status endpoint
  // reports progress, and it also appears on the Jobs page.
  app.get('/api/library/refile-plan', (req, res) => {
    try { res.json(planLibrary(db)); } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
  });
  app.post('/api/library/refile', (req, res) => {
    const r = runLibraryRefile();
    if (r.busy) return res.status(409).json({ error: 'a reorganize is already running' });
    res.json(r);
  });
  app.get('/api/library/refile-status', (req, res) => res.json(refileState()));
  // Live preview for the settings pattern fields — render a sample path.
  app.post('/api/naming/preview', (req, res) => {
    const { folderPattern, filePattern } = req.body || {};
    const s = { title: 'Batman', publisher: 'DC Comics', year: '2011' };
    const iss = { issue_number: '1', title: 'The Court of Owls, Part One', cover_date: '2011-11-01' };
    try {
      const folder = seriesFolderFromPattern(s, folderPattern);
      const file = fileStemFromPattern(s, iss, filePattern) + '.cbz';
      res.json({ folder, file, example: `${folder}/${file}` });
    } catch (e) { res.status(400).json({ error: String(e?.message || e) }); }
  });
  app.get('/api/scan-folder', (req, res) => res.json(state.scanFolder || { running: false }));
  // Set (or clear, with empty) a comic's folder on disk.
  app.post('/api/collection/:id/path', (req, res) => {
    setSeriesPath(db, Number(req.params.id), req.body?.path || null);
    const row = getSeriesById(db, Number(req.params.id));
    res.json({ path: row?.path || null, location: row ? resolveSeriesDir(db, row) : null });
  });
  // GLOBAL monitor flag — what download automation fetches (library.manage).
  app.post('/api/collection/:id/monitor', (req, res) => {
    const monitored = !!(req.body && req.body.monitored);
    setFollowed(db, Number(req.params.id), monitored);
    res.json({ monitored });
  });
  // PERSONAL follow — the signed-in user's own pull list (any library.view user;
  // see PERM_RULES). No effect on automation.
  app.post('/api/collection/:id/follow', (req, res) => {
    const follow = !!(req.body && req.body.follow);
    setUserFollow(db, req.user.id, Number(req.params.id), follow);
    res.json({ followed: follow });
  });

  // --- ComicVine metadata ---
  app.post('/api/cv/match', (req, res) => {
    runCvMatch();
    res.json({ started: true });
  });
  app.get('/api/cv', (req, res) => res.json(state.cv || { running: false }));
  app.get('/api/cv/search', async (req, res) => {
    try { res.json(await cvSearch(String(req.query.q || ''))); }
    catch (e) { res.status(502).json({ error: String(e?.message || e) }); }
  });
  // One volume by id — used when a ComicVine URL/id is pasted into the picker.
  app.get('/api/cv/volume/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid id' });
    try { res.json(await cvVolumeInfo(id)); }
    catch (e) { res.status(502).json({ error: String(e?.message || e) }); }
  });
  app.post('/api/collection/add-cv', async (req, res) => {
    const comicvineId = Number(req.body?.comicvineId);
    if (!comicvineId) return res.status(400).json({ error: 'comicvineId required' });
    try {
      const r = await addFromCv(comicvineId);
      // Adding implies personal interest: the adder follows it automatically
      // (the add itself sets the global monitor flag for automation).
      if (r?.seriesId != null) setUserFollow(db, req.user.id, r.seriesId, true);
      // Adding implies wanting: queue every missing issue right away. Runs
      // only under the ADDER's own download permission (a role that may
      // reshape the library but not download gets the add, nothing more),
      // and only while the autoDownloadOnAdd setting is on. With ZERO enabled
      // sources, queueing would just manufacture a wall of failed items — skip
      // it and tell the client why (r.noSources) so the UI can say so.
      const anySource = (listSources ? listSources() : []).length > 0;
      if (!anySource) r.noSources = true;
      if (config.autoDownloadOnAdd !== false && r.seriesId && anySource
          && users.roleGrants(db, req.user.role, 'downloads.grab', permCatalog)) {
        const missing = db.prepare(`
          SELECT ci.comicvine_id, ci.issue_number, ci.name FROM cv_issues ci
           WHERE ci.cv_series_id = ? AND NOT EXISTS
             (SELECT 1 FROM library_files lf WHERE lf.cv_issue_id = ci.comicvine_id AND lf.valid = 1)
        `).all(r.cvId);
        const ids = missing.map((ci) => ensureCvIssueRow(db, {
          seriesId: r.seriesId, cvIssueId: ci.comicvine_id, number: ci.issue_number, title: ci.name,
        }));
        if (ids.length) { queueIssues(db, ids); startDownloads(); }
        r.queued = ids.length;
      }
      res.json(r);
    } catch (e) { res.status(502).json({ error: String(e?.message || e) }); }
  });
  app.post('/api/collection/:id/cv', async (req, res) => {
    const comicvineId = Number(req.body?.comicvineId);
    if (!comicvineId) return res.status(400).json({ error: 'comicvineId required' });
    try { res.json(await cvSetManual(Number(req.params.id), comicvineId)); }
    catch (e) { res.status(502).json({ error: String(e?.message || e) }); }
  });

  app.post('/api/queue/cancel/:id', (req, res) => { res.json({ cancelled: cancelIssue(db, Number(req.params.id)) }); });

  app.post('/api/redownload', async (req, res) => {
    const ids = Array.isArray(req.body.issueIds) ? req.body.issueIds.map(Number) : [];
    await prepareRedownload(ids); // delete old files + reset status to pending
    queueIssues(db, ids);
    startDownloads(ids);
    res.json({ queued: ids.length });
  });

  app.post('/api/retry-failed', (req, res) => {
    const requeued = requeueFailed(db);
    if (requeued) startDownloads();
    res.json({ requeued });
  });
  // Retry ONE failed item (the queue row's Retry button).
  app.post('/api/queue/retry/:id', (req, res) => {
    const requeued = requeueFailed(db, Number(req.params.id));
    if (requeued) startDownloads();
    res.json({ requeued });
  });

  app.post('/api/clear-failed', (req, res) => res.json({ cleared: clearFailed(db) }));

  app.get('/api/settings', (req, res) => {
    res.json(getSettings());
  });

  app.post('/api/settings', (req, res) => {
    res.json(saveSettings(req.body || {}));
  });

  // Probe a Newznab indexer without saving it (used by the indexer modal's Test).
  app.post('/api/indexers/test', async (req, res) => {
    const { url, apiKey, name } = req.body || {};
    if (!url) return res.status(400).json({ ok: false, message: 'A URL is required.' });
    try {
      const result = await testIndexer({ name, url: String(url).replace(/\/+$/, ''), apiKey: apiKey || '' });
      res.json(result);
    } catch (e) {
      res.json({ ok: false, message: String(e?.message || e) });
    }
  });

  // Ping the download client (SABnzbd/NZBGet) without grabbing anything.
  app.post('/api/clients/test', async (req, res) => {
    try {
      res.json(await testClient(req.body || {}));
    } catch (e) {
      res.json({ ok: false, message: String(e?.message || e) });
    }
  });

  // Probe a Torznab indexer without saving it (the torrent indexer modal's Test).
  app.post('/api/torznab/test', async (req, res) => {
    const { url, apiKey, name } = req.body || {};
    if (!url) return res.status(400).json({ ok: false, message: 'A URL is required.' });
    try {
      res.json(await testTorznabIndexer({ name, url: String(url).replace(/\/+$/, ''), apiKey: apiKey || '' }));
    } catch (e) {
      res.json({ ok: false, message: String(e?.message || e) });
    }
  });

  // Ping qBittorrent without adding anything.
  app.post('/api/torrent-client/test', async (req, res) => {
    try {
      res.json(await testTorrentClient(req.body || {}));
    } catch (e) {
      res.json({ ok: false, message: String(e?.message || e) });
    }
  });


  // Plugin-contributed routes (e.g. a private catalog source's crawl/status
  // endpoints), mounted after core routes and before the SPA fallback.
  for (const r of pluginRoutes) {
    if (typeof app[r.method] === 'function') app[r.method](r.path, r.handler);
  }

  // Client-side routes (History API): serve the app shell for any non-API,
  // non-file GET so deep links like /volume/482 and /settings work on refresh.
  app.get(/^(?!\/api\/).*/, (req, res, next) => {
    if (req.method !== 'GET' || req.path.includes('.')) return next();
    const html = shellHtml(req);
    if (html == null) {
      return res.status(503).type('text/plain')
        .send('BackIssue UI is not built yet.\n\nRun:  npm run build\n\nthen reload. (The API is up — this only affects the web UI.)');
    }
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(html);
  });

  // Error backstop. Express 5 forwards REJECTED PROMISES from async handlers
  // here automatically — so a route that throws returns a clean 500 JSON instead
  // of hanging the request forever (which is what Express 4 did).
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    // A malformed JSON body is the CLIENT's fault → 400, and not worth a
    // scary error log (it's reachable pre-auth with any garbage payload).
    if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) {
      return res.status(400).json({ error: 'invalid JSON body' });
    }
    // An oversized body (past express.json's 100kb cap) is also a 4xx.
    if (err?.type === 'entity.too.large' || err?.status === 413) {
      return res.status(413).json({ error: 'request body too large' });
    }
    console.error(`API error ${req.method} ${req.path}:`, err?.message || err);
    res.status(500).json({ error: String(err?.message || err) });
  });

  return app;
}
