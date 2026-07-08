// Library organization: admin-configurable folder + file naming patterns.
//
// Two patterns, each a string of literal text plus {tokens}:
//   folder pattern → the series directory under a root (may contain "/" for
//     sub-folders, e.g. "{publisher}/{series} ({year})")
//   file   pattern → the issue filename stem (no extension)
//
// Tokens: {publisher} {series} {year} {issue} {issueTitle} {date} {edition}.
// {issue} zero-pads numeric numbers to 3 by default; {issue:2} sets the width.
// A token that resolves to nothing is dropped and a cleanup pass tidies the
// spacing/punctuation it left behind — so the defaults below reproduce the old
// hardcoded "Publisher/Title (Year)" + "Series VYYYY #NNN (Month YYYY)" layout.
import { detectEdition } from './editions.js';

// Make one substituted value safe as a path segment (strip chars illegal on
// Windows/SMB — including "/" so a value can't create sub-folders or traverse).
// Kept local so paths.js can import this module without a cycle.
function safeSegment(s) {
  return String(s || '').replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export const DEFAULT_FOLDER_PATTERN = '{publisher}/{series} ({year})';
// No {date} by default — it matches the historical on-disk output, and keeps
// downloads (no cover date at filing time) consistent with re-filing (which
// does have it) so the reorganizer doesn't churn freshly-downloaded files.
export const DEFAULT_FILE_PATTERN = '{series} V{year} {edition} #{issue}';

// The tokens each pattern may use (for the settings UI reference + validation).
export const FOLDER_TOKENS = ['publisher', 'series', 'year'];
export const FILE_TOKENS = ['publisher', 'series', 'year', 'issue', 'issueTitle', 'date', 'edition'];

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const year4 = (y) => { const m = String(y ?? '').match(/\d{4}/); return m ? m[0] : ''; };
// A cover date "2011-09-01" (or "2011-09") → "September 2011".
function monthYear(date) {
  const m = String(date ?? '').match(/^(\d{4})-(\d{2})/);
  return m ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : '';
}
// Series title with any trailing "(...)" removed, so {series} ({year}) doesn't
// double up a year already baked into the title.
const cleanSeriesTitle = (t) => String(t ?? '').replace(/\s*\([^)]*\)\s*$/, '').trim();
// A year embedded in the title's "(YYYY)" / "(YYYY-…)" marker (fallback when
// the series has no explicit start year).
const titleYear = (t) => { const m = String(t ?? '').match(/\((\d{4})[^)]*\)/); return m ? m[1] : ''; };

/** Token values for a series (folder-level tokens). */
export function seriesTokens(series) {
  return {
    publisher: series.publisher || '',
    series: cleanSeriesTitle(series.title),
    year: year4(series.year) || titleYear(series.title),
  };
}

/** Token values for one issue of a series (file-level tokens). Edition-aware:
 *  a detected edition (Annual/TPB/…) fills {edition} and drives {issue}. */
export function issueTokens(series, issue) {
  const ed = issue && issue.title ? detectEdition(issue.title) : null;
  const num = ed ? (ed.num != null ? ed.num : '') : (issue && issue.issue_number != null ? issue.issue_number : '');
  return {
    ...seriesTokens(series),
    issue: num,
    issueTitle: (issue && issue.title) || '',
    edition: ed ? ed.type : '',
    date: monthYear(issue && (issue.cover_date || issue.date)),
  };
}

// Tidy one path segment after substitution: drop empty ()/[], a dangling "V" or
// "#" left by an empty year/issue, collapse spaces, and trim stray separators.
function cleanSegment(s) {
  return String(s)
    .replace(/\(\s*\)/g, '').replace(/\[\s*\]/g, '')
    .replace(/(^|\s)[Vv](?=\s|$)/g, '$1')  // "V " with no year after
    .replace(/#(?=\s|$)/g, '')             // "#" with no issue after
    .replace(/\s*([)\]])/g, '$1').replace(/([([])\s*/g, '$1')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—._]+|[\s\-–—._]+$/g, '')
    .trim();
}

/** Render a pattern with the given token values. "/" splits into sub-folders;
 *  each token value is sanitized so it can never introduce a path separator. */
export function renderPattern(pattern, tokens, { padIssue = 3 } = {}) {
  const filled = String(pattern || '').replace(/\{(\w+)(?::(\d+))?\}/g, (_m, token, width) => {
    let v = tokens[token];
    v = v == null ? '' : String(v);
    if (token === 'issue' && /^\d+$/.test(v)) v = v.padStart(width ? Number(width) : padIssue, '0');
    return safeSegment(v);
  });
  return filled.split('/').map(cleanSegment).filter(Boolean).join('/');
}

/** The series folder (relative to a root) from a folder pattern. */
export function seriesFolderFromPattern(series, pattern) {
  return renderPattern(pattern || DEFAULT_FOLDER_PATTERN, seriesTokens(series)) || cleanSegment(cleanSeriesTitle(series.title));
}

/** The issue filename stem (no extension) from a file pattern. */
export function fileStemFromPattern(series, issue, pattern) {
  return renderPattern(pattern || DEFAULT_FILE_PATTERN, issueTokens(series, issue));
}
