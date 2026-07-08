// Session state + auth actions. The app boots by asking /api/auth/me:
//   openMode  — no accounts exist yet; the app runs unauthenticated (classic
//               single-user appliance) and the sidebar offers to secure it.
//   user      — the signed-in account { id, username, role, permissions }.
// The server resolves the role to a permission list ('*' = everything);
// components use can()/isTrusted/isAdmin to hide affordances the server
// would 403 anyway — the middleware is the real enforcement.
import { apiGet, apiPost } from './api.js';

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
export const isAdmin = () => can('users.manage');

export async function loadMe() {
  try {
    const r = await apiGet('/api/auth/me');
    auth.openMode = !!r.openMode;
    auth.user = r.user || null;
    auth.registration = !!r.registration;
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

// api.js calls this on any 401 — the session expired or was revoked.
export function sessionLost() {
  if (auth.ready && (auth.user || auth.openMode)) {
    auth.user = null;
    auth.openMode = false;
  }
}
