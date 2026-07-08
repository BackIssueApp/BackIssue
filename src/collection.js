import path from 'node:path';
import { listSeries, listIssues, getScanOverride, getSeriesById } from './db.js';
import { scoreMatch, extractYear, normalizeTitle } from './matcher.js';
import { matchCatalogSeries, issueKey, parseIssueFromFilename } from './scanner.js';

const RANK = { high: 3, medium: 2, low: 1, none: 0 };

function matchSeriesByMeta(db, name, year) {
  const word = normalizeTitle(name).split(' ')[0];
  if (!word) return null;
  let best = null;
  for (const c of listSeries(db, { search: word })) {
    const { confidence } = scoreMatch({ name, year }, c.title);
    if (!best || RANK[confidence] > RANK[best.confidence]) best = { seriesId: c.id, confidence };
  }
  return best && RANK[best.confidence] >= RANK.low ? best.seriesId : null;
}

// Link a library file to a catalog series (+ specific issue). Hybrid: a saved
// override wins; else a tagged file matches by its ComicInfo series; else fall
// back to the folder name. Then the issue is matched by number (edition-aware).
export function linkFile(db, f) {
  let seriesId = null;
  const override = f.dir ? getScanOverride(db, f.dir) : undefined;
  if (override != null && getSeriesById(db, override)) seriesId = override;
  if (!seriesId && f.ci_series) {
    const yr = extractYear(f.ci_volume || '') || (f.ci_volume || null);
    seriesId = matchSeriesByMeta(db, f.ci_series, yr);
  }
  if (!seriesId) {
    const folder = path.basename(f.dir || '');
    seriesId = matchCatalogSeries(db, folder, extractYear(folder))?.seriesId ?? null;
  }
  if (!seriesId) return { seriesId: null, issueId: null };

  const num = (f.ci_number != null && String(f.ci_number) !== '') ? String(f.ci_number) : parseIssueFromFilename(f.name);
  let issueId = null;
  if (num != null && num !== '') {
    const wantKey = issueKey(String(f.name).replace(/\.(cbz|cbr|pdf)$/i, ''), num);
    for (const i of listIssues(db, { seriesId })) {
      if (issueKey(i.title, i.issue_number) === wantKey) { issueId = i.id; break; }
    }
  }
  return { seriesId, issueId };
}
