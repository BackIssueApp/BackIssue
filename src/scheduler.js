// Cron scheduler for background tasks. Each task reads its cron pattern live
// from a getter (a settings change applies without a restart); blank/invalid
// pattern = disabled. Last-run times persist in the database (schedule_state),
// so a restart neither re-fires everything nor forgets the cadence — and a
// scheduled time missed while the app was down catches up ONCE on the next tick
// (anacron-style), rather than being skipped for a whole cycle.

import { nextCronTime, validateCron } from './cron.js';
import { getScheduleLastRun, setScheduleLastRun } from './db.js';
import { logWarn, logError } from './logstore.js';

// Hung-run watchdog: a run that never settles would leave `running` true forever,
// silently killing the schedule (and blocking Run-now). Warn once when a run
// outlives WARN; after RELEASE, assume the promise is wedged and free the task so
// the schedule survives — downstream tasks carry their own overlap guards.
const STALL_WARN_MS = 6 * 3600 * 1000;
const STALL_RELEASE_MS = 24 * 3600 * 1000;

export function createScheduler({ db = null, now = () => Date.now() } = {}) {
  const tasks = [];

  // cron: () => string and enabled: () => bool (both live from config);
  // run: async () => void.
  function register({ key, label, cron, enabled = () => true, run }) {
    let lastRun = db ? getScheduleLastRun(db, key) : null;
    if (lastRun == null) {
      // First time we've ever seen this task: baseline "now" so a fresh install
      // (or a newly added task) waits for its next scheduled time instead of
      // treating all of history as one giant missed window.
      lastRun = now();
      if (db) setScheduleLastRun(db, key, lastRun);
    }
    tasks.push({ key, label, cron, enabled, run, lastRun, running: false });
  }

  // The next time this task should fire: the first cron match after its last
  // run. If that moment is already in the past (missed while down), it's due now.
  function dueAt(t) {
    if (!t.enabled()) return null;
    const expr = String(t.cron() || '').trim();
    if (!expr || validateCron(expr)) return null; // blank or invalid = off
    return nextCronTime(expr, t.lastRun);
  }

  // Kick a task off (fire-and-forget — long tasks must not block the caller).
  // Returns false when unknown or already running.
  function runNow(key) {
    const t = tasks.find((x) => x.key === key);
    if (!t || t.running) return false;
    t.running = true;
    t.runStartedAt = now();
    t.stallWarned = false;
    t.lastRun = t.runStartedAt;
    if (db) setScheduleLastRun(db, key, t.lastRun);
    const started = t.runStartedAt;
    Promise.resolve()
      .then(() => t.run())
      .catch(() => { /* the task's own job entry records the failure */ })
      .finally(() => {
        // Only clear if the watchdog hasn't already released this run (a released
        // task may have been re-run — don't stomp the newer run's flag).
        if (t.runStartedAt === started) t.running = false;
      });
    return true;
  }

  // One pass: start anything due, and watchdog anything stuck. Called on an
  // interval (and directly in tests).
  function tick() {
    for (const t of tasks) {
      if (t.running) {
        const ranFor = now() - t.runStartedAt;
        if (ranFor > STALL_RELEASE_MS) {
          logError(`Scheduled task "${t.label}" has been running for ${Math.round(ranFor / 3600000)}h — assuming it hung; releasing so the schedule can continue.`, 'app');
          t.running = false;
        } else if (ranFor > STALL_WARN_MS && !t.stallWarned) {
          t.stallWarned = true;
          logWarn(`Scheduled task "${t.label}" has been running for over ${Math.round(ranFor / 3600000)}h — it may be stuck.`, 'app');
        }
      }
      const due = dueAt(t);
      if (due != null && now() >= due && !t.running) runNow(t.key);
    }
  }

  function list() {
    return tasks.map((t) => {
      const expr = String(t.cron() || '').trim();
      return {
        key: t.key, label: t.label,
        cron: expr, enabled: !!t.enabled(),
        invalid: expr ? validateCron(expr) : null, // human reason when the pattern is bad
        lastRun: t.lastRun, nextRun: dueAt(t), running: t.running,
        runningSince: t.running ? t.runStartedAt : null, // lets the UI show "running · 3h"
      };
    });
  }

  function start(intervalMs = 30 * 1000) {
    const h = setInterval(tick, intervalMs);
    if (h.unref) h.unref();
    return h;
  }

  return { register, runNow, tick, list, start };
}
