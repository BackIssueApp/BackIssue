export const fmt = (n) => (n ?? 0).toLocaleString('en-US');

export const pad3 = (n) => (/^\d+$/.test(String(n)) ? String(n).padStart(3, '0') : String(n ?? ''));

export function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

export function initials(title) {
  const clean = String(title).replace(/\(.*?\)/g, '').trim();
  const words = clean.split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] || '') + (words[1]?.[0] || '')).toUpperCase() || '?';
}

export function humanBytes(n) {
  n = Number(n) || 0;
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n : n.toFixed(n >= 100 ? 0 : 1)) + ' ' + u[i];
}

// Windowed range for a virtualized list/grid. Given the item count, columns
// per row (1 = list), row stride (height incl. gap), viewport height, and how
// far the list is scrolled, return which items to render plus spacer heights
// for the skipped rows above/below. Keeps huge series (2000AD: thousands of
// issues) from mounting thousands of DOM nodes — that froze the browser.
export function windowRange({ n, cols = 1, stride, viewH, scrollTop, listTop = 0, overscan = 6 }) {
  const c = Math.max(1, cols | 0);
  if (!n || !(stride > 0)) return { start: 0, end: n || 0, padTop: 0, padBottom: 0 };
  const totalRows = Math.ceil(n / c);
  // Clamp: when the item set shrinks while scrolled deep (filter/search), the
  // stale scrollTop must not push the window past the end and render nothing.
  const firstRow = Math.min(Math.floor(Math.max(0, scrollTop - listTop) / stride), Math.max(0, totalRows - 1));
  const rowsInView = Math.ceil(viewH / stride);
  const startRow = Math.max(0, firstRow - overscan);
  const endRow = Math.min(totalRows, firstRow + rowsInView + overscan);
  return {
    start: startRow * c,
    end: Math.min(n, endRow * c),
    padTop: startRow * stride,
    padBottom: Math.max(0, (totalRows - endRow) * stride),
  };
}

// Percentage for stats. Never rounds up to a misleading 100% (or down to 0%) —
// only shows 100 when actually complete, and ≥1 while any progress exists.
export const spct = (a, b) => {
  if (b <= 0) return 0;
  if (a >= b) return 100;
  return Math.min(99, Math.max(a > 0 ? 1 : 0, Math.round((a / b) * 100)));
};

export function fmtAgo(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + 's';
  const m = Math.round(s / 60);
  return m < 60 ? m + 'm' : Math.round(m / 60) + 'h';
}

export function fmtIn(ms) {
  if (ms <= 0) return 'due now';
  const m = Math.round(ms / 60000);
  if (m < 60) return 'in ' + m + 'm';
  const h = Math.floor(m / 60);
  return 'in ' + h + 'h' + (m % 60 ? ' ' + (m % 60) + 'm' : '');
}

// Strip HTML tags to plain text (ComicVine deck/description can contain markup).
export function stripTags(html) {
  const t = document.createElement('div');
  t.innerHTML = String(html || '');
  return (t.textContent || '').replace(/\s+/g, ' ').trim();
}

// Allow only benign URL schemes on links/images. Browsers strip embedded
// whitespace/control chars (tab, newline, NUL) from a URL scheme before acting
// on it, so a leading-substring check like /^javascript:/ is bypassable with
// `java\tscript:` — normalize by removing ALL control/space chars up to the
// first ':' before testing. Returns the URL if safe, else '' (drop it).
const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:']);
export function safeUrl(url) {
  const s = String(url ?? '').trim();
  if (!s) return '';
  const colon = s.indexOf(':');
  // No scheme (relative/anchor/fragment) -> safe.
  if (colon === -1) return s;
  // A colon after a /?# is part of a path/query, not a scheme.
  if (/[/?#]/.test(s.slice(0, colon))) return s;
  // Strip whitespace + control chars the browser ignores, then check scheme.
  const scheme = s.slice(0, colon + 1).replace(/[\u0000- ]/g, '').toLowerCase();
  return SAFE_SCHEMES.has(scheme) ? s : '';
}

// Minimal sanitizer for ComicVine's HTML description: strip active content.
export function sanitizeHtml(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = String(html || '');
  tpl.content.querySelectorAll('script,style,iframe,object,embed,link,meta').forEach((el) => el.remove());
  tpl.content.querySelectorAll('*').forEach((el) => {
    for (const a of [...el.attributes]) {
      if (/^on/i.test(a.name)) { el.removeAttribute(a.name); continue; }
      // href/src must resolve to an allowed scheme (control-char-safe check).
      if (/^(href|src|xlink:href)$/i.test(a.name) && !safeUrl(a.value)) el.removeAttribute(a.name);
    }
  });
  return tpl.innerHTML;
}

// A pasted ComicVine volume reference: a CV URL (…/4050-72763/) or a bare id.
export function parseCvVolumeRef(q) {
  const url = String(q).match(/4050-(\d+)/);
  if (url) return Number(url[1]);
  const bare = String(q).trim().match(/^(\d{2,})$/);
  return bare ? Number(bare[1]) : null;
}

// Client-side twin of parseIndexers in src/newznab.js ("name | url | apikey" per
// line) — the browser can't import Node modules, so KEEP THE TWO IN SYNC.
export function parseIndexerString(str) {
  return String(str || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    .map((line) => { const [name, url, apiKey] = line.split('|').map((s) => (s || '').trim()); return { name: name || url, url: (url || '').replace(/\/+$/, ''), apiKey: apiKey || '' }; })
    .filter((i) => i.url);
}

export const serializeIndexers = (list) => list.map((i) => [i.name, i.url, i.apiKey].join(' | ')).join('\n');

// Rank ComicVine volumes by |issue count − on-disk files| — a volume holding
// about as many issues as you have files is very likely the right one. The
// original (CV relevance) order breaks ties. Ranks the FULL set before any
// trimming so a right-but-buried volume still surfaces.
export function rankCvResults(rows, files) {
  if (files == null) return rows;
  return rows
    .map((v, i) => ({ v, i, d: v.count_of_issues != null ? Math.abs(v.count_of_issues - files) : Infinity }))
    .sort((a, b) => a.d - b.d || a.i - b.i)
    .map((x) => x.v);
}

// strftime %U week of year (Sunday-first, 00-53) — client-side twin of
// weekOfYear in src/releases.js (what the release provider expects). The
// browser can't import Node modules, so KEEP THE TWO IN SYNC.
export function weekOfYear(date) {
  const y = date.getUTCFullYear();
  const yday = Math.floor((Date.UTC(y, date.getUTCMonth(), date.getUTCDate()) - Date.UTC(y, 0, 1)) / 86400000);
  const week = Math.floor((yday + 7 - date.getUTCDay()) / 7);
  return { week: String(week).padStart(2, '0'), year: String(y) };
}

// The {week, year} `delta` weeks away from a given %U week. Date-based so year
// boundaries (week 52/53 ↔ 00/01) just work.
export function shiftWeek(week, year, delta) {
  const y = Number(year), w = Number(week);
  const jan1Dow = new Date(Date.UTC(y, 0, 1)).getUTCDay();
  // Day-of-year of the week's first day: week 00 starts Jan 1; week N≥1 starts
  // at the first Sunday + (N-1) weeks.
  const anchorYday = w === 0 ? 0 : (7 - jan1Dow) % 7 + (w - 1) * 7;
  return weekOfYear(new Date(Date.UTC(y, 0, 1 + anchorYday + delta * 7)));
}

// Does an issue's display state pass the issue-list filter chip?
export function issueMatchesFilter(state, filter) {
  if (filter === 'saved') return state === 'done' || state === 'untagged'; // owned, tagged or not
  if (filter === 'missing') return !['done', 'untagged', 'corrupt'].includes(state); // no usable file
  if (filter === 'corrupt') return state === 'corrupt';
  if (filter === 'untagged') return state === 'untagged';
  if (filter === 'failed') return state === 'failed';
  return true;
}
