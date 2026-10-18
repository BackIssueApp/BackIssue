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

