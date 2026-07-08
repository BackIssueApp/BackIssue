// History-API router. The URL fully determines the view: /settings, /queue,
// /logs, /volume/:id, and ?filter=&q= for the collection rail. Deep links +
// Back/Forward just work.

export const route = $state({ path: location.pathname, search: location.search });

// Section page routes. They sit ON TOP of the base library/volume view —
// opening one must NOT tear down the comic being viewed, so it's restored
// intact when the page closes (Escape/Back).
export const OVERLAY_PATHS = ['/settings', '/jobs', '/import', '/logs', '/tools', '/stats', '/history', '/wanted', '/queue', '/releases', '/plugins', '/users', '/lists'];

function sync() {
  route.path = location.pathname;
  route.search = location.search;
}

export function navigate(url, { replace = false } = {}) {
  if (replace) history.replaceState({}, '', url);
  else if (url !== location.pathname + location.search) history.pushState({}, '', url);
  sync();
}

export function goBack() { history.back(); }

// Queue/Releases were once ?drawer= overlays — App redirects old links via
// this reader. (openDrawer itself is gone; they're real routes now.)
export function activeDrawer(search) {
  return new URLSearchParams(search).get('drawer');
}

// Merge a patch into the current URL's query (replace, no history entry).
// null/undefined/''/false delete the key — so defaults keep URLs clean.
export function setQuery(patch) {
  const p = new URLSearchParams(location.search);
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined || v === '' || v === false) p.delete(k);
    else p.set(k, String(v));
  }
  const s = p.toString();
  navigate(location.pathname + (s ? '?' + s : ''), { replace: true });
}

window.addEventListener('popstate', sync);

// On a deep link past home, seed a home entry so Back always has somewhere to go.
if (location.pathname !== '/') {
  const here = location.pathname + location.search;
  history.replaceState({}, '', '/');
  history.pushState({}, '', here);
  sync();
}
