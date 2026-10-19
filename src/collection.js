import path from 'node:path';
import { seriesTitleCandidates, listIssues } from './db.js';
import { scoreMatch, extractYear, normalizeTitle } from './matcher.js';
import { matchCatalogSeries, issueKey, parseIssueFromFilename } from './scanner.js';

const RANK = { high: 3, medium: 2, low: 1, none: 0 };

function matchSeriesByMeta(db, name, year, memo) {
  const word = normalizeTitle(name).split(' ')[0];
  if (!word) return null;
  let best = null;
  for (const c of candidatesFor(db, word, memo)) {
    const { confidence } = scoreMatch({ name, year }, c.title);
    if (!best || RANK[confidence] > RANK[best.confidence]) best = { seriesId: c.id, confidence };
  }
  return best && RANK[best.confidence] >= RANK.low ? best.seriesId : null;
}

// Title candidates for one search word, cached in `memo` (one scan's worth of
// lookups) — a folder of 200 files asks the same question 200 times.
function candidatesFor(db, word, memo) {
  if (!memo) return seriesTitleCandidates(db, word);
  const k = `w:${word}`;
  if (!memo.has(k)) memo.set(k, seriesTitleCandidates(db, word));
  return memo.get(k);
}

// The series a file belongs to, by its ComicInfo series, else its folder name.
function resolveSeries(db, f, memo) {
  const k = `s:${f.ci_series || ''}|${f.ci_volume || ''}|${f.dir || ''}`;
  if (memo?.has(k)) return memo.get(k);
  let seriesId = null;
  if (f.ci_series) {
    const yr = extractYear(f.ci_volume || '') || (f.ci_volume || null);
    seriesId = matchSeriesByMeta(db, f.ci_series, yr, memo);
  }
  if (!seriesId) {
    const folder = path.basename(f.dir || '');
    seriesId = matchCatalogSeries(db, folder, extractYear(folder), memo)?.seriesId ?? null;
  }
  memo?.set(k, seriesId);
  return seriesId;
}

// The issue of `seriesId` a file is, by number (edition-aware).
export function issueForFile(db, seriesId, f, memo = null) {
  const num = (f.ci_number != null && String(f.ci_number) !== '') ? String(f.ci_number) : parseIssueFromFilename(f.name);
  if (num == null || num === '') return null;
  const k = `i:${seriesId}`;
  let issues = memo?.get(k);
  if (!issues) { issues = listIssues(db, { seriesId }); memo?.set(k, issues); }
  const wantKey = issueKey(String(f.name).replace(/\.(cbz|cbr|pdf)$/i, ''), num);
  for (const i of issues) {
    if (issueKey(i.title, i.issue_number) === wantKey) return i.id;
  }
  return null;
}

// Link a library file to a catalog series (+ specific issue). A tagged file
// matches by its ComicInfo series; else fall back to the folder name. Then the issue is matched by number (edition-aware).
// `memo` (optional Map) caches lookups across the files of one scan.
export function linkFile(db, f, memo = null) {
  const seriesId = resolveSeries(db, f, memo);
  if (!seriesId) return { seriesId: null, issueId: null };
  return { seriesId, issueId: issueForFile(db, seriesId, f, memo) };
}
