// Svelte action for horizontal strips (chip rows, tab strips, stat bands).
// Adds the `hscroll` class and keeps `can-left` / `can-right` in step with the
// scroll position, so the CSS can fade the edge that has more content. A mouse
// wheel over the strip scrolls it sideways — the hidden scrollbar otherwise
// leaves desktop users no way to discover the overflow.
export function hscroll(node) {
  node.classList.add('hscroll');
  const update = () => {
    const max = node.scrollWidth - node.clientWidth;
    node.classList.toggle('can-left', node.scrollLeft > 2);
    node.classList.toggle('can-right', max - node.scrollLeft > 2);
  };
  const wheel = (e) => {
    if (node.scrollWidth <= node.clientWidth || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    node.scrollLeft += e.deltaY;
    e.preventDefault();
  };
  node.addEventListener('scroll', update, { passive: true });
  node.addEventListener('wheel', wheel, { passive: false });
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
  ro?.observe(node);
  const mo = typeof MutationObserver !== 'undefined' ? new MutationObserver(update) : null;
  mo?.observe(node, { childList: true, subtree: true, characterData: true });
  update();
  return {
    destroy() {
      node.removeEventListener('scroll', update);
      node.removeEventListener('wheel', wheel);
      ro?.disconnect(); mo?.disconnect();
    },
  };
}
