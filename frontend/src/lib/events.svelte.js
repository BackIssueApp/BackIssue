// Client side of /api/events (SSE). The server pushes which domains changed;
// subscribers re-fetch just those. While the stream is down (server restart,
// old server, proxy trouble) every subscription falls back to slow polling —
// the UI keeps working either way.
import { selectionActive } from './poll.js';

export const live = $state({ connected: false });

const listeners = new Map(); // domain key -> Set<fn>
const pendingRetry = new Set();

let es = null;
let reconnectTimer = null;
export function startEvents() {
  if (es || typeof EventSource === 'undefined') return;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  es = new EventSource('/api/events');
  es.addEventListener('hello', () => { live.connected = true; });
  es.addEventListener('changed', (e) => {
    let keys;
    try { keys = JSON.parse(e.data); } catch { return; }
    for (const k of keys) fire(k);
  });
  // Flag disconnects so fallback polls take over. A transient drop leaves the
  // browser in CONNECTING and it auto-reconnects — the server's next `hello`
  // clears the flag. But a fatal error (a non-2xx during a server restart or
  // proxy blip) puts it in CLOSED, where the browser will NEVER retry on its
  // own — so the "reconnecting…" badge would stick forever. Detect that and
  // recreate the stream ourselves on a short backoff.
  es.onerror = () => {
    live.connected = false;
    if (es && es.readyState === EventSource.CLOSED) {
      try { es.close(); } catch { /* already dead */ }
      es = null;
      if (!reconnectTimer) {
        reconnectTimer = setTimeout(() => { reconnectTimer = null; startEvents(); }, 3000);
      }
    }
  };
}

function fire(key) {
  const set = listeners.get(key);
  if (!set || !set.size) return;
  // Don't re-render over a text selection the user is copying — retry shortly.
  if (selectionActive()) {
    if (pendingRetry.has(key)) return;
    pendingRetry.add(key);
    const retry = () => {
      if (selectionActive()) { setTimeout(retry, 500); return; }
      pendingRetry.delete(key);
      for (const fn of listeners.get(key) || []) fn();
    };
    setTimeout(retry, 500);
    return;
  }
  for (const fn of set) fn();
}

// Run `fn` whenever the server reports `key` changed; while disconnected,
// poll it every `fallbackMs` instead. Returns an unsubscribe function.
export function subscribe(key, fn, fallbackMs = 0) {
  let set = listeners.get(key);
  if (!set) listeners.set(key, (set = new Set()));
  set.add(fn);
  const t = fallbackMs
    ? setInterval(() => { if (!live.connected && !selectionActive()) fn(); }, fallbackMs)
    : null;
  return () => { set.delete(fn); if (t) clearInterval(t); };
}
