// Minimal 5-field cron: "minute hour day-of-month month day-of-week".
// Supports *, numbers, ranges (a-b), steps (*/n, a-b/n), and lists (a,b,c).
// day-of-week: 0-7 where both 0 and 7 are Sunday. Standard (vixie) semantics for
// the dom/dow pair: when BOTH are restricted, a time matches if EITHER matches.
// Numeric fields only (no name aliases) — patterns come from the settings UI.

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day of week', min: 0, max: 7 },
];

function parseField(spec, { name, min, max }) {
  const out = new Set();
  for (const part of String(spec).split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part.trim());
    if (!m) throw new Error(`bad ${name} "${part}"`);
    const step = m[2] ? Number(m[2]) : 1;
    if (step < 1) throw new Error(`bad ${name} step "${part}"`);
    let lo = min, hi = max;
    if (m[1] !== '*') {
      const [a, b] = m[1].split('-').map(Number);
      lo = a; hi = b == null ? (m[2] ? max : a) : b; // "a/n" = a..max/n; bare "a" = just a
      if (lo < min || hi > max || lo > hi) throw new Error(`${name} out of range "${part}"`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

// Parse a cron expression → matcher sets (throws with a human message on error).
export function parseCron(expr) {
  const parts = String(expr || '').trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('expected 5 fields: minute hour day month weekday');
  const [minute, hour, dom, month, dow] = parts.map((p, i) => parseField(p, FIELDS[i]));
  if (dow.has(7)) dow.add(0); // 7 = Sunday too
  return {
    minute, hour, dom, month, dow,
    domAny: parts[2] === '*', dowAny: parts[4] === '*',
  };
}

// null when valid, else a human-readable reason.
export function validateCron(expr) {
  try { parseCron(expr); return null; } catch (e) { return String(e.message || e); }
}

// Does this local time match the pattern?
export function cronMatches(parsed, date) {
  const d = date instanceof Date ? date : new Date(date);
  if (!parsed.minute.has(d.getMinutes()) || !parsed.hour.has(d.getHours()) || !parsed.month.has(d.getMonth() + 1)) return false;
  const domOk = parsed.dom.has(d.getDate());
  const dowOk = parsed.dow.has(d.getDay());
  // vixie rule: both restricted → OR; otherwise the restricted one gates.
  if (!parsed.domAny && !parsed.dowAny) return domOk || dowOk;
  return (parsed.domAny || domOk) && (parsed.dowAny || dowOk);
}

// The first minute-aligned time STRICTLY AFTER `afterMs` that matches, or null
// within the horizon (400 days covers every valid pattern incl. "Feb 29-ish"
// gaps; anything rarer is a typo we'd rather surface as never-due).
export function nextCronTime(expr, afterMs) {
  const parsed = typeof expr === 'string' ? parseCron(expr) : expr;
  const d = new Date(afterMs);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const horizon = afterMs + 400 * 24 * 3600 * 1000;
  while (d.getTime() <= horizon) {
    if (cronMatches(parsed, d)) return d.getTime();
    // Skip ahead cheaply: wrong month → jump to the 1st of next month.
    if (!parsed.month.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1); d.setHours(0, 0, 0, 0);
      continue;
    }
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

// Migrate a legacy every-N-hours cadence to a cron pattern (best effort).
export function hoursToCron(h) {
  h = Number(h) || 0;
  if (h <= 0) return '';
  if (h < 24) return `0 */${h} * * *`;
  const days = Math.round(h / 24);
  if (days >= 7) return '0 8 * * 1';          // ~weekly → Mondays 8am
  if (days === 1) return '0 8 * * *';         // daily 8am
  return `0 8 */${days} * *`;                 // every N days at 8am
}
