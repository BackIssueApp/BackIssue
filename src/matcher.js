export function extractYear(s) {
  const m = String(s).match(/(?:19|20)\d{2}/);
  return m ? m[0] : null;
}

export function normalizeTitle(s) {
  return String(s)
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')                 // drop (year) etc.
    .replace(/\b(?:vol|volume)\.?\s*\d+/g, ' ') // drop volume markers
    .replace(/[^a-z0-9]+/g, ' ')              // punctuation -> space
    .replace(/^\s*the\s+/, '')                // leading "the"
    .replace(/\s+/g, ' ')
    .trim();
}

export function scoreMatch(wanted, candidateTitle) {
  const wn = normalizeTitle(wanted.name);
  const cn = normalizeTitle(candidateTitle);
  if (!wn || !cn) return { confidence: 'none', reason: 'empty' };
  if (wn === cn) {
    const cy = extractYear(candidateTitle);
    if (wanted.year && cy && String(wanted.year) === String(cy)) return { confidence: 'high', reason: 'name+year' };
    if (!cy || !wanted.year) return { confidence: 'medium', reason: 'name, year unknown' };
    return { confidence: 'medium', reason: 'name, year differs' };
  }
  if (wn.length > 3 && (cn.includes(wn) || wn.includes(cn))) return { confidence: 'low', reason: 'partial name' };
  return { confidence: 'none', reason: 'no name match' };
}

const FRACTIONS = { '½': 0.5, '¼': 0.25, '¾': 0.75, '⅓': 1 / 3, '⅔': 2 / 3 };

export function normalizeNumber(n) {
  const s = String(n ?? '').trim().replace(/^#/, '');
  if (s in FRACTIONS) return String(FRACTIONS[s]);        // ½ -> "0.5"
  const frac = s.match(/^(\d+)\s*\/\s*(\d+)$/);           // 1/2 -> "0.5"
  if (frac) { const v = Number(frac[1]) / Number(frac[2]); if (Number.isFinite(v)) return String(v); }
  if (/^\d*\.\d+$/.test(s) || /^\d+(?:\.\d+)?$/.test(s)) { // 004 -> "4", .5 -> "0.5", 000.5 -> "0.5", 1.1 -> "1.1"
    const f = parseFloat(s);
    if (Number.isFinite(f)) return String(f);
  }
  return s.toLowerCase();
}

export function matchIssueNumber(issues, wantedNumber) {
  const target = normalizeNumber(wantedNumber);
  for (const i of issues) {
    if (normalizeNumber(i.issue_number) === target) return i;
  }
  return null;
}

// The issue number embedded in a chapter/issue title: "#N", a trailing number,
// or the "1/2" half-issue shorthand. Returns the number string or null.
export function issueNumberFromTitle(title) {
  const t = String(title);
  // Half issues are written "1/2" (e.g. "Earth X Issue #1/2"). Catch it before
  // the integer match, which would otherwise read just "1".
  if (/#\s*1\/2(?!\d)/.test(t)) return '½';
  let m = t.match(/#\s*(\d+(?:\.\d+)?)/);
  if (m) return m[1];
  m = t.match(/(\d+(?:\.\d+)?)\s*$/);
  if (m) return m[1];
  return null;
}
