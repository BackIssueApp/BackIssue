// Is the user currently selecting/has selected text on the page? Used to hold off
// background polls: pages that re-render on a 1–2s poll would clear a selection
// the user is trying to copy.
export function selectionActive() {
  const sel = window.getSelection();
  return !!sel && !sel.isCollapsed && sel.toString().length > 0;
}

// setInterval for UI polls that re-render — skips a tick while the user has text
// selected so a refresh can't wipe their copy. Resumes automatically once the
// selection is cleared. Returns the timer id so callers can clearInterval it.
export function pollInterval(fn, ms) {
  return setInterval(() => { if (!selectionActive()) fn(); }, ms);
}

// THE background-progress poller: hit `url` on an interval, call onRunning each
// tick while the job reports running, then onDone once and stop. One timer per
// url (restarting a poll replaces the old one). Every "poll shared state until a
// job finishes" flow goes through this — don't hand-roll another setInterval.
const progressTimers = {};
export function pollProgress(url, { ms = 700, onRunning, onDone } = {}) {
  clearInterval(progressTimers[url]);
  progressTimers[url] = setInterval(async () => {
    let st;
    try { st = await (await fetch(url)).json(); } catch { return; }
    if (st.running) { if (onRunning) onRunning(st); }
    else { clearInterval(progressTimers[url]); if (onDone) onDone(st); }
  }, ms);
}
