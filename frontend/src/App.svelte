<script>
  import { untrack } from 'svelte';
  import { route, navigate, goBack, OVERLAY_PATHS, activeDrawer } from './lib/router.svelte.js';
  import { rail, railSelect, detail, loadCollection, openVolume, clearDetail, loadFlags, startOpsTracking } from './lib/store.svelte.js';
  import Icon from './lib/Icon.svelte';
  import { startStatusPolling } from './lib/status.svelte.js';
  import { startEvents } from './lib/events.svelte.js';
  import { loadClientPlugins } from './lib/plugins.svelte.js';
  import { closeTopModal } from './lib/modals.svelte.js';

  import Header from './components/Header.svelte';
  import Sidebar from './components/Sidebar.svelte';
  import LibraryPage from './components/LibraryPage.svelte';
  import SeriesDetail from './components/SeriesDetail.svelte';
  import SettingsPage from './components/SettingsPage.svelte';
  import SystemPage from './components/SystemPage.svelte';
  import WantedPage from './components/WantedPage.svelte';
  import HistoryPage from './components/HistoryPage.svelte';
  import StatsPage from './components/StatsPage.svelte';
  import ImportPage from './components/ImportPage.svelte';
  import PluginsPage from './components/PluginsPage.svelte';
  import UsersPage from './components/UsersPage.svelte';
  import ListsPage from './components/ListsPage.svelte';
  import ProfilePage from './components/ProfilePage.svelte';
  import LoginPage from './components/LoginPage.svelte';
  import AccountModal from './components/AccountModal.svelte';
  import HelpModal from './components/HelpModal.svelte';
  import { auth, loadMe, can } from './lib/auth.svelte.js';
  import QueuePage from './components/QueuePage.svelte';
  import ReleasesDrawer from './components/ReleasesDrawer.svelte';
  import AddModal from './components/AddModal.svelte';
  import CvPickerModal from './components/CvPickerModal.svelte';
  import IssueModal from './components/IssueModal.svelte';
import EditMetadataModal from './components/EditMetadataModal.svelte';
  import SourceSearchModal from './components/SourceSearchModal.svelte';
  import PackSearchModal from './components/PackSearchModal.svelte';
  import IndexerModal from './components/IndexerModal.svelte';
  import DialogModal from './components/DialogModal.svelte';
  import Onboarding from './components/Onboarding.svelte';
  import Toasts from './components/Toasts.svelte';

  // Section pages are always mounted (plugin slots inject into them) —
  // a body class picks which one is visible (app.css hides .home under it).
  const PAGE_CLASSES = {
    '/settings': 'settings', '/system': 'systempage',
    '/wanted': 'wanted', '/history': 'history', '/stats': 'stats', '/import': 'import',
    '/queue': 'queuepage', '/releases': 'releasespage', '/plugins': 'pluginspage',
    '/users': 'userspage', '/lists': 'listspage', '/profile': 'profilepage',
  };

  // Route-level permission guard. Section pages are always mounted, so a user
  // could otherwise reach a page by typing its URL even with the nav link
  // hidden. The server still enforces every action; this keeps the UI honest by
  // bouncing anyone who lacks the page's permission back to the library.
  const PAGE_PERMS = {
    '/settings': 'settings.manage', '/users': 'users.manage', '/plugins': 'plugins.manage',
    '/import': 'library.manage',
    '/wanted': 'downloads.grab', '/queue': 'downloads.grab',
    '/releases': 'downloads.grab', '/history': 'downloads.grab',
  };
  // A page the account can't open shows an access notice in place, rather
  // than silently landing on Home (which read as "the link is broken").
  // System bundles Jobs/Tools (system.jobs) and Logs (system.logs) — either
  // grants access; the page hides the tabs the user can't see.
  const denied = $derived.by(() => {
    if (!authed) return false;
    if (route.path === '/system') return !can('system.jobs') && !can('system.logs');
    const need = PAGE_PERMS[route.path];
    return !!(need && !can(need));
  });

  const overlay = $derived(OVERLAY_PATHS.includes(route.path));
  const volumeId = $derived.by(() => {
    const m = route.path.match(/^\/volume\/(\d+)/);
    return m ? Number(m[1]) : null;
  });
  // The URLs this app renders itself. Anything else is a typo or a stale link —
  // and gets told so, instead of quietly showing Home.
  const KNOWN_PATHS = new Set(['/', '/system', '/profile', '/jobs', '/tools', '/logs', ...OVERLAY_PATHS]);
  const unknown = $derived(!volumeId && !KNOWN_PATHS.has(route.path));
  // Section pages only load their data when they are the page being shown.
  const page = $derived(denied || unknown ? null : route.path);

  // Browser tab, history and Back button name the page, not just the app.
  const PAGE_TITLES = {
    '/settings': 'Settings', '/system': 'System', '/wanted': 'Wanted', '/queue': 'Queue', '/releases': 'Releases',
    '/history': 'History', '/lists': 'Reading lists', '/import': 'Import', '/stats': 'Stats', '/plugins': 'Plugins',
    '/users': 'Users', '/profile': 'Profile',
  };
  $effect(() => {
    let name = PAGE_TITLES[route.path] || '';
    if (volumeId) name = detail.series?.title && detail.series.title !== 'Comic' ? detail.series.title : 'Series';
    else if (unknown) name = 'Page not found';
    else if (route.path === '/' && route.search.includes('collections=1')) name = 'Collections';
    document.title = name ? `${name} · BackIssue` : 'BackIssue';
  });

  // Queue/Releases were drawers (?drawer=) for a while — keep old links working.
  $effect(() => {
    const d = activeDrawer(route.search);
    if (d === 'queue' || d === 'releases') navigate('/' + d, { replace: true });
  });

  // Jobs/Tools/Logs merged into the System page — keep old links/bookmarks
  // working by redirecting to the matching System tab.
  $effect(() => {
    const tab = { '/jobs': 'jobs', '/tools': 'tools', '/logs': 'logs' }[route.path];
    if (tab) navigate('/system?tab=' + tab, { replace: true });
  });

  $effect(() => {
    for (const cls of Object.values(PAGE_CLASSES)) {
      document.body.classList.toggle(cls, PAGE_CLASSES[page] === cls); // a denied/unknown page shows the notice, not the section
    }
  });

  // The rail reflects ?filter/?q on every route change. Other pages keep their
  // own query keys (wf/find/src/level/cat) — only reload the collection when
  // the rail's own params actually changed.
  let lastRail = null;
  $effect(() => {
    if (!authed) return;
    const p = new URLSearchParams(route.search);
    const filter = p.get('filter') || 'all';
    const q = p.get('q') || '';
    const sort = p.get('sort') || 'title';
    const library = p.get('library') || '';
    const facet = p.get('facet') || '';
    const collections = p.get('collections') === '1';
    if (lastRail === filter + '\n' + q + '\n' + sort + '\n' + library + '\n' + facet + '\n' + collections) return;
    lastRail = filter + '\n' + q + '\n' + sort + '\n' + library + '\n' + facet + '\n' + collections;
    rail.filter = filter;
    rail.search = q;
    rail.sort = sort;
    rail.library = library ? Number(library) : null;
    rail.facet = facet;
    rail.collections = collections;
    untrack(() => loadCollection());
  });

  // /volume/:id opens the detail; leaving it (not into an overlay) clears it.
  $effect(() => {
    if (!authed) return;
    if (volumeId) untrack(() => { openVolume(volumeId); });
    else if (!overlay) untrack(() => clearDetail());
  });

  // Boot: resolve the session FIRST, then start services — the SSE stream,
  // polls, and plugin assets are all authenticated, so starting them logged
  // out would just spray 401s at the login screen. Open mode (no accounts yet)
  // is NOT "authed": a fresh install must create the admin before the app runs,
  // so services don't start and the app doesn't render until a real user exists.
  const authed = $derived(auth.ready && !!auth.user);
  let servicesStarted = false;
  loadMe();
  $effect(() => {
    if (!authed || servicesStarted) return;
    servicesStarted = true;
    startEvents();
    startStatusPolling();
    // Settings and the scan/tag/match progress feeds are admin-side; a viewer
    // asking for them only produced 403s in the console.
    if (can('library.manage')) startOpsTracking();
    if (can('settings.manage')) loadFlags();
    loadClientPlugins();
    loadCollection();
  });

  // ---- Keyboard: Escape closes the topmost modal, else backs out of a
  // section page; "/" focuses the search box. ----
  function onKeydown(e) {
    if (e.key === 'Escape') {
      if (closeTopModal()) return;
      if (rail.selecting) { rail.selecting = false; railSelect.clear(); return; }
      if (OVERLAY_PATHS.includes(location.pathname)) goBack();
      return;
    }
    if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')) {
      e.preventDefault();
      document.getElementById('search')?.focus();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if !auth.ready}
  <div class="authgate"><div class="authgate__card"><div class="brand"><span class="brand__logo">BACKISSUE</span></div></div></div>
{:else if auth.openMode}
  <!-- First run: no accounts exist yet. Force creating the admin before the
       app is usable — a fresh install never sits in an open, unsecured state. -->
  <LoginPage mode="secure" />
{:else if !authed}
  <LoginPage />
{:else}
<div class="shell">
  <Sidebar />
  <div class="shell__main">
    <Header />
    <main class="content">
      {#if denied || unknown}
        <div class="nopage" id="nopage">
          <div class="nopage__card">
            <div class="nopage__art"><Icon name={denied ? 'shield' : 'search'} size={24} /></div>
            <div class="nopage__title">{denied ? 'You don’t have access to this page' : 'Page not found'}</div>
            <div class="nopage__text">{denied ? 'Your account isn’t allowed to open it. Ask an admin if you think it should be.' : 'There is nothing at this address. It may have moved, or the link is wrong.'}</div>
            <div class="nopage__code">{route.path}</div>
            <div class="nopage__actions"><button class="btn" onclick={() => navigate('/')}><Icon name="home" size={14} /> Go to Home</button></div>
          </div>
        </div>
      {/if}
      <div class="home" hidden={denied || unknown}>
        <div class="home__pane" hidden={!!volumeId}><LibraryPage /></div>
        <div class="home__pane" hidden={!volumeId}><SeriesDetail /></div>
      </div>

      <SettingsPage active={page === '/settings'} />
      <SystemPage active={page === '/system'} />
      <WantedPage active={page === '/wanted'} />
      <HistoryPage active={page === '/history'} />
      <StatsPage active={page === '/stats'} />
      <ImportPage active={page === '/import'} />
      <PluginsPage active={page === '/plugins'} />

      <QueuePage active={page === '/queue'} />
      <ReleasesDrawer active={page === '/releases'} />
      <UsersPage active={page === '/users'} />
      <ListsPage active={page === '/lists'} />
      <ProfilePage active={page === '/profile'} />
    </main>
  </div>
</div>
{/if}

<AddModal />
<AccountModal />
<HelpModal />
<CvPickerModal />
<IssueModal />
<EditMetadataModal />
<SourceSearchModal />
<PackSearchModal />
<IndexerModal />
<DialogModal />
<Onboarding />

<Toasts />
