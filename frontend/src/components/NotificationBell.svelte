<script>
  // Header notification centre: a bell with an unread badge and a dropdown of
  // recent notifications. Feed is per-user (broadcasts + your targeted items);
  // it refreshes on the SSE 'notifications' signal, so new events appear live.
  import { apiGet, apiPost } from '../lib/api.js';
  import { subscribe } from '../lib/events.svelte.js';
  import { navigate } from '../lib/router.svelte.js';
  import { fmtAgo } from '../lib/util.js';
  import Icon from '../lib/Icon.svelte';

  let open = $state(false);
  let items = $state([]);
  let unread = $state(0);

  async function refresh() {
    try {
      const r = await apiGet('/api/notifications?limit=30');
      if (!r.error) { items = r.items || []; unread = r.unread || 0; }
    } catch { /* keep last */ }
  }

  // Live: the SSE hub signals 'notifications' when the feed changes; also do an
  // initial load. subscribe() returns an unsubscribe (cleaned up on unmount).
  $effect(() => {
    refresh();
    return subscribe('notifications', refresh, 15000);
  });

  async function markAll() {
    const r = await apiPost('/api/notifications/read', { all: true });
    if (r?.error) return; // keep real unread state — don't zero it client-side
    unread = r.unread ?? 0;
    items = items.map((i) => ({ ...i, read: true }));
  }

  async function openItem(it) {
    if (!it.read) {
      apiPost('/api/notifications/read', { ids: [it.id] }).then((r) => { unread = r.unread ?? Math.max(0, unread - 1); });
      it.read = true;
    }
    open = false;
    if (it.url) navigate(it.url);
  }

  const ICON = { success: 'check', error: 'close', warn: 'alert-triangle', info: 'info' };
  function toggle() { open = !open; if (open) refresh(); }
  function onWindowClick(e) { if (open && !e.target.closest('.notif')) open = false; }
</script>

<svelte:window onclick={onWindowClick} />

<div class="notif">
  <button class="notif__bell" title="Notifications" aria-label="Notifications" onclick={toggle}>
    <Icon name="bell" />{#if unread > 0}<span class="notif__badge">{unread > 99 ? '99+' : unread}</span>{/if}
  </button>
  {#if open}
    <div class="notif__panel">
      <div class="notif__head">
        <span>Notifications</span>
        {#if unread > 0}<button class="notif__mark" onclick={markAll}>Mark all read</button>{/if}
      </div>
      <div class="notif__list">
        {#if !items.length}
          <div class="notif__empty">Nothing yet — imports, releases, and request activity show up here.</div>
        {/if}
        {#each items as it (it.id)}
          <button class="notif-item notif-item--{it.level}" class:is-unread={!it.read}
            onclick={() => openItem(it)}>
            <span class="notif-item__dot"><Icon name={ICON[it.level] || 'info'} size={14} /></span>
            <span class="notif-item__main">
              <span class="notif-item__title">{it.title}</span>
              {#if it.body}<span class="notif-item__body">{it.body}</span>{/if}
              <span class="notif-item__time">{fmtAgo(Date.now() - it.ts)}</span>
            </span>
          </button>
        {/each}
      </div>
    </div>
  {/if}
</div>
