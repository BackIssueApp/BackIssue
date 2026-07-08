// ---- Client plugin bridge -------------------------------------------------
// Plugins ship a client script (served from /plugins/<name>/client/) that calls
// BackIssue.registerClient(fn); core calls fn(api) once assets have loaded. The
// api lets a plugin inject UI into the slots (plain DOM ids — the slot elements
// stay mounted for the app's lifetime) and subscribe to core events.
// This object's shape is a public contract with plugin client scripts — keep it
// exactly in sync with the plugin API docs.
import { escapeHtml, fmt, safeUrl } from './util.js';
import { iconSvg } from './icons.js';
import { notify } from './toasts.svelte.js';
import { auth } from './auth.svelte.js';

// Flips when plugin assets have loaded — the Settings page watches it so
// plugin-injected fields get populated even if Settings was opened first.
export const plugins = $state({ ready: false });

// Per-issue actions plugins register (e.g. a reader's 'Read' button). Each is
// { id, icon, title, when(issue), run(issue, series) }; issue rows render a
// button for every action whose when() passes. Reactive so rows update when a
// plugin registers after mount.
export const issueActions = $state([]);
// Series-level actions (e.g. a reader's "Continue #13 (12/24 read)" button).
// Each is { id, label, title?, when(series, issues), run(series, issues) };
// label/title/when may be functions of (series, issues).
export const seriesActions = $state([]);
// Bumped by plugins (api.refreshIssueActions) when per-issue state changes —
// rows referencing .n re-render so dynamic icons (read/unread) stay current.
// Series actions share the same tick.
export const issueActionsTick = $state({ n: 0 });

// Issue-cover providers (plugins may serve real covers, e.g. the reader's
// page-0 thumbnails for owned files). First non-null answer wins.
export const issueCoverProviders = $state([]);
export function issueCoverUrl(issue) {
  for (const fn of issueCoverProviders) {
    try { const u = fn(issue); if (u) return u; } catch { /* provider's problem */ }
  }
  return issue.image_url || null;
}

// The Settings page assigns the real syncSourceUI here on mount.
export const bridgeRefs = { refreshSourceUI: () => {} };

const bi = {
  _clients: [], _statusHooks: [], _sourceSyncHooks: [], _settingsHooks: [], _ready: false,
  registerClient(fn) {
    if (this._ready) { try { fn(this.api); } catch (e) { console.warn('plugin client init failed', e); } }
    else this._clients.push(fn);
  },
  api: {
    escapeHtml: (s) => escapeHtml(s), fmt: (n) => fmt(n),
    // Shared icon set as an inline-SVG string, so plugin-rendered rows/menus
    // match the core UI exactly (and render the same on every device). Returns
    // '' for an unknown name. e.g. api.icon('download'), api.icon('star', { fill: true }).
    icon: (name, opts) => iconSvg(name, opts),
    // Host toast system — plugins report outcomes the same way core does.
    // type: 'info' | 'ok' | 'error'.
    toast: (msg, type) => notify(msg, type),
    // Neutralize javascript:/data: URLs on plugin-rendered links (returns ''
    // to drop an unsafe scheme). Plugins building <a href> from CV/user data
    // MUST route it through here.
    safeUrl: (u) => safeUrl(u),
    slot: (id) => document.getElementById(id),
    // The already-resolved session ({ openMode, user } with permissions) —
    // spares plugin clients an /api/auth/me roundtrip on boot. May be
    // pre-resolution (user null, openMode false): fall back to fetching.
    me: () => ({ openMode: auth.openMode, user: auth.user }),
    // Does the signed-in user hold a permission? Mirrors core's can(): true in
    // open mode or for a '*'/exact grant. Lets a plugin hide affordances the
    // server would 403 anyway (e.g. a "Discover" button that adds to the library).
    can: (perm) => auth.openMode || (auth.user?.permissions || []).some((p) => p === '*' || p === perm),
    // Add a per-issue action button (rendered on matching issue rows).
    registerIssueAction(action) {
      if (action && typeof action.run === 'function') issueActions.push(action);
    },
    // Add a series-level action button (rendered in the series header).
    registerSeriesAction(action) {
      if (action && typeof action.run === 'function') seriesActions.push(action);
    },
    // Provide cover-image URLs for issue cards: fn(issue) → url | null. First
    // non-null provider wins; core falls back to CV art, then a placeholder.
    // (The reader plugin serves real page-0 thumbnails for owned issues.)
    registerIssueCover(fn) {
      if (typeof fn === 'function') issueCoverProviders.push(fn);
    },
    // Re-render issue/series action buttons (e.g. after reading progress changed).
    refreshIssueActions() { issueActionsTick.n++; },
    // Add a button to the sidebar menu's plugin area, rendered like a core
    // nav item: a fixed-width icon column + label. `icon` is a single glyph;
    // without one, a leading symbol in the label (legacy "✨ Discover" style)
    // is lifted into the icon column so old plugins line up too.
    // opts.section: group items under a titled header (like core's "System"
    // section) — items with the same section name cluster together even when
    // other plugins register items in between.
    addMenuAction(label, onClick, icon, opts = {}) {
      const b = document.createElement('button');
      b.className = 'menu__item';
      let text = String(label);
      if (!icon) {
        const m = text.match(/^(\S{1,2})\s+(.+)$/u);
        if (m && !/^[\p{L}\p{N}]/u.test(m[1])) { icon = m[1]; text = m[2]; }
      }
      const ic = document.createElement('span');
      ic.className = 'sidenav__icon';
      // icon may be an inline-SVG string (from api.icon) or a legacy glyph —
      // innerHTML renders both. Plugin scripts are first-party.
      ic.innerHTML = icon || '';
      b.append(ic, document.createTextNode(text));
      b.onclick = onClick;
      const area = document.getElementById('menu-plugin-actions') || document.body;
      const section = String(opts.section || '');
      // One container per section (display:contents keeps the nav's flex
      // layout); the sectionless group is created first so it sits on top.
      let group = area.querySelector(`[data-plugin-section="${CSS.escape(section)}"]`);
      if (!group) {
        group = document.createElement('div');
        group.dataset.pluginSection = section;
        group.style.display = 'contents';
        if (section) {
          const head = document.createElement('div');
          head.className = 'sidenav__head';
          head.textContent = section;
          group.appendChild(head);
        }
        area.appendChild(group);
      }
      group.appendChild(b);
      return b;
    },
    // Subscribe to the /api/status poll (for progress bars etc.).
    onStatus(cb) { bi._statusHooks.push(cb); },
    // Called on every settings-source sync; return true if this plugin's source
    // is enabled (feeds the "no sources enabled" warning). Also update own UI here.
    onSourcesSync(cb) { bi._sourceSyncHooks.push(cb); },
    // Called when the settings page opens, with the current settings object.
    onSettingsLoad(cb) { bi._settingsHooks.push(cb); },
    refreshSourceUI: () => bridgeRefs.refreshSourceUI(),
    async get(path) { return (await fetch(path)).json(); },
    async post(path, body) { return (await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json(); },
  },
};
// The server-rendered shell installs a stub BackIssue before any plugin
// script can run; adopt whatever it queued, then take the global over.
for (const fn of window.BackIssue?._q || []) bi._clients.push(fn);
window.BackIssue = bi;
export const BackIssue = bi;

// Load plugin client assets, then hand each registered client the api.
//
// The normal path is SERVER-RENDERED: the served shell already carries every
// plugin's <script>/<link> tags (see server.js shellHtml), so assets load in
// parallel with the app bundle and there's nothing to fetch here — just adopt
// any registerClient calls the pre-bundle stub queued and flip ready. The
// fetch fallback covers the one shell served without tags: a session that
// signed in on the login page without a full reload (and dev servers).
export async function loadClientPlugins() {
  // Slots are mounted before this runs, so each client initializes the moment
  // its script has loaded — no waiting on the rest of the batch.
  bi._ready = true;
  for (const fn of bi._clients.splice(0)) { try { fn(bi.api); } catch (e) { console.warn('plugin client init failed', e); } }
  if (window.__BI_PLUGINS_INLINE__) {
    // Deferred scripts all execute before DOMContentLoaded — that's the
    // "everything loaded" barrier the Settings page waits on.
    if (document.readyState === 'loading') {
      await new Promise((r) => document.addEventListener('DOMContentLoaded', r, { once: true }));
    }
    plugins.ready = true;
    return;
  }
  let assets = [];
  try { assets = await (await fetch('/api/plugins/client')).json(); } catch { /* offline */ }
  await Promise.all((Array.isArray(assets) ? assets : []).flatMap((a) => {
    const v = a.v ? `?v=${a.v}` : '';
    const loads = [];
    if (a.css) { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = `/plugins/${a.name}/${a.css}${v}`; document.head.appendChild(l); }
    if (a.js) loads.push(new Promise((res) => { const s = document.createElement('script'); s.src = `/plugins/${a.name}/${a.js}${v}`; s.onload = res; s.onerror = res; document.head.appendChild(s); }));
    return loads;
  }));
  plugins.ready = true;
}
