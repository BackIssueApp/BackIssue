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
