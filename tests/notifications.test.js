// The notification system: per-user feed (broadcast + targeted), read
// receipts, retention pruning, and category-filtered webhook dispatch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import config from '../src/config.js';
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

test('webhook fires only for enabled categories, with structured payload', async () => {
  const d = db();
  const posts = [];
  const fetchImpl = async (url, opts) => { posts.push({ url, body: JSON.parse(opts.body) }); return { ok: true }; };
  const prevUrl = config.notifyWebhookUrl, prevEv = config.notifyWebhookEvents;
  config.notifyWebhookUrl = 'https://hook.example/x';
  config.notifyWebhookEvents = 'failure'; // only failures
  try {
    notify(d, { type: 'import.done', category: 'import', title: 'Downloaded', body: 'X #1' }, { fetchImpl });
    notify(d, { type: 'import.failed', category: 'failure', level: 'error', title: 'Failed', body: 'Y #2' }, { fetchImpl });
    await new Promise((r) => setTimeout(r, 10)); // fire-and-forget
    assert.equal(posts.length, 1, 'only the failure category posted');
    assert.equal(posts[0].body.category, 'failure');
    assert.equal(posts[0].body.content, 'Failed — Y #2');
    assert.equal(posts[0].body.source, 'backissue');
  } finally { config.notifyWebhookUrl = prevUrl; config.notifyWebhookEvents = prevEv; }
});

test('empty category setting = all categories fire', async () => {
  const d = db();
  const posts = [];
  const fetchImpl = async (url, opts) => { posts.push(JSON.parse(opts.body)); return { ok: true }; };
  const prevUrl = config.notifyWebhookUrl, prevEv = config.notifyWebhookEvents;
  config.notifyWebhookUrl = 'https://hook.example/x';
  config.notifyWebhookEvents = '';
  try {
    notify(d, { type: 'a', category: 'import', title: 'A' }, { fetchImpl });
    notify(d, { type: 'b', category: 'request', title: 'B' }, { fetchImpl });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(posts.length, 2);
  } finally { config.notifyWebhookUrl = prevUrl; config.notifyWebhookEvents = prevEv; }
});
