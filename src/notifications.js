// Notification system: a typed event feed. Every notable event (import,
// download failure, new release, request activity) becomes a row in the
// in-app notification centre AND is handed (fire-and-forget) to every
// registered outbound notifier — plugins provide the transports (Discord,
// Telegram, generic webhooks, …) and do their own per-channel filtering.
//
// Events carry a category so channels can filter, and an optional user_id:
// null = broadcast to everyone, a value = targeted (the requester of a
// request, say) but still visible to user managers.
import { registeredNotifiers } from './plugins.js';

// Webhook-filter categories, in display order. An event's `category` must be
// one of these keys; the UI shows a checkbox per category.
export const CATEGORIES = {
  import: 'Imports & downloads',
  failure: 'Failures',
  release: 'New releases',
  request: 'Requests',
  system: 'System',
};

// Who may see BROADCAST rows of each category: a user needs any one of the
// listed permissions. Targeted rows (user_id set) always reach their user
// regardless. Keeps download/request/system chatter away from roles that
// can't see those features anyway.
export const CATEGORY_VISIBILITY = {
  import: ['downloads.grab', 'library.manage'],
  failure: ['downloads.grab', 'library.manage'],
  release: ['library.view'],
  request: ['requests.manage'],
  system: ['settings.manage', 'system.jobs'],
};

const KEEP = 500; // ring the table: prune the oldest beyond this on insert

export function initNotificationTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      type TEXT NOT NULL,
      category TEXT NOT NULL,
      level TEXT NOT NULL DEFAULT 'info',   -- info | success | warn | error
      title TEXT NOT NULL,
      body TEXT,
      url TEXT,                              -- in-app link to open on click
      user_id INTEGER,                       -- NULL = broadcast to everyone
      series_id INTEGER                      -- the library series this concerns (restricted filtering)
    );
    CREATE INDEX IF NOT EXISTS idx_notif_ts ON notifications(ts DESC);
    -- Per-user read receipts (a broadcast row can be read by A but not B).
    CREATE TABLE IF NOT EXISTS notification_reads (
      notification_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      PRIMARY KEY (notification_id, user_id)
    );
  `);
  // series_id arrived after first ship; CREATE TABLE IF NOT EXISTS won't alter
  // an existing table (errors if the column already exists; ignored).
  try { db.exec('ALTER TABLE notifications ADD COLUMN series_id INTEGER'); } catch { /* exists */ }
}

/** Record + dispatch a notification. Never throws (a bad channel or a closed
 *  DB must not break the thing that triggered it). Returns the row id or 0. */
export function notify(db, { type, category = 'system', level = 'info', title, body = null, url = null, userId = null, seriesId = null }, { fetchImpl = fetch } = {}) {
  let id = 0;
  try {
    const r = db.prepare(
      'INSERT INTO notifications (ts, type, category, level, title, body, url, user_id, series_id) VALUES (?,?,?,?,?,?,?,?,?)',
    ).run(Date.now(), String(type || 'event'), category, level, String(title || ''), body, url, userId ?? null, seriesId ?? null);
    id = r.lastInsertRowid;
    // Prune oldest beyond KEEP (and their read receipts).
    db.prepare(`DELETE FROM notifications WHERE id <= (
      SELECT id FROM notifications ORDER BY id DESC LIMIT 1 OFFSET ?
    )`).run(KEEP);
    db.prepare('DELETE FROM notification_reads WHERE notification_id NOT IN (SELECT id FROM notifications)').run();
  } catch (e) {
    console.warn('notification insert failed:', e?.message || e);
  }
  // Outbound channels (plugins): fire-and-forget, each does its own filtering
  // and transport. A channel's failure never breaks the caller or the others.
  const event = { type, category, level, title, body, url, userId, seriesId };
  for (const fn of registeredNotifiers()) {
    Promise.resolve()
      .then(() => fn(event, { fetchImpl }))
      .catch((e) => console.warn('notification channel failed:', e?.message || e));
  }
  return id;
}

// Broadcast-visibility clause: targeted rows always reach their user; broadcast
// rows only in the caller's visible categories (null = no filtering, back-compat).
// includeRestricted=false additionally hides rows linked to a series that is
// CURRENTLY restricted — a live check, so flagging a series retroactively hides
// its old notifications too.
function visClause(categories, includeRestricted = true) {
  const restrict = includeRestricted
    ? ''
    : ' AND (n.series_id IS NULL OR NOT EXISTS(SELECT 1 FROM series s WHERE s.id = n.series_id AND s.restricted = 1))';
  if (!Array.isArray(categories)) {
    return { sql: `((n.user_id IS NULL OR n.user_id = ?)${restrict})`, extra: [] };
  }
  const ph = categories.map(() => '?').join(',');
  return {
    sql: `((n.user_id = ? OR (n.user_id IS NULL AND n.category IN (${ph || "''"})))${restrict})`,
    extra: categories,
  };
}

/** A user's feed: broadcast rows (in the user's visible categories) + their own
 *  targeted rows, newest first, each flagged read/unread for this user. */
export function listNotifications(db, userId, { limit = 30, categories = null, includeRestricted = true } = {}) {
  const v = visClause(categories, includeRestricted);
  const items = db.prepare(`
    SELECT n.id, n.ts, n.type, n.category, n.level, n.title, n.body, n.url,
           EXISTS(SELECT 1 FROM notification_reads r WHERE r.notification_id = n.id AND r.user_id = ?) AS read
      FROM notifications n
     WHERE ${v.sql}
     ORDER BY n.ts DESC LIMIT ?`).all(userId, userId, ...v.extra, Math.min(200, Math.max(1, limit)));
  return { items: items.map((i) => ({ ...i, read: !!i.read })), unread: unreadCount(db, userId, { categories, includeRestricted }) };
}

export function unreadCount(db, userId, { categories = null, includeRestricted = true } = {}) {
  const v = visClause(categories, includeRestricted);
  return db.prepare(`
    SELECT COUNT(*) n FROM notifications n
     WHERE ${v.sql}
       AND n.id NOT IN (SELECT notification_id FROM notification_reads WHERE user_id = ?)`)
    .get(userId, ...v.extra, userId).n;
}

/** Mark specific ids (or all visible) read for this user. */
export function markRead(db, userId, { ids = null, all = false, categories = null, includeRestricted = true } = {}) {
  const ins = db.prepare('INSERT OR IGNORE INTO notification_reads (notification_id, user_id) VALUES (?, ?)');
  if (all) {
    const v = visClause(categories, includeRestricted);
    const rows = db.prepare(`SELECT n.id FROM notifications n WHERE ${v.sql}`).all(userId, ...v.extra);
    const tx = db.transaction(() => { for (const { id } of rows) ins.run(id, userId); });
    tx();
  } else if (Array.isArray(ids)) {
    const tx = db.transaction(() => { for (const id of ids) ins.run(Number(id), userId); });
    tx();
  }
  return unreadCount(db, userId, { categories, includeRestricted });
}

/** Cheap change signal for the SSE hub — the newest id + total count. */
export function notifyWatermark(db) {
  try { return db.prepare('SELECT MAX(id) m, COUNT(*) c FROM notifications').get(); }
  catch { return { m: 0, c: 0 }; }
}
