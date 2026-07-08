// Notification system: a typed event feed. Every notable event (import,
// download failure, new release, request activity) becomes a row in the
// in-app notification centre AND, when a webhook is configured and the
// event's category is enabled, a fire-and-forget POST to it.
//
// Events carry a category so the webhook can be filtered per category, and an
// optional user_id: null = broadcast to everyone, a value = targeted (the
// requester of a request, say) but still visible to user managers.
import config from './config.js';

// Webhook-filter categories, in display order. An event's `category` must be
// one of these keys; the UI shows a checkbox per category.
export const CATEGORIES = {
  import: 'Imports & downloads',
  failure: 'Failures',
  release: 'New releases',
  request: 'Requests',
  system: 'System',
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
      user_id INTEGER                        -- NULL = broadcast to everyone
    );
    CREATE INDEX IF NOT EXISTS idx_notif_ts ON notifications(ts DESC);
    -- Per-user read receipts (a broadcast row can be read by A but not B).
    CREATE TABLE IF NOT EXISTS notification_reads (
      notification_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      PRIMARY KEY (notification_id, user_id)
    );
  `);
}

// Webhook categories that are enabled. Empty/unset setting = all categories on.
function webhookAllows(category) {
  const raw = String(config.notifyWebhookEvents || '').trim();
  if (!raw) return true;
  return raw.split(',').map((s) => s.trim()).filter(Boolean).includes(category);
}

/** Record + dispatch a notification. Never throws (a bad webhook or a closed
 *  DB must not break the thing that triggered it). Returns the row id or 0. */
export function notify(db, { type, category = 'system', level = 'info', title, body = null, url = null, userId = null }, { fetchImpl = fetch } = {}) {
  let id = 0;
  try {
    const r = db.prepare(
      'INSERT INTO notifications (ts, type, category, level, title, body, url, user_id) VALUES (?,?,?,?,?,?,?,?)',
    ).run(Date.now(), String(type || 'event'), category, level, String(title || ''), body, url, userId ?? null);
    id = r.lastInsertRowid;
    // Prune oldest beyond KEEP (and their read receipts).
    db.prepare(`DELETE FROM notifications WHERE id <= (
      SELECT id FROM notifications ORDER BY id DESC LIMIT 1 OFFSET ?
    )`).run(KEEP);
    db.prepare('DELETE FROM notification_reads WHERE notification_id NOT IN (SELECT id FROM notifications)').run();
  } catch (e) {
    console.warn('notification insert failed:', e?.message || e);
  }
  // Webhook: fire-and-forget, category-filtered. Keeps a Discord-compatible
  // `content` so existing receivers work, plus structured fields.
  const wurl = String(config.notifyWebhookUrl || '').trim();
  if (wurl && webhookAllows(category)) {
    const content = body ? `${title} — ${body}` : String(title || '');
    Promise.resolve(fetchImpl(wurl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content, source: 'backissue', type, category, level, title, body, url }),
    })).catch((e) => console.warn('notification webhook failed:', e?.message || e));
  }
  return id;
}

/** A user's feed: broadcast rows + their own targeted rows, newest first,
 *  each flagged read/unread for this user. */
export function listNotifications(db, userId, { limit = 30 } = {}) {
  const items = db.prepare(`
    SELECT n.id, n.ts, n.type, n.category, n.level, n.title, n.body, n.url,
           EXISTS(SELECT 1 FROM notification_reads r WHERE r.notification_id = n.id AND r.user_id = ?) AS read
      FROM notifications n
     WHERE n.user_id IS NULL OR n.user_id = ?
     ORDER BY n.ts DESC LIMIT ?`).all(userId, userId, Math.min(200, Math.max(1, limit)));
  return { items: items.map((i) => ({ ...i, read: !!i.read })), unread: unreadCount(db, userId) };
}

export function unreadCount(db, userId) {
  return db.prepare(`
    SELECT COUNT(*) n FROM notifications
     WHERE (user_id IS NULL OR user_id = ?)
       AND id NOT IN (SELECT notification_id FROM notification_reads WHERE user_id = ?)`).get(userId, userId).n;
}

/** Mark specific ids (or all visible) read for this user. */
export function markRead(db, userId, { ids = null, all = false } = {}) {
  const ins = db.prepare('INSERT OR IGNORE INTO notification_reads (notification_id, user_id) VALUES (?, ?)');
  if (all) {
    const rows = db.prepare('SELECT id FROM notifications WHERE user_id IS NULL OR user_id = ?').all(userId);
    const tx = db.transaction(() => { for (const { id } of rows) ins.run(id, userId); });
    tx();
  } else if (Array.isArray(ids)) {
    const tx = db.transaction(() => { for (const id of ids) ins.run(Number(id), userId); });
    tx();
  }
  return unreadCount(db, userId);
}

/** Cheap change signal for the SSE hub — the newest id + total count. */
export function notifyWatermark(db) {
  try { return db.prepare('SELECT MAX(id) m, COUNT(*) c FROM notifications').get(); }
  catch { return { m: 0, c: 0 }; }
}
