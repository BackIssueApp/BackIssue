// The arc model: a reading list is a run you read through, so what matters
// about it is where you are in it, not what fraction of it you happen to own.
//
// Everything here is pure, so the rules it encodes can be tested directly —
// in particular the one rule that is easy to get subtly wrong: read state
// comes from the reader plugin, and `null` means "we have not been told",
// which is NOT the same as "nothing read". Without the reader these helpers
// report ownership and say so, rather than inventing progress.

/**
 * @param {Array} rows   issues in reading order ({ cv_issue_id, owned })
 * @param {Object|null} states  reader state by issue id, or null = no reader
 */
export function arcModel(rows, states) {
  const hasReader = !!states;
  const stateOf = (r) => (hasReader ? states[r.cv_issue_id] : null) || null;
  const isRead = (r) => !!stateOf(r)?.completed;

  const readCount = hasReader ? rows.filter(isRead).length : 0;
  const inProgressCount = hasReader
    ? rows.filter((r) => { const st = stateOf(r); return !!st && !st.completed && st.page > 0; }).length
    : 0;
  // Where the run has got to: the first issue not yet read, owned or not. It
  // deliberately stops AT a gap — filling past one would claim the arc had
  // been read through a hole in it.
  const positionIndex = hasReader ? rows.findIndex((r) => !isRead(r)) : -1;
  // What Continue opens: the first unread issue you can actually read.
  const nextReadable = hasReader ? rows.find((r) => !isRead(r) && r.owned) || null : null;
  const done = hasReader && rows.length > 0 && readCount >= rows.length;

  /** read | current | missing | upcoming — what a node on the spine shows. */
  const nodeKind = (r, idx) => {
    if (!r.owned) return 'missing';
    if (hasReader && isRead(r)) return 'read';
    if (hasReader && idx === positionIndex) return 'current';
    return 'upcoming';
  };
  /** Is the spine filled up to this row? Past the end when the run is read. */
  const spineDone = (idx) => (positionIndex === -1 ? hasReader : idx < positionIndex);

  return { hasReader, isRead, readCount, inProgressCount, positionIndex, nextReadable, done, nodeKind, spineDone };
}

/**
 * A tick per issue, capped so a 300-issue list stays legible; the read count
 * is scaled onto the capped row so the lit fraction still reads true.
 * @returns {boolean[]} one entry per tick, true = read
 */
export function arcTicks(read, total, cap = 40) {
  if (!total) return [];
  const n = Math.min(total, cap);
  const lit = Math.round((Math.min(read, total) / total) * n);
  return Array.from({ length: n }, (_, i) => i < lit);
}

/** done | reading | new, or null when there is no reader to ask. */
export function arcStatus(pr) {
  if (!pr) return null;
  if (pr.total && pr.read >= pr.total) return 'done';
  if (pr.read > 0 || pr.in_progress > 0) return 'reading';
  return 'new';
}

/**
 * Which arc to offer as "Continue": the one read most recently that still has
 * somewhere to go. An arc you have started but whose timestamp we don't have
 * (issues marked read by hand never stamp one) still counts — it sorts last.
 */
export function pickResume(lists, progress) {
  if (!progress) return null;
  const started = [];
  for (const l of lists) {
    const pr = progress[String(l.id)];
    if (!pr?.next) continue;
    if (!(pr.read > 0 || pr.in_progress > 0)) continue;   // not started = nothing to resume
    started.push({ list: l, pr });
  }
  started.sort((a, b) => String(b.pr.last_read_at || '').localeCompare(String(a.pr.last_read_at || '')));
  return started[0] || null;
}
