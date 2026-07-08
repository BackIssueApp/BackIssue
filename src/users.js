// User accounts, sessions, and roles.
//
// Roles (strictly ordered): viewer < trusted < admin.
//   viewer  — browse and read only (the default for signups): no searching,
//             downloading, or queue actions
//   trusted — everything viewer has + search & download + library mutations
//             (add/remove volumes, scan, tag, import, matching…)
//   admin   — everything + settings, users, plugins, jobs/tools/logs
//
// Passwords are scrypt (node:crypto, no dependency); sessions are opaque
// random tokens stored HASHED (a leaked DB can't impersonate anyone), sent as
// an HttpOnly cookie. HTTP Basic is still accepted and verified against the
// users table so scripts and tools keep working.
import crypto from 'node:crypto';

export const ROLES = ['viewer', 'trusted', 'admin'];
export const roleAtLeast = (have, need) => ROLES.indexOf(have) >= ROLES.indexOf(need);

// ---- permissions ------------------------------------------------------------
// Every gated action maps to a named permission. The three built-in roles grant
// by TIER (viewer-tier perms for viewer, +trusted-tier for trusted, everything
// for admin) — so new permissions, including plugin-registered ones, slot into
// the built-ins automatically. Custom roles hold an explicit permission list.
export const TIERS = ['viewer', 'trusted', 'admin'];
const tierRank = (t) => TIERS.indexOf(t);

export const CORE_PERMISSIONS = [
  { key: 'library.view', label: 'Browse the library', description: 'See series, issues, releases, and the queue', tier: 'viewer', category: 'Library' },
  { key: 'downloads.grab', label: 'Search & download', description: 'Search sources, queue downloads, cancel queued items', tier: 'trusted', category: 'Library' },
  { key: 'library.manage', label: 'Manage the library', description: 'Add/remove volumes and issues, scan, tag, import, fix matches', tier: 'trusted', category: 'Library' },
  { key: 'library.restricted', label: 'View mature content', description: 'See and read series flagged as mature/restricted (hidden from roles without this)', tier: 'trusted', category: 'Library' },
  { key: 'settings.manage', label: 'Settings & indexers', description: 'Change app settings, indexers, and run connection tests', tier: 'admin', category: 'System' },
  { key: 'users.manage', label: 'Users & roles', description: 'Create and manage accounts, roles, and permissions', tier: 'admin', category: 'System' },
  { key: 'plugins.manage', label: 'Plugins & restart', description: 'Enable/disable plugins and restart the app', tier: 'admin', category: 'System' },
  { key: 'system.jobs', label: 'Jobs & tools', description: 'Run jobs, schedules, and library maintenance tools', tier: 'admin', category: 'System' },
  { key: 'system.logs', label: 'Logs', description: 'View and clear application logs', tier: 'admin', category: 'System' },
];

// N=2^15 (double the old 2^14) — a stronger work factor while staying fast
// enough for interactive login. maxmem must be raised or scryptSync throws
// (memory ≈ 128·N·r = 32MB here). The N is stored per-hash, so existing
// 2^14 hashes keep verifying and re-hash to 2^15 on the next password change.
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 };
const SESSION_DAYS = 30;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT.keylen,
    { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [algo, N, r, p, saltHex, hashHex] = String(stored).split('$');
    if (algo !== 'scrypt') return false;
    const hash = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), hashHex.length / 2, {
      N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem,
    });
    return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
  } catch {
    return false;
  }
}

const tokenHash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

export function initUserTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'viewer',
      disabled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      expires_at TEXT NOT NULL,
      last_seen TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE TABLE IF NOT EXISTS roles (
      name TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      tier TEXT,                -- built-in roles: grant every permission at/below this tier
      permissions TEXT,         -- custom roles: JSON array of permission keys
      builtin INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
  `);
  db.prepare(`INSERT OR IGNORE INTO roles (name, label, tier, builtin) VALUES
    ('viewer', 'Viewer', 'viewer', 1),
    ('trusted', 'Trusted', 'trusted', 1),
    ('admin', 'Admin', 'admin', 1)`).run();
  // External identities (OIDC/SSO): map a verified (provider, subject) to a
  // local user so external logins land on a stable account. email is added to
  // users for linking-by-email and display. ALTER is idempotent-guarded since
  // CREATE TABLE IF NOT EXISTS can't add a column to an existing table.
  const userCols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!userCols.includes('email')) db.exec('ALTER TABLE users ADD COLUMN email TEXT');
  db.exec(`
    CREATE TABLE IF NOT EXISTS external_identities (
      provider TEXT NOT NULL,
      subject TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      PRIMARY KEY (provider, subject)
    );
    CREATE INDEX IF NOT EXISTS idx_extid_user ON external_identities(user_id);
  `);
  clearRoleCache();
}

// ---- external identities (SSO/OIDC) ----------------------------------------
// Sanitize an arbitrary display name/email-local-part into a valid username.
function sanitizeUsername(raw) {
  let s = String(raw || '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 32);
  while (s.length < 2) s += '0';
  return s;
}

export function findUserByEmail(db, email) {
  if (!email) return null;
  return db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE LIMIT 1').get(String(email)) || null;
}

export function findUserByExternalIdentity(db, provider, subject) {
  const row = db.prepare('SELECT user_id FROM external_identities WHERE provider = ? AND subject = ?')
    .get(String(provider), String(subject));
  return row ? getUser(db, row.user_id) : null;
}

export function linkExternalIdentity(db, provider, subject, userId) {
  db.prepare('INSERT OR IGNORE INTO external_identities (provider, subject, user_id) VALUES (?, ?, ?)')
    .run(String(provider), String(subject), userId);
}

// Create a user with no usable password — they authenticate via their external
// provider. A unique username is derived from the requested one.
export function createExternalUser(db, { username, email, role = 'viewer' }) {
  if (!roleExists(db, role)) role = 'viewer';
  const pw = hashPassword(crypto.randomBytes(24).toString('hex')); // random → unusable for password login
  const base = sanitizeUsername(username) || 'user';
  let final = base;
  for (let n = 1; db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE').get(final); n += 1) {
    final = `${base}${n}`.slice(0, 32);
  }
  const r = db.prepare('INSERT INTO users (username, password_hash, role, email) VALUES (?, ?, ?, ?)')
    .run(final, pw, role, email ? String(email) : null);
  return getUser(db, r.lastInsertRowid);
}

// Resolve an ALREADY-VERIFIED external identity to a local user: by prior link,
// else by matching email, else auto-provision. Links the identity for next
// time. Callers MUST have verified the identity (e.g. a valid OIDC id_token).
export function resolveExternalUser(db, { provider, subject, email, name, defaultRole = 'viewer' }) {
  if (!provider || !subject) throw new Error('external identity requires provider and subject');
  let user = findUserByExternalIdentity(db, provider, subject);
  if (user) return user;
  if (email) {
    user = findUserByEmail(db, email);
    if (user) { linkExternalIdentity(db, provider, subject, user.id); return user; }
  }
  const uname = name || (email ? String(email).split('@')[0] : '') || `${provider}-user`;
  user = createExternalUser(db, { username: uname, email, role: defaultRole });
  linkExternalIdentity(db, provider, subject, user.id);
  return user;
}

// ---- roles ------------------------------------------------------------------
// Role rows are read on every request, so they're cached; any mutation clears
// the cache (single process — no cross-instance invalidation to worry about).
let roleCache = null;
const rolesMap = (db) => {
  if (!roleCache) roleCache = new Map(db.prepare('SELECT * FROM roles').all().map((r) => [r.name, r]));
  return roleCache;
};
export function clearRoleCache() { roleCache = null; }

export function roleExists(db, name) { return rolesMap(db).has(String(name)); }

/** Does `roleName` grant `permKey`? `catalog` maps key → { tier } (core +
 *  plugin-registered). Unknown permissions default to admin-tier — a perm
 *  whose plugin is uninstalled stays locked down rather than leaking open. */
export function roleGrants(db, roleName, permKey, catalog) {
  const role = rolesMap(db).get(String(roleName));
  if (!role) return false;
  if (role.tier) {
    const perm = catalog.get(permKey);
    return tierRank(role.tier) >= tierRank(perm ? perm.tier : 'admin');
  }
  let list = [];
  try { list = JSON.parse(role.permissions || '[]'); } catch { /* treated as none */ }
  return list.includes('*') || list.includes(permKey);
}

/** The resolved permission list for a role — what the client's can() uses.
 *  Built-in admin resolves to ['*'] so future permissions need no re-login. */
export function rolePermissions(db, roleName, catalog) {
  const role = rolesMap(db).get(String(roleName));
  if (!role) return [];
  if (role.tier === 'admin') return ['*'];
  if (role.tier) return [...catalog.values()].filter((p) => tierRank(role.tier) >= tierRank(p.tier)).map((p) => p.key);
  try { return JSON.parse(role.permissions || '[]'); } catch { return []; }
}

export function listRoles(db, catalog) {
  return db.prepare('SELECT name, label, tier, builtin FROM roles ORDER BY builtin DESC, name').all()
    .map((r) => ({
      name: r.name, label: r.label, builtin: !!r.builtin, tier: r.tier || null,
      permissions: rolePermissions(db, r.name, catalog),
      users: db.prepare('SELECT COUNT(*) n FROM users WHERE role=?').get(r.name).n,
    }));
}

const validRoleName = (n) => /^[a-z0-9][a-z0-9_-]{1,31}$/.test(String(n || ''));
const validPermissions = (perms, catalog) => {
  if (!Array.isArray(perms)) return 'permissions must be a list';
  for (const p of perms) if (!catalog.has(p)) return `unknown permission: ${p}`;
  return null;
};

export function createRole(db, { name, label, permissions }, catalog) {
  if (!validRoleName(name)) throw new Error('role name must be 2–32 chars: lowercase letters, digits, _ -');
  if (roleExists(db, name)) throw new Error('that role name is taken');
  const bad = validPermissions(permissions, catalog);
  if (bad) throw new Error(bad);
  db.prepare('INSERT INTO roles (name, label, permissions, builtin) VALUES (?, ?, ?, 0)')
    .run(String(name), String(label || name), JSON.stringify(permissions));
  clearRoleCache();
}

export function updateRole(db, name, { label, permissions }, catalog) {
  const role = rolesMap(db).get(String(name));
  if (!role) throw new Error('no such role');
  if (role.builtin) throw new Error('built-in roles cannot be edited');
  if (permissions !== undefined) {
    const bad = validPermissions(permissions, catalog);
    if (bad) throw new Error(bad);
    db.prepare('UPDATE roles SET permissions=? WHERE name=?').run(JSON.stringify(permissions), name);
  }
  if (label !== undefined) db.prepare('UPDATE roles SET label=? WHERE name=?').run(String(label), name);
  clearRoleCache();
}

export function deleteRole(db, name) {
  const role = rolesMap(db).get(String(name));
  if (!role) throw new Error('no such role');
  if (role.builtin) throw new Error('built-in roles cannot be deleted');
  const inUse = db.prepare('SELECT COUNT(*) n FROM users WHERE role=?').get(name).n;
  if (inUse) throw new Error(`${inUse} account(s) still have this role — reassign them first`);
  db.prepare('DELETE FROM roles WHERE name=?').run(name);
  clearRoleCache();
}

const validUsername = (u) => /^[A-Za-z0-9_.-]{2,32}$/.test(String(u || ''));

export function userCount(db) {
  return db.prepare('SELECT COUNT(*) n FROM users').get().n;
}

export function createUser(db, { username, password, role = 'viewer' }) {
  if (!validUsername(username)) throw new Error('username must be 2–32 chars: letters, digits, _ . -');
  if (String(password || '').length < 8) throw new Error('password must be at least 8 characters');
  if (!roleExists(db, role)) throw new Error('unknown role');
  try {
    const r = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
      .run(String(username), hashPassword(password), role);
    return getUser(db, r.lastInsertRowid);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new Error('that username is taken');
    throw e;
  }
}

export function getUser(db, id) {
  return db.prepare('SELECT id, username, email, role, disabled, created_at FROM users WHERE id=?').get(id) || null;
}

export function listUsers(db) {
  return db.prepare(`
    SELECT u.id, u.username, u.role, u.disabled, u.created_at,
           (SELECT MAX(last_seen) FROM sessions s WHERE s.user_id = u.id) AS last_seen,
           (SELECT GROUP_CONCAT(DISTINCT provider) FROM external_identities e WHERE e.user_id = u.id) AS providers
      FROM users u ORDER BY u.id`).all()
    // A user linked to an external login (SSO/OIDC, WHMCS, …) carries its
    // provider id(s); a plain local account has none.
    .map((u) => ({ ...u, providers: u.providers ? u.providers.split(',') : [] }));
}

/** One account's own details for the profile page: identity + when they joined,
 *  last activity, and any external-login providers. */
export function userProfile(db, id) {
  const u = db.prepare(`
    SELECT u.id, u.username, u.email, u.role, u.created_at,
           (SELECT MAX(last_seen) FROM sessions s WHERE s.user_id = u.id) AS last_seen,
           (SELECT GROUP_CONCAT(DISTINCT provider) FROM external_identities e WHERE e.user_id = u.id) AS providers
      FROM users u WHERE u.id = ?`).get(id);
  if (!u) return null;
  return { ...u, providers: u.providers ? u.providers.split(',') : [] };
}

/** Set a user's email (self-service). Blank clears it. Validates format and
 *  guards uniqueness so it stays a reliable key for external-login linking. */
export function updateEmail(db, id, email) {
  const e = String(email || '').trim() || null;
  if (e && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new Error('that doesn’t look like an email address');
  if (e) {
    const other = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(e, id);
    if (other) throw new Error('that email is already linked to another account');
  }
  db.prepare('UPDATE users SET email = ? WHERE id = ?').run(e, id);
  return e;
}

/** Sign out every OTHER session for a user, keeping the one making the request
 *  (identified by its raw token). Returns how many were cleared. */
export function destroyOtherSessions(db, userId, keepToken) {
  const keep = keepToken ? tokenHash(keepToken) : '';
  return db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(userId, keep).changes;
}

/** Credentials → user row (with hash timing regardless of user existence). */
export function verifyCredentials(db, username, password) {
  const row = db.prepare('SELECT * FROM users WHERE username=?').get(String(username || ''));
  const stored = row?.password_hash || hashPassword('timing-pad');
  const ok = verifyPassword(password, stored);
  if (!ok || !row || row.disabled) return null;
  return { id: row.id, username: row.username, role: row.role, disabled: row.disabled };
}

export function setPassword(db, id, password) {
  if (String(password || '').length < 8) throw new Error('password must be at least 8 characters');
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(password), id);
  // password change invalidates every session except none — callers decide;
  // safest default is to revoke all of the user's sessions.
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
}

export function setRole(db, id, role) {
  if (!roleExists(db, role)) throw new Error('unknown role');
  db.prepare('UPDATE users SET role=? WHERE id=?').run(role, id);
}

export function setDisabled(db, id, disabled) {
  db.prepare('UPDATE users SET disabled=? WHERE id=?').run(disabled ? 1 : 0, id);
  if (disabled) db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
}

export function deleteUser(db, id) {
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
  db.prepare('DELETE FROM users WHERE id=?').run(id);
}

// ---- sessions -------------------------------------------------------------

export function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  // Stamp last_seen at creation so a brand-new sign-in reads as "seen just now"
  // immediately — otherwise a user who logs in (especially via SSO/WHMCS and
  // lands on a single page) shows as "never signed in" until their next request.
  db.prepare(`INSERT INTO sessions (token_hash, user_id, expires_at, last_seen)
              VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now','+${SESSION_DAYS} days'),
                      strftime('%Y-%m-%dT%H:%M:%SZ','now'))`)
    .run(tokenHash(token), userId);
  return token;
}

export function sessionUser(db, token) {
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.id, u.username, u.role, u.disabled FROM sessions s
      JOIN users u ON u.id = s.user_id
     WHERE s.token_hash=? AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%SZ','now')`)
    .get(tokenHash(token));
  if (!row || row.disabled) return null;
  db.prepare("UPDATE sessions SET last_seen=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE token_hash=?")
    .run(tokenHash(token));
  return row;
}

export function destroySession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash(token));
}

export function pruneSessions(db) {
  db.prepare("DELETE FROM sessions WHERE expires_at <= strftime('%Y-%m-%dT%H:%M:%SZ','now')").run();
}

// ---- login throttling --------------------------------------------------
// Brute-force protection for login/register/Basic: after 5 consecutive
// failures per (ip, username) the key locks for 30s, doubling per further
// failure up to 15 minutes. A success clears the key. In-memory by design —
// a restart forgiving locks is fine; a DB table would just be a new disk
// write on every wrong password.
const AUTH_FAILS = new Map(); // key → { n, until }
// 5-minute cap (was 15) to bound any account-lockout-DoS window when the app
// sits behind a proxy that shares one client IP. Set `trustProxy` so req.ip
// is the real client and each attacker only throttles their own bucket.
const LOCK_AFTER = 5, LOCK_BASE_MS = 30_000, LOCK_MAX_MS = 5 * 60_000;

/** Seconds until this key may try again (0 = not locked). */
export function authBlockedFor(key) {
  const e = AUTH_FAILS.get(key);
  if (!e) return 0;
  const left = Math.ceil((e.until - Date.now()) / 1000);
  return left > 0 ? left : 0;
}
export function authFailed(key) {
  const e = AUTH_FAILS.get(key) || { n: 0, until: 0 };
  e.n++;
  if (e.n >= LOCK_AFTER) {
    e.until = Date.now() + Math.min(LOCK_MAX_MS, LOCK_BASE_MS * 2 ** (e.n - LOCK_AFTER));
  }
  AUTH_FAILS.set(key, e);
  if (AUTH_FAILS.size > 10_000) AUTH_FAILS.clear(); // memory backstop under a spray
}
export function authSucceeded(key) { AUTH_FAILS.delete(key); }
export function clearAuthThrottle() { AUTH_FAILS.clear(); } // tests

// Basic-auth verification is scrypt (~50–100ms) — far too slow per request.
// Successful verifications are cached by (username, sha256(password)) for a
// few minutes; disabled/deleted users drop out on the next cache miss.
const basicCache = new Map(); // key → { user, until }
export function verifyBasicCached(db, username, password) {
  const key = `${String(username).toLowerCase()}:${crypto.createHash('sha256').update(String(password)).digest('hex')}`;
  const hit = basicCache.get(key);
  if (hit && hit.until > Date.now()) return hit.user;
  const user = verifyCredentials(db, username, password);
  if (user) basicCache.set(key, { user, until: Date.now() + 5 * 60_000 });
  else basicCache.delete(key);
  if (basicCache.size > 500) basicCache.clear(); // crude cap
  return user;
}
export function clearBasicCache() { basicCache.clear(); }
