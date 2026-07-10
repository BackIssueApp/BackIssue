// The notification system: per-user feed (broadcast + targeted), read
// receipts, retention pruning, and fan-out to registered outbound notifiers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { pluginApi } from '../src/plugins.js';
import { initNotificationTables, notify, listNotifications, unreadCount, markRead } from '../src/notifications.js';

function db() { const d = openDb(':memory:'); initNotificationTables(d); return d; }

test('feed scoping: broadcast is seen by all; targeted only by its user', () => {
  const d = db();
  notify(d, { type: 'x', category: 'import', title: 'Everyone' });          // broadcast
  notify(d, { type: 'y', category: 'request', title: 'Just Bob', userId: 7 }); // targeted to 7

  const bob = listNotifications(d, 7);
  assert.equal(bob.items.length, 2, 'user 7 sees broadcast + own');
  assert.equal(bob.unread, 2);
  const ann = listNotifications(d, 9);
  assert.equal(ann.items.length, 1, 'user 9 sees only the broadcast');
  assert.equal(ann.items[0].title, 'Everyone');
});

test('broadcasts are filtered to the categories a user may see', () => {
  const d = db();
  notify(d, { type: 'a', category: 'import', title: 'Import done' });          // broadcast
  notify(d, { type: 'b', category: 'request', title: 'New request' });         // broadcast
  const mine = notify(d, { type: 'c', category: 'request', title: 'Your request', userId: 5 }); // targeted

  // A viewer-ish user: may see release broadcasts only.
  const viewer = listNotifications(d, 5, { categories: ['release'] });
  assert.equal(viewer.items.length, 1, 'no import/request broadcasts…');
  assert.equal(viewer.items[0].id, mine, '…but their own targeted row still arrives');
  assert.equal(unreadCount(d, 5, { categories: ['release'] }), 1);

  // A downloader: import broadcasts + nothing targeted.
  const dl = listNotifications(d, 6, { categories: ['import', 'failure'] });
  assert.deepEqual(dl.items.map((i) => i.title), ['Import done']);

  // mark-all only touches what the user can see.
  markRead(d, 6, { all: true, categories: ['import', 'failure'] });
  assert.equal(unreadCount(d, 6, { categories: ['import', 'failure'] }), 0);
  assert.equal(unreadCount(d, 6, { categories: ['import', 'request'] }), 1, 'the request row was NOT marked read');

  // No filter (back-compat) = everything broadcast.
  assert.equal(listNotifications(d, 9).items.length, 2);
});

test('notifications about restricted series are hidden without the permission', () => {
  const d = db();
  d.exec("INSERT INTO series (id, title, url, restricted) VALUES (1, 'Safe', 'u1', 0), (2, 'Mature', 'u2', 1)");
  notify(d, { type: 'a', category: 'import', title: 'Safe series', seriesId: 1 });
  notify(d, { type: 'b', category: 'import', title: 'Mature series', seriesId: 2 });
  notify(d, { type: 'c', category: 'import', title: 'No series link' });

  const cats = ['import'];
  const plain = listNotifications(d, 4, { categories: cats, includeRestricted: false });
  assert.deepEqual(plain.items.map((i) => i.title).sort(), ['No series link', 'Safe series'],
    'restricted-series row hidden');
  assert.equal(unreadCount(d, 4, { categories: cats, includeRestricted: false }), 2);

  const priv = listNotifications(d, 5, { categories: cats, includeRestricted: true });
  assert.equal(priv.items.length, 3, 'permitted user sees all three');

  // Live check: unflagging the series reveals its old notifications.
  d.exec('UPDATE series SET restricted=0 WHERE id=2');
  assert.equal(listNotifications(d, 4, { categories: cats, includeRestricted: false }).items.length, 3);
});

test('read receipts are per-user', () => {
  const d = db();
  const id = notify(d, { type: 'x', category: 'import', title: 'Hi' }); // broadcast
  assert.equal(unreadCount(d, 1), 1);
  assert.equal(unreadCount(d, 2), 1);
  markRead(d, 1, { ids: [id] });
  assert.equal(unreadCount(d, 1), 0, 'user 1 read it');
  assert.equal(unreadCount(d, 2), 1, "user 2 still hasn't");
  markRead(d, 2, { all: true });
  assert.equal(unreadCount(d, 2), 0, 'mark-all clears user 2');
});

// The notifier registry has no unregister, so this single test covers the full
// dispatch contract: event shape, fan-out to every channel, the fetchImpl
// handoff, and a throwing channel neither breaking notify() nor its siblings.
test('notify() hands the event to every registered notifier, fire-and-forget', async () => {
  const d = db();
  const got = [];
  const fetches = [];
  const fetchImpl = async () => ({ ok: true });
  pluginApi.registerNotifier((ev, opts) => { got.push(ev); fetches.push(opts.fetchImpl); });
  pluginApi.registerNotifier(() => { throw new Error('boom'); }); // a bad channel is isolated

  const id = notify(d, {
    type: 'import.failed', category: 'failure', level: 'error',
    title: 'Failed', body: 'Y #2', url: '/wanted', seriesId: 3,
  }, { fetchImpl });
  await new Promise((r) => setTimeout(r, 10)); // fire-and-forget settles

  assert.ok(id > 0, 'notify still returns the row id despite the throwing channel');
  assert.equal(got.length, 1);
  assert.deepEqual(got[0], {
    type: 'import.failed', category: 'failure', level: 'error',
    title: 'Failed', body: 'Y #2', url: '/wanted', userId: null, seriesId: 3,
  });
  assert.equal(fetches[0], fetchImpl, 'channels receive the injected fetch');

  // Defaults fill in for fields the caller omits.
  notify(d, { type: 'x', title: 'Bare' });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(got.length, 2, 'every event reaches every notifier');
  assert.deepEqual(got[1], {
    type: 'x', category: 'system', level: 'info',
    title: 'Bare', body: null, url: null, userId: null, seriesId: null,
  });
});
