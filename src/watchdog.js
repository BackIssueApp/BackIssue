// Event-loop watchdog.
//
// A worker thread has its own event loop, so it keeps running when the main
// one does not. The main thread pings it every few seconds; when no ping has
// arrived for `stallMs` the main loop is wedged — a runaway synchronous loop,
// or V8 spending every cycle collecting garbage against its heap limit — and
// nothing above it (HTTP, timers, the SIGTERM handler) will ever run again.
// The worker then kills the whole process with SIGKILL, which no handler can
// swallow, and the supervisor (Docker's restart policy, systemd) brings up a
// fresh one. A Docker healthcheck alone is not enough: Docker marks a
// container unhealthy but never restarts it by itself.
//
// The same worker watches heap pressure: a heap that sits above `heapFrac` of
// V8's limit for `heapStallMs` is the thrash regime that precedes a full
// freeze (the loop still limps, so pings arrive, but requests take minutes),
// so that restarts too. Every `memLogMs` the main thread also logs memory, so
// a leak leaves a trend in the app log rather than a mystery.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import v8 from 'node:v8';
import fs from 'node:fs';

const defaults = {
  stallMs: 120_000,     // main loop silent this long → kill
  pingMs: 5_000,
  heapFrac: 0.92,       // heapUsed / heap_size_limit
  heapStallMs: 90_000,  // sustained that high this long → kill
  memLogMs: 10 * 60_000,
};

function sample() {
  const m = process.memoryUsage();
  return { rss: m.rss, heapUsed: m.heapUsed, heapLimit: v8.getHeapStatistics().heap_size_limit, at: Date.now() };
}

export function fmtMb(n) { return `${Math.round(n / 1048576)} MB`; }

/** Start the watchdog from the main thread. `log` takes { info, warn }. */
export function startWatchdog(opts = {}) {
  const o = { ...defaults, ...opts };
  const log = o.log || console;
  const worker = new Worker(fileURLToPath(import.meta.url), {
    workerData: { stallMs: o.stallMs, heapFrac: o.heapFrac, heapStallMs: o.heapStallMs, checkMs: Math.max(250, Math.min(o.pingMs, o.stallMs / 4)) },
    // Workers inherit the parent's node flags; ones that only make sense for
    // string input (`--input-type`, from `node -e`) would fail the worker.
    execArgv: process.execArgv.filter((a) => !a.startsWith('--input-type')),
  });
  worker.unref(); // never keeps the process alive on its own
  worker.on('error', (e) => {
    const msg = `watchdog worker failed, the server is running without it: ${e?.message || e}`;
    try { log.warn(msg); } catch { /* ignore */ }
    try { fs.writeSync(2, msg + '\n'); } catch { /* ignore */ }
  });
  let lastMemLog = Date.now();
  const timer = setInterval(() => {
    const s = sample();
    try { worker.postMessage(s); } catch { /* worker gone */ }
    if (o.memLogMs > 0 && s.at - lastMemLog >= o.memLogMs) {
      lastMemLog = s.at;
      try { log.info(`memory: rss ${fmtMb(s.rss)}, heap ${fmtMb(s.heapUsed)} of ${fmtMb(s.heapLimit)} limit`); } catch { /* ignore */ }
    }
  }, o.pingMs);
  timer.unref();
  return { stop() { clearInterval(timer); worker.terminate().catch(() => {}); } };
}

/** The worker side: judge the pings, kill when they stop. Exported for tests. */
export function judge({ now, lastPingAt, lastSample, heapHighSince, stallMs, heapFrac, heapStallMs }) {
  if (now - lastPingAt > stallMs) {
    return { kill: true, reason: `main thread unresponsive for ${Math.round((now - lastPingAt) / 1000)}s` };
  }
  if (lastSample && lastSample.heapLimit > 0 && lastSample.heapUsed / lastSample.heapLimit >= heapFrac) {
    const since = heapHighSince ?? now;
    if (now - since >= heapStallMs) {
      return { kill: true, reason: `heap at ${fmtMb(lastSample.heapUsed)} of ${fmtMb(lastSample.heapLimit)} (${Math.round(100 * lastSample.heapUsed / lastSample.heapLimit)}%) for ${Math.round((now - since) / 1000)}s`, heapHighSince: since };
    }
    return { kill: false, heapHighSince: since };
  }
  return { kill: false, heapHighSince: null };
}

if (!isMainThread && parentPort) {
  const { stallMs, heapFrac, heapStallMs, checkMs } = workerData;
  let lastPingAt = Date.now();
  let lastSample = null;
  let heapHighSince = null;
  parentPort.on('message', (s) => { lastPingAt = Date.now(); lastSample = s; });
  const t = setInterval(() => {
    const r = judge({ now: Date.now(), lastPingAt, lastSample, heapHighSince, stallMs, heapFrac, heapStallMs });
    heapHighSince = r.heapHighSince ?? null;
    if (!r.kill) return;
    const mem = lastSample ? ` (rss ${fmtMb(lastSample.rss)}, heap ${fmtMb(lastSample.heapUsed)})` : '';
    // A worker's process.stderr is relayed through the main thread, which is
    // exactly what is wedged — so write the fd directly and synchronously.
    try { fs.writeSync(2, `watchdog: ${r.reason}${mem} — killing the process so the supervisor restarts it\n`); } catch { /* ignore */ }
    clearInterval(t);
    // SIGKILL cannot be caught, so a wedged main thread cannot ignore it.
    try { process.kill(process.pid, 'SIGKILL'); } catch (e) { try { fs.writeSync(2, `watchdog: kill failed: ${e?.message || e}\n`); } catch { /* ignore */ } }
  }, checkMs);
}
