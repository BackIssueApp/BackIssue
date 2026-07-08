// Non-blocking notifications (never window.alert — it freezes the page and
// stalls every poll). type: 'info' | 'ok' | 'error'. Errors stay longer, and
// hovering (or touching) a toast pauses its timer so long error strings can
// actually be read.
export const toasts = $state([]);
let nextId = 1;

export function notify(msg, type = 'info') {
  const t = { id: nextId++, msg, type, out: false, _timer: null };
  toasts.push(t);
  startTimer(t, type === 'error' ? 8000 : 4500);
}

function startTimer(t, ms) {
  t._timer = setTimeout(() => dismiss(t.id), ms);
}

/** Pause/resume a toast's auto-dismiss (pointer over it = user is reading). */
export function holdToast(id, hold) {
  const t = toasts.find((x) => x.id === id);
  if (!t || t.out) return;
  if (hold) { clearTimeout(t._timer); t._timer = null; }
  else if (!t._timer) startTimer(t, 2500); // resume with a short grace period
}

export function dismiss(id) {
  const t = toasts.find((x) => x.id === id);
  if (!t || t.out) return;
  clearTimeout(t._timer);
  t.out = true;
  setTimeout(() => {
    const i = toasts.findIndex((x) => x.id === id);
    if (i >= 0) toasts.splice(i, 1);
  }, 300);
}
