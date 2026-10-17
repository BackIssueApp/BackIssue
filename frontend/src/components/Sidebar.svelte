<script>
  // App navigation: sections on the left, content on the right. On phones the
  // sidebar is an off-canvas overlay opened by the header's ☰.
  import { navigate, route } from '../lib/router.svelte.js';
  import { ui } from '../lib/store.svelte.js';
  import { status } from '../lib/status.svelte.js';
  import { fmt } from '../lib/util.js';
  import { auth, logout, can, isTrusted } from '../lib/auth.svelte.js';
  import Icon from '../lib/Icon.svelte';
  import { t, hasMessage, roleName } from '../lib/i18n.svelte.js';

  let userMenuOpen = $state(false);

  // Everything the queue view shows as a live row: queued + in-flight issues
  // (downloading / handed to the client / tagging) + active pack grabs. Summing
  // only queued+downloading hid grabbed/tagging items, so the badge undercounted.
  const c = $derived(status.counts);
  const queueActive = $derived((c.queued || 0) + (c.downloading || 0) + (c.grabbed || 0) + (c.tagging || 0) + (status.packsActive || 0) + (status.mediaActive || 0));
  const failed = $derived(c.failed || 0);

  // Library owns '/' and every /volume/* page.
  const isActive = (path) => path === '/'
    ? route.path === '/' || route.path.startsWith('/volume/')
    : route.path === path;

  function go(path) {
    ui.sidebarOpen = false;
    navigate(path);
  }

  // The libraries you can open. Explicitly created libraries (Settings →
  // Libraries) take precedence; otherwise one entry per library type. With a
  // single type (or a fresh, empty install) a single "everything" entry keeps
  // the grid — and its Add button — reachable. Home ('/') is separate: it shows
  // the account's reading rails, not the whole collection.
  const TYPE_KEYS = { comic: 'sidebar.typeComics', manga: 'sidebar.typeManga', magazine: 'sidebar.typeMagazines', ebook: 'sidebar.typeBooks' };
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  // Core types have their own keys; a plugin's type is translated when its
  // catalog ships _shared.libraryTypes.<type>, else capitalised as before.
  const typeLabel = (type) => (TYPE_KEYS[type] ? t(TYPE_KEYS[type]) : hasMessage('libraryTypes.' + type) ? t('libraryTypes.' + type) : cap(type));
  const libraryEntries = $derived.by(() => {
    const libs = status.libraries || [];
    if (libs.length) return libs.map((l) => ({ key: 'lib:' + l.id, q: '/?library=' + l.id, label: l.name }));
    const types = status.libraryTypes || [];
    if (types.length > 1)
      return types.map((t) => ({
        key: t.type === 'comic' ? 'comics' : t.type,
        q: '/?filter=' + (t.type === 'comic' ? 'comics' : t.type),
        label: typeLabel(t.type),
      }));
    return [{ key: 'all', q: '/?all=1', label: types[0] ? typeLabel(types[0].type) : t('common.library') }];
  });
  const activeLane = $derived.by(() => {
    const p = new URLSearchParams(route.search);
    if (p.get('library')) return 'lib:' + p.get('library');
    if (p.get('all')) return 'all';
    return p.get('filter') || '';
  });
  const laneActive = (key) => isActive('/') && activeLane === key && !collectionsActive;
  // Collections = the library grid restricted to multi-volume book/audiobook
  // series (?collections=1); it lives on '/', so it's tracked by its own flag.
  const collectionsActive = $derived(new URLSearchParams(route.search).get('collections') === '1');
</script>

<aside class="sidebar" class:is-open={ui.sidebarOpen} aria-label={t('sidebar.appSections')}>
  <div class="brand" onclick={() => go('/')} role="button" tabindex="0" onkeydown={(e) => { if (e.key === 'Enter') go('/'); }}>
    <span class="brand__logo">BACKISSUE</span>
  </div>

  <nav class="sidenav">
    <div class="sidenav__head">{t('common.library')}</div>
    <button class="sidenav__item" class:is-active={isActive('/') && !activeLane && !collectionsActive} onclick={() => go('/')}>
      <span class="sidenav__icon"><Icon name="home" /></span> {t('sidebar.home')}</button>
    <button id="collections-btn" class="sidenav__item" class:is-active={collectionsActive} onclick={() => go('/?collections=1')}>
      <span class="sidenav__icon"><Icon name="layers" /></span> {t('sidebar.collections')}</button>
    <button id="lists-btn" class="sidenav__item" class:is-active={isActive('/lists')} onclick={() => go('/lists')}>
      <span class="sidenav__icon"><Icon name="list" /></span> {t('sidebar.lists')}</button>
    {#if isTrusted()}
      <button id="import-btn" class="sidenav__item" class:is-active={isActive('/import')} onclick={() => go('/import')}>
        <span class="sidenav__icon"><Icon name="import" /></span> {t('sidebar.import')}</button>
    {/if}
    <button id="stats-btn" class="sidenav__item" class:is-active={isActive('/stats')} onclick={() => go('/stats')}>
      <span class="sidenav__icon"><Icon name="bar-chart" /></span> {t('sidebar.stats')}</button>

    <div class="sidenav__head">{t('sidebar.libraries')}</div>
    {#each libraryEntries as lane (lane.key)}
      <button class="sidenav__item" class:is-active={laneActive(lane.key)} onclick={() => go(lane.q)}>
        <span class="sidenav__icon"><Icon name="book" /></span> {lane.label}</button>
    {/each}

    {#if can('downloads.grab')}
      <div class="sidenav__head">{t('sidebar.downloads')}</div>
      <button id="wanted-btn" class="sidenav__item" class:is-active={isActive('/wanted')} onclick={() => go('/wanted')}>
        <span class="sidenav__icon"><Icon name="target" /></span> {t('sidebar.wanted')}</button>
      <button id="queue-btn" class="sidenav__item" class:is-active={isActive('/queue')} onclick={() => go('/queue')}>
        <span class="sidenav__icon"><Icon name="queue" /></span> {t('sidebar.queue')}
        {#if queueActive}<span class="sidenav__count">{fmt(queueActive)}</span>{/if}
        {#if failed}<span class="sidenav__count sidenav__count--bad">{fmt(failed)}</span>{/if}</button>
      <button id="releases-btn" class="sidenav__item" class:is-active={isActive('/releases')} onclick={() => go('/releases')}>
        <span class="sidenav__icon"><Icon name="calendar" /></span> {t('sidebar.releases')}</button>
      <button id="history-btn" class="sidenav__item" class:is-active={isActive('/history')} onclick={() => go('/history')}>
        <span class="sidenav__icon"><Icon name="history" /></span> {t('sidebar.history')}</button>
    {/if}

    <!-- Plugin menu actions inject here (plain DOM — must stay mounted). -->
    <div id="menu-plugin-actions" class="sidenav__plugins" onclick={() => { ui.sidebarOpen = false; }}></div>

    {#if can('users.manage') || can('plugins.manage') || can('system.jobs') || can('system.logs') || can('settings.manage')}
      <div class="sidenav__head">{t('sidebar.system')}</div>
      {#if can('users.manage')}
        <button id="users-btn" class="sidenav__item" class:is-active={isActive('/users')} onclick={() => go('/users')}>
          <span class="sidenav__icon"><Icon name="users" /></span> {t('sidebar.users')}</button>
      {/if}
      {#if can('plugins.manage')}
        <button id="plugins-btn" class="sidenav__item" class:is-active={isActive('/plugins')} onclick={() => go('/plugins')}>
          <span class="sidenav__icon"><Icon name="puzzle" /></span> {t('sidebar.plugins')}</button>
      {/if}
      {#if can('system.jobs') || can('system.logs')}
        <button id="system-btn" class="sidenav__item" class:is-active={isActive('/system')} onclick={() => go('/system')}>
          <span class="sidenav__icon"><Icon name="tools" /></span> {t('sidebar.system')}</button>
      {/if}
      {#if can('settings.manage')}
        <button id="settings-btn" class="sidenav__item" class:is-active={isActive('/settings')} onclick={() => go('/settings')}>
          <span class="sidenav__icon"><Icon name="settings" /></span> {t('common.settings')}</button>
      {/if}
    {/if}
    <!-- Plugin items that belong under the System header (addMenuAction with
         section 'System') join here instead of forming their own group. Always
         mounted — the {#if} above must never own plugin children. -->
    <div id="menu-plugin-system" class="sidenav__plugins" onclick={() => { ui.sidebarOpen = false; }}></div>
  </nav>

  <!-- Account chip: who you are + account menu. (A fresh install can't reach
       the sidebar in open mode — first run forces admin creation instead.) -->
  <div class="sideuser">
    {#if auth.user}
      <button class="sideuser__chip" class:is-open={userMenuOpen} aria-haspopup="menu" aria-expanded={userMenuOpen} onclick={() => { userMenuOpen = !userMenuOpen; }}>
        <span class="sideuser__avatar">{auth.user.username.slice(0, 1).toUpperCase()}</span>
        <span class="sideuser__name">{auth.user.username}</span>
        <span class="sideuser__role sideuser__role--{auth.user.role}">{roleName(auth.user.role)}</span>
        <span class="sideuser__caret" class:is-open={userMenuOpen}><Icon name="chevron-down" size={15} /></span>
      </button>
      {#if userMenuOpen}
        <div class="sideuser__menu">
          <button class="menu__item" onclick={() => { userMenuOpen = false; go('/profile'); }}>{t('sidebar.profile')}</button>
          <button class="menu__item" onclick={() => { userMenuOpen = false; logout(); }}>{t('sidebar.signOut')}</button>
        </div>
      {/if}
    {/if}
  </div>

  <div class="sidenav__version" id="app-version">{status.version ? t('sidebar.version', { version: status.version }) : ''}</div>
</aside>

{#if ui.sidebarOpen}
  <div class="sidebar__scrim" onclick={() => { ui.sidebarOpen = false; }} aria-hidden="true"></div>
{/if}
