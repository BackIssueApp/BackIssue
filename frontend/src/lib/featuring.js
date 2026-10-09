/* Grouping and summarising for the "Credited on" / "Appears in" results — the
   list of every issue in the collection crediting a person or featuring a
   character or team. Pure functions so the shapes can be tested without a DOM;
   the modal only renders them. */

/** A credit role arrives as one name ("Writer") or several joined by commas
 *  (the enriched source records a list per credit), so a chip filter has to
 *  match a token, not the whole string. */
export function roleTokens(role) {
  return String(role || '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** Roles present across the results, busiest first — the chip row. */
export function roleTally(issues) {
  const seen = new Map();
  for (const i of issues || []) {
    for (const r of roleTokens(i.role)) {
      const key = r.toLowerCase();
      const hit = seen.get(key);
      if (hit) hit.count += 1;
      else seen.set(key, { role: r, count: 1 });
    }
  }
  return [...seen.values()].sort((a, b) => b.count - a.count || a.role.localeCompare(b.role));
}

export function filterIssues(issues, { q = '', ownedOnly = false, role = '' } = {}) {
  const needle = q.trim().toLowerCase();
  const want = role.trim().toLowerCase();
  return (issues || []).filter((i) => {
    if (ownedOnly && !i.owned) return false;
    if (want && !roleTokens(i.role).some((r) => r.toLowerCase() === want)) return false;
    if (!needle) return true;
    return `${i.series || ''} ${i.title || ''} #${i.issue_number ?? ''}`.toLowerCase().includes(needle);
  });
}

/** "1984" or "1984–1996" from cover dates; '' when none are dated. */
export function yearSpan(issues) {
  const years = (issues || [])
    .map((i) => Number(String(i.cover_date || '').slice(0, 4)))
    .filter((y) => y > 1000);
  if (!years.length) return '';
  const a = Math.min(...years);
  const b = Math.max(...years);
  return a === b ? String(a) : `${a}–${b}`;
}

// Annuals and half-issues ("½", "Annual 1") sort after the numbered run.
const numOf = (n) => {
  const v = parseFloat(String(n));
  return Number.isFinite(v) ? v : Infinity;
};

/** One group per series — by id where the series is in the library, by name
 *  otherwise (a credit can name a series nothing is tracked for). */
export function groupBySeries(issues, { sort = 'series' } = {}) {
  const map = new Map();
  for (const i of issues || []) {
    const key = i.series_id != null ? `s${i.series_id}` : `n:${i.series || ''}`;
    let g = map.get(key);
    if (!g) {
      g = { key, seriesId: i.series_id ?? null, series: i.series || 'Unknown series', items: [] };
      map.set(key, g);
    }
    g.items.push(i);
  }
  const groups = [...map.values()];
  for (const g of groups) {
    g.items.sort((a, b) => numOf(a.issue_number) - numOf(b.issue_number)
      || String(a.issue_number ?? '').localeCompare(String(b.issue_number ?? '')));
    g.total = g.items.length;
    g.owned = g.items.filter((i) => i.owned).length;
    g.years = yearSpan(g.items);
    g.latest = g.items.reduce((d, i) => (i.cover_date && i.cover_date > d ? i.cover_date : d), '');
  }
  groups.sort(sort === 'recent'
    ? (a, b) => (b.latest || '').localeCompare(a.latest || '') || a.series.localeCompare(b.series)
    : (a, b) => b.total - a.total || a.series.localeCompare(b.series));
  return groups;
}

/** Consecutive issue numbers collapsed into ranges — "#208–250, #400–443" —
 *  so a 130-issue group's coverage reads without expanding it. Numbers that
 *  aren't integers are counted rather than listed. */
export function runsOf(numbers, { cap = 4 } = {}) {
  const ints = (numbers || []).map(Number).filter((n) => Number.isInteger(n)).sort((a, b) => a - b);
  const runs = [];
  let from = null;
  let to = null;
  for (const n of ints) {
    if (from === null) { from = to = n; }
    else if (n === to) continue;
    else if (n === to + 1) { to = n; }
    else { runs.push(from === to ? `${from}` : `${from}–${to}`); from = to = n; }
  }
  if (from !== null) runs.push(from === to ? `${from}` : `${from}–${to}`);
  const odd = (numbers || []).length - ints.length;
  const parts = [];
  if (runs.length) {
    parts.push(runs.slice(0, cap).map((r) => '#' + r).join(', ')
      + (runs.length > cap ? ` +${runs.length - cap} more runs` : ''));
  }
  if (odd) parts.push(`${odd} other`);
  return parts.join(' · ');
}
