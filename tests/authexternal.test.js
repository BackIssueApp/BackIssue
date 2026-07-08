import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import * as users from '../src/users.js';

function freshDb() {
  const d = openDb(':memory:');
  users.initUserTables(d);
  return d;
}

test('resolveExternalUser auto-provisions + links, then returns the same user', () => {
  const d = freshDb();
  const u1 = users.resolveExternalUser(d, { provider: 'oidc', subject: 'abc', email: 'a@x.com', name: 'Alice', defaultRole: 'viewer' });
  assert.ok(u1.id);
  assert.equal(u1.role, 'viewer');
  assert.equal(u1.email, 'a@x.com');
  const u2 = users.resolveExternalUser(d, { provider: 'oidc', subject: 'abc', email: 'a@x.com' });
  assert.equal(u2.id, u1.id, 'same (provider,subject) → same linked user');
  assert.equal(users.userCount(d), 1, 'no duplicate user');
});

test('resolveExternalUser links to an existing account by email (keeps its role)', () => {
  const d = freshDb();
  const existing = users.createUser(d, { username: 'bob', password: 'password1', role: 'trusted' });
  d.prepare('UPDATE users SET email=? WHERE id=?').run('bob@x.com', existing.id);
  const u = users.resolveExternalUser(d, { provider: 'oidc', subject: 'zzz', email: 'bob@x.com' });
  assert.equal(u.id, existing.id, 'linked to the existing account');
  assert.equal(u.role, 'trusted', 'existing role preserved');
  assert.equal(users.userCount(d), 1, 'no new user created');
});

test('an auto-provisioned external user cannot log in with a password', () => {
  const d = freshDb();
  const u = users.resolveExternalUser(d, { provider: 'oidc', subject: 's', email: 'c@x.com' });
  assert.equal(users.verifyCredentials(d, u.username, ''), null);
  assert.equal(users.verifyCredentials(d, u.username, 'anything'), null);
});

test('defaultRole is honored for auto-provisioned users, and subject is required', () => {
  const d = freshDb();
  const u = users.resolveExternalUser(d, { provider: 'oidc', subject: 's2', email: 'd@x.com', defaultRole: 'admin' });
  assert.equal(u.role, 'admin');
  assert.throws(() => users.resolveExternalUser(d, { provider: 'oidc', subject: '' }), /provider and subject/);
});

test('listUsers reports external-login providers and a plain account has none', () => {
  const d = freshDb();
  const local = users.createUser(d, { username: 'localguy', password: 'password1', role: 'viewer' });
  const ext = users.resolveExternalUser(d, { provider: 'whmcs', subject: '42', email: 'w@x.com', name: 'W', defaultRole: 'viewer' });
  const rows = users.listUsers(d);
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.deepEqual(byId[local.id].providers, [], 'local account has no providers');
  assert.deepEqual(byId[ext.id].providers, ['whmcs'], 'external account reports its provider');
});

test('createSession stamps last_seen so a fresh login is not "never signed in"', () => {
  const d = freshDb();
  const u = users.createUser(d, { username: 'seenme', password: 'password1', role: 'viewer' });
  users.createSession(d, u.id);
  const row = users.listUsers(d).find((r) => r.id === u.id);
  assert.ok(row.last_seen, 'last_seen is set at session creation');
});

test('profile email: set, validate, uniqueness, clear; userProfile shape', () => {
  const d = freshDb();
  const a = users.createUser(d, { username: 'alice', password: 'password1', role: 'viewer' });
  const b = users.createUser(d, { username: 'bob', password: 'password1', role: 'viewer' });
  assert.equal(users.updateEmail(d, a.id, 'alice@x.com'), 'alice@x.com');
  assert.equal(users.userProfile(d, a.id).email, 'alice@x.com');
  assert.throws(() => users.updateEmail(d, a.id, 'not-an-email'), /email address/);
  assert.throws(() => users.updateEmail(d, b.id, 'alice@x.com'), /already linked/);
  assert.equal(users.updateEmail(d, a.id, ''), null, 'blank clears');
  const p = users.userProfile(d, a.id);
  assert.equal(p.username, 'alice');
  assert.equal(p.email, null);
  assert.deepEqual(p.providers, []);
});

test('sign out other devices keeps the current session, drops the rest', () => {
  const d = freshDb();
  const u = users.createUser(d, { username: 'multi', password: 'password1' });
  const t1 = users.createSession(d, u.id);
  const t2 = users.createSession(d, u.id);
  const t3 = users.createSession(d, u.id);
  assert.ok(users.sessionUser(d, t1) && users.sessionUser(d, t2) && users.sessionUser(d, t3));
  assert.equal(users.destroyOtherSessions(d, u.id, t2), 2, 'two others cleared');
  assert.equal(users.sessionUser(d, t2)?.id, u.id, 'current session kept');
  assert.equal(users.sessionUser(d, t1), null);
  assert.equal(users.sessionUser(d, t3), null);
});
