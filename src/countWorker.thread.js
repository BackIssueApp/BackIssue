// Worker-thread half of the count offloader (see countWorker.js). Opens its
// OWN read-only connection — WAL supports concurrent readers, so the heavy
// chip-count scan runs here without freezing the main thread's synchronous
// better-sqlite3 connection (or the event loop) for ~0.5-1s at 320k series.
import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';

const db = new Database(workerData.dbPath, { readonly: true, fileMustExist: true });
db.pragma('busy_timeout = 5000');

parentPort.on('message', ({ id, sql, params }) => {
  try {
    parentPort.postMessage({ id, row: db.prepare(sql).get(params) ?? null });
  } catch (e) {
    parentPort.postMessage({ id, error: String(e?.message || e) });
  }
});
