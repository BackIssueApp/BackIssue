// Svelte action: keep Tab focus inside a modal/drawer panel while it's open.
// Escape/backdrop close are handled elsewhere; this only stops Tab from
// wandering into the page behind the overlay.
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function trapFocus(node) {
  // Remember who opened the modal; give focus back on close so keyboard
  // users don't get dropped at <body> after Escape.
  const invoker = document.activeElement;
  function onKeydown(e) {
    if (e.key !== 'Tab') return;
    const els = [...node.querySelectorAll(FOCUSABLE)]
      .filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (!els.length) return;
    const first = els[0];
    const last = els[els.length - 1];
    const inside = node.contains(document.activeElement);
    if (e.shiftKey && (!inside || document.activeElement === first)) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && (!inside || document.activeElement === last)) {
      e.preventDefault(); first.focus();
    }
  }
  node.addEventListener('keydown', onKeydown);
  return {
    destroy() {
      node.removeEventListener('keydown', onKeydown);
      if (invoker && typeof invoker.focus === 'function' && document.contains(invoker)) {
        try { invoker.focus(); } catch { /* focus is best-effort */ }
      }
    },
  };
}

// Shared keydown handler for role="button" divs: the role contracts BOTH
// Enter and Space (Space alone would scroll the page).
export function onActivate(fn) {
  return (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(e); }
  };
}
