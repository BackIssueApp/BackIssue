// Notifications carry the facts behind their text (`params`) so a client can
// render them in the reader's language; title/body stay as the fallback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { initNotificationTables, notify, listNotifications } from '../src/notifications.js';

function db() { const d = openDb(':memory:'); initNotificationTables(d); return d; }

test('params round-trip as an object; rows without them read as null', () => {
  const d = db();
  notify(d, { type: 'import.done', category: 'import', title: 'Downloaded', body: 'Saga #1 · usenet', params: { title: 'Saga #1', source: 'usenet' } });
  notify(d, { type: 'request.created', category: 'request', title: 'New request', body: 'x' });
  notify(d, { type: 'odd', category: 'system', title: 'odd', params: 'not an object' });
  const { items } = listNotifications(d, 1);
  const byType = Object.fromEntries(items.map((i) => [i.type, i]));
  assert.deepEqual(byType['import.done'].params, { title: 'Saga #1', source: 'usenet' });
  assert.equal(byType['import.done'].title, 'Downloaded');
  assert.equal(byType['request.created'].params, null);
  assert.equal(byType.odd.params, null);
});

test('a params column is added to a database created before it existed', () => {
  const d = openDb(':memory:');
  d.exec(`CREATE TABLE notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, type TEXT NOT NULL, category TEXT NOT NULL,
    level TEXT NOT NULL DEFAULT 'info', title TEXT NOT NULL, body TEXT, url TEXT, user_id INTEGER)`);
  initNotificationTables(d);
  const cols = d.prepare('PRAGMA table_info(notifications)').all().map((c) => c.name);
  assert.ok(cols.includes('params'));
  assert.ok(cols.includes('series_id'));
  notify(d, { type: 'x', category: 'system', title: 't', params: { a: 1 } });
  assert.deepEqual(listNotifications(d, 1).items[0].params, { a: 1 });
});
