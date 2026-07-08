// Reading lists: per-user ordered runs of ComicVine issues — hand-built or
// imported from a ComicVine story arc. Cross-series by design (that's the
// point: "read Infinity Gauntlet in order across six volumes"). Items
// reference cv_issues rows; arc import inserts stub rows for issues we've
// never cached, without ever clobbering existing cached data.

export function initListTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reading_lists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL DEFAULT 0,
      name TEXT NOT NULL,
      arc_cv_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
    CREATE TABLE IF NOT EXISTS reading_list_items (
      list_id INTEGER NOT NULL,
      position INTEGER NOT NULL,
      cv_issue_id INTEGER NOT NULL,
      PRIMARY KEY (list_id, cv_issue_id)
    );
    CREATE INDEX IF NOT EXISTS idx_rli_list ON reading_list_items(list_id, position);
  `);
}

const owned = (db, listId) => db.prepare(`
  SELECT COUNT(*) n FROM reading_list_items li
   WHERE li.list_id = ? AND EXISTS
     (SELECT 1 FROM library_files lf WHERE lf.cv_issue_id = li.cv_issue_id AND lf.valid = 1)`).get(listId).n;

export function listLists(db, userId) {
  return db.prepare(
    'SELECT id, name, arc_cv_id, created_at FROM reading_lists WHERE user_id = ? ORDER BY created_at DESC',
  ).all(userId).map((l) => ({
    ...l,
    items: db.prepare('SELECT COUNT(*) n FROM reading_list_items WHERE list_id = ?').get(l.id).n,
    owned: owned(db, l.id),
  }));
}

const listRow = (db, userId, id) =>
  db.prepare('SELECT * FROM reading_lists WHERE id = ? AND user_id = ?').get(id, userId);

/** Full detail: items in order with CV metadata, ownership, and the local
 *  series id when the volume is in the library (enables navigation and
 *  per-series download grouping). */
export function getList(db, userId, id) {
  const l = listRow(db, userId, id);
  if (!l) return null;
  const items = db.prepare(`
    SELECT li.position, li.cv_issue_id,
           ci.issue_number, ci.name AS title, ci.cover_date, ci.image_url,
           ci.cv_series_id, cs.name AS series_title,
           s.id AS series_id,
           EXISTS (SELECT 1 FROM library_files lf WHERE lf.cv_issue_id = li.cv_issue_id AND lf.valid = 1) AS owned,
           EXISTS (SELECT 1 FROM library_files lf WHERE lf.cv_issue_id = li.cv_issue_id AND lf.valid = 0
                   AND NOT EXISTS (SELECT 1 FROM library_files ok WHERE ok.cv_issue_id = li.cv_issue_id AND ok.valid = 1)) AS corrupt
      FROM reading_list_items li
      LEFT JOIN cv_issues ci ON ci.comicvine_id = li.cv_issue_id
      LEFT JOIN cv_series cs ON cs.comicvine_id = ci.cv_series_id
      LEFT JOIN series s ON s.cv_id = ci.cv_series_id
     WHERE li.list_id = ? ORDER BY li.position`).all(id);
  return { id: l.id, name: l.name, arc_cv_id: l.arc_cv_id, created_at: l.created_at, items };
}

export function createList(db, userId, name) {
  const n = String(name || '').trim();
  if (!n) throw new Error('the list needs a name');
  if (n.length > 120) throw new Error('list name is too long');
  const r = db.prepare('INSERT INTO reading_lists (user_id, name) VALUES (?, ?)').run(userId, n);
  return r.lastInsertRowid;
}

export function renameList(db, userId, id, name) {
  if (!listRow(db, userId, id)) throw new Error('no such list');
  const n = String(name || '').trim();
  if (!n) throw new Error('the list needs a name');
  db.prepare('UPDATE reading_lists SET name = ? WHERE id = ?').run(n, id);
}

export function deleteList(db, userId, id) {
  if (!listRow(db, userId, id)) throw new Error('no such list');
  db.prepare('DELETE FROM reading_list_items WHERE list_id = ?').run(id);
  db.prepare('DELETE FROM reading_lists WHERE id = ?').run(id);
}

/** Append issues (dupes silently skipped, order of the given ids kept). */
export function addItems(db, userId, id, cvIssueIds) {
  if (!listRow(db, userId, id)) throw new Error('no such list');
  const ids = (cvIssueIds || []).map(Number).filter((n) => Number.isFinite(n) && n > 0);
  if (!ids.length) return 0;
  let pos = db.prepare('SELECT COALESCE(MAX(position),0) p FROM reading_list_items WHERE list_id = ?').get(id).p;
  const ins = db.prepare('INSERT OR IGNORE INTO reading_list_items (list_id, position, cv_issue_id) VALUES (?, ?, ?)');
  let added = 0;
  const tx = db.transaction(() => { for (const cv of ids) added += ins.run(id, ++pos, cv).changes; });
  tx();
  return added;
}

export function removeItem(db, userId, id, cvIssueId) {
  if (!listRow(db, userId, id)) throw new Error('no such list');
  db.prepare('DELETE FROM reading_list_items WHERE list_id = ? AND cv_issue_id = ?').run(id, Number(cvIssueId));
}

/** Reorder to exactly `orderedIds` (must be a permutation of the current
 *  items — anything missing/extra is rejected so a stale client can't
 *  silently drop issues). */
export function reorderList(db, userId, id, orderedIds) {
  if (!listRow(db, userId, id)) throw new Error('no such list');
  const current = db.prepare('SELECT cv_issue_id FROM reading_list_items WHERE list_id = ?').all(id).map((r) => r.cv_issue_id);
  const next = (orderedIds || []).map(Number);
  if (current.length !== next.length || new Set(next).size !== next.length
      || !current.every((c) => next.includes(c))) {
    throw new Error('reorder must include every item exactly once');
  }
  const up = db.prepare('UPDATE reading_list_items SET position = ? WHERE list_id = ? AND cv_issue_id = ?');
  db.transaction(() => { next.forEach((cv, i) => up.run(i + 1, id, cv)); })();
}

// ---- ComicVine story-arc import --------------------------------------------
// Arc data comes from the official CV API (a CloneVine mirror only speaks
// volumes/issues). Two calls: the arc's issue stubs, then one issues-list
// hydration per 100 ids. Issues are ordered by cover date (CV's arc stub
// order is by id — useless as reading order), stub rows are inserted for
// anything not already cached, and the result becomes a normal list.
export function importArcAsList(db, userId, arc, issues) {
  const sorted = [...issues].sort((a, b) => {
    const ad = a.cover_date || '9999', bd = b.cover_date || '9999';
    if (ad !== bd) return ad < bd ? -1 : 1;
    const an = parseFloat(a.issue_number), bn = parseFloat(b.issue_number);
    if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) return an - bn;
    return (a.id || 0) - (b.id || 0);
  });
  const insSeries = db.prepare(
    'INSERT OR IGNORE INTO cv_series (comicvine_id, name, cached_at) VALUES (?, ?, datetime(\'now\'))');
  const insIssue = db.prepare(`
    INSERT OR IGNORE INTO cv_issues (comicvine_id, cv_series_id, issue_number, name, cover_date, image_url, cached_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`);
  const listId = db.transaction(() => {
    for (const i of sorted) {
      if (i.volume?.id) insSeries.run(i.volume.id, i.volume.name || null);
      insIssue.run(i.id, i.volume?.id || 0, i.issue_number ?? null, i.name ?? null,
        i.cover_date ?? null, i.image_url ?? null);
    }
    const lid = db.prepare('INSERT INTO reading_lists (user_id, name, arc_cv_id) VALUES (?, ?, ?)')
      .run(userId, String(arc.name || 'Story arc').slice(0, 120), arc.id).lastInsertRowid;
    const ins = db.prepare('INSERT OR IGNORE INTO reading_list_items (list_id, position, cv_issue_id) VALUES (?, ?, ?)');
    sorted.forEach((i, idx) => ins.run(lid, idx + 1, i.id));
    return lid;
  })();
  return listId;
}
