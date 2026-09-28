// Library organization: admin-configurable folder + file naming patterns.
//
// Two patterns, each a string of literal text plus {tokens}:
//   folder pattern → the series directory under a root (may contain "/" for
//     sub-folders, e.g. "{publisher}/{series} ({year})")
//   file   pattern → the issue filename stem (no extension)
//
// Tokens: {publisher} {series} {year} {issue} {issueTitle} {date} {edition}.
// {issue} zero-pads numeric numbers to 3 by default; {issue:2} sets the width.
// {date} is the cover date, "November 2011" by default, with a format modifier
// for libraries that want the parts separately: {date:m} 11, {date:y} 2011,
// {date:mon} Nov. So "({date:m}-{date:y})" renders "(11-2011)".
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
const MONTHS_SHORT = MONTHS.map((m) => m.slice(0, 3));

const year4 = (y) => { const m = String(y ?? '').match(/\d{4}/); return m ? m[0] : ''; };

// A cover date "2011-09-01" (or "2011-09") → its parts, or null when absent or
// unparseable. Guards a bogus month ("2011-13") rather than indexing past the
// table and rendering "undefined" into a filename.
function dateParts(date) {
  const m = String(date ?? '').match(/^(\d{4})-(\d{2})/);
  if (!m) return null;
  const idx = Number(m[2]) - 1;
  if (!(idx >= 0 && idx < 12)) return null;
  return { y: m[1], m: m[2], mon: MONTHS_SHORT[idx], month: MONTHS[idx] };
}

/** The {date} formats. The empty key is bare {date} — the historical output,
 *  so an existing pattern renders exactly as it always has. An unrecognised
 *  modifier falls back to it rather than silently emptying the token. */
const DATE_FORMATS = {
  '': (p) => `${p.month} ${p.y}`,   // November 2011
  m: (p) => p.m,                    // 11
  y: (p) => p.y,                    // 2011
  mon: (p) => p.mon,                // Nov
};
export const DATE_MODIFIERS = Object.keys(DATE_FORMATS).filter(Boolean);

function formatDate(raw, mod) {
  const parts = dateParts(raw);
  if (!parts) return '';
  const fmt = DATE_FORMATS[String(mod || '').toLowerCase()] || DATE_FORMATS[''];
  return fmt(parts);
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
    // Raw — renderPattern formats it, so {date} and {date:m} both work off one
    // value instead of needing a token per format.
    date: (issue && (issue.cover_date || issue.date)) || '',
  };
}

// Tidy one path segment after substitution: drop empty ()/[], a dangling "V" or
// "#" left by an empty year/issue, collapse spaces, and trim stray separators.
function cleanSegment(s) {
  return String(s)
    // Empty brackets, including ones left holding only the separators of a
    // dropped token — "({date:m}-{date:y})" with no cover date leaves "(-)".
    .replace(/[([]\s*[-–—_.,;:\s]*[)\]]/g, '')
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
  const filled = String(pattern || '').replace(/\{(\w+)(?::(\w+))?\}/g, (_m, token, mod) => {
    let v = tokens[token];
    v = v == null ? '' : String(v);
    // {issue:N} sets the zero-pad width; {date:fmt} picks a date format.
    if (token === 'issue' && /^\d+$/.test(v)) v = v.padStart(/^\d+$/.test(mod || '') ? Number(mod) : padIssue, '0');
    else if (token === 'date') v = formatDate(v, mod);
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
