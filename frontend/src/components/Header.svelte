<script>
  // Slim top bar over the content area: mobile sidebar toggle, global search,
  // plugin widgets, status pills. Sections live in the Sidebar. Must stay
  // always-mounted (plugin bridge injects into #header-plugin-slot).
  import { untrack } from 'svelte';
  import { navigate, route } from '../lib/router.svelte.js';
  import { rail, ui } from '../lib/store.svelte.js';
  import { status } from '../lib/status.svelte.js';
  import { can } from '../lib/auth.svelte.js';
  import { live } from '../lib/events.svelte.js';
  import { fmt } from '../lib/util.js';
  import { openHelp } from './HelpModal.svelte';
  import NotificationBell from './NotificationBell.svelte';
  import Icon from '../lib/Icon.svelte';

  let searchValue = $state('');

  // In-flight downloads = actively fetching + handed to the client (grabbed) +
  // post-processing (tagging). The bare 'downloading' count hid grabbed/tagging
  // items that the queue view shows, so the pill undercounted.
  const inFlight = $derived((status.counts.downloading || 0) + (status.counts.grabbed || 0) + (status.counts.tagging || 0));

  // "Reconnecting" pill: only after the live stream has been down for a few
  // seconds (EventSource auto-reconnects; brief blips shouldn't flash chrome).
  // Without it a dead server is indistinguishable from a healthy idle app.
  let disconnected = $state(false);
  $effect(() => {
    if (live.connected) { disconnected = false; return; }
    const t = setTimeout(() => { disconnected = true; }, 5000);
    return () => clearTimeout(t);
  });

  // Keep the box in sync with the URL's ?q= (Back/Forward, deep links). Only
  // route.search is a dependency — tracking searchValue here would stomp the
  // user's in-progress typing on every keystroke.
  $effect(() => {
    const q = new URLSearchParams(route.search).get('q') || '';
    untrack(() => { if (searchValue !== q) searchValue = q; });
  });

  function libraryQuery() {
    const p = new URLSearchParams();
    if (rail.filter && rail.filter !== 'all') p.set('filter', rail.filter);
    if (rail.sort && rail.sort !== 'title') p.set('sort', rail.sort);
    const q = searchValue.trim();
    if (q) p.set('q', q);
    const s = p.toString();
    return s ? '?' + s : '';
  }

  let searchTimer;
  function onSearchInput() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      // Searching always means "find in my library": from anywhere else it
      // takes you there (first keystroke pushes one history entry so Back
      // returns to the page you left); on the library it filters in place.
      const onLibrary = location.pathname === '/';
      navigate('/' + libraryQuery(), { replace: onLibrary });
    }, 180);
  }

</script>

<header class="topbar">
  <button class="btn btn--ghost topbar__burger" title="Menu" aria-label="Open navigation" onclick={() => { ui.sidebarOpen = !ui.sidebarOpen; }}><Icon name="menu" /></button>

  <div class="search">
    <input id="search" type="search" autocomplete="off" placeholder="Search your collection…" bind:value={searchValue} oninput={onSearchInput} />
  </div>

  <div class="topbar__right">
    {#if disconnected}
      <span class="topbar__offline" title="Lost the live connection to the server — reconnecting. Data may be stale.">reconnecting…</span>
    {/if}
    <!-- Plugin header widgets inject here (plain DOM — must stay mounted). -->
    <div id="header-plugin-slot"></div>
    <NotificationBell />
    <button class="topbar__help" title="Help for this page" aria-label="Help for this page" onclick={openHelp}>?</button>
    {#if can('downloads.grab')}
      <!-- Download-pipeline stats: meaningless to a read-only viewer, so hidden
           unless the user can actually queue downloads. -->
      <div class="pills" id="pills">
        <span class="pill pill--done"><span class="dot"></span>saved <b>{fmt(status.counts.done || 0)}</b></span>
        <span class="pill pill--queued"><span class="dot"></span>queued <b>{fmt(status.counts.queued || 0)}</b></span>
        {#if status.counts.failed}
          <span class="pill pill--failed"><span class="dot"></span>failed <b>{fmt(status.counts.failed)}</b></span>
        {/if}
        {#if status.downloading || inFlight}
          <span class="pill pill--busy"><span class="dot"></span>downloading <b>{fmt(inFlight)}</b></span>
        {/if}
      </div>
    {/if}
  </div>
</header>
