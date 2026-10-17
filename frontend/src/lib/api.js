// Thin fetch wrappers — every API call in the app goes through these.
// A 401 anywhere means the session died (expired, revoked, logged out in
// another tab): notify the auth store so the login gate appears. Lazy import
// avoids a circular dependency (auth.svelte.js uses these wrappers).
//
// Every non-JSON or non-OK response normalizes to { error } — call sites
// already check r.error, so 5xx / proxy HTML / crashed-server responses light
// up the existing error paths instead of throwing parse errors that dozens of
// `catch { /* keep last */ }` blocks silently swallow.
import { t, translateServerMessage } from './i18n.js';

async function handle(res) {
  if (res.status === 401) {
    import('./auth.svelte.js').then((m) => m.sessionLost()).catch(() => {});
  }
  let data = null;
  try { data = await res.json(); }
  catch { return { error: res.ok ? t('errors.badResponse') : t('errors.serverError', { status: res.status }) }; }
  if (!res.ok && data && typeof data === 'object' && !Array.isArray(data) && !data.error) {
    data.error = t('errors.serverError', { status: res.status });
  }
  // Server messages are English; show the reader's language when we know the text.
  if (data && typeof data === 'object' && typeof data.error === 'string') data.error = translateServerMessage(data.error);
  return data;
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
