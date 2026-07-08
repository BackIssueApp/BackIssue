// Judging the weekly 0-Day pack. Titles look like "0-Day Week of 2026.06.24 by
// Marvel, DC [ENG / CBR CBZ] [VIP]". The SAME week is reposted under different
// title variants (publisher lists, [VIP], (Late)), so we judge by the WEEK DATE in
// the title — never the exact title string.

// Parse the week date out of a pack title → "YYYY-MM-DD" (lexically sortable), or null.
export function zeroDayDate(title) {
  const m = /0-?day week of\s+(\d{4})[.\-/](\d{2})[.\-/](\d{2})/i.exec(String(title || ''));
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

// A real weekly pack is gigabytes; a KB/MB-scale "0-Day Week of …" is a fake.
// Unknown size (many indexers omit it) is not rejected.
const PACK_MIN_BYTES = 50 * 1024 * 1024;

// From Torznab results + the titles of packs we've already grabbed, return the
// newest pack whose week is strictly newer than any we hold — or null (nothing
// found, or nothing newer than what we already grabbed). Robust to title variants.
export function pickZeroDayGrab(results, grabbedTitles = []) {
  const dated = (results || [])
    .filter((r) => !(Number(r.size) > 0 && Number(r.size) < PACK_MIN_BYTES))
    .map((r) => ({ r, date: zeroDayDate(r.title) }))
    .filter((x) => x.date)
    .sort((a, b) => b.date.localeCompare(a.date));
  if (!dated.length) return null;
  const newestGrabbed = (grabbedTitles || []).map(zeroDayDate).filter(Boolean).sort().pop() || '';
  const best = dated[0];
  return best.date > newestGrabbed ? { ...best.r, date: best.date } : null;
}
