import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { judge, fmtMb } from '../src/watchdog.js';

// The child scripts import the module by URL: on Windows a bare absolute path
// is not a valid ESM specifier.
const mod = new URL('../src/watchdog.js', import.meta.url).href;

test('judge: silence past the stall window kills; heap pressure must be sustained', () => {
  const base = { stallMs: 1000, heapFrac: 0.9, heapStallMs: 500 };
  assert.equal(judge({ ...base, now: 900, lastPingAt: 0, lastSample: null, heapHighSince: null }).kill, false);
  const r = judge({ ...base, now: 1001, lastPingAt: 0, lastSample: null, heapHighSince: null });
  assert.equal(r.kill, true);
  assert.match(r.reason, /unresponsive/);
  // Heap high: the first sighting only starts the clock.
  const hot = { rss: 1, heapUsed: 95, heapLimit: 100 };
  const a = judge({ ...base, now: 10, lastPingAt: 10, lastSample: hot, heapHighSince: null });
  assert.deepEqual([a.kill, a.heapHighSince], [false, 10]);
  const b = judge({ ...base, now: 400, lastPingAt: 400, lastSample: hot, heapHighSince: 10 });
  assert.equal(b.kill, false);
  const c = judge({ ...base, now: 520, lastPingAt: 520, lastSample: hot, heapHighSince: 10 });
  assert.equal(c.kill, true);
  assert.match(c.reason, /heap at/);
  // Heap back under the line resets the clock.
  const cool = { rss: 1, heapUsed: 10, heapLimit: 100 };
  assert.equal(judge({ ...base, now: 600, lastPingAt: 600, lastSample: cool, heapHighSince: 10 }).heapHighSince, null);
  assert.equal(fmtMb(3 * 1048576), '3 MB');
});

test('a process whose main loop wedges is killed by the worker', async () => {
  // A child that starts the watchdog with short windows, then spins forever.
  // Without the watchdog it would never exit; with it, the worker's SIGKILL
  // ends it within a couple of seconds.
  const script = `
    import { startWatchdog } from ${JSON.stringify(mod)};
    startWatchdog({ stallMs: 600, pingMs: 100, memLogMs: 0, log: { info() {}, warn() {} } });
    setTimeout(() => { console.log('spinning'); const end = Date.now() + 60_000; while (Date.now() < end) { /* wedge */ } console.log('survived'); }, 150);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const result = await new Promise((resolve) => {
    const t = setTimeout(() => { child.kill('SIGKILL'); resolve({ timedOut: true }); }, 15_000);
    child.on('exit', (code, signal) => { clearTimeout(t); resolve({ code, signal }); });
  });
  assert.equal(result.timedOut, undefined, 'the watchdog should have killed the child before the test timeout');
  assert.match(out, /spinning/);
  assert.doesNotMatch(out, /survived/);
  assert.match(err, /watchdog: main thread unresponsive/);
});

test('a healthy process is left alone and can stop the watchdog', async () => {
  const script = `
    import { startWatchdog } from ${JSON.stringify(mod)};
    const w = startWatchdog({ stallMs: 400, pingMs: 50, memLogMs: 0, log: { info() {}, warn() {} } });
    setTimeout(() => { w.stop(); console.log('clean'); }, 900);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const result = await new Promise((resolve) => {
    const t = setTimeout(() => { child.kill('SIGKILL'); resolve({ timedOut: true }); }, 10_000);
    child.on('exit', (code, signal) => { clearTimeout(t); resolve({ code, signal }); });
  });
  assert.equal(result.code, 0, `expected a clean exit, got ${JSON.stringify(result)}`);
  assert.match(out, /clean/);
});
