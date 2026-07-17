<script>
  // App navigation: sections on the left, content on the right. On phones the
  // sidebar is an off-canvas overlay opened by the header's ☰.
  import { navigate, route } from '../lib/router.svelte.js';
  import { ui } from '../lib/store.svelte.js';
  import { status } from '../lib/status.svelte.js';
  import { fmt } from '../lib/util.js';
  import { auth, logout, can, isTrusted } from '../lib/auth.svelte.js';
  import Icon from '../lib/Icon.svelte';

  let userMenuOpen = $state(false);

  // Everything the queue view shows as a live row: queued + in-flight issues
  // (downloading / handed to the client / tagging) + active pack grabs. Summing
  // only queued+downloading hid grabbed/tagging items, so the badge undercounted.
  const c = $derived(status.counts);
  const queueActive = $derived((c.queued || 0) + (c.downloading || 0) + (c.grabbed || 0) + (c.tagging || 0) + (status.packsActive || 0));
  const failed = $derived(c.failed || 0);

  // Library owns '/' and every /volume/* page.
  const isActive = (path) => path === '/'
    ? route.path === '/' || route.path.startsWith('/volume/')
    : route.path === path;

  function go(path) {
    ui.sidebarOpen = false;
    navigate(path);
  }

  // Library entries under the main one. Explicitly created libraries (Settings
  // → Libraries) take precedence; with none defined, auto type-lanes appear
  // once the collection holds a second library type. One type, no libraries =
  // the classic single entry.
  const TYPE_LABELS = { comic: 'Comics', manga: 'Manga', magazine: 'Magazines' };
  const typeLanes = $derived(
    (status.libraries || []).length
      ? status.libraries.map((l) => ({ key: 'lib:' + l.id, q: '/?library=' + l.id, label: l.name }))
      : (status.libraryTypes || []).length > 1
        ? status.libraryTypes.map((t) => ({
            key: t.type === 'comic' ? 'comics' : t.type,
            q: '/?filter=' + (t.type === 'comic' ? 'comics' : t.type),
            label: TYPE_LABELS[t.type] || (t.type.charAt(0).toUpperCase() + t.type.slice(1)),
          }))
        : []);
  const activeLane = $derived.by(() => {
    const p = new URLSearchParams(route.search);
    return p.get('library') ? 'lib:' + p.get('library') : (p.get('filter') || '');
  });
  const laneActive = (key) => isActive('/') && activeLane === key;
</script>

<aside class="sidebar" class:is-open={ui.sidebarOpen} aria-label="App sections">
  <div class="brand" onclick={() => go('/')} role="button" tabindex="0" onkeydown={(e) => { if (e.key === 'Enter') go('/'); }}>
    <span class="brand__logo">BACKISSUE</span>
  </div>

  <nav class="sidenav">
    <div class="sidenav__head">Library</div>
    <button class="sidenav__item" class:is-active={isActive('/') && !activeLane} onclick={() => go('/')}>
      <span class="sidenav__icon"><Icon name="library" /></span> Library</button>
    {#each typeLanes as lane (lane.key)}
      <button class="sidenav__item sidenav__item--sub" class:is-active={laneActive(lane.key)} onclick={() => go(lane.q)}>
        <span class="sidenav__icon"><Icon name="book" /></span> {lane.label}</button>
    {/each}
    <button id="lists-btn" class="sidenav__item" class:is-active={isActive('/lists')} onclick={() => go('/lists')}>
      <span class="sidenav__icon"><Icon name="list" /></span> Lists</button>
    {#if isTrusted()}
      <button id="import-btn" class="sidenav__item" class:is-active={isActive('/import')} onclick={() => go('/import')}>
        <span class="sidenav__icon"><Icon name="import" /></span> Import</button>
    {/if}
    <button id="stats-btn" class="sidenav__item" class:is-active={isActive('/stats')} onclick={() => go('/stats')}>
      <span class="sidenav__icon"><Icon name="bar-chart" /></span> Stats</button>

    {#if can('downloads.grab')}
      <div class="sidenav__head">Downloads</div>
      <button id="wanted-btn" class="sidenav__item" class:is-active={isActive('/wanted')} onclick={() => go('/wanted')}>
        <span class="sidenav__icon"><Icon name="target" /></span> Wanted</button>
      <button id="queue-btn" class="sidenav__item" class:is-active={isActive('/queue')} onclick={() => go('/queue')}>
        <span class="sidenav__icon"><Icon name="queue" /></span> Queue
        {#if queueActive}<span class="sidenav__count">{fmt(queueActive)}</span>{/if}
        {#if failed}<span class="sidenav__count sidenav__count--bad">{fmt(failed)}</span>{/if}</button>
      <button id="releases-btn" class="sidenav__item" class:is-active={isActive('/releases')} onclick={() => go('/releases')}>
        <span class="sidenav__icon"><Icon name="calendar" /></span> Releases</button>
      <button id="history-btn" class="sidenav__item" class:is-active={isActive('/history')} onclick={() => go('/history')}>
        <span class="sidenav__icon"><Icon name="history" /></span> History</button>
    {/if}

    <!-- Plugin menu actions inject here (plain DOM — must stay mounted). -->
    <div id="menu-plugin-actions" class="sidenav__plugins" onclick={() => { ui.sidebarOpen = false; }}></div>

    {#if can('users.manage') || can('plugins.manage') || can('system.jobs') || can('system.logs') || can('settings.manage')}
      <div class="sidenav__head">System</div>
      {#if can('users.manage')}
        <button id="users-btn" class="sidenav__item" class:is-active={isActive('/users')} onclick={() => go('/users')}>
          <span class="sidenav__icon"><Icon name="users" /></span> Users</button>
      {/if}
      {#if can('plugins.manage')}
        <button id="plugins-btn" class="sidenav__item" class:is-active={isActive('/plugins')} onclick={() => go('/plugins')}>
          <span class="sidenav__icon"><Icon name="puzzle" /></span> Plugins</button>
      {/if}
      {#if can('system.jobs') || can('system.logs')}
        <button id="system-btn" class="sidenav__item" class:is-active={isActive('/system')} onclick={() => go('/system')}>
          <span class="sidenav__icon"><Icon name="tools" /></span> System</button>
      {/if}
      {#if can('settings.manage')}
        <button id="settings-btn" class="sidenav__item" class:is-active={isActive('/settings')} onclick={() => go('/settings')}>
          <span class="sidenav__icon"><Icon name="settings" /></span> Settings</button>
      {/if}
    {/if}
  </nav>

  <!-- Account chip: who you are + account menu. (A fresh install can't reach
       the sidebar in open mode — first run forces admin creation instead.) -->
  <div class="sideuser">
    {#if auth.user}
      <button class="sideuser__chip" class:is-open={userMenuOpen} aria-haspopup="menu" aria-expanded={userMenuOpen} onclick={() => { userMenuOpen = !userMenuOpen; }}>
        <span class="sideuser__avatar">{auth.user.username.slice(0, 1).toUpperCase()}</span>
        <span class="sideuser__name">{auth.user.username}</span>
        <span class="sideuser__role sideuser__role--{auth.user.role}">{auth.user.role}</span>
        <span class="sideuser__caret" class:is-open={userMenuOpen}><Icon name="chevron-down" size={15} /></span>
      </button>
      {#if userMenuOpen}
        <div class="sideuser__menu">
          <button class="menu__item" onclick={() => { userMenuOpen = false; go('/profile'); }}>Profile</button>
          <button class="menu__item" onclick={() => { userMenuOpen = false; logout(); }}>Sign out</button>
        </div>
      {/if}
    {/if}
  </div>

  <div class="sidenav__version" id="app-version">{status.version ? `BackIssue v${status.version}` : ''}</div>
</aside>

{#if ui.sidebarOpen}
  <div class="sidebar__scrim" onclick={() => { ui.sidebarOpen = false; }} aria-hidden="true"></div>
{/if}
