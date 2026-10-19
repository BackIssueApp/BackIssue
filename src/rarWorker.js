// A small pool of worker threads for RAR decoding (see rarWorker.thread.js).
// Callers already hold one of archive.js's RAR slots, so the pool never runs
// more jobs than there are slots. A worker that dies (a WASM abort on a hostile
// archive) fails only its own job and is replaced on the next call. When no
// worker can start, runRar returns null and the caller decodes inline.
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const threadFile = path.join(path.dirname(fileURLToPath(import.meta.url)), 'rarWorker.thread.js');
const idle = [];
const all = new Set();
let seq = 0;
let disabled = false;

function spawn() {
  const w = new Worker(threadFile);
  w.jobs = new Map(); // id → { resolve, reject }
  w.on('message', (m) => {
    const job = w.jobs.get(m.id);
    if (!job) return;
    w.jobs.delete(m.id);
    if (m.error) job.reject(new Error(m.error)); else job.resolve(m.result);
  });
  const die = (e) => {
    all.delete(w);
    const i = idle.indexOf(w);
    if (i >= 0) idle.splice(i, 1);
    if (w.jobs.size) console.warn('archive reader stopped:', e?.message || e || 'exited');
    for (const job of w.jobs.values()) job.reject(new Error('the archive could not be read'));
    w.jobs.clear();
  };
  w.on('error', die);
  w.on('exit', (code) => die(code ? `exit code ${code}` : null));
  all.add(w);
  return w;
}

/** Run `op` on a worker; resolves with its result. Returns null when workers
 *  are unavailable (the caller then does the work inline). */
export function runRar(op, args, transfer = []) {
  if (disabled) return null;
  let w = idle.pop();
  if (!w) {
    try { w = spawn(); } catch { disabled = true; return null; }
  }
  // Referenced only while it has work: an idle pool never holds the process open.
  w.ref();
  return new Promise((resolve, reject) => {
    const id = ++seq;
    w.jobs.set(id, { resolve, reject });
    w.postMessage({ id, op, args }, transfer);
  }).finally(() => {
    if (!all.has(w)) return;
    if (!w.jobs.size) { w.unref(); idle.push(w); }
  });
}

/** Stop every worker (tests). */
export async function closeRarWorkers() {
  const ws = [...all];
  idle.length = 0;
  await Promise.all(ws.map((w) => w.terminate()));
}
