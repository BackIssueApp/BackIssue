import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pushLog, listLogs, clearLogs, logCounts, logCategories, logWarn, logError, installConsoleCapture, attachLogDb } from '../src/logstore.js';
import { openDb } from '../src/db.js';

test('pushLog: newest-first, level filter, counts (in-memory)', () => {
  attachLogDb(null);
  clearLogs();
  logWarn('a warning');
  logError('a failure');
  const all = listLogs();
  assert.equal(all[0].message, 'a failure'); // newest first
  assert.equal(all.length, 2);
  assert.equal(listLogs({ level: 'error' }).length, 1);
  assert.equal(listLogs({ level: 'error' })[0].message, 'a failure');
  const c = logCounts();
  assert.equal(c.error, 1);
  assert.equal(c.warn, 1);
});

test('clearLogs empties the buffer', () => {
  attachLogDb(null);
  clearLogs();
  pushLog('error', 'x');
  assert.equal(listLogs().length, 1);
  assert.equal(clearLogs(), 1);
  assert.equal(listLogs().length, 0);
});

test('ring buffer caps size (does not grow unbounded)', () => {
  attachLogDb(null);
  clearLogs();
  for (let i = 0; i < 600; i++) pushLog('info', 'e' + i);
  assert.ok(listLogs({ limit: 500 }).length <= 500);
});

test('logs persist to the db and survive a reopen (same file)', () => {
  attachLogDb(null); clearLogs();
  const db = openDb(':memory:');
  attachLogDb(db);          // flushes pre-attach buffer + persists onward
  pushLog('error', 'boom');
  pushLog('warn', 'hmm');
  // read straight from the table — proves it's persisted, not just in memory
  const rows = db.prepare('SELECT level, message FROM logs ORDER BY id DESC').all();
  assert.equal(rows[0].message, 'hmm');
  assert.equal(rows.length, 2);
  assert.equal(listLogs({ level: 'error' })[0].message, 'boom');
  assert.equal(logCounts().error, 1);
  attachLogDb(null);        // detach so later in-memory tests are clean
});

test('category filtering + logCategories (in-memory + db)', () => {
  for (const db of [null, openDb(':memory:')]) {
    attachLogDb(db); clearLogs();
    pushLog('info', 'downloaded a', 'download');
    pushLog('error', 'grab failed', 'usenet');
    pushLog('info', 'downloaded b', 'download');
    assert.deepEqual(logCategories().sort(), ['download', 'usenet']);
    assert.equal(listLogs({ category: 'download' }).length, 2);
    assert.equal(listLogs({ category: 'usenet', level: 'error' }).length, 1);
    assert.equal(listLogs({ category: 'usenet', level: 'info' }).length, 0); // level + category combine
  }
  attachLogDb(null);
});

test('installConsoleCapture mirrors console.warn/error, keeps output', () => {
  attachLogDb(null);
  clearLogs();
  const orig = console.warn;
  let printed = '';
  console.warn = (...a) => { printed = a.join(' '); };
  installConsoleCapture(); // wraps the (stubbed) console.warn
  console.warn('captured', 'me');
  assert.equal(printed, 'captured me');       // original still runs
  assert.equal(listLogs()[0].message, 'captured me'); // and it was recorded
  console.warn = orig;
});
