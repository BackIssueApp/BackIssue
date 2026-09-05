// Edition detection for comic titles/filenames — shared by the downloader (for
// naming) and the scanner (for matching). Browser-free: regex only.

// "The Shadow (1987) Annual 1", "… Annual #1", "… Special". Longest first so
// "Holiday Special" wins over "Special".
const BARE_EDITION = /\b(Holiday Special|Annual|TPB|Special)\s*#?\s*(\d+)?\s*$/i;

function normEdition(w) {
  const t = String(w).trim();
  return /^(tpb|ogn)$/i.test(t) ? t.toUpperCase() : t.replace(/\b\w/g, (c) => c.toUpperCase());
}

// Returns { type, num } for an edition (Annual/TPB/Special/Holiday Special...),
// or null for a regular issue.
export function detectEdition(title) {
  const s = String(title ?? '');
  // An underscore edition tag: "_Annual 1", "_TPB 2", "_Special".
  let m = s.match(/_\s*([A-Za-z][A-Za-z ]*?)\s*(\d+)?\s*$/);
  if (m) return { type: m[1].trim(), num: m[2] || null };
  // bare trailing edition keyword (no underscore).
  m = s.match(BARE_EDITION);
  if (m) return { type: normEdition(m[1]), num: m[2] || null };
  return null;
}

// ---- Collected editions (trades, hardcovers, omnibuses) ----
// A collection is rarely posted with an issue-style number ("Series TPB 001"
// is not a thing); releases read "Series TPB", or "Series TPB v02" for a
// later volume. The automatic search must know which kind of run it is
// searching for, or it appends "001" and finds nothing.
const COLLECTED_KIND = /trade|hard ?cover|omnibus|collect|graphic novel|tpb|paperback|compendium/i;
// Edition words that appear in a collection's own name (and in release names).
const COLLECTED_NAME = /\b(TPB|HC|Omnibus|Graphic Novel|OGN|Compendium|Trade Paperback|Hardcover|Deluxe Edition|Collected Edition|Collection)\b/i;

/** Is this series a collected edition? `kind` = the metadata service's series
 *  type when known; otherwise the volume's name(s) decide. */
export function isCollectedSeries({ kind = null, title = '', names = [] } = {}) {
  if (kind && COLLECTED_KIND.test(String(kind))) return true;
  return [title, ...(names || [])].some((n) => COLLECTED_NAME.test(String(n || '')));
}

/** Strip a trailing edition word from a release's series part, so
 *  "Batman Secret Files TPB" matches a volume named "Batman Secret Files". */
export function stripEditionSuffix(series) {
  return String(series || '').replace(/[\s._-]*\b(TPB|HC|Omnibus|Graphic Novel|OGN|Compendium|Trade Paperback|Hardcover|Deluxe Edition|Collected Edition|Collection)\b\s*$/i, '').trim();
}

/** Search queries for one collected-edition issue: the bare name, plus the
 *  scene-style volume marker ("v02") when the number is above 1. */
export function collectedQueries(name, issue, normalize = (n) => String(n ?? '')) {
  const n = normalize(issue?.issue_number);
  const out = [String(name || '').trim()].filter(Boolean);
  if (/^\d+$/.test(n) && Number(n) > 1) out.push(`${name} v${n.padStart(2, '0')}`);
  return out;
}
