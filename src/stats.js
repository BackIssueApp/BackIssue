// Collection + ComicVine statistics for the Stats page. Pure read-only queries
// over the existing schema — no new tables. "Collection series" means the same
// scope the sidebar uses: a series you follow OR own at least one valid file for.
import { cvKey } from './cv.js';

// A series counts toward the collection if followed or backed by a valid file.
const IN_COLLECTION = `(s.followed=1 OR EXISTS(SELECT 1 FROM library_files lf WHERE lf.series_id=s.id AND lf.valid=1))`;

export function collectionStats(db, config = {}) {
  // ---- Files: totals, health, pages, size ----
  const files = db.prepare(`SELECT
    COUNT(*) total, COALESCE(SUM(size),0) bytes, COALESCE(SUM(page_count),0) pages,
    SUM(CASE WHEN valid=1 THEN 1 ELSE 0 END) valid,
    SUM(CASE WHEN valid=0 THEN 1 ELSE 0 END) corrupt,
    SUM(CASE WHEN valid=1 AND has_metadata=1 THEN 1 ELSE 0 END) tagged,
    SUM(CASE WHEN valid=1 AND has_metadata=0 THEN 1 ELSE 0 END) untagged
    FROM library_files`).get();

  // Format mix (by extension — after Convert/Verify these are honest).
  const fmt = db.prepare(`SELECT
    SUM(CASE WHEN LOWER(name) LIKE '%.cbz' OR LOWER(name) LIKE '%.zip' THEN 1 ELSE 0 END) cbz,
    SUM(CASE WHEN LOWER(name) LIKE '%.cbr' OR LOWER(name) LIKE '%.rar' THEN 1 ELSE 0 END) cbr,
    SUM(CASE WHEN LOWER(name) LIKE '%.pdf' THEN 1 ELSE 0 END) pdf
    FROM library_files WHERE valid=1`).get();
  const formats = { cbz: fmt.cbz || 0, cbr: fmt.cbr || 0, pdf: fmt.pdf || 0 };
  formats.other = Math.max(0, (files.valid || 0) - formats.cbz - formats.cbr - formats.pdf);

  // ---- Series: collection size, matched to CV, followed ----
  const series = db.prepare(`SELECT
    COUNT(*) total,
    SUM(CASE WHEN s.cv_id IS NOT NULL THEN 1 ELSE 0 END) matched,
    SUM(CASE WHEN s.followed=1 THEN 1 ELSE 0 END) followed
    FROM series s WHERE ${IN_COLLECTION}`).get();

  const ownedIssues = db.prepare(
    `SELECT COUNT(DISTINCT cv_issue_id) c FROM library_files WHERE valid=1 AND cv_issue_id IS NOT NULL`,
  ).get().c;

  // ---- By-publisher rollup (matched → CV publisher; else Unmatched/Unknown) ----
  const byPublisher = db.prepare(`SELECT
      COALESCE(cv.publisher, CASE WHEN s.cv_id IS NULL THEN 'Unmatched' ELSE 'Unknown' END) publisher,
      COUNT(DISTINCT s.id) series,
      COUNT(DISTINCT CASE WHEN lf.valid=1 AND lf.cv_issue_id IS NOT NULL THEN lf.cv_issue_id END) issues,
      COUNT(CASE WHEN lf.valid=1 THEN 1 END) files,
      COALESCE(SUM(CASE WHEN lf.valid=1 THEN lf.size ELSE 0 END),0) bytes
    FROM series s
    LEFT JOIN cv_series cv ON cv.comicvine_id=s.cv_id
    LEFT JOIN library_files lf ON lf.series_id=s.id
    WHERE ${IN_COLLECTION}
    GROUP BY 1
    ORDER BY issues DESC, series DESC`).all();

  // ---- Completion & gaps (matched series: CV-owned vs CV-total) ----
  const comp = db.prepare(`SELECT s.id, COALESCE(cv.name, s.title) title,
      (SELECT COUNT(*) FROM cv_issues ci WHERE ci.cv_series_id=s.cv_id) total,
      (SELECT COUNT(DISTINCT lf.cv_issue_id) FROM library_files lf
        WHERE lf.series_id=s.id AND lf.valid=1 AND lf.cv_issue_id IS NOT NULL) owned
    FROM series s LEFT JOIN cv_series cv ON cv.comicvine_id=s.cv_id
    WHERE s.cv_id IS NOT NULL AND ${IN_COLLECTION}`).all();

  let complete = 0, incomplete = 0, missingIssues = 0, cvIssuesTotal = 0;
  const gaps = [];
  for (const r of comp) {
    const total = r.total || 0;
    const owned = Math.min(r.owned || 0, total);
    const missing = Math.max(0, total - owned);
    cvIssuesTotal += total;
    if (total > 0 && owned >= total) complete++;
    else if (total > 0) { incomplete++; if (missing > 0) gaps.push({ id: r.id, title: r.title, owned, total, missing }); }
    missingIssues += missing;
  }
  gaps.sort((a, b) => b.missing - a.missing);
  const topGaps = gaps.slice(0, 12);

  // ---- ComicVine usage: cache depth + linkage + key count ----
  const cv = db.prepare(`SELECT
    (SELECT COUNT(*) FROM cv_series) volumes,
    (SELECT COUNT(*) FROM cv_issues) issues,
    (SELECT COUNT(*) FROM cv_issues WHERE has_detail=1) detailed`).get();
  const linkage = db.prepare(`SELECT
    SUM(CASE WHEN valid=1 AND cv_issue_id IS NOT NULL THEN 1 ELSE 0 END) linked,
    SUM(CASE WHEN valid=1 AND cv_issue_id IS NULL THEN 1 ELSE 0 END) unlinked
    FROM library_files`).get();
  const comicvine = {
    keys: cvKey(config.comicvineKeys) ? 1 : 0,
    volumes: cv.volumes || 0,
    issues: cv.issues || 0,
    detailed: cv.detailed || 0,
    seriesMatched: series.matched || 0,
    seriesUnmatched: (series.total || 0) - (series.matched || 0),
    filesLinked: linkage.linked || 0,
    filesUnlinked: linkage.unlinked || 0,
  };

  // ---- Activity: downloads tracked as grabs (usenet/monitored sources) ----
  const grabTotals = db.prepare(`SELECT
    SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) active,
    SUM(CASE WHEN status='imported' THEN 1 ELSE 0 END) imported,
    SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) failed,
    COUNT(*) total FROM grabs`).get();
  // Imports per day for the last 14 days, zero-filled (UTC axis, matches stored ts).
  const perDay = db.prepare(`WITH RECURSIVE d(day) AS (
      SELECT date('now','-13 days') UNION ALL SELECT date(day,'+1 day') FROM d WHERE day < date('now'))
    SELECT d.day day, COUNT(g.id) n FROM d
      LEFT JOIN grabs g ON g.imported_at IS NOT NULL AND date(g.imported_at)=d.day
    GROUP BY d.day ORDER BY d.day`).all();
  const recent = db.prepare(
    `SELECT title, imported_at FROM grabs WHERE imported_at IS NOT NULL ORDER BY imported_at DESC LIMIT 8`,
  ).all();

  return {
    files: {
      total: files.total || 0, valid: files.valid || 0, corrupt: files.corrupt || 0,
      tagged: files.tagged || 0, untagged: files.untagged || 0,
      bytes: files.bytes || 0, pages: files.pages || 0, formats,
    },
    collection: {
      series: series.total || 0, followed: series.followed || 0,
      ownedIssues, byPublisher,
    },
    completion: { complete, incomplete, missingIssues, cvIssuesTotal, topGaps },
    comicvine,
    activity: {
      grabs: { active: grabTotals.active || 0, imported: grabTotals.imported || 0, failed: grabTotals.failed || 0, total: grabTotals.total || 0 },
      perDay, recent,
    },
  };
}
