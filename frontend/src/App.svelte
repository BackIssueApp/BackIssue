<script>
  import { untrack } from 'svelte';
  import { route, navigate, goBack, OVERLAY_PATHS, activeDrawer } from './lib/router.svelte.js';
  import { rail, railSelect, loadCollection, openVolume, clearDetail, loadFlags, startOpsTracking } from './lib/store.svelte.js';
  import { startStatusPolling } from './lib/status.svelte.js';
  import { startEvents } from './lib/events.svelte.js';
  import { loadClientPlugins } from './lib/plugins.svelte.js';
  import { closeTopModal } from './lib/modals.svelte.js';

  import Header from './components/Header.svelte';
  import Sidebar from './components/Sidebar.svelte';
  import LibraryPage from './components/LibraryPage.svelte';
  import SeriesDetail from './components/SeriesDetail.svelte';
  import SettingsPage from './components/SettingsPage.svelte';
  import JobsPage from './components/JobsPage.svelte';
  import ToolsPage from './components/ToolsPage.svelte';
  import LogsPage from './components/LogsPage.svelte';
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
  import QueueDrawer from './components/QueueDrawer.svelte';
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
    '/settings': 'settings', '/jobs': 'jobs', '/tools': 'tools', '/logs': 'logs',
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
    '/jobs': 'system.jobs', '/tools': 'system.jobs', '/logs': 'system.logs',
    '/import': 'library.manage',
    '/wanted': 'downloads.grab', '/queue': 'downloads.grab',
    '/releases': 'downloads.grab', '/history': 'downloads.grab',
  };
  $effect(() => {
    if (!authed) return;
    const need = PAGE_PERMS[route.path];
    if (need && !can(need)) navigate('/', { replace: true });
  });

  const overlay = $derived(OVERLAY_PATHS.includes(route.path));
  const volumeId = $derived.by(() => {
    const m = route.path.match(/^\/volume\/(\d+)/);
    return m ? Number(m[1]) : null;
  });

  // Queue/Releases were drawers (?drawer=) for a while — keep old links working.
  $effect(() => {
    const d = activeDrawer(route.search);
    if (d === 'queue' || d === 'releases') navigate('/' + d, { replace: true });
  });

  $effect(() => {
    for (const cls of Object.values(PAGE_CLASSES)) {
      document.body.classList.toggle(cls, PAGE_CLASSES[route.path] === cls);
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
    if (lastRail === filter + '\n' + q + '\n' + sort + '\n' + library) return;
    lastRail = filter + '\n' + q + '\n' + sort + '\n' + library;
    rail.filter = filter;
    rail.search = q;
    rail.sort = sort;
    rail.library = library ? Number(library) : null;
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
    startOpsTracking();
    loadFlags();
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
      <div class="home">
        <div class="home__pane" hidden={!!volumeId}><LibraryPage /></div>
        <div class="home__pane" hidden={!volumeId}><SeriesDetail /></div>
      </div>

      <SettingsPage active={route.path === '/settings'} />
      <JobsPage active={route.path === '/jobs'} />
      <ToolsPage active={route.path === '/tools'} />
      <LogsPage active={route.path === '/logs'} />
      <WantedPage active={route.path === '/wanted'} />
      <HistoryPage active={route.path === '/history'} />
      <StatsPage active={route.path === '/stats'} />
      <ImportPage active={route.path === '/import'} />
      <PluginsPage active={route.path === '/plugins'} />

      <QueueDrawer active={route.path === '/queue'} />
      <ReleasesDrawer active={route.path === '/releases'} />
      <UsersPage active={route.path === '/users'} />
      <ListsPage active={route.path === '/lists'} />
      <ProfilePage active={route.path === '/profile'} />
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
