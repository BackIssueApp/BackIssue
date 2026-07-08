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
