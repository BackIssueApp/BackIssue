<script module>
  // One context menu at a time, opened imperatively from anywhere:
  //
  //   import { openContextMenu } from './ContextMenu.svelte';
  //   oncontextmenu={(e) => openContextMenu(e, items)}
  //
  // `items` is an array of { id, label, icon?, iconHtml?, danger?, disabled?,
  // note?, run() } or the string 'sep' for a divider. `icon` is a core icon
  // name; `iconHtml` is raw markup, which is what plugin actions hand us. A falsy entry is skipped, so a caller can
  // build the list with `cond && {...}` inline. run() may be async; the menu
  // closes as soon as it is invoked so a slow action never leaves it hanging.
  //
  // Mounted once by App.svelte — the same pattern Toasts/DialogModal use.
  const menu = $state({ open: false, x: 0, y: 0, items: [] });

  export function openContextMenu(event, items) {
    const list = (items || []).filter(Boolean);
    if (!list.length) return false;
    event?.preventDefault?.();
    event?.stopPropagation?.();
    // A touch long-press has no clientX/Y on the synthesized event.
    const t = event?.touches?.[0] || event?.changedTouches?.[0];
    menu.x = event?.clientX ?? t?.clientX ?? 0;
    menu.y = event?.clientY ?? t?.clientY ?? 0;
    menu.items = list;
    menu.open = true;
    return true;
  }

  export function closeContextMenu() {
    menu.open = false;
    menu.items = [];
  }

  /** Svelte action: right-click (and touch long-press) opens `items()`.
   *  Used as `use:contextMenu={() => buildItems(row)}` so the list is built
   *  fresh at open time and reflects current state (read/unread, owned, …).
   *
   *  Touch needs three things a mouse does not. The press must not also count
   *  as a tap, or lifting your finger opens the row behind the menu. iOS must
   *  be told not to run its own long-press (the copy/share callout, and text
   *  selection) on top of ours, which is the `.has-longpress` class below. And
   *  a short buzz, where the device supports one, is what tells someone the
   *  press registered — without it a long press feels like nothing happened. */
  export function contextMenu(node, getItems) {
    let build = getItems;
    let timer = null;
    let startX = 0;
    let startY = 0;

    const onContext = (e) => openContextMenu(e, build?.());
    const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };

    // Swallow the compatibility click the browser sends after touchend, so the
    // long press does not also activate the row. One shot, and self-cancelling
    // so a later genuine tap is never eaten.
    const swallowNextClick = () => {
      const kill = (e) => { e.preventDefault(); e.stopPropagation(); };
      window.addEventListener('click', kill, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', kill, { capture: true }), 700);
    };

    const onTouchStart = (e) => {
      const t = e.touches?.[0];
      if (!t) return;
      startX = t.clientX; startY = t.clientY;
      clear();
      timer = setTimeout(() => {
        timer = null;
        if (!openContextMenu(e, build?.())) return;
        swallowNextClick();
        try { navigator.vibrate?.(8); } catch { /* not supported, no matter */ }
      }, 500);
    };
    // Scrolling a list must not fire the menu, so any real movement cancels.
    const onTouchMove = (e) => {
      const t = e.touches?.[0];
      if (!t) return clear();
      if (Math.abs(t.clientX - startX) > 10 || Math.abs(t.clientY - startY) > 10) clear();
    };

    node.classList.add('has-longpress');
    node.addEventListener('contextmenu', onContext);
    node.addEventListener('touchstart', onTouchStart, { passive: true });
    node.addEventListener('touchmove', onTouchMove, { passive: true });
    node.addEventListener('touchend', clear);
    node.addEventListener('touchcancel', clear);

    return {
      update(next) { build = next; },
      destroy() {
        clear();
        node.classList.remove('has-longpress');
        node.removeEventListener('contextmenu', onContext);
        node.removeEventListener('touchstart', onTouchStart);
        node.removeEventListener('touchmove', onTouchMove);
        node.removeEventListener('touchend', clear);
        node.removeEventListener('touchcancel', clear);
      },
    };
  }

  export { menu as contextMenuState };
</script>

<script>
  import Icon from '../lib/Icon.svelte';

  let el = $state(null);
  let pos = $state({ left: 0, top: 0 });

  // Place it at the pointer, flipped back inside the viewport near an edge.
  // Measured after render because the width depends on the longest label.
  $effect(() => {
    if (!menu.open || !el) return;
    const r = el.getBoundingClientRect();
    const pad = 8;
    pos = {
      left: Math.max(pad, Math.min(menu.x, window.innerWidth - r.width - pad)),
      top: Math.max(pad, Math.min(menu.y, window.innerHeight - r.height - pad)),
    };
    el.focus?.();
  });

  async function pick(item) {
    if (item.disabled) return;
    closeContextMenu();
    try { await item.run?.(); } catch { /* the action reports its own failure */ }
  }

  function onKeydown(e) {
    if (e.key === 'Escape') { e.stopPropagation(); closeContextMenu(); }
  }

  // The issue and library grids scroll an inner element, so a window-level
  // scroll listener never fires for them. Capture catches both.
  $effect(() => {
    if (!menu.open) return;
    const close = () => closeContextMenu();
    document.addEventListener('scroll', close, true);
    return () => document.removeEventListener('scroll', close, true);
  });
</script>

<svelte:window
  onscroll={() => menu.open && closeContextMenu()}
  onresize={() => menu.open && closeContextMenu()}
/>

{#if menu.open}
  <!-- Catches the click that dismisses. Right-clicking it closes too, so a
       second right-click elsewhere does not stack menus. -->
  <div
    class="ctxmenu__scrim"
    role="presentation"
    onpointerdown={closeContextMenu}
    oncontextmenu={(e) => { e.preventDefault(); closeContextMenu(); }}
  ></div>
  <div
    bind:this={el}
    class="ctxmenu"
    style="left:{pos.left}px; top:{pos.top}px"
    role="menu"
    tabindex="-1"
    onkeydown={onKeydown}
  >
    {#each menu.items as item, i (item === 'sep' ? 'sep' + i : item.id)}
      {#if item === 'sep'}
        <div class="ctxmenu__sep"></div>
      {:else}
        <button
          class="menu__item"
          class:menu__item--danger={item.danger}
          role="menuitem"
          disabled={item.disabled}
          title={item.note || undefined}
          onclick={() => pick(item)}
        >
          {#if item.iconHtml}
            <span class="ctxmenu__icon">{@html item.iconHtml}</span>
          {:else if item.icon}
            <Icon name={item.icon} size={15} />
          {/if}
          <span class="ctxmenu__label">{item.label}</span>
        </button>
      {/if}
    {/each}
  </div>
{/if}
