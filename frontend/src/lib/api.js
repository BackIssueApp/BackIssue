// Thin fetch wrappers — every API call in the app goes through these.
// A 401 anywhere means the session died (expired, revoked, logged out in
// another tab): the auth store registers a listener (onSessionLost) so the
// login gate appears. A callback rather than an import keeps auth.svelte.js
// (which uses these wrappers) out of a circular dependency.
//
// Every non-JSON or non-OK response normalizes to { error }, marked as a
// failed request (isFailure). apiGet/apiPost RESOLVE that object: call sites
// check r.error. Loaders that keep the last good state on failure use
// apiGetOk instead, which throws, so their `catch { keep last }` blocks see
// a 502 the same way they see a dropped connection.
import { t, translateServerMessage } from './i18n.js';

let sessionLostHandler = null;
/** Register the 401 handler (the auth store does, once). */
export function onSessionLost(fn) { sessionLostHandler = fn; }

const FAILED = Symbol('apiFailed');
const failure = (error, status) => {
  const r = { error };
  // Non-enumerable, so spreading a response never copies the mark.
  Object.defineProperty(r, FAILED, { value: status || true });
  return r;
};

async function handle(res) {
  if (res.status === 401 && sessionLostHandler) {
    try { sessionLostHandler(); } catch { /* never let the gate break the call */ }
  }
  let data = null;
  try { data = await res.json(); }
  catch { return failure(res.ok ? t('errors.badResponse') : t('errors.serverError', { status: res.status }), res.status); }
  if (!res.ok) {
    const msg = data && typeof data === 'object' && !Array.isArray(data) && typeof data.error === 'string'
      ? translateServerMessage(data.error) : t('errors.serverError', { status: res.status });
    return Object.assign(failure(msg, res.status), data && typeof data === 'object' && !Array.isArray(data) ? { ...data, error: msg } : {});
  }
  // Server messages are English; show the reader's language when we know the text.
  if (data && typeof data === 'object' && typeof data.error === 'string') data.error = translateServerMessage(data.error);
  return data;
}

/** True for a request that failed: a non-OK or unreadable response, or a
 *  body that is nothing but { error }. A payload that merely carries an
 *  error field among others (a finished job's state, say) is not one. */
export function isFailure(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return false;
  if (r[FAILED]) return true;
  const keys = Object.keys(r);
  return keys.length === 1 && keys[0] === 'error';
}

/** The error a request failed with, thrown by apiGetOk. */
export class ApiError extends Error {
  constructor(message, status) { super(message); this.name = 'ApiError'; this.status = status || 0; }
}

/** GET that throws (ApiError, or the network error) instead of resolving a
 *  failure, for loaders that must keep their last good state. */
export async function apiGetOk(path) {
  const r = await apiGet(path);
  if (isFailure(r)) throw new ApiError(r.error, typeof r[FAILED] === 'number' ? r[FAILED] : 0);
  return r;
}

/** The text to show for anything a request threw or resolved as a failure. */
export function errorText(e) {
  if (e && typeof e === 'object' && typeof e.error === 'string') return e.error;
  if (e instanceof ApiError) return e.message;
  return t('common.notReachable');
}

export async function apiGet(path) {
  return handle(await fetch(path));
}

export async function apiPost(path, body) {
  return handle(await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
}

/** POST a raw text body (an uploaded XML file, say) rather than JSON. */
export async function apiPostText(path, text, contentType = 'text/plain') {
  return handle(await fetch(path, { method: 'POST', headers: { 'content-type': contentType }, body: text }));
}

export async function apiPatch(path, body) {
  return handle(await fetch(path, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }));
}

export async function apiDelete(path) {
  return handle(await fetch(path, { method: 'DELETE' }));
}
