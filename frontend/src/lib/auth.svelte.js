// Session state + auth actions. The app boots by asking /api/auth/me:
//   openMode  — no accounts exist yet; the app shows only the create-account
//               screen, and the server refuses the rest of the API until then.
//   user      — the signed-in account { id, username, role, permissions }.
// The server resolves the role to a permission list ('*' = everything);
// components use can()/isTrusted to hide affordances the server
// would 403 anyway — the middleware is the real enforcement.
import { apiGet, apiPost, onSessionLost } from './api.js';
import { currentLang, setLanguage, matchLanguage } from './i18n.svelte.js';

export const auth = $state({
  ready: false,
  openMode: false,
  registration: false, // self-service signups allowed (shown on the login page)
  user: null,
});

export const can = (perm) => {
  if (auth.openMode) return true;
  const perms = auth.user?.permissions || [];
  return perms.includes('*') || perms.includes(perm);
};
// Legacy aliases, mapped onto the permissions the old tiers implied.
export const isTrusted = () => can('library.manage');

export async function loadMe() {
  try {
    const r = await apiGet('/api/auth/me');
    auth.openMode = !!r.openMode;
    auth.user = r.user || null;
    auth.registration = !!r.registration;
    // Signing in without a reload: switch to the account's language now (a
    // fresh page load gets it from the server shell before anything renders).
    const want = matchLanguage(r.user?.lang);
    if (want && want !== currentLang()) await setLanguage(want);
  } catch {
    auth.openMode = false;
    auth.user = null;
  }
  auth.ready = true;
}

export async function login(username, password) {
  const r = await apiPost('/api/auth/login', { username, password });
  if (r.error) throw new Error(r.error);
  await loadMe();
  return r.user;
}

export async function register(username, password) {
  const r = await apiPost('/api/auth/register', { username, password });
  if (r.error) throw new Error(r.error);
  await loadMe();
  return r.user;
}

export async function logout() {
  try { await apiPost('/api/auth/logout'); } catch { /* session may already be dead */ }
  auth.user = null;
  auth.openMode = false;
  // full reload: tears down plugin UI, SSE streams, and polls cleanly
  location.href = '/';
}

// api.js calls this on any 401 — the session expired or was revoked. Before
// the first account exists every API call is refused (setup pending), which
// isn't a lost session: stay on the create-account screen.
export function sessionLost() {
  if (auth.ready && auth.user) auth.user = null;
}
onSessionLost(sessionLost);
