// Runs the collection chip-count query on a worker thread so it can't block
// the event loop. better-sqlite3 is synchronous: the count pass over a 320k-row
// catalog holds the main thread for ~0.5-1s, which stalled EVERY concurrent
// request (page loads, covers) behind it — the "library switch takes seconds"
// symptom. The worker owns a separate read-only connection (WAL: readers don't
// block); if it can't start or dies, callers fall back to the sync path.
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const threadFile = path.join(path.dirname(fileURLToPath(import.meta.url)), 'countWorker.thread.js');

let dbPath = null;
let worker = null;
let seq = 0;
const pending = new Map(); // id → { resolve, reject }

export function initCountWorker(p) { dbPath = p; }

function ensureWorker() {
  if (worker || !dbPath) return worker;
  try {
    worker = new Worker(threadFile, { workerData: { dbPath } });
    worker.unref(); // never keeps the process alive
    worker.on('message', (m) => {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error)); else p.resolve(m.row);
    });
    const die = () => {
      for (const p of pending.values()) p.reject(new Error('count worker gone'));
      pending.clear();
      worker = null; // next call respawns
    };
    worker.on('error', die);
    worker.on('exit', die);
  } catch {
    worker = null;
  }
  return worker;
}

/** Run a single-row SELECT off the main thread. Returns null when no worker is
 *  available (caller should fall back to running it synchronously). */
export function workerGetRow(sql, params) {
  const w = ensureWorker();
  if (!w) return null;
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    w.postMessage({ id, sql, params });
  });
}
