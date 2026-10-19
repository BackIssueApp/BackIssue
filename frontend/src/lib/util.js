import { currentLang, t } from './i18n.js';

export const fmt = (n) => (n ?? 0).toLocaleString(currentLang());

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

// Variable-height sibling of windowRange. The featuring results interleave
// group headings, issue rows and whole blocks (a number grid, a grid of
// covers), so there is no single stride to divide by — each unit carries its
// own height instead. The heights are exact, not estimates (the blocks' column
// counts are computed rather than left to auto-fill), so the pads always sum
// to the real column height and the scrollbar never lies.
export function offsetWindow(heights, { viewH, scrollTop, overscan = 4 }) {
  const n = heights.length;
  if (!n) return { start: 0, end: 0, padTop: 0, padBottom: 0 };
  const off = new Array(n + 1);
  off[0] = 0;
  for (let i = 0; i < n; i++) off[i + 1] = off[i] + Math.max(0, heights[i]);
  const total = off[n];
  const top = Math.min(Math.max(0, scrollTop), Math.max(0, total - 1));
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (off[mid + 1] <= top) lo = mid + 1; else hi = mid;
  }
  const start = Math.max(0, lo - overscan);
  const limit = top + viewH;
  let end = start;
  while (end < n && off[end] < limit) end++;
  end = Math.min(n, end + overscan);
  return { start, end, padTop: off[start], padBottom: total - off[end] };
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
  if (ms <= 0) return t('common.dueNow');
  const m = Math.round(ms / 60000);
  if (m < 60) return t('common.inTime', { time: m + 'm' });
  const h = Math.floor(m / 60);
  return t('common.inTime', { time: h + 'h' + (m % 60 ? ' ' + (m % 60) + 'm' : '') });
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

// Sanitizer for description HTML (from the metadata service, or edited by a
// library manager). An allowlist: formatting tags keep a few inert
// attributes; any other element is unwrapped to its text, and elements whose
// content is code or a separate document are dropped whole. A blocklist kept
// missing things (form action, formaction, SVG animate, base href).
const KEEP_TAGS = new Set(['P', 'BR', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'SMALL', 'SUB', 'SUP', 'SPAN', 'DIV',
  'A', 'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'HR', 'IMG', 'FIGURE', 'FIGCAPTION',
  'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TH', 'TD', 'CAPTION', 'DL', 'DT', 'DD', 'CITE', 'Q', 'CODE', 'PRE']);
const DROP_TAGS = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'FRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'BASE',
  'SVG', 'MATH', 'TEMPLATE', 'NOSCRIPT', 'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT', 'AUDIO', 'VIDEO', 'TITLE']);
const KEEP_ATTRS = { A: ['href', 'title'], IMG: ['src', 'alt', 'title', 'width', 'height'], TD: ['colspan', 'rowspan'], TH: ['colspan', 'rowspan'] };
export function sanitizeHtml(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = String(html || '');
  // Deepest first, so unwrapping a parent never revisits moved children.
  for (const el of [...tpl.content.querySelectorAll('*')].reverse()) {
    const tag = el.tagName.toUpperCase();
    if (DROP_TAGS.has(tag)) { el.remove(); continue; }
    if (!KEEP_TAGS.has(tag)) { el.replaceWith(...el.childNodes); continue; }
    const allowed = KEEP_ATTRS[tag] || [];
    for (const a of [...el.attributes]) {
      if (!allowed.includes(a.name.toLowerCase())) el.removeAttribute(a.name);
      // href/src must resolve to an allowed scheme (control-char-safe check).
      else if ((a.name === 'href' || a.name === 'src') && !safeUrl(a.value)) el.removeAttribute(a.name);
    }
  }
  return tpl.innerHTML;
}

// A pasted ComicVine volume reference: a CV URL (…/4050-72763/), a tagged id
// ("cv:72763"), or a bare id.
export function parseCvVolumeRef(q) {
  const url = String(q).match(/4050-(\d+)/);
  if (url) return Number(url[1]);
  const tagged = String(q).trim().match(/^cv:\s*(\d+)$/i);
  if (tagged) return Number(tagged[1]);
  const bare = String(q).trim().match(/^(\d{2,})$/);
  return bare ? Number(bare[1]) : null;
}

// Is the reference unambiguous (URL or cv: tag — not bare digits that could be
// a title like "2000 AD")? Unambiguous refs skip the name search entirely.
export function isExactCvRef(q) {
  return /4050-\d+/.test(String(q)) || /^cv:\s*\d+$/i.test(String(q).trim());
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

/** A day (ISO "2026-09-09" or a Date) as the reader's short local date:
 *  "Sep 9", with the year only when it isn't this year. Unparseable input
 *  comes back as given. */
export function fmtDay(value) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(String(value).slice(0, 10) + 'T00:00:00');
  if (isNaN(d)) return String(value);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

/** Last-request-wins guard for async loaders. Make one per loader; call it
 *  before the await and check the returned function after:
 *    const seq = latestGuard();            // module/component level
 *    const isLatest = seq();               // each call
 *    const r = await apiGet(…); if (!isLatest()) return;
 *  A slower, older response is then dropped instead of overwriting a newer one. */
export function latestGuard() {
  let n = 0;
  return () => { const mine = ++n; return () => mine === n; };
}

/** Columns and row stride of a rendered grid/list, from its item elements
 *  (columns = items sharing the first one's top; stride = the gap to the
 *  next row). null until two items exist; stride null when it reads as 0. */
export function measureGrid(items) {
  if (!items || items.length < 2) return null;
  const top0 = items[0].offsetTop;
  let c = 1;
  while (c < items.length && items[c].offsetTop === top0) c++;
  const next = items[c] || items[1];
  const d = next.offsetTop - top0;
  return { cols: Math.max(1, c), stride: d > 10 ? d : null };
}

/** HTML for `text` with every case-insensitive match of `q` wrapped in
 *  <mark class={cls}>. Splits the raw text and escapes each piece, so a search
 *  for "amp" never lands inside an escaped entity. */
export function highlightHtml(text, q, cls = '') {
  const raw = String(text ?? '');
  if (!q) return escapeHtml(raw);
  const rx = new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig');
  const open = cls ? `<mark class="${escapeHtml(cls)}">` : '<mark>';
  let out = '', last = 0, m;
  while ((m = rx.exec(raw))) {
    if (!m[0].length) { rx.lastIndex++; continue; }
    out += escapeHtml(raw.slice(last, m.index)) + open + escapeHtml(m[0]) + '</mark>';
    last = m.index + m[0].length;
  }
  return out + escapeHtml(raw.slice(last));
}
