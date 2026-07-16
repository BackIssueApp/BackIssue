import Database from 'better-sqlite3';
import { normalizeNumber } from './matcher.js';

export function initSchema(db) {
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS series (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      url TEXT NOT NULL UNIQUE,
      publisher TEXT,
      year TEXT,
      cover_url TEXT,
      complete INTEGER NOT NULL DEFAULT 0,
      followed INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS issues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      series_id INTEGER NOT NULL REFERENCES series(id),
      title TEXT NOT NULL,
      issue_number TEXT,
      url TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending',
      file_path TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_issues_series ON issues(series_id);
    CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status);
    CREATE TABLE IF NOT EXISTS scan_overrides (
      dir TEXT PRIMARY KEY,
      series_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS library_files (
      path TEXT PRIMARY KEY, dir TEXT, name TEXT, size INTEGER, mtime INTEGER,
      page_count INTEGER, has_metadata INTEGER DEFAULT 0,
      ci_series TEXT, ci_number TEXT, ci_volume TEXT, ci_title TEXT,
      series_id INTEGER, issue_id INTEGER, cv_issue_id INTEGER,
      valid INTEGER DEFAULT 1, error TEXT, verified INTEGER DEFAULT 0, scanned_at TEXT
    );
    CREATE TABLE IF NOT EXISTS cv_series (
      comicvine_id INTEGER PRIMARY KEY,
      name TEXT, publisher TEXT, start_year TEXT,
      count_of_issues INTEGER, description TEXT, image_url TEXT,
      site_detail_url TEXT,
      cached_at TEXT
    );
    CREATE TABLE IF NOT EXISTS cv_issues (
      comicvine_id INTEGER PRIMARY KEY,
      cv_series_id INTEGER NOT NULL,
      issue_number TEXT, name TEXT,
      cover_date TEXT, store_date TEXT,
      description TEXT, credits TEXT, site_detail_url TEXT, image_url TEXT,
      has_detail INTEGER NOT NULL DEFAULT 0,
      cached_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_cvissues_series ON cv_issues(cv_series_id);
    CREATE TABLE IF NOT EXISTS grabs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id INTEGER NOT NULL,
      source TEXT NOT NULL,
      client TEXT,
      download_id TEXT,
      category TEXT,
      title TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      error TEXT,
      grabbed_at TEXT NOT NULL DEFAULT (datetime('now')),
      imported_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_grabs_status ON grabs(status);
    -- Releases that failed to download and shouldn't be auto-grabbed again. A
    -- broken usenet post (failed par2/repair, missing articles) is recorded here
    -- so a retry falls through to the next-best release instead of re-fetching
    -- the same dud. Keyed by both indexer guid and a normalized title, so it's
    -- caught even when the same release is re-posted under a fresh guid.
    CREATE TABLE IF NOT EXISTS release_blacklist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      guid TEXT,
      title_norm TEXT,
      issue_id INTEGER,
      reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_blacklist_guid ON release_blacklist(source, guid);
    CREATE INDEX IF NOT EXISTS idx_blacklist_title ON release_blacklist(source, title_norm);
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL, level TEXT NOT NULL, category TEXT, message TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS schedule_state (
      key TEXT PRIMARY KEY,
      last_run INTEGER
    );
    CREATE TABLE IF NOT EXISTS jobs_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT, label TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      done INTEGER DEFAULT 0, total INTEGER DEFAULT 0, message TEXT,
      result TEXT, error TEXT,
      started_at INTEGER NOT NULL, finished_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_started ON jobs_history(started_at);
    CREATE TABLE IF NOT EXISTS import_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      series_id INTEGER, series_title TEXT,
      issue_title TEXT, issue_number TEXT, cv_issue_id INTEGER,
      source TEXT, path TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_history_ts ON import_history(ts);
    CREATE TABLE IF NOT EXISTS import_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      folder TEXT UNIQUE NOT NULL,
      name TEXT, year TEXT, publisher TEXT, file_count INTEGER,
      cv_id INTEGER, cv_name TEXT, cv_year TEXT, cv_image TEXT,
      confidence TEXT, status TEXT NOT NULL DEFAULT 'review',
      series_type TEXT, -- inferred library type ('manga' from ComicInfo's Manga tag); null = comic
      library_id INTEGER, -- library whose root folder contains this candidate; null = default
      scanned_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    -- Personal follows: each user's own pull list. Distinct from
    -- series.followed, which is the GLOBAL monitor flag driving download
    -- automation (name kept for compatibility — plugins query it directly).
    CREATE TABLE IF NOT EXISTS user_follows (
      user_id INTEGER NOT NULL,
      series_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, series_id)
    );
  `);
}

// Add columns introduced after the first release to pre-existing databases.
function migrate(db) {
  const cols = db.prepare('PRAGMA table_info(series)').all().map((c) => c.name);
  if (!cols.includes('complete')) {
    db.exec('ALTER TABLE series ADD COLUMN complete INTEGER NOT NULL DEFAULT 0');
  }
  if (!cols.includes('followed')) {
    db.exec('ALTER TABLE series ADD COLUMN followed INTEGER NOT NULL DEFAULT 0');
  }
  if (!cols.includes('year')) {
    db.exec('ALTER TABLE series ADD COLUMN year TEXT');
  }
  const lf = db.prepare('PRAGMA table_info(library_files)').all().map((c) => c.name);
  if (lf.length && !lf.includes('series_id')) db.exec('ALTER TABLE library_files ADD COLUMN series_id INTEGER');
  if (lf.length && !lf.includes('issue_id')) db.exec('ALTER TABLE library_files ADD COLUMN issue_id INTEGER');
  if (lf.length && !lf.includes('cv_issue_id')) db.exec('ALTER TABLE library_files ADD COLUMN cv_issue_id INTEGER');
  if (lf.length) db.exec('CREATE INDEX IF NOT EXISTS idx_libfiles_series ON library_files(series_id)');
  // "Is this CV issue owned?" is probed constantly (wanted list, pack imports,
  // ownership rollups) — without this index each probe scans the whole table.
  if (lf.length && lf.includes('cv_issue_id')) db.exec('CREATE INDEX IF NOT EXISTS idx_libfiles_cvissue ON library_files(cv_issue_id)');
  // ComicVine identity: link a series to its canonical CV volume.
  if (!cols.includes('cv_id')) db.exec('ALTER TABLE series ADD COLUMN cv_id INTEGER');
  if (!cols.includes('cv_locked')) db.exec('ALTER TABLE series ADD COLUMN cv_locked INTEGER NOT NULL DEFAULT 0');
  // Per-comic folder on disk (Radarr-style). NULL = derived (from files / root folder).
  if (!cols.includes('path')) db.exec('ALTER TABLE series ADD COLUMN path TEXT');
  // User-added alternative names used when searching download sources (indexers
  // sometimes name a volume differently, e.g. "2000 AD" vs "2000AD"). Newline-sep.
  if (!cols.includes('aliases')) db.exec('ALTER TABLE series ADD COLUMN aliases TEXT');
  // Mature/restricted flag. When 1, the series (and its issues, files, releases)
  // are hidden from any user whose role lacks the library.restricted permission.
  if (!cols.includes('restricted')) db.exec('ALTER TABLE series ADD COLUMN restricted INTEGER NOT NULL DEFAULT 0');
  // Library type: 'comic' (default) | 'manga' | future types (e.g. 'magazine').
  // Kept as free TEXT so new types don't need a migration; consumers treat
  // unknown values as 'comic'. Drives parsing conventions (chapters vs issues),
  // reader defaults (RTL), and library filtering.
  if (!cols.includes('type')) db.exec("ALTER TABLE series ADD COLUMN type TEXT NOT NULL DEFAULT 'comic'");
  // Explicit libraries: named containers with a behavior type and optionally
  // their own root folder. series.library_id NULL = the implicit default
  // library (classic single-library behavior).
  db.exec(`CREATE TABLE IF NOT EXISTS libraries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'comic',
    root_folder TEXT,
    folder_pattern TEXT, -- per-library folder naming; null = the global pattern
    restricted INTEGER NOT NULL DEFAULT 0, -- members ride the mature-content machinery
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  if (!cols.includes('library_id')) db.exec('ALTER TABLE series ADD COLUMN library_id INTEGER');
  const libCols = db.prepare('PRAGMA table_info(libraries)').all().map((c) => c.name);
  if (libCols.length && !libCols.includes('folder_pattern')) db.exec('ALTER TABLE libraries ADD COLUMN folder_pattern TEXT');
  if (libCols.length && !libCols.includes('restricted')) db.exec('ALTER TABLE libraries ADD COLUMN restricted INTEGER NOT NULL DEFAULT 0');
  const cvcols = db.prepare('PRAGMA table_info(cv_series)').all().map((c) => c.name);
  if (cvcols.length && !cvcols.includes('site_detail_url')) db.exec('ALTER TABLE cv_series ADD COLUMN site_detail_url TEXT');
  // ComicVine-provided alternative names (its `aliases` field, newline-separated).
  if (cvcols.length && !cvcols.includes('aliases')) db.exec('ALTER TABLE cv_series ADD COLUMN aliases TEXT');
  const cvi = db.prepare('PRAGMA table_info(cv_issues)').all().map((c) => c.name);
  for (const col of ['description', 'credits', 'site_detail_url', 'image_url']) {
    if (cvi.length && !cvi.includes(col)) db.exec(`ALTER TABLE cv_issues ADD COLUMN ${col} TEXT`);
  }
  // Metron enrichment fields (CloneVine's enrich=metron) + the CV fields we
  // didn't originally store. Only populated when the metadata endpoint
  // supports enrichment / the fetch carries them.
  for (const col of ['metron_rating', 'metron_status', 'metron_year_end', 'metron_series_type',
                     'metron_imprint', 'metron_genres', 'metron_sort_name', 'metron_gcd_id', 'deck']) {
    if (cvcols.length && !cvcols.includes(col)) db.exec(`ALTER TABLE cv_series ADD COLUMN ${col} TEXT`);
  }
  // Per-issue: full CV credit arrays + every Metron extra. metron_checked
  // marks "enrichment answered" (hit or miss) so detail rows cached before
  // enrichment existed re-fetch exactly once, not forever.
  for (const col of ['metron_price', 'metron_upc', 'metron_story_titles', 'metron_reprints', 'metron_checked',
                     'metron_isbn', 'metron_sku', 'metron_foc_date', 'metron_variants', 'metron_cover_hash', 'metron_rating',
                     'character_credits', 'team_credits', 'location_credits', 'story_arc_credits', 'associated_images']) {
    if (cvi.length && !cvi.includes(col)) db.exec(`ALTER TABLE cv_issues ADD COLUMN ${col} TEXT`);
  }
  // Metadata editor: user_fields is a JSON array of column names the user has
  // edited by hand. Every sync path (refresh, match, enrichment) preserves
  // those columns — an edit survives any number of refreshes until reset.
  if (cvcols.length && !cvcols.includes('user_fields')) db.exec('ALTER TABLE cv_series ADD COLUMN user_fields TEXT');
  if (cvi.length && !cvi.includes('user_fields')) db.exec('ALTER TABLE cv_issues ADD COLUMN user_fields TEXT');
  // Pack grabs (per-series or 0-day) carry a series_id (null = whole-collection
  // 0-day pack) and kind='pack'; individual-issue grabs stay kind='issue'.
  const grabCols = db.prepare('PRAGMA table_info(grabs)').all().map((c) => c.name);
  if (grabCols.length && !grabCols.includes('series_id')) db.exec('ALTER TABLE grabs ADD COLUMN series_id INTEGER');
  if (grabCols.length && !grabCols.includes('kind')) db.exec("ALTER TABLE grabs ADD COLUMN kind TEXT NOT NULL DEFAULT 'issue'");
  // Indexer guid of the grabbed release, so a failure can blacklist that exact
  // release (not just its title) and future searches skip it.
  if (grabCols.length && !grabCols.includes('release_guid')) db.exec('ALTER TABLE grabs ADD COLUMN release_guid TEXT');
  // Library type inferred by the import scan (ComicInfo's Manga tag).
  const icCols = db.prepare('PRAGMA table_info(import_candidates)').all().map((c) => c.name);
  if (icCols.length && !icCols.includes('series_type')) db.exec('ALTER TABLE import_candidates ADD COLUMN series_type TEXT');
  // Owning explicit library (candidate folder under that library's root).
  if (icCols.length && !icCols.includes('library_id')) db.exec('ALTER TABLE import_candidates ADD COLUMN library_id INTEGER');
  // The Mylar integration is gone — BackIssue replaces it.
  db.exec('DROP TABLE IF EXISTS mylar_series_map');
  // The dedicated tag log was folded into the Logs page (category 'tag').
  db.exec('DROP TABLE IF EXISTS tag_log');
}

export function openDb(dbPath) {
  const db = new Database(dbPath);
  initSchema(db);
  migrate(db);
  return db;
}

export function upsertSeries(db, { title, url, publisher = null, coverUrl = null }) {
  db.prepare(
    `INSERT INTO series (title, url, publisher, cover_url) VALUES (?, ?, ?, ?)
     ON CONFLICT(url) DO UPDATE SET title=excluded.title, cover_url=COALESCE(excluded.cover_url, cover_url)`
  ).run(title, url, publisher, coverUrl);
  return db.prepare('SELECT id FROM series WHERE url = ?').get(url).id;
}

export function upsertIssue(db, { seriesId, title, issueNumber = null, url }) {
  db.prepare(
    `INSERT INTO issues (series_id, title, issue_number, url) VALUES (?, ?, ?, ?)
     ON CONFLICT(url) DO UPDATE SET title=excluded.title, issue_number=excluded.issue_number`
  ).run(seriesId, title, issueNumber, url);
  return db.prepare('SELECT id FROM issues WHERE url = ?').get(url).id;
}

export function listSeries(db, { search, includeRestricted = true } = {}) {
  const clauses = [];
  if (search) clauses.push('s.title LIKE @q');
  if (!includeRestricted) clauses.push('s.restricted = 0');
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(
    `SELECT s.*, COUNT(i.id) AS issue_count
     FROM series s LEFT JOIN issues i ON i.series_id = s.id
     ${where}
     GROUP BY s.id ORDER BY s.title`
  ).all(search ? { q: `%${search}%` } : {});
}

export function setSeriesRestricted(db, id, restricted) {
  db.prepare('UPDATE series SET restricted=? WHERE id=?').run(restricted ? 1 : 0, id);
}
// Library types the CORE ships behavior for: comics (default conventions) and
// manga (chapter-aware search, RTL reading defaults). A type only belongs here
// when picking it actually changes behavior — anything else (e.g. magazines,
// planned as a plugin with schedule-driven issues) registers itself via
// registerLibraryType, which pushes into this whitelist at plugin load.
export const SERIES_TYPES = ['comic', 'manga'];
export function setSeriesType(db, id, type) {
  if (!SERIES_TYPES.includes(type)) throw new Error(`unknown series type "${type}"`);
  db.prepare('UPDATE series SET type=? WHERE id=?').run(type, id);
}

/* ---------- Explicit libraries ---------- */
// A library's root_folder column holds one folder PER LINE — the first is the
// default (where new comics are filed); the rest are extra scan locations.
export function libraryFolders(rootFolder) {
  return String(rootFolder || '').split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
}
// Named containers with a behavior type (and, later, their own root folder).
// Assigning a series to a library also sets its type — one decision, so a
// library's contents always behave like the library says they do.
export function createLibrary(db, { name, type = 'comic', rootFolder = null, folderPattern = null, restricted = false }) {
  if (!String(name || '').trim()) throw new Error('a library needs a name');
  if (!SERIES_TYPES.includes(type)) throw new Error(`unknown series type "${type}"`);
  const ord = (db.prepare('SELECT COALESCE(MAX(sort_order),0)+1 n FROM libraries').get()).n;
  return db.prepare('INSERT INTO libraries (name, type, root_folder, folder_pattern, restricted, sort_order) VALUES (?,?,?,?,?,?)')
    .run(String(name).trim(), type, rootFolder || null, folderPattern || null, restricted ? 1 : 0, ord).lastInsertRowid;
}
export function listLibraries(db) {
  // series_count = COLLECTION members only (followed or with files on disk) —
  // the series table also holds catalog rows the user never added, which the
  // collection views filter out; counting those made libraries look huge.
  return db.prepare(`SELECT l.*, (SELECT COUNT(*) FROM series s WHERE s.library_id = l.id
      AND (s.followed=1 OR EXISTS(SELECT 1 FROM library_files lf WHERE lf.series_id=s.id AND lf.valid=1))) series_count
    FROM libraries l ORDER BY l.sort_order, l.id`).all();
}
export function getLibrary(db, id) {
  return db.prepare('SELECT * FROM libraries WHERE id=?').get(id);
}
export function updateLibrary(db, id, { name, type, rootFolder, folderPattern, restricted, sortOrder } = {}) {
  const lib = getLibrary(db, id);
  if (!lib) throw new Error('unknown library');
  if (type != null && !SERIES_TYPES.includes(type)) throw new Error(`unknown series type "${type}"`);
  db.prepare('UPDATE libraries SET name=?, type=?, root_folder=?, folder_pattern=?, restricted=?, sort_order=? WHERE id=?').run(
    name != null && String(name).trim() ? String(name).trim() : lib.name,
    type ?? lib.type,
    rootFolder !== undefined ? (rootFolder || null) : lib.root_folder,
    folderPattern !== undefined ? (folderPattern || null) : lib.folder_pattern,
    restricted !== undefined ? (restricted ? 1 : 0) : lib.restricted,
    sortOrder ?? lib.sort_order, id);
  // A type change re-types the members (the library defines their behavior).
  if (type != null && type !== lib.type) db.prepare('UPDATE series SET type=? WHERE library_id=?').run(type, id);
  // A restricted flag flip re-flags the members — they ride the existing
  // mature-content permission, which every surface already enforces.
  if (restricted !== undefined && (restricted ? 1 : 0) !== lib.restricted) {
    db.prepare('UPDATE series SET restricted=? WHERE library_id=?').run(restricted ? 1 : 0, id);
  }
}
// Delete a library, never its series: members move to a surviving library
// (first comic-typed one, else the first remaining, re-typed accordingly).
// Deleting the LAST library leaves members unassigned — the pre-libraries
// state, where the startup migration would re-home them on next boot.
export function deleteLibrary(db, id) {
  const survivors = db.prepare('SELECT * FROM libraries WHERE id<>? ORDER BY sort_order, id').all(id);
  const home = survivors.find((l) => l.type === 'comic') || survivors[0] || null;
  if (home) {
    db.prepare('UPDATE series SET library_id=?, type=?, restricted=CASE WHEN ? THEN 1 ELSE restricted END WHERE library_id=?')
      .run(home.id, home.type, home.restricted ? 1 : 0, id);
  } else {
    db.prepare('UPDATE series SET library_id=NULL WHERE library_id=?').run(id);
  }
  return db.prepare('DELETE FROM libraries WHERE id=?').run(id).changes;
}
// The library new series land in by default: the first comic-typed one (the
// migration's "Comics"), else the first library at all, else none (pre-library
// installs — the startup migration adopts later).
export function defaultLibrary(db) {
  const libs = db.prepare('SELECT * FROM libraries ORDER BY sort_order, id').all();
  return libs.find((l) => l.type === 'comic') || libs[0] || null;
}

// Move a series into a library (typing it accordingly), or out (null). A
// restricted library also flags the member restricted; moving OUT clears only
// the library-inherited flag (a restricted library → default move unhides —
// deliberate: the default library carries no restriction of its own).
export function assignSeriesLibrary(db, seriesId, libraryId) {
  const prev = db.prepare('SELECT library_id FROM series WHERE id=?').get(seriesId);
  if (libraryId == null) {
    const prevLib = prev?.library_id ? getLibrary(db, prev.library_id) : null;
    db.prepare('UPDATE series SET library_id=NULL WHERE id=?').run(seriesId);
    if (prevLib?.restricted) db.prepare('UPDATE series SET restricted=0 WHERE id=?').run(seriesId);
    return;
  }
  const lib = getLibrary(db, libraryId);
  if (!lib) throw new Error('unknown library');
  db.prepare('UPDATE series SET library_id=?, type=?, restricted=CASE WHEN ? THEN 1 ELSE restricted END WHERE id=?')
    .run(lib.id, lib.type, lib.restricted ? 1 : 0, seriesId);
  // Leaving a restricted library for an unrestricted one clears the inherited flag.
  if (!lib.restricted && prev?.library_id) {
    const prevLib = getLibrary(db, prev.library_id);
    if (prevLib?.restricted) db.prepare('UPDATE series SET restricted=0 WHERE id=?').run(seriesId);
  }
}
export function isSeriesRestricted(db, id) {
  const r = db.prepare('SELECT restricted FROM series WHERE id=?').get(id);
  return !!(r && r.restricted);
}

/** Ids of every restricted series — for filtering joined rows (queue, history)
 *  on surfaces serving viewers without library.restricted. */
export function restrictedSeriesIds(db) {
  return new Set(db.prepare('SELECT id FROM series WHERE restricted=1').all().map((r) => r.id));
}

/** Does this ComicVine issue belong to a restricted series in the library?
 *  Guards direct-by-id issue lookups (list surfaces are filtered separately). */
export function isCvIssueRestricted(db, cvIssueId) {
  const r = db.prepare(
    'SELECT 1 x FROM cv_issues ci JOIN series s ON s.cv_id = ci.cv_series_id WHERE ci.comicvine_id=? AND s.restricted=1',
  ).get(cvIssueId);
  return !!r;
}

export function listIssues(db, { seriesId, status } = {}) {
  const clauses = [];
  const params = {};
  if (seriesId != null) { clauses.push('series_id = @seriesId'); params.seriesId = seriesId; }
  if (status) { clauses.push('status = @status'); params.status = status; }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM issues ${where} ORDER BY id`).all(params);
}

export function setIssueStatus(db, issueId, status, { filePath = null, error = null } = {}) {
  db.prepare('UPDATE issues SET status=?, file_path=?, error=? WHERE id=?')
    .run(status, filePath, error, issueId);
}

export function queueIssues(db, issueIds) {
  const stmt = db.prepare(
    `UPDATE issues SET status='queued' WHERE id=? AND status NOT IN ('done','downloading','grabbed')`
  );
  const tx = db.transaction((ids) => ids.forEach((id) => stmt.run(id)));
  tx(issueIds);
}

export function getIssueById(db, id) {
  return db.prepare('SELECT * FROM issues WHERE id=?').get(id);
}

// A "grab" is a deferred download handed to an external client (usenet). We
// remember which issue it maps to and the client's own id so the background
// monitor can match completed downloads back to the right issue — even across
// an app restart.
// A guid must reach SQL as a string or null — an object passed positionally is
// read by better-sqlite3 as a NAMED-parameter bag, shrinking the anonymous arg
// list ("Too few parameter values were provided"). Sources normally hand us
// strings, but a malformed indexer response can leak other shapes.
const guidStr = (g) => (typeof g === 'string' && g) || (typeof g === 'number' ? String(g) : null);

export function recordGrab(db, { issueId = 0, source, client = null, downloadId = null, category = null, title = null, seriesId = null, kind = 'issue', releaseGuid = null }) {
  // issue_id is NOT NULL in the schema; pack grabs have no single issue → 0 sentinel.
  return db.prepare(
    `INSERT INTO grabs (issue_id, source, client, download_id, category, title, series_id, kind, release_guid) VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(issueId ?? 0, source, client, downloadId != null ? String(downloadId) : null, category, title, seriesId, kind, guidStr(releaseGuid)).lastInsertRowid;
}

// Normalize a release title to a stable comparison key: lowercase, drop a comic
// extension, and reduce everything non-alphanumeric to single spaces. Two ways
// of writing the same scene release ("Series 005 (2020).cbz" vs
// "Series.005.2020") collapse to the same key. Used by both the blacklist store
// and the search filter — they MUST normalize identically.
export function normReleaseTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/\.(cbz|cbr|cb7|cbt|pdf|nzb)$/i, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Does this import error mean the downloaded CONTENT is bad (damaged archive,
// wrong bytes) — as opposed to a transient problem (paths, permissions, an
// unreachable client)? Content failures are deterministic: the same release
// fails the same way every retry, so it belongs on the blacklist.
export function isCorruptContentError(e) {
  return /archive header|data are damaged|not RAR archive|corrupt|invalid zip|end of central directory/i
    .test(String(e?.message || e || ''));
}

// Record a release that failed to download so it isn't auto-grabbed again.
// Deduplicated on (source, guid, title_norm) so the same dud failing twice
// doesn't pile up rows.
export function blacklistRelease(db, { source, guid = null, title = null, issueId = null, reason = null }) {
  guid = guidStr(guid);
  const titleNorm = title ? normReleaseTitle(title) : null;
  if (!guid && !titleNorm) return; // nothing to key on
  const dup = db.prepare(
    `SELECT 1 FROM release_blacklist WHERE source=? AND IFNULL(guid,'')=IFNULL(?,'') AND IFNULL(title_norm,'')=IFNULL(?,'') LIMIT 1`
  ).get(source, guid || null, titleNorm || null);
  if (dup) return;
  db.prepare(
    `INSERT INTO release_blacklist (source, guid, title_norm, issue_id, reason) VALUES (?,?,?,?,?)`
  ).run(source, guid || null, titleNorm || null, issueId ?? null, reason ? String(reason).slice(0, 500) : null);
}

// Load the blacklist for a source as fast-lookup sets the search filter checks
// each candidate against (by guid and by normalized title).
export function loadReleaseBlacklist(db, source) {
  const rows = db.prepare(`SELECT guid, title_norm FROM release_blacklist WHERE source=?`).all(source);
  const guids = new Set(), titles = new Set();
  for (const r of rows) { if (r.guid) guids.add(r.guid); if (r.title_norm) titles.add(r.title_norm); }
  return { guids, titles };
}

// Blacklisted releases for the management view — most recent first, with the
// series/issue they were grabbed for resolved for a friendly label. The stored
// grab title is the human-readable release name; title_norm is the match key.
export function listBlacklist(db, { limit = 200, offset = 0 } = {}) {
  const rows = db.prepare(`
    SELECT b.id, b.source, b.title_norm, b.reason, b.created_at, b.issue_id,
           g.title, i.issue_number, i.series_id,
           COALESCE(cv.name, s.title) AS series_title
      FROM release_blacklist b
      LEFT JOIN issues i ON i.id = b.issue_id
      LEFT JOIN series s ON s.id = i.series_id
      LEFT JOIN cv_series cv ON cv.comicvine_id = s.cv_id
      LEFT JOIN grabs g ON g.id = (
        SELECT gg.id FROM grabs gg WHERE gg.issue_id = b.issue_id AND gg.source = b.source
        ORDER BY gg.id DESC LIMIT 1)
     ORDER BY b.id DESC LIMIT ? OFFSET ?`).all(limit, offset);
  const total = db.prepare('SELECT COUNT(*) n FROM release_blacklist').get().n;
  return { rows, total };
}

// Remove one blacklist entry (lets that release be auto-grabbed again).
export function deleteBlacklistEntry(db, id) {
  return db.prepare('DELETE FROM release_blacklist WHERE id=?').run(id).changes;
}

// Empty the whole blacklist.
export function clearBlacklist(db) {
  return db.prepare('DELETE FROM release_blacklist').run().changes;
}

// Has this exact pack (by title) already been grabbed and not failed? Used to
// avoid re-grabbing the same 0-day week every scheduled run.
export function packGrabbed(db, title) {
  return !!db.prepare("SELECT 1 FROM grabs WHERE kind='pack' AND title=? AND status!='failed' LIMIT 1").get(title);
}

// Scheduler persistence: when each scheduled task last ran, surviving restarts —
// so a reboot doesn't re-fire everything, and a missed window catches up once.
export function getScheduleLastRun(db, key) {
  return db.prepare('SELECT last_run FROM schedule_state WHERE key=?').get(key)?.last_run ?? null;
}
export function setScheduleLastRun(db, key, ts) {
  db.prepare('INSERT INTO schedule_state (key, last_run) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET last_run=excluded.last_run').run(key, ts);
}

// One row per imported issue — the History page's data. Written by finishImport,
// which every import path goes through (queue downloads, monitor, packs).
export function recordImport(db, { seriesId = null, seriesTitle = null, issueTitle = null, issueNumber = null, cvIssueId = null, source = null, path = null }) {
  db.prepare(`INSERT INTO import_history (ts, series_id, series_title, issue_title, issue_number, cv_issue_id, source, path)
    VALUES (?,?,?,?,?,?,?,?)`).run(Date.now(), seriesId, seriesTitle, issueTitle, issueNumber, cvIssueId, source, path);
}

// Wanted = every ComicVine issue of a collection series (followed, or owned via a
// valid file) that has NO valid file yet. `queue_status` carries the in-flight
// state (queued/grabbed/failed…) when the issue has already been sent for
// download, so the page can show a badge instead of a Download button.
export function listWantedIssues(db, { limit = 200, offset = 0, followedOnly = false, hideUnreleased = false, releasedWithinDays = 0, search = '', includeRestricted = true } = {}) {
  const conds = [
    `(s.followed=1 OR EXISTS(SELECT 1 FROM library_files lf WHERE lf.series_id=s.id AND lf.valid=1))`,
    `NOT EXISTS (SELECT 1 FROM library_files lf2 WHERE lf2.cv_issue_id = ci.comicvine_id AND lf2.valid=1)`,
  ];
  const args = {};
  if (!includeRestricted) conds.push('s.restricted = 0');
  if (followedOnly) conds.push('s.followed=1');
  // Best-effort: most cached issues have no cover date (volume stubs don't carry
  // one), so this only hides issues we KNOW are future-dated — honest, not complete.
  if (hideUnreleased) conds.push(`NOT (ci.cover_date IS NOT NULL AND date(ci.cover_date) > date('now'))`);
  // Only issues RELEASED within the last N days (store date first — that's the
  // real shelf date; cover dates run weeks ahead). Requires a known, non-future
  // date, so this is a strict subset: the "new releases" lane, not the backlog.
  if (releasedWithinDays > 0) {
    conds.push(`COALESCE(ci.store_date, ci.cover_date) IS NOT NULL
      AND date(COALESCE(ci.store_date, ci.cover_date)) >= date('now', @recentSince)
      AND date(COALESCE(ci.store_date, ci.cover_date)) <= date('now')`);
    args.recentSince = `-${Math.floor(releasedWithinDays)} days`;
  }
  if (search) { conds.push('COALESCE(cv.name, s.title) LIKE @q'); args.q = `%${search}%`; }
  const from = `FROM series s
    JOIN cv_series cv ON cv.comicvine_id = s.cv_id
    JOIN cv_issues ci ON ci.cv_series_id = s.cv_id
    WHERE ${conds.join(' AND ')}`;
  const total = db.prepare(`SELECT COUNT(*) n ${from}`).get(args).n;
  const items = db.prepare(`SELECT s.id series_id, COALESCE(cv.name, s.title) series_title, s.followed,
      cv.image_url series_cover,
      ci.comicvine_id cv_issue_id, ci.issue_number, ci.name issue_name, ci.cover_date,
      (SELECT i.status FROM issues i WHERE i.url = 'cvissue:' || ci.comicvine_id) queue_status
    ${from}
    ORDER BY series_title, CAST(ci.issue_number AS REAL), ci.issue_number
    LIMIT @limit OFFSET @offset`).all({ ...args, limit, offset });
  return { items, total };
}

// Newest-first page of the import history (+ the distinct sources for the filter
// chips — derived from the data so core stays source-agnostic).
export function listImportHistory(db, { limit = 200, offset = 0, source = null } = {}) {
  const where = source ? 'WHERE source=?' : '';
  const args = source ? [source] : [];
  const total = db.prepare(`SELECT COUNT(*) n FROM import_history ${where}`).get(...args).n;
  const items = db.prepare(`SELECT * FROM import_history ${where} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
  const sources = db.prepare('SELECT DISTINCT source FROM import_history WHERE source IS NOT NULL ORDER BY source').all().map((r) => r.source);
  return { items, total, sources };
}

export function activeGrabs(db) {
  return db.prepare(`SELECT * FROM grabs WHERE status='active' ORDER BY id`).all();
}

// Active PACK grabs (0-day / per-series) for the queue drawer — they have no
// issue rows, so the plain queue can't show them.
export function activePackGrabs(db) {
  return db.prepare(`SELECT g.id, g.title, g.source, g.series_id,
      COALESCE(cv.name, s.title) series_title
    FROM grabs g
    LEFT JOIN series s ON s.id = g.series_id
    LEFT JOIN cv_series cv ON cv.comicvine_id = s.cv_id
    WHERE g.status='active' AND g.kind='pack' ORDER BY g.id`).all();
}

export function getGrab(db, id) {
  return db.prepare('SELECT * FROM grabs WHERE id=?').get(id);
}

// Failed grabs, newest first — the durable "what failed and why" record for
// the History page (queue rows clear; this doesn't).
export function listFailedGrabs(db, { limit = 200, offset = 0 } = {}) {
  const rows = db.prepare(`
    SELECT g.id, g.title, g.source, g.error, g.grabbed_at, i.issue_number, i.series_id,
           COALESCE(cv.name, s.title) AS series_title
      FROM grabs g
      LEFT JOIN issues i ON i.id = g.issue_id
      LEFT JOIN series s ON s.id = i.series_id
      LEFT JOIN cv_series cv ON cv.comicvine_id = s.cv_id
     WHERE g.status = 'failed'
     ORDER BY g.id DESC LIMIT ? OFFSET ?`).all(limit, offset);
  const total = db.prepare("SELECT COUNT(*) n FROM grabs WHERE status='failed'").get().n;
  return { rows, total };
}

export function setGrabStatus(db, id, status, { error = null, importedAt = null } = {}) {
  db.prepare(`UPDATE grabs SET status=?, error=?, imported_at=COALESCE(?, imported_at) WHERE id=?`)
    .run(status, error, importedAt, id);
}

export function getNextQueued(db) {
  return db.prepare(`SELECT * FROM issues WHERE status='queued' ORDER BY id LIMIT 1`).get();
}

// Atomically claim the next queued issue (mark it 'downloading') and return it,
// so multiple concurrent download workers never grab the same issue.
export function claimNextQueued(db) {
  const tx = db.transaction(() => {
    const row = db.prepare(`SELECT * FROM issues WHERE status='queued' ORDER BY id LIMIT 1`).get();
    if (!row) return undefined;
    db.prepare("UPDATE issues SET status='downloading' WHERE id=?").run(row.id);
    return row;
  });
  return tx();
}

export function countByStatus(db) {
  const rows = db.prepare(`SELECT status, COUNT(*) n FROM issues GROUP BY status`).all();
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

export function getSeriesTitleById(db, id) {
  return db.prepare('SELECT title FROM series WHERE id=?').get(id)?.title;
}

export function getSeriesById(db, id) {
  return db.prepare('SELECT * FROM series WHERE id=?').get(id);
}

export function getSeriesByUrl(db, url) {
  return db.prepare('SELECT * FROM series WHERE url = ?').get(url);
}

// Manual scanner match overrides: a library folder -> catalog series link that
// survives re-scans (from the "Fix match" control).
export function setScanOverride(db, dir, seriesId) {
  db.prepare("INSERT INTO scan_overrides (dir, series_id, created_at) VALUES (?, ?, datetime('now')) ON CONFLICT(dir) DO UPDATE SET series_id=excluded.series_id, created_at=excluded.created_at")
    .run(dir, seriesId);
}
export function getScanOverride(db, dir) {
  const r = db.prepare('SELECT series_id FROM scan_overrides WHERE dir = ?').get(dir);
  return r ? r.series_id : undefined;
}
export function clearScanOverride(db, dir) {
  return db.prepare('DELETE FROM scan_overrides WHERE dir = ?').run(dir).changes;
}

// --- Library health index ---
export function upsertLibraryFile(db, r) {
  // series_id/issue_id are NOT touched on conflict — the link is preserved across
  // re-indexes and set explicitly via linkLibraryFile.
  db.prepare(`INSERT INTO library_files
    (path,dir,name,size,mtime,page_count,has_metadata,ci_series,ci_number,ci_volume,ci_title,series_id,issue_id,valid,error,verified,scanned_at)
    VALUES (@path,@dir,@name,@size,@mtime,@page_count,@has_metadata,@ci_series,@ci_number,@ci_volume,@ci_title,@series_id,@issue_id,@valid,@error,@verified,datetime('now'))
    ON CONFLICT(path) DO UPDATE SET dir=excluded.dir,name=excluded.name,size=excluded.size,mtime=excluded.mtime,
      page_count=excluded.page_count,has_metadata=excluded.has_metadata,ci_series=excluded.ci_series,ci_number=excluded.ci_number,
      ci_volume=excluded.ci_volume,ci_title=excluded.ci_title,valid=excluded.valid,error=excluded.error,verified=excluded.verified,scanned_at=excluded.scanned_at`)
    .run({ page_count: null, has_metadata: 0, ci_series: null, ci_number: null, ci_volume: null, ci_title: null, series_id: null, issue_id: null, valid: 1, error: null, verified: 0, ...r });
}
export function linkLibraryFile(db, path, seriesId, issueId) {
  db.prepare('UPDATE library_files SET series_id=?, issue_id=? WHERE path=?').run(seriesId ?? null, issueId ?? null, path);
}
export function getLibraryFile(db, path) { return db.prepare('SELECT * FROM library_files WHERE path=?').get(path); }
export function deleteLibraryFile(db, path) { return db.prepare('DELETE FROM library_files WHERE path=?').run(path).changes; }
export function listLibraryFiles(db, { filter = 'all', limit = 2000 } = {}) {
  const where = filter === 'untagged' ? 'WHERE valid=1 AND has_metadata=0'
    : filter === 'corrupt' ? 'WHERE valid=0'
    : filter === 'cbr' ? "WHERE name LIKE '%.cbr'" : '';
  return db.prepare(`SELECT * FROM library_files ${where} ORDER BY dir, name LIMIT ?`).all(Math.max(1, Math.min(5000, limit)));
}
export function libraryStats(db) {
  const r = db.prepare(`SELECT COUNT(*) total, COALESCE(SUM(size),0) bytes,
    SUM(CASE WHEN valid=1 AND has_metadata=1 THEN 1 ELSE 0 END) tagged,
    SUM(CASE WHEN valid=1 AND has_metadata=0 THEN 1 ELSE 0 END) untagged,
    SUM(CASE WHEN valid=0 THEN 1 ELSE 0 END) corrupt,
    SUM(CASE WHEN name LIKE '%.cbr' THEN 1 ELSE 0 END) cbr FROM library_files`).get();
  return { total: r.total, bytes: r.bytes, tagged: r.tagged || 0, untagged: r.untagged || 0, corrupt: r.corrupt || 0, cbr: r.cbr || 0 };
}
export function pruneLibraryFiles(db, seen) {
  const keep = seen instanceof Set ? seen : new Set(seen);
  let n = 0;
  for (const row of db.prepare('SELECT path FROM library_files').all()) {
    if (!keep.has(row.path)) { db.prepare('DELETE FROM library_files WHERE path=?').run(row.path); n++; }
  }
  return n;
}

// --- Collection (radar) ---
// A collection series = one you monitor (followed) OR own a valid linked file for.
// Last path segment (folder name) of a dir, across / or \ separators.
function dirBaseName(d) { return d ? (String(d).split(/[\\/]/).filter(Boolean).pop() || null) : null; }

export function collectionSeries(db, { filter = 'all', search = '', sort = 'title', includeRestricted = true, userId = null, library = null } = {}) {
  // Sort options for the rail: title (default), recently added (id desc — rows
  // are only ever inserted), most missing (CV total minus owned).
  const ORDERS = {
    title: 'ORDER BY s.title',
    added: 'ORDER BY s.id DESC',
    missing: `ORDER BY (
      (SELECT COUNT(*) FROM cv_issues ci WHERE ci.cv_series_id = s.cv_id) -
      (SELECT COUNT(DISTINCT lf.cv_issue_id) FROM library_files lf WHERE lf.series_id = s.id AND lf.valid = 1 AND lf.cv_issue_id IS NOT NULL)
    ) DESC, s.title`,
  };
  const orderBy = ORDERS[sort] || ORDERS.title;
  const rows = db.prepare(`
    SELECT s.id, s.title, s.publisher, s.year, s.cover_url, s.followed, s.cv_id, s.cv_locked, s.url, s.restricted, s.type,
      EXISTS(SELECT 1 FROM user_follows uf WHERE uf.series_id=s.id AND uf.user_id=@uid) my_follow,
      cv.name cv_name, cv.publisher cv_publisher, cv.start_year cv_year, cv.image_url cv_image,
      (SELECT COUNT(*) FROM issues i WHERE i.series_id=s.id) bc_total,
      (SELECT COUNT(*) FROM issues i WHERE i.series_id=s.id AND EXISTS
        (SELECT 1 FROM library_files lf WHERE lf.issue_id=i.id AND lf.valid=1)) bc_owned,
      (SELECT COUNT(*) FROM cv_issues ci WHERE ci.cv_series_id=s.cv_id) cv_total,
      (SELECT COUNT(DISTINCT lf.cv_issue_id) FROM library_files lf
        WHERE lf.series_id=s.id AND lf.valid=1 AND lf.cv_issue_id IS NOT NULL) cv_owned,
      (SELECT COUNT(*) FROM library_files lf WHERE lf.series_id=s.id AND lf.valid=1 AND lf.has_metadata=0) untagged,
      -- corrupt = invalid files with NO valid copy of the same issue (a good .cbz
      -- superseding an old bad .cbr means that issue is not corrupt).
      (SELECT COUNT(*) FROM library_files bad WHERE bad.series_id=s.id AND bad.valid=0
        AND NOT EXISTS (SELECT 1 FROM library_files g WHERE g.series_id=s.id AND g.valid=1
          AND g.cv_issue_id IS NOT NULL AND g.cv_issue_id=bad.cv_issue_id)) corrupt,
      (SELECT COUNT(*) FROM library_files lf WHERE lf.series_id=s.id AND lf.valid=1) file_count,
      (SELECT lf.dir FROM library_files lf WHERE lf.series_id=s.id AND lf.valid=1 GROUP BY lf.dir ORDER BY COUNT(*) DESC LIMIT 1) file_dir,
      -- list-view extras: newest known issue date, in-flight downloads, disk footprint
      (SELECT MAX(ci.cover_date) FROM cv_issues ci WHERE ci.cv_series_id=s.cv_id) cv_latest,
      (SELECT COUNT(*) FROM issues i WHERE i.series_id=s.id
        AND i.status IN ('queued','downloading','grabbed','tagging')) active,
      (SELECT COALESCE(SUM(lf.size),0) FROM library_files lf WHERE lf.series_id=s.id AND lf.valid=1) size_bytes
    FROM series s
    LEFT JOIN cv_series cv ON cv.comicvine_id=s.cv_id
    WHERE (s.followed=1 OR EXISTS(SELECT 1 FROM library_files lf WHERE lf.series_id=s.id AND lf.valid=1)
           OR EXISTS(SELECT 1 FROM user_follows uf WHERE uf.series_id=s.id AND uf.user_id=@uid))
      ${includeRestricted ? '' : 'AND s.restricted = 0'}
      ${library != null ? 'AND s.library_id = @lib' : ''}
      ${search ? 'AND (s.title LIKE @q OR cv.name LIKE @q OR cv.publisher LIKE @q)' : ''}
    ${orderBy}`).all({ uid: userId ?? -1, ...(library != null ? { lib: library } : {}), ...(search ? { q: `%${search}%` } : {}) });
  // ComicVine is the data source. A matched comic shows CV name/publisher/year/
  // cover and rolls up against CV's issues. An unmatched comic surfaces NO source
  // metadata — just a neutral "needs a ComicVine match" state (sources are download-only).
  return rows.map((r) => {
    const sourced = !String(r.url).startsWith('cv:');
    if (!r.cv_id) {
      return {
        id: r.id, followed: r.my_follow ? 1 : 0, monitored: r.followed, cv_id: null, cv_locked: 0, sourced, matched: false, source: 'unmatched',
        title: null, publisher: null, year: null, cover_url: null, restricted: !!r.restricted, type: r.type || 'comic',
        folder: dirBaseName(r.file_dir), files: r.file_count,
        total: 0, owned: 0, missing: 0, untagged: r.untagged, corrupt: r.corrupt,
        latest: null, active: r.active, size: r.size_bytes,
      };
    }
    const total = r.cv_total;
    const owned = Math.min(r.cv_owned, r.cv_total);
    return {
      id: r.id, followed: r.my_follow ? 1 : 0, monitored: r.followed, cv_id: r.cv_id, cv_locked: r.cv_locked, sourced, matched: true, source: 'cv',
      title: r.cv_name || r.title, publisher: r.cv_publisher || null, year: r.cv_year || null, cover_url: r.cv_image || null,
      cv_name: r.cv_name, cv_year: r.cv_year, restricted: !!r.restricted, type: r.type || 'comic',
      total, owned, missing: Math.max(0, total - owned), untagged: r.untagged, corrupt: r.corrupt,
      latest: r.cv_latest, active: r.active, size: r.size_bytes,
    };
  })
    .filter((r) => filter === 'incomplete' ? r.missing > 0
      : filter === 'followed' ? !!r.followed
      : filter === 'unmonitored' ? !r.monitored
      : filter === 'problems' ? (r.untagged > 0 || r.corrupt > 0)
      : filter === 'unmatched' ? !r.cv_id
      // Library-type lanes. The comics lane means "not any other known type",
      // so unknown/legacy values count as comics and are never silently hidden.
      : filter === 'comics' ? !SERIES_TYPES.includes(r.type) || r.type === 'comic'
      // Any whitelisted type (built-in or plugin-registered) is its own lane.
      : SERIES_TYPES.includes(filter) ? r.type === filter
      : true);
}

export function seriesCollectionDetail(db, id, userId = null) {
  const series = getSeriesById(db, id);
  if (!series) return null;
  const files = db.prepare('SELECT * FROM library_files WHERE series_id=? ORDER BY name').all(id);
  const asFile = (f) => ({ path: f.path, name: f.name, valid: f.valid, has_metadata: f.has_metadata, error: f.error, size: f.size, page_count: f.page_count });
  // Per-issue copies omit the full path — the UI only shows name/size/health,
  // and on a 2,000-issue series the (JSON-escaped) paths dominated the payload.
  const asIssueFile = (f) => ({ name: f.name, valid: f.valid, has_metadata: f.has_metadata, error: f.error, size: f.size, page_count: f.page_count });
  // Invalid files already superseded by a valid copy of the same CV issue —
  // safe-to-remove duplicates (see removeSupersededFiles).
  const validCvIds = new Set(files.filter((f) => f.valid && f.cv_issue_id != null).map((f) => f.cv_issue_id));
  const superseded = files.filter((f) => !f.valid && f.cv_issue_id != null && validCvIds.has(f.cv_issue_id)).length;
  const cvRow = series.cv_id ? getCvSeries(db, series.cv_id) : null;
  const cvIssues = cvRow ? listCvIssues(db, series.cv_id) : [];
  const sourced = !String(series.url).startsWith('cv:'); // has a real catalog download source
  // ComicVine is the display source when matched; the catalog title/publisher/cover are fallbacks.
  const seriesOut = {
    id: series.id,
    title: (cvRow && cvRow.name) || series.title,
    publisher: (cvRow && cvRow.publisher) || series.publisher,
    year: (cvRow && cvRow.start_year) || series.year,
    cover_url: (cvRow && cvRow.image_url) || series.cover_url,
    followed: userId != null
      ? (db.prepare('SELECT 1 FROM user_follows WHERE user_id=? AND series_id=?').get(userId, id) ? 1 : 0)
      : 0,
    monitored: series.followed,
    cv_id: series.cv_id, cv_locked: series.cv_locked, sourced, path: series.path,
    restricted: !!series.restricted,
    type: series.type || 'comic',
    library_id: series.library_id ?? null,
    aliases: series.aliases || '',                 // user-added search names (editable)
    cv_aliases: parseAliases(cvRow && cvRow.aliases), // ComicVine's aliases (read-only hint)
  };
  const parseJson = (v) => { try { return v ? JSON.parse(v) : null; } catch { return null; } };
  const cvOut = cvRow ? {
    comicvine_id: cvRow.comicvine_id, name: cvRow.name, publisher: cvRow.publisher,
    start_year: cvRow.start_year, count_of_issues: cvRow.count_of_issues,
    image_url: cvRow.image_url, site_detail_url: cvRow.site_detail_url, issue_count: cvIssues.length,
    description: cvRow.description || null,
    deck: cvRow.deck || null,
    // Metron enrichment (present only when cvEnrich has populated them).
    metron_rating: cvRow.metron_rating || null,
    metron_status: cvRow.metron_status || null,
    metron_year_end: cvRow.metron_year_end || null,
    metron_series_type: cvRow.metron_series_type || null,
    metron_imprint: cvRow.metron_imprint || null,
    metron_genres: parseJson(cvRow.metron_genres),
    user_fields: parseJson(cvRow.user_fields) || [],
  } : null;

  if (cvRow) {
    // ComicVine-authoritative: canonical issue list, each mapped back to a
    // catalog issue (by number) so downloads still have something to fetch.
    const bcByNum = new Map();
    for (const bi of db.prepare('SELECT id, issue_number, status FROM issues WHERE series_id=?').all(id)) {
      const k = normalizeNumber(bi.issue_number);
      if (k && !bcByNum.has(k)) bcByNum.set(k, bi);
    }
    const filesByCv = new Map();
    for (const f of files) {
      if (f.cv_issue_id == null) continue;
      if (!filesByCv.has(f.cv_issue_id)) filesByCv.set(f.cv_issue_id, []);
      filesByCv.get(f.cv_issue_id).push(f);
    }
    const issues = cvIssues.map((ci) => {
      const fs = filesByCv.get(ci.comicvine_id) || [];
      const bc = bcByNum.get(normalizeNumber(ci.issue_number)); // an in-flight/queued row, if any
      const valid = fs.filter((f) => f.valid);
      const owned = valid.length > 0;
      const corrupt = fs.length > 0 && !owned;                 // file(s) on disk but none readable
      const untagged = owned && valid.every((f) => !f.has_metadata); // owned but no ComicInfo
      return {
        id: bc ? bc.id : null,             // download-queue row id (null until queued)
        cv_issue_id: ci.comicvine_id,      // what we queue by — sources resolve on demand
        number: ci.issue_number,
        title: ci.name || ('#' + (ci.issue_number ?? '?')),
        image_url: ci.image_url,           // cover art for the issue grid
        cover_date: ci.cover_date,         // list-view date column
        has_detail: !!ci.has_detail,       // full CV detail cached (drives the sweep-watch poll)
        owned,
        corrupt,
        untagged,
        status: bc ? bc.status : 'pending',
        downloadable: !owned,              // any un-owned issue can be grabbed; a source is found at download time
        files: fs.map(asIssueFile),
      };
    });
    return {
      series: seriesOut, cv: cvOut, source: 'cv', sourced, issues, superseded,
      unlinkedFiles: files.filter((f) => f.cv_issue_id == null && f.issue_id == null).map(asFile),
    };
  }

  // Not matched to ComicVine — no issue data (sources are download-only). Present a
  // neutral state: the folder + the files on disk, and a prompt to match.
  return {
    series: {
      id: series.id, title: null, publisher: null, year: null, cover_url: null,
      followed: userId != null
        ? (db.prepare('SELECT 1 FROM user_follows WHERE user_id=? AND series_id=?').get(userId, id) ? 1 : 0)
        : 0,
      monitored: series.followed,
      cv_id: null, cv_locked: 0, sourced, path: series.path,
      type: series.type || 'comic',
      library_id: series.library_id ?? null,
      folder: dirBaseName(files[0]?.dir),
    },
    cv: null, source: 'unmatched', sourced, matched: false,
    issues: [],
    files: files.map(asFile),
    unlinkedFiles: files.map(asFile),
  };
}

/* ---------- ComicVine identity ---------- */

/** Column names the user has hand-edited on a row (JSON in user_fields). */
function userLockedFields(row) {
  try { return new Set(JSON.parse(row?.user_fields || '[]')); } catch { return new Set(); }
}

export function upsertCvSeries(db, v) {
  // Respect the metadata editor: any hand-edited column keeps its current
  // value through refreshes/matches — the incoming payload only fills the rest.
  const prev = db.prepare('SELECT * FROM cv_series WHERE comicvine_id=?').get(v.id);
  const locked = userLockedFields(prev);
  if (locked.size) {
    v = { ...v };
    for (const f of ['name', 'publisher', 'start_year', 'count_of_issues', 'description', 'deck', 'image_url', 'site_detail_url', 'aliases']) {
      if (locked.has(f)) v[f] = prev[f];
    }
  }
  db.prepare(
    `INSERT INTO cv_series (comicvine_id, name, publisher, start_year, count_of_issues, description, deck, image_url, site_detail_url, aliases, cached_at)
     VALUES (@id, @name, @publisher, @start_year, @count_of_issues, @description, @deck, @image_url, @site_detail_url, @aliases, datetime('now'))
     ON CONFLICT(comicvine_id) DO UPDATE SET
       name=excluded.name, publisher=excluded.publisher, start_year=excluded.start_year,
       count_of_issues=excluded.count_of_issues, description=excluded.description,
       deck=COALESCE(excluded.deck, cv_series.deck),
       image_url=excluded.image_url, site_detail_url=COALESCE(excluded.site_detail_url, cv_series.site_detail_url),
       aliases=COALESCE(excluded.aliases, cv_series.aliases), cached_at=excluded.cached_at`
  ).run({
    id: v.id, name: v.name ?? null, publisher: v.publisher ?? null,
    start_year: v.start_year != null ? String(v.start_year) : null,
    count_of_issues: v.count_of_issues ?? null, description: v.description ?? null, deck: v.deck ?? null,
    image_url: v.image_url ?? null, site_detail_url: v.site_detail_url ?? null,
    aliases: v.aliases ?? null,
  });
  // Enrichment came back with the payload (key present = the endpoint
  // answered; null = checked, not on Metron). Absent key = leave whatever we
  // had — an un-enriched refresh must never erase enrichment.
  if (v.metron !== undefined) applyMetronEnrichment(db, v.id, v.metron);
  return v.id;
}

/** Metron ratings that flag a series as mature. */
const MATURE_RATINGS = new Set(['Mature', 'Explicit', 'Adult']);

/** Store a volume's Metron enrichment and auto-flag newly-mature series.
 *  The flag fires only on the NULL→mature TRANSITION of the stored rating, so
 *  a manual unflag sticks: later refreshes see mature→mature (no transition)
 *  and leave the user's decision alone. Returns the flagged series id, if any. */
export function applyMetronEnrichment(db, comicvineId, metron) {
  const prev = db.prepare('SELECT metron_rating, user_fields FROM cv_series WHERE comicvine_id=?').get(comicvineId);
  const locked = userLockedFields(prev);
  const rating = metron?.rating ?? null;
  const incoming = {
    metron_rating: rating,
    metron_status: metron?.status ?? null,
    metron_year_end: metron?.year_end != null ? String(metron.year_end) : null,
    metron_series_type: metron?.series_type ?? null,
    metron_imprint: metron?.imprint ?? null,
    metron_genres: Array.isArray(metron?.genres) && metron.genres.length ? JSON.stringify(metron.genres) : null,
    metron_sort_name: metron?.sort_name ?? null,
    metron_gcd_id: metron?.gcd_id != null ? String(metron.gcd_id) : null,
  };
  const cols = Object.keys(incoming).filter((c) => !locked.has(c));
  if (cols.length) {
    db.prepare(`UPDATE cv_series SET ${cols.map((c) => `${c}=?`).join(', ')} WHERE comicvine_id=?`)
      .run(...cols.map((c) => incoming[c]), comicvineId);
  }
  const wasMature = MATURE_RATINGS.has(prev?.metron_rating || '');
  // A hand-edited rating owns the flag decision — endpoint data can't re-trigger.
  if (!locked.has('metron_rating') && !wasMature && MATURE_RATINGS.has(rating || '')) {
    const flagged = db.prepare(
      'UPDATE series SET restricted=1 WHERE cv_id=? AND restricted=0'
    ).run(comicvineId).changes;
    if (flagged) {
      return db.prepare('SELECT id FROM series WHERE cv_id=?').get(comicvineId)?.id ?? null;
    }
  }
  return null;
}

export function getCvSeries(db, comicvineId) {
  return db.prepare('SELECT * FROM cv_series WHERE comicvine_id=?').get(comicvineId);
}

// Insert an issue stub from the volume list. Preserves any detail already fetched.
export function upsertCvIssue(db, i) {
  // Hand-edited name/number survive stub refreshes (metadata editor locks).
  const prev = db.prepare('SELECT issue_number, name, user_fields FROM cv_issues WHERE comicvine_id=?').get(i.id);
  const locked = userLockedFields(prev);
  db.prepare(
    `INSERT INTO cv_issues (comicvine_id, cv_series_id, issue_number, name, cover_date, store_date, has_detail, cached_at)
     VALUES (@id, @cv_series_id, @issue_number, @name, @cover_date, @store_date, @has_detail, datetime('now'))
     ON CONFLICT(comicvine_id) DO UPDATE SET
       cv_series_id=excluded.cv_series_id, issue_number=excluded.issue_number, name=excluded.name,
       cover_date=COALESCE(cv_issues.cover_date, excluded.cover_date),
       store_date=COALESCE(cv_issues.store_date, excluded.store_date)`
  ).run({
    id: i.id, cv_series_id: i.cv_series_id,
    issue_number: locked.has('issue_number') ? prev.issue_number : (i.issue_number ?? i.number ?? null),
    name: locked.has('name') ? prev.name : (i.name ?? null),
    cover_date: i.cover_date ?? null, store_date: i.store_date ?? null,
    has_detail: i.has_detail ? 1 : 0,
  });
  return i.id;
}

export function setCvIssueDetail(db, comicvineId, {
  cover_date = null, store_date = null, description = null, credits = null,
  site_detail_url = null, image_url = null,
  character_credits = null, team_credits = null, location_credits = null,
  story_arc_credits = null, associated_images = null,
  metron,
} = {}) {
  const asJson = (v) => (v == null ? null : typeof v === 'string' ? v : JSON.stringify(v));
  const prev = db.prepare('SELECT * FROM cv_issues WHERE comicvine_id=?').get(comicvineId);
  const locked = userLockedFields(prev);
  const base = {
    cover_date, store_date, description,
    credits: credits ? JSON.stringify(credits) : null,
    site_detail_url, image_url,
    character_credits: asJson(character_credits), team_credits: asJson(team_credits),
    location_credits: asJson(location_credits), story_arc_credits: asJson(story_arc_credits),
    associated_images: asJson(associated_images),
  };
  // Hand-edited columns keep their values through detail refreshes.
  const baseCols = Object.keys(base).filter((c) => !locked.has(c));
  const n = db.prepare(
    `UPDATE cv_issues SET ${baseCols.map((c) => `${c}=?`).join(', ')},
     has_detail=1, cached_at=datetime('now') WHERE comicvine_id=?`
  ).run(...baseCols.map((c) => base[c]), comicvineId).changes;
  // Enrichment answered (object = data, null = checked miss). Absent key =
  // enrichment off/unsupported — leave whatever a prior fetch stored.
  if (metron !== undefined) {
    const mbase = {
      metron_price: metron?.price ?? null,
      metron_upc: metron?.upc || null,
      metron_story_titles: metron?.story_titles?.length ? JSON.stringify(metron.story_titles) : null,
      metron_reprints: metron?.reprints?.length ? JSON.stringify(metron.reprints) : null,
      metron_isbn: metron?.isbn || null,
      metron_sku: metron?.sku || null,
      metron_foc_date: metron?.foc_date ?? null,
      metron_variants: metron?.variants?.length ? JSON.stringify(metron.variants) : null,
      metron_cover_hash: metron?.cover_hash ?? null,
      metron_rating: metron?.rating ?? null,
    };
    const mcols = Object.keys(mbase).filter((c) => !locked.has(c));
    db.prepare(
      `UPDATE cv_issues SET ${mcols.map((c) => `${c}=?`).join(', ')},
       metron_checked=datetime('now') WHERE comicvine_id=?`
    ).run(...mcols.map((c) => mbase[c]), comicvineId);
  }
  return n;
}

// ---- Metadata editor -----------------------------------------------------
// User edits write straight to the display columns AND record the field names
// in user_fields — every sync path above skips locked columns, so edits
// survive refresh/match/enrichment until reset.

const SERIES_EDITABLE = new Set(['name', 'publisher', 'start_year', 'description', 'deck', 'image_url', 'aliases',
  'metron_rating', 'metron_status', 'metron_year_end', 'metron_series_type', 'metron_imprint', 'metron_genres']);
const ISSUE_EDITABLE = new Set(['name', 'issue_number', 'cover_date', 'store_date', 'description',
  'metron_price', 'metron_upc', 'metron_isbn', 'metron_rating', 'metron_story_titles']);

function applyUserEdit(db, table, idCol, id, patch, allowed) {
  const row = db.prepare(`SELECT user_fields FROM ${table} WHERE ${idCol}=?`).get(id);
  if (!row) return { error: 'not found' };
  const locked = userLockedFields(row);
  const cols = [];
  const vals = [];
  for (const [k, raw] of Object.entries(patch || {})) {
    if (!allowed.has(k)) continue;
    const v = Array.isArray(raw) ? (raw.length ? JSON.stringify(raw) : null)
      : raw === '' || raw == null ? null : String(raw);
    cols.push(k); vals.push(v); locked.add(k);
  }
  if (!cols.length) return { error: 'no editable fields in patch' };
  db.prepare(
    `UPDATE ${table} SET ${cols.map((c) => `${c}=?`).join(', ')}, user_fields=? WHERE ${idCol}=?`
  ).run(...vals, JSON.stringify([...locked]), id);
  return { updated: cols };
}

export function updateCvSeriesUser(db, comicvineId, patch) {
  return applyUserEdit(db, 'cv_series', 'comicvine_id', comicvineId, patch, SERIES_EDITABLE);
}
export function updateCvIssueUser(db, cvIssueId, patch) {
  return applyUserEdit(db, 'cv_issues', 'comicvine_id', cvIssueId, patch, ISSUE_EDITABLE);
}
/** Drop all locks — the next refresh restores source values. */
export function resetCvSeriesUser(db, comicvineId) {
  return db.prepare('UPDATE cv_series SET user_fields=NULL WHERE comicvine_id=?').run(comicvineId).changes;
}
export function resetCvIssueUser(db, cvIssueId) {
  return db.prepare('UPDATE cv_issues SET user_fields=NULL WHERE comicvine_id=?').run(cvIssueId).changes;
}

export function getCvIssue(db, comicvineId) {
  return db.prepare('SELECT * FROM cv_issues WHERE comicvine_id=?').get(comicvineId);
}

export function listCvIssues(db, cvSeriesId) {
  return db.prepare('SELECT * FROM cv_issues WHERE cv_series_id=? ORDER BY CAST(issue_number AS REAL), issue_number').all(cvSeriesId);
}

export function linkFileCvIssue(db, path, cvIssueId) {
  return db.prepare('UPDATE library_files SET cv_issue_id=? WHERE path=?').run(cvIssueId ?? null, path).changes;
}

export function getSeriesByCvId(db, cvId) {
  return db.prepare('SELECT * FROM series WHERE cv_id=?').get(cvId);
}

// Set (or clear, with null) a comic's explicit folder on disk.
export function setSeriesPath(db, id, folder) {
  const v = folder && String(folder).trim() ? String(folder).trim() : null;
  return db.prepare('UPDATE series SET path=? WHERE id=?').run(v, id).changes;
}

// Split a newline/comma-separated aliases string into a clean list.
export function parseAliases(s) {
  return String(s || '').split(/[\n,]/).map((a) => a.trim()).filter(Boolean);
}

// Set a comic's user alternative names (newline-separated; empty clears).
export function setSeriesAliases(db, id, aliases) {
  const list = Array.isArray(aliases) ? aliases : parseAliases(aliases);
  const v = list.length ? list.join('\n') : null;
  db.prepare('UPDATE series SET aliases=? WHERE id=?').run(v, id);
  return list;
}

// All names to search a download source under: the display title first, then
// ComicVine's aliases, then the user's — deduped (case-insensitively).
export function seriesSearchNames(db, seriesId) {
  const s = db.prepare('SELECT title, cv_id, aliases FROM series WHERE id=?').get(seriesId);
  if (!s) return [];
  const cv = s.cv_id ? db.prepare('SELECT name, aliases FROM cv_series WHERE comicvine_id=?').get(s.cv_id) : null;
  const names = [cv?.name || s.title, ...parseAliases(cv?.aliases), ...parseAliases(s.aliases)];
  const seen = new Set(), out = [];
  for (const n of names) { const k = n.toLowerCase(); if (n && !seen.has(k)) { seen.add(k); out.push(n); } }
  return out;
}

// Create a ComicVine-originated series. Uses a synthetic
// url so the NOT NULL/UNIQUE url column is satisfied without schema surgery.
export function createCvSeries(db, { cvId, title, publisher = null, year = null, coverUrl = null }) {
  const url = 'cv:' + cvId;
  const existing = db.prepare('SELECT id FROM series WHERE url=?').get(url);
  if (existing) {
    db.prepare('UPDATE series SET followed=1, cv_id=?, cv_locked=1 WHERE id=?').run(cvId, existing.id);
    return existing.id;
  }
  const info = db.prepare(
    'INSERT INTO series (title, url, publisher, year, cover_url, cv_id, cv_locked, followed) VALUES (?,?,?,?,?,?,1,1)'
  ).run(title, url, publisher, year, coverUrl, cvId);
  return info.lastInsertRowid;
}

// Create (or reuse) a synthetic issue row on a ComicVine series so a CV issue can
// be queued for download without any catalog series. url `cvissue:<cvIssueId>`
// keeps the NOT NULL/UNIQUE url column happy; sources resolve the actual file.
export function ensureCvIssueRow(db, { seriesId, cvIssueId, number = null, title = null }) {
  const url = 'cvissue:' + cvIssueId;
  const existing = db.prepare('SELECT id FROM issues WHERE url=?').get(url);
  if (existing) return existing.id;
  return db.prepare('INSERT INTO issues (series_id, title, issue_number, url) VALUES (?,?,?,?)')
    .run(seriesId, title || ('#' + (number ?? '?')), number != null ? String(number) : null, url).lastInsertRowid;
}

// ---- Persistent application log ---------------------------------------
export function insertLog(db, { ts, level, category = null, message }) {
  return db.prepare('INSERT INTO logs (ts, level, category, message) VALUES (?,?,?,?)').run(ts, level, category, String(message)).lastInsertRowid;
}
export function listLogsDb(db, { level = 'all', category = 'all', limit = 300 } = {}) {
  const lim = Math.max(1, Math.min(1000, limit));
  const where = [], params = [];
  if (level !== 'all') { where.push('level=?'); params.push(level); }
  if (category !== 'all') { where.push('category=?'); params.push(category); }
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  return db.prepare(`SELECT ts, level, category, message FROM logs ${clause} ORDER BY id DESC LIMIT ?`).all(...params, lim);
}
export function logCategoriesDb(db) {
  return db.prepare("SELECT DISTINCT category FROM logs WHERE category IS NOT NULL AND category<>'' ORDER BY category").all().map((r) => r.category);
}
export function clearLogsDb(db) { return db.prepare('DELETE FROM logs').run().changes; }
export function logCountsDb(db) {
  const c = { error: 0, warn: 0, info: 0 };
  for (const r of db.prepare('SELECT level, COUNT(*) n FROM logs GROUP BY level').all()) c[r.level] = r.n;
  return c;
}
export function pruneLogs(db, keep = 3000) {
  return db.prepare('DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT ?)').run(keep).changes;
}

// ---- Library import candidates ----------------------------------------
export function clearImportCandidates(db, { keepImported = true } = {}) {
  return db.prepare(keepImported ? "DELETE FROM import_candidates WHERE status<>'imported'" : 'DELETE FROM import_candidates').run().changes;
}
export function upsertImportCandidate(db, c) {
  return db.prepare(`INSERT INTO import_candidates
    (folder,name,year,publisher,file_count,cv_id,cv_name,cv_year,cv_image,confidence,status,series_type,library_id,scanned_at)
    VALUES (@folder,@name,@year,@publisher,@file_count,@cv_id,@cv_name,@cv_year,@cv_image,@confidence,@status,@series_type,@library_id,datetime('now'))
    ON CONFLICT(folder) DO UPDATE SET name=excluded.name,year=excluded.year,publisher=excluded.publisher,
      file_count=excluded.file_count,cv_id=excluded.cv_id,cv_name=excluded.cv_name,cv_year=excluded.cv_year,
      cv_image=excluded.cv_image,confidence=excluded.confidence,status=excluded.status,series_type=excluded.series_type,library_id=excluded.library_id,scanned_at=datetime('now')`)
    .run({ name: null, year: null, publisher: null, file_count: 0, cv_id: null, cv_name: null, cv_year: null, cv_image: null, confidence: 'none', status: 'review', series_type: null, library_id: null, ...c });
}
export function listImportCandidates(db) {
  return db.prepare(`SELECT * FROM import_candidates ORDER BY
    CASE status WHEN 'review' THEN 0 WHEN 'ready' THEN 1 WHEN 'skipped' THEN 2 ELSE 3 END,
    CASE confidence WHEN 'none' THEN 0 WHEN 'low' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, name`).all();
}
export function getImportCandidate(db, id) {
  return db.prepare('SELECT * FROM import_candidates WHERE id=?').get(id);
}
export function setImportCandidateMatch(db, id, { cvId, cvName = null, cvYear = null, cvImage = null, confidence = 'manual', status = 'ready' } = {}) {
  return db.prepare('UPDATE import_candidates SET cv_id=?, cv_name=?, cv_year=?, cv_image=?, confidence=?, status=? WHERE id=?')
    .run(cvId ?? null, cvName, cvYear, cvImage, confidence, status, id).changes;
}
export function setImportCandidateStatus(db, id, status) {
  return db.prepare('UPDATE import_candidates SET status=? WHERE id=?').run(status, id).changes;
}
export function readyImportCandidates(db) {
  return db.prepare("SELECT * FROM import_candidates WHERE status='ready' ORDER BY id").all();
}

export function setSeriesCv(db, seriesId, cvId, { locked = 0 } = {}) {
  return db.prepare('UPDATE series SET cv_id=?, cv_locked=? WHERE id=?').run(cvId, locked ? 1 : 0, seriesId).changes;
}

export function clearSeriesCv(db, seriesId) {
  return db.prepare('UPDATE series SET cv_id=NULL, cv_locked=0 WHERE id=?').run(seriesId).changes;
}

// Owned (has a valid file) or followed series that still need a CV match.
// A locked match (manually chosen) is never re-matched automatically.
export function seriesNeedingCvMatch(db, { includeMatched = false } = {}) {
  return db.prepare(`
    SELECT s.* FROM series s
    WHERE (s.followed=1 OR EXISTS(SELECT 1 FROM library_files lf WHERE lf.series_id=s.id AND lf.valid=1))
      AND s.cv_locked=0
      ${includeMatched ? '' : 'AND s.cv_id IS NULL'}
    ORDER BY s.title`).all();
}

// Stop tracking a comic: drop its file index and remove it from the collection.
// A CV-only row (no catalog source) is deleted outright; an adopted catalog
// row is kept but unfollowed/unlinked so it leaves the collection.
// Does NOT touch files on disk. Returns the file paths that were indexed.
export function untrackSeries(db, id) {
  const series = getSeriesById(db, id);
  if (!series) return { removed: false, files: [] };
  const files = db.prepare('SELECT path FROM library_files WHERE series_id=?').all(id).map((r) => r.path);
  db.prepare('DELETE FROM library_files WHERE series_id=?').run(id);
  if (String(series.url).startsWith('cv:')) {
    db.prepare('DELETE FROM issues WHERE series_id=?').run(id);
    db.prepare('DELETE FROM series WHERE id=?').run(id);
  } else {
    db.prepare('UPDATE series SET followed=0, cv_id=NULL, cv_locked=0, path=NULL WHERE id=?').run(id);
  }
  return { removed: true, files };
}

export function resetDownloading(db) {
  db.prepare("UPDATE issues SET status='pending' WHERE status='downloading'").run();
}

// Update series metadata parsed from the series page, without clobbering
// existing values when a field is absent (COALESCE keeps the current value).
export function setSeriesMeta(db, id, { year = null, publisher = null } = {}) {
  db.prepare('UPDATE series SET year = COALESCE(?, year), publisher = COALESCE(?, publisher) WHERE id = ?')
    .run(year, publisher, id);
}

export function setSeriesComplete(db, id, complete = 1) {
  db.prepare('UPDATE series SET complete=? WHERE id=?').run(complete ? 1 : 0, id);
}

// GLOBAL monitor flag (column named 'followed' for compatibility): drives the
// download automation lanes and plugin queries.
export function setFollowed(db, id, followed) {
  db.prepare('UPDATE series SET followed=? WHERE id=?').run(followed ? 1 : 0, id);
}

// PERSONAL follow: this user's pull list. No effect on automation.
export function setUserFollow(db, userId, seriesId, follow) {
  if (follow) db.prepare('INSERT OR IGNORE INTO user_follows (user_id, series_id) VALUES (?, ?)').run(userId, seriesId);
  else db.prepare('DELETE FROM user_follows WHERE user_id=? AND series_id=?').run(userId, seriesId);
}

export function listFollowed(db) {
  return db.prepare('SELECT * FROM series WHERE followed=1 ORDER BY title').all();
}

// Re-queue every failed issue (clearing its error). Returns how many.
export function requeueFailed(db, id = null) {
  // All failed issues, or just one (the queue row's per-item Retry).
  if (id != null) return db.prepare("UPDATE issues SET status='queued', error=NULL WHERE status='failed' AND id=?").run(id).changes;
  return db.prepare("UPDATE issues SET status='queued', error=NULL WHERE status='failed'").run().changes;
}

// Forget failed downloads: reset them to 'pending' (available) and drop the error.
export function clearFailed(db) {
  return db.prepare("UPDATE issues SET status='pending', error=NULL WHERE status='failed'").run().changes;
}

// Active queue: downloading first, then tagging, then queued, then failed (capped).
export function listQueue(db, limit = 200) {
  return db.prepare(
    `SELECT i.id, i.title, i.status, i.error, i.series_id, COALESCE(cv.name, s.title) AS series_title,
       (SELECT g.id FROM grabs g WHERE g.issue_id = i.id AND g.status='active' ORDER BY g.id DESC LIMIT 1) AS grab_id
     FROM issues i JOIN series s ON s.id = i.series_id
     LEFT JOIN cv_series cv ON cv.comicvine_id = s.cv_id
     WHERE i.status IN ('queued','downloading','grabbed','tagging','failed')
     ORDER BY CASE i.status WHEN 'downloading' THEN 0 WHEN 'grabbed' THEN 1 WHEN 'tagging' THEN 2 WHEN 'queued' THEN 3 ELSE 4 END, i.id
     LIMIT ?`
  ).all(limit);
}

export function countQueue(db) {
  return db.prepare("SELECT COUNT(*) n FROM issues WHERE status IN ('queued','downloading','grabbed')").get().n;
}

export function queuedCount(db) {
  return db.prepare("SELECT COUNT(*) n FROM issues WHERE status IN ('queued','downloading','grabbed','tagging')").get().n;
}

// Remove still-queued issues from the queue (back to pending). Returns how many.
export function cancelQueued(db) {
  return db.prepare("UPDATE issues SET status='pending' WHERE status='queued'").run().changes;
}

export function cancelIssue(db, id) {
  return db.prepare("UPDATE issues SET status='pending' WHERE id=? AND status='queued'").run(id).changes;
}

// Reset the given issues for re-download (even if 'done'): return their current
// file paths (so the caller can delete the old files), then clear status to
// 'pending' and forget the file path so the download writes the correct name.
export function clearIssuesForRedownload(db, ids) {
  if (!ids || !ids.length) return [];
  const ph = ids.map(() => '?').join(',');
  const paths = db.prepare(`SELECT file_path FROM issues WHERE id IN (${ph})`)
    .all(...ids).map((r) => r.file_path).filter(Boolean);
  db.prepare(`UPDATE issues SET status='pending', file_path=NULL, error=NULL WHERE id IN (${ph})`).run(...ids);
  return paths;
}


