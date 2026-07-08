// The user/permission system: open single-user mode until the first account
// exists, first registration = admin, role-gated routes (viewer < trusted <
// admin), sessions via HttpOnly cookie, Basic auth against the users table,
// and the can't-lock-yourself-out guard rails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { hashPassword, verifyPassword } from '../src/users.js';
import { pluginApi, registeredRoutes } from '../src/plugins.js';

function makeApp() {
  const db = openDb(':memory:');
  const app = createApp({
    db, state: { queue: {} },
    getSettings: () => ({}), saveSettings: (b) => b,
    prepareRedownload: async () => {}, runDownloads: async () => {},
    pluginRoutes: registeredRoutes(),
  });
  return { app, db };
}
async function listen(app) {
  return new Promise((res) => { const s = app.listen(0, () => res(s)); });
}
const cookieOf = (r) => (r.headers.get('set-cookie') || '').split(';')[0];

test('password hashing round-trips and rejects wrong passwords', () => {
  const h = hashPassword('correct horse battery');
  assert.ok(h.startsWith('scrypt$'));
  assert.ok(verifyPassword('correct horse battery', h));
  assert.ok(!verifyPassword('wrong', h));
});

test('zero users = open mode; first registration becomes admin and closes it', async () => {
  const { app } = makeApp();
  const s = await listen(app);
  const base = `http://localhost:${s.address().port}`;
  try {
    // open mode: API reachable without credentials, me() says so
    const me0 = await (await fetch(`${base}/api/auth/me`)).json();
    assert.equal(me0.openMode, true);
    assert.equal((await fetch(`${base}/api/series`)).status, 200);

    // first registration → admin, gets a session cookie
    const reg = await fetch(`${base}/api/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'testadmin', password: 'a-strong-one' }),
    });
    const regBody = await reg.json();
    assert.equal(regBody.user.role, 'admin');
    const cookie = cookieOf(reg);
    assert.match(cookie, /bi_session=/);

    // auth is now ACTIVE: anonymous requests are rejected
    assert.equal((await fetch(`${base}/api/series`)).status, 401);
    // …but the session works
    assert.equal((await fetch(`${base}/api/series`, { headers: { cookie } })).status, 200);
    // …and so does HTTP Basic against the users table
    const basic = 'Basic ' + Buffer.from('testadmin:a-strong-one').toString('base64');
    assert.equal((await fetch(`${base}/api/series`, { headers: { authorization: basic } })).status, 200);

    // second registration blocked while allowRegistration is off
    const reg2 = await fetch(`${base}/api/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'friend', password: 'password123' }),
    });
    assert.equal(reg2.status, 403);
  } finally { s.close(); }
});

test('roles gate routes: viewer can download but not mutate; admin routes locked down', async () => {
  const { app } = makeApp();
  const s = await listen(app);
  const base = `http://localhost:${s.address().port}`;
  try {
    // admin + a viewer
    const reg = await fetch(`${base}/api/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'adminpass1' }),
    });
    const adminCookie = cookieOf(reg);
    await fetch(`${base}/api/users`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ username: 'casual', password: 'viewerpass1', role: 'viewer' }),
    });
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'casual', password: 'viewerpass1' }),
    });
    assert.equal(login.status, 200);
    const viewerCookie = cookieOf(login);
    const V = { cookie: viewerCookie, 'content-type': 'application/json' };

    // viewer: reads OK
    assert.equal((await fetch(`${base}/api/series`, { headers: V })).status, 200);
    // viewer: downloads allowed by policy (route exists; 4xx would be 403 if gated)
    const dl = await fetch(`${base}/api/redownload`, { method: 'POST', headers: V, body: '{"issueIds":[]}' });
    assert.notEqual(dl.status, 403, 'viewer may queue downloads');
    // viewer: library mutation → 403
    const mut = await fetch(`${base}/api/collection/bulk`, { method: 'POST', headers: V, body: '{"ids":[],"action":"follow"}' });
    assert.equal(mut.status, 403);
    // viewer: admin surface → 403
    assert.equal((await fetch(`${base}/api/settings`, { headers: V })).status, 403);
    assert.equal((await fetch(`${base}/api/users`, { headers: V })).status, 403);

    // guard rails: the only admin cannot demote or delete themselves
    const meList = await (await fetch(`${base}/api/users`, { headers: { cookie: adminCookie } })).json();
    const adminId = meList.users.find((u) => u.username === 'admin').id;
    const demote = await fetch(`${base}/api/users/${adminId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ role: 'viewer' }),
    });
    assert.equal(demote.status, 400);
    const del = await fetch(`${base}/api/users/${adminId}`, { method: 'DELETE', headers: { cookie: adminCookie } });
    assert.equal(del.status, 400);

    // logout kills the session
    const lo = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { cookie: viewerCookie } });
    assert.equal(lo.status, 200, 'logout succeeds');
    assert.equal((await fetch(`${base}/api/series`, { headers: { cookie: viewerCookie } })).status, 401, 'dead session rejected');

    // Browsers cache Basic credentials and re-send them after logout — the
    // bi_nobasic marker from the logout response must suppress that, or
    // logging out of a browser that ever used Basic is impossible.
    const basicHdr = 'Basic ' + Buffer.from('casual:viewerpass1').toString('base64');
    assert.match(lo.headers.get('set-cookie') || '', /bi_nobasic=1/);
    assert.equal((await fetch(`${base}/api/series`, {
      headers: { authorization: basicHdr, cookie: 'bi_nobasic=1' },
    })).status, 401, 'cached Basic ignored after logout');
    // without the marker (scripts, tools) Basic still works
    assert.equal((await fetch(`${base}/api/series`, { headers: { authorization: basicHdr } })).status, 200);
    // an explicit sign-in clears the marker for that browser
    const relog = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: 'bi_nobasic=1' },
      body: JSON.stringify({ username: 'casual', password: 'viewerpass1' }),
    });
    assert.match(relog.headers.get('set-cookie') || '', /bi_nobasic=;.*Max-Age=0/);
  } finally { s.close(); }
});

// Boots an app with an admin session and returns helpers for the role tests.
async function appWithAdmin() {
  const { app } = makeApp();
  const s = await listen(app);
  const base = `http://localhost:${s.address().port}`;
  const reg = await fetch(`${base}/api/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'adminpass1' }),
  });
  const adminH = { cookie: cookieOf(reg), 'content-type': 'application/json' };
  const loginAs = async (username, password) => {
    const r = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    return { cookie: cookieOf(r), 'content-type': 'application/json' };
  };
  return { s, base, adminH, loginAs };
}

test('custom roles: explicit permission sets gate exactly what they name', async () => {
  const { s, base, adminH, loginAs } = await appWithAdmin();
  try {
    // a role that may browse and download — but not manage the library
    let r = await fetch(`${base}/api/roles`, {
      method: 'POST', headers: adminH,
      body: JSON.stringify({ name: 'downloader', label: 'Downloader', permissions: ['library.view', 'downloads.grab'] }),
    });
    assert.equal(r.status, 200);
    await fetch(`${base}/api/users`, {
      method: 'POST', headers: adminH,
      body: JSON.stringify({ username: 'dl', password: 'dlpassword1', role: 'downloader' }),
    });
    const dlH = await loginAs('dl', 'dlpassword1');

    assert.equal((await fetch(`${base}/api/series`, { headers: dlH })).status, 200, 'library.view grants reads');
    const grab = await fetch(`${base}/api/redownload`, { method: 'POST', headers: dlH, body: '{"issueIds":[]}' });
    assert.notEqual(grab.status, 403, 'downloads.grab grants download POSTs');
    const mut = await fetch(`${base}/api/collection/bulk`, { method: 'POST', headers: dlH, body: '{"ids":[],"action":"follow"}' });
    assert.equal(mut.status, 403, 'no library.manage → mutations blocked');
    assert.equal((await fetch(`${base}/api/settings`, { headers: dlH })).status, 403);
    assert.equal((await fetch(`${base}/api/logs`, { headers: dlH })).status, 403);
    // the user's resolved permissions ride along on /api/auth/me
    const me = await (await fetch(`${base}/api/auth/me`, { headers: dlH })).json();
    assert.deepEqual(me.user.permissions.sort(), ['downloads.grab', 'library.view']);

    // shrinking the role applies immediately (role cache invalidation)
    r = await fetch(`${base}/api/roles/downloader`, {
      method: 'PATCH', headers: adminH, body: JSON.stringify({ permissions: ['library.view'] }),
    });
    assert.equal(r.status, 200);
    const grab2 = await fetch(`${base}/api/redownload`, { method: 'POST', headers: dlH, body: '{"issueIds":[]}' });
    assert.equal(grab2.status, 403, 'revoked permission blocks on the next request');
  } finally { s.close(); }
});

test('role guard rails: built-ins immutable, in-use undeletable, unknown perms rejected', async () => {
  const { s, base, adminH } = await appWithAdmin();
  try {
    const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: adminH, body: JSON.stringify(body) });

    let r = await fetch(`${base}/api/roles/admin`, { method: 'PATCH', headers: adminH, body: '{"permissions":[]}' });
    assert.equal(r.status, 400, 'built-in roles cannot be edited');
    r = await fetch(`${base}/api/roles/viewer`, { method: 'DELETE', headers: adminH });
    assert.equal(r.status, 400, 'built-in roles cannot be deleted');

    r = await post('/api/roles', { name: 'ghost', permissions: ['no.such.permission'] });
    assert.equal(r.status, 400, 'unknown permissions are rejected');
    r = await post('/api/users', { username: 'x1', password: 'password123', role: 'nope' });
    assert.equal(r.status, 400, 'users cannot get a nonexistent role');

    await post('/api/roles', { name: 'temp', permissions: ['library.view'] });
    await post('/api/users', { username: 'tmpuser', password: 'password123', role: 'temp' });
    r = await fetch(`${base}/api/roles/temp`, { method: 'DELETE', headers: adminH });
    assert.equal(r.status, 400, 'a role still assigned to accounts cannot be deleted');
    const list = await (await fetch(`${base}/api/users`, { headers: adminH })).json();
    const tmp = list.users.find((u) => u.username === 'tmpuser');
    await fetch(`${base}/api/users/${tmp.id}`, { method: 'PATCH', headers: adminH, body: '{"role":"viewer"}' });
    r = await fetch(`${base}/api/roles/temp`, { method: 'DELETE', headers: adminH });
    assert.equal(r.status, 200, 'unused custom role deletes fine');
  } finally { s.close(); }
});

test('plugin-registered permissions gate plugin routes per role', async () => {
  // What a plugin does at load time: expose a permission, mark a route with it.
  pluginApi.registerPermission({ key: 'testplug.use', label: 'Use testplug', tier: 'viewer' });
  pluginApi.registerRoute('post', '/api/testplug/act', (req, res) => res.json({ ok: true }), { access: 'testplug.use' });

  const { s, base, adminH, loginAs } = await appWithAdmin();
  try {
    // built-in viewer: the perm's tier is viewer, so it's granted automatically
    await fetch(`${base}/api/users`, {
      method: 'POST', headers: adminH,
      body: JSON.stringify({ username: 'v1', password: 'password123', role: 'viewer' }),
    });
    const vH = await loginAs('v1', 'password123');
    assert.equal((await fetch(`${base}/api/testplug/act`, { method: 'POST', headers: vH, body: '{}' })).status, 200);

    // custom role without the plugin permission → 403; with it → 200
    await fetch(`${base}/api/roles`, {
      method: 'POST', headers: adminH,
      body: JSON.stringify({ name: 'noplug', permissions: ['library.view'] }),
    });
    await fetch(`${base}/api/users`, {
      method: 'POST', headers: adminH,
      body: JSON.stringify({ username: 'n1', password: 'password123', role: 'noplug' }),
    });
    const nH = await loginAs('n1', 'password123');
    assert.equal((await fetch(`${base}/api/testplug/act`, { method: 'POST', headers: nH, body: '{}' })).status, 403);
    await fetch(`${base}/api/roles/noplug`, {
      method: 'PATCH', headers: adminH, body: JSON.stringify({ permissions: ['library.view', 'testplug.use'] }),
    });
    assert.equal((await fetch(`${base}/api/testplug/act`, { method: 'POST', headers: nH, body: '{}' })).status, 200);
  } finally { s.close(); }
});

test('shell injection: plugin tags ride the served shell only for a session', async () => {
  const { app } = makeApp();
  const s = await listen(app);
  const base = `http://localhost:${s.address().port}`;
  try {
    // open mode: the shell carries the plugin bootstrap inline
    const open = await (await fetch(`${base}/`)).text();
    assert.match(open, /__BI_PLUGINS_INLINE__/, 'open mode gets inline plugin assets');

    // accounts exist: an anonymous shell is plugin-free, a session's is not
    const reg = await fetch(`${base}/api/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'adminpass1' }),
    });
    const anon = await (await fetch(`${base}/`)).text();
    assert.ok(!anon.includes('__BI_PLUGINS_INLINE__'), 'login page shell stays plugin-free');
    const authed = await (await fetch(`${base}/`, { headers: { cookie: cookieOf(reg) } })).text();
    assert.match(authed, /__BI_PLUGINS_INLINE__/, 'a session gets inline plugin assets');
  } finally { s.close(); }
});

test('login throttling: five failures lock the key; Basic honors the lock', async () => {
  const { clearAuthThrottle } = await import('../src/users.js');
  clearAuthThrottle();
  const { s, base, adminH } = await appWithAdmin();
  try {
    await fetch(`${base}/api/users`, {
      method: 'POST', headers: adminH,
      body: JSON.stringify({ username: 'target', password: 'password123', role: 'viewer' }),
    });
    const attempt = (password) => fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'target', password }),
    });

    // four failures: still just 401s, and the right password still works
    for (let i = 0; i < 4; i++) assert.equal((await attempt('wrong-wrong')).status, 401);
    assert.equal((await attempt('password123')).status, 200, 'success under the limit clears the count');

    // five straight failures: the key locks — even the RIGHT password 429s
    for (let i = 0; i < 5; i++) assert.equal((await attempt('wrong-wrong')).status, 401);
    const blocked = await attempt('password123');
    assert.equal(blocked.status, 429);
    assert.match((await blocked.json()).error, /try again in \d+s/);

    // Basic auth is the same password check — locked means locked
    const basic = 'Basic ' + Buffer.from('target:password123').toString('base64');
    assert.equal((await fetch(`${base}/api/series`, { headers: { authorization: basic } })).status, 401,
      'correct Basic credentials are refused while the key is locked');

    // other users are unaffected (per ip+username key)
    assert.equal((await fetch(`${base}/api/users`, { headers: adminH })).status, 200);
  } finally { clearAuthThrottle(); s.close(); }
});

test('setDisabled actually disables (regression: missing id bind), and kills sessions', async () => {
  const { openDb } = await import('../src/db.js');
  const users = await import('../src/users.js');
  const db = openDb(':memory:');
  users.initUserTables(db);
  const u = users.createUser(db, { username: 'victim', password: 'password123', role: 'viewer' });
  const tok = users.createSession(db, u.id);
  assert.ok(users.sessionUser(db, tok), 'session valid before disable');
  users.setDisabled(db, u.id, true); // previously threw (one bind for two ?)
  assert.equal(users.getUser(db, u.id).disabled, 1, 'row is disabled');
  assert.equal(users.sessionUser(db, tok), null, 'sessions revoked on disable');
  assert.equal(users.verifyCredentials(db, 'victim', 'password123'), null, 'disabled user cannot authenticate');
  users.setDisabled(db, u.id, false);
  assert.equal(users.getUser(db, u.id).disabled, 0, 're-enable works too');
});

test('security headers + CSRF-Basic block', async () => {
  const { app } = makeApp();
  const s = await listen(app);
  const base = `http://localhost:${s.address().port}`;
  try {
    const r = await fetch(`${base}/api/auth/me`);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.match(r.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);

    // activate auth, then a cross-origin Basic POST must be refused
    await fetch(`${base}/api/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'adminpass1' }),
    });
    const basic = 'Basic ' + Buffer.from('admin:adminpass1').toString('base64');
    const evil = await fetch(`${base}/api/cv/match`, {
      method: 'POST', headers: { authorization: basic, origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(evil.status, 403, 'cross-origin Basic POST refused');
    // a tool with Basic and NO Origin header is allowed through (not a browser)
    const tool = await fetch(`${base}/api/series`, { headers: { authorization: basic } });
    assert.equal(tool.status, 200, 'header-less Basic (scripts) still works');
  } finally { s.close(); }
});

test('basicAuth routes send a WWW-Authenticate challenge on 401; the SPA does not', async () => {
  // A machine-facing route (like OPDS) opts into a Basic challenge so external
  // readers know to send credentials. Core routes must NOT — a browser would
  // pop a native Basic dialog otherwise.
  const db = openDb(':memory:');
  const app = createApp({
    db, state: { queue: {} },
    getSettings: () => ({}), saveSettings: (b) => b,
    prepareRedownload: async () => {}, runDownloads: async () => {},
    pluginRoutes: [
      { method: 'get', path: '/api/opds', handler: (req, res) => res.send('root'), access: 'viewer', basicAuth: true },
      { method: 'get', path: '/api/opds/series/:id', handler: (req, res) => res.send('one'), access: 'viewer', basicAuth: true },
    ],
  });
  const s = await listen(app);
  const base = `http://localhost:${s.address().port}`;
  try {
    // activate auth
    await fetch(`${base}/api/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'reader', password: 'a-strong-one' }),
    });
    // anonymous OPDS: 401 WITH the challenge header (Panels needs this)
    const anon = await fetch(`${base}/api/opds`);
    assert.equal(anon.status, 401);
    assert.match(anon.headers.get('www-authenticate') || '', /^Basic /);
    // a sub-path with a param also challenges
    const sub = await fetch(`${base}/api/opds/series/42`);
    assert.match(sub.headers.get('www-authenticate') || '', /^Basic /);
    // a core route's 401 must NOT challenge (no browser Basic popup)
    const core = await fetch(`${base}/api/series`);
    assert.equal(core.status, 401);
    assert.equal(core.headers.get('www-authenticate'), null);
    // and correct Basic credentials get in
    const basic = 'Basic ' + Buffer.from('reader:a-strong-one').toString('base64');
    assert.equal((await fetch(`${base}/api/opds`, { headers: { authorization: basic } })).status, 200);
  } finally { s.close(); }
});

test('safeUrl blocks javascript:/data: incl. control-char-split schemes', async () => {
  const { safeUrl } = await import('../frontend/src/lib/util.js');
  for (const good of ['https://cv.com/x', 'http://a.b', '/rel', '#a', 'mailto:x@y.z']) {
    assert.equal(safeUrl(good), good, `keeps ${good}`);
  }
  for (const bad of ['javascript:alert(1)', 'java\tscript:alert(1)', 'java\nscript:x', '  javascript:x', 'JAVAscript:x', 'data:text/html,x', 'vbscript:x']) {
    assert.equal(safeUrl(bad), '', `drops ${JSON.stringify(bad)}`);
  }
});

test('login falls back to a plugin credential provider and provisions the user', async () => {
  // Simulates a remote password backend (e.g. WHMCS): verifies a specific
  // credential pair and hands core a verified external identity.
  pluginApi.registerCredentialProvider(async (username, password) =>
    username === 'client@x.com' && password === 'good'
      ? { provider: 'mock-billing', subject: 'client-1', email: 'client@x.com', name: 'Client', defaultRole: 'viewer' }
      : null);
  const { app } = makeApp();
  const s = await listen(app);
  const base = `http://localhost:${s.address().port}`;
  const post = (path, body) => fetch(`${base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    // Close open mode with a real admin so login is enforced.
    await post('/api/auth/register', { username: 'admin', password: 'adminpass1' });

    // Wrong remote password → local fails, provider returns null → 401.
    const bad = await post('/api/auth/login', { username: 'client@x.com', password: 'nope' });
    assert.equal(bad.status, 401);

    // Valid remote creds → provider verifies → core provisions + issues a session.
    const ok = await post('/api/auth/login', { username: 'client@x.com', password: 'good' });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.user.username, 'Client'); // provisioned from the verified identity's name
    assert.equal(body.user.role, 'viewer');
    assert.ok(cookieOf(ok), 'issues a session cookie');

    // The provider is not consulted for the local admin (local auth wins first).
    const admin = await post('/api/auth/login', { username: 'admin', password: 'adminpass1' });
    assert.equal(admin.status, 200);
  } finally { s.close(); }
});
