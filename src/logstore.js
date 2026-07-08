// Application log of recent problems (warnings + errors), so the UI can show WHY
// things failed. Persisted to the `logs` table once a db is attached; a small
// in-memory buffer holds entries logged before that (e.g. console capture set up
// at startup) and is flushed on attach.
import { insertLog, listLogsDb, logCategoriesDb, clearLogsDb, logCountsDb, pruneLogs } from './db.js';

const PREBUF_MAX = 500;
const PRUNE_EVERY = 200;
const KEEP = 3000;
let db = null;
let sinceProne = 0;
const preBuf = []; // newest-first, used only before a db is attached
let clock = () => Date.now();
export function _setClock(fn) { clock = fn; }

function fmt(a) {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return a.stack || a.message;
  try { return JSON.stringify(a); } catch { return String(a); }
}

// Attach the database: flush any pre-attach entries (oldest-first so ids order
// correctly), then persist all future logs. Pass null to detach (tests).
export function attachLogDb(database) {
  db = database || null;
  if (!db) return;
  for (const e of [...preBuf].reverse()) { try { insertLog(db, e); } catch { /* ignore */ } }
  preBuf.length = 0;
  try { pruneLogs(db, KEEP); } catch { /* ignore */ }
}

export function pushLog(level, message, category = null) {
  const e = { ts: clock(), level, category, message: String(message) };
  if (db) {
    try {
      insertLog(db, e);
      if (++sinceProne >= PRUNE_EVERY) { sinceProne = 0; pruneLogs(db, KEEP); }
    } catch { /* never break logging */ }
  } else {
    preBuf.unshift(e);
    if (preBuf.length > PREBUF_MAX) preBuf.length = PREBUF_MAX;
  }
}
export const logInfo = (msg, cat) => pushLog('info', msg, cat);
export const logWarn = (msg, cat) => pushLog('warn', msg, cat);
export const logError = (msg, cat) => pushLog('error', msg, cat);

export function listLogs({ level = 'all', category = 'all', limit = 300 } = {}) {
  if (db) { try { return listLogsDb(db, { level, category, limit }); } catch { return []; } }
  let out = preBuf;
  if (level !== 'all') out = out.filter((e) => e.level === level);
  if (category !== 'all') out = out.filter((e) => e.category === category);
  return out.slice(0, Math.max(1, Math.min(500, limit)));
}
export function logCategories() {
  if (db) { try { return logCategoriesDb(db); } catch { return []; } }
  return [...new Set(preBuf.map((e) => e.category).filter(Boolean))].sort();
}
export function clearLogs() {
  if (db) { try { return clearLogsDb(db); } catch { return 0; } }
  const n = preBuf.length; preBuf.length = 0; return n;
}
export function logCounts() {
  if (db) { try { return logCountsDb(db); } catch { return { error: 0, warn: 0, info: 0 }; } }
  const c = { error: 0, warn: 0, info: 0 };
  for (const e of preBuf) c[e.level] = (c[e.level] || 0) + 1;
  return c;
}

// Mirror console.warn/console.error into the log (keeping normal console output),
// so existing warn/error call sites across modules show up automatically.
// console.log stays uncaptured to keep the log about problems.
export function installConsoleCapture() {
  for (const [method, level] of [['warn', 'warn'], ['error', 'error']]) {
    const orig = console[method].bind(console);
    console[method] = (...args) => {
      try { pushLog(level, args.map(fmt).join(' ')); } catch { /* ignore */ }
      orig(...args);
    };
  }
}
