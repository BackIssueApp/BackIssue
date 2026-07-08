import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScheduler } from '../src/scheduler.js';
import { openDb } from '../src/db.js';

const flush = () => new Promise((r) => setImmediate(r));
const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi).getTime();

test('a task fires at its next cron match after registration, then per pattern', async () => {
  let t = at(2026, 7, 1, 10, 0); // Wednesday 10:00
  const runs = [];
  const s = createScheduler({ now: () => t });
  s.register({ key: 'zd', label: '0-Day', cron: () => '0 9 * * 3', run: async () => { runs.push(t); } });

  s.tick(); await flush();
  assert.equal(runs.length, 0);                    // registered at 10:00 — next match is NEXT Wednesday
  assert.equal(s.list()[0].nextRun, at(2026, 7, 8, 9, 0));
  t = at(2026, 7, 8, 9, 0); s.tick(); await flush();
  assert.equal(runs.length, 1);
  t = at(2026, 7, 8, 12, 0); s.tick(); await flush();
  assert.equal(runs.length, 1);                    // not due again this week
  t = at(2026, 7, 15, 9, 0); s.tick(); await flush();
  assert.equal(runs.length, 2);
});

test('a missed window (app was down) catches up ONCE', async () => {
  let t = at(2026, 7, 1, 10, 0);
  const runs = [];
  const s = createScheduler({ now: () => t });
  s.register({ key: 'x', label: 'X', cron: () => '0 9 * * *', run: async () => { runs.push(t); } });
  // "Down" over three 9ams; back at noon on the 5th → exactly one catch-up run.
  t = at(2026, 7, 5, 12, 0); s.tick(); await flush();
  assert.equal(runs.length, 1);
  s.tick(); await flush();
  assert.equal(runs.length, 1);                    // not again until tomorrow 9am
  t = at(2026, 7, 6, 9, 0); s.tick(); await flush();
  assert.equal(runs.length, 2);
});

test('enabled toggle + invalid/blank pattern disable the task, live', async () => {
  let t = at(2026, 7, 1, 10, 0);
  let enabled = false, cron = '0 * * * *';
  const runs = [];
  const s = createScheduler({ now: () => t });
  s.register({ key: 'x', label: 'X', cron: () => cron, enabled: () => enabled, run: async () => { runs.push(t); } });
  t = at(2026, 7, 2, 10, 0); s.tick(); await flush();
  assert.equal(runs.length, 0);                    // disabled
  assert.equal(s.list()[0].enabled, false);
  assert.equal(s.list()[0].nextRun, null);
  enabled = true; s.tick(); await flush();
  assert.equal(runs.length, 1);                    // toggled on → catches up
  cron = 'nonsense'; s.tick(); await flush();
  assert.equal(runs.length, 1);                    // invalid pattern = off
  assert.ok(s.list()[0].invalid);
});

test('lastRun persists in the db — a "restart" neither re-fires nor forgets', async () => {
  const db = openDb(':memory:');
  let t = at(2026, 7, 1, 10, 0);
  const runs = [];
  const mk = () => {
    const s = createScheduler({ db, now: () => t });
    s.register({ key: 'zd', label: '0-Day', cron: () => '0 9 * * 3', run: async () => { runs.push(t); } });
    return s;
  };
  let s = mk();
  t = at(2026, 7, 8, 9, 0); s.tick(); await flush();
  assert.equal(runs.length, 1);
  // "Restart" 5 minutes later: same db, fresh scheduler → does NOT re-fire.
  t = at(2026, 7, 8, 9, 5); s = mk();
  s.tick(); await flush();
  assert.equal(runs.length, 1);
  assert.equal(s.list()[0].lastRun, at(2026, 7, 8, 9, 0)); // remembered across the restart
  t = at(2026, 7, 15, 9, 0); s.tick(); await flush();
  assert.equal(runs.length, 2);                            // next week fires normally
});

test('runNow starts immediately without blocking and guards double-runs', async () => {
  let t = at(2026, 7, 1, 10, 0);
  let resolveRun;
  const s = createScheduler({ now: () => t });
  s.register({ key: 'crawl', label: 'Crawl', cron: () => '', run: () => new Promise((r) => { resolveRun = r; }) });
  assert.equal(s.runNow('crawl'), true);   // returns synchronously, task still running
  assert.equal(s.list()[0].running, true);
  assert.equal(s.runNow('crawl'), false);  // already running
  assert.equal(s.runNow('nope'), false);   // unknown
  await flush();
  resolveRun(); await flush();
  assert.equal(s.list()[0].running, false);
  assert.equal(s.list()[0].lastRun, t);
});

test('a failing run still clears running and schedules the next match', async () => {
  let t = at(2026, 7, 1, 9, 0);
  const s = createScheduler({ now: () => t });
  s.register({ key: 'x', label: 'X', cron: () => '0 9 * * *', run: async () => { throw new Error('boom'); } });
  s.runNow('x'); await flush();
  const [row] = s.list();
  assert.equal(row.running, false);
  assert.equal(row.lastRun, t);
  assert.equal(row.nextRun, at(2026, 7, 2, 9, 0)); // retries at the next match, no tight loop
});

test('watchdog: a hung run is released after the stall threshold so the schedule survives', async () => {
  let t = at(2026, 7, 1, 9, 0);
  const starts = [];
  const s = createScheduler({ now: () => t });
  // run() never settles — a wedged crawl/browser.
  s.register({ key: 'crawl', label: 'Crawl', cron: () => '0 9 * * *', run: () => { starts.push(t); return new Promise(() => {}); } });
  s.runNow('crawl'); await flush();
  assert.equal(s.list()[0].running, true);
  assert.equal(s.list()[0].runningSince, t);

  t += 7 * 3600 * 1000; s.tick(); await flush();   // 7h in: warned, still held
  assert.equal(s.list()[0].running, true);
  assert.equal(starts.length, 1);

  t += 20 * 3600 * 1000; s.tick(); await flush();  // 27h in: released — and the daily
  await flush();                                    // pattern is past due → re-fires
  assert.equal(starts.length, 2, 'schedule resumed after the hung run was released');
});
