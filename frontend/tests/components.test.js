import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import Badge from '../src/components/Badge.svelte';
import Toasts from '../src/components/Toasts.svelte';
import DialogModal from '../src/components/DialogModal.svelte';
import { confirmDialog, inputDialog, choiceDialog } from '../src/components/DialogModal.svelte';
import { notify, toasts } from '../src/lib/toasts.svelte.js';
import ContextMenu, { openContextMenu, closeContextMenu, contextMenu } from '../src/components/ContextMenu.svelte';

describe('Badge', () => {
  test('maps statuses to labels', () => {
    render(Badge, { props: { status: 'done' } });
    expect(screen.getByText('saved')).toBeTruthy();
  });
  test('unknown status falls back to "new"', () => {
    render(Badge, { props: { status: 'wat' } });
    expect(screen.getByText('new')).toBeTruthy();
  });
});

describe('Toasts', () => {
  test('notify renders a toast; clicking dismisses it', async () => {
    render(Toasts);
    notify('Saved 3 files.', 'ok');
    await tick();
    const t = screen.getByText('Saved 3 files.');
    expect(t.className).toContain('toast--ok');
    t.click();
    await tick();
    // dismiss animates out (toast--out), then removes after 300ms
    expect(t.className).toContain('toast--out');
    toasts.length = 0;
  });
});

describe('DialogModal', () => {
  test('confirmDialog resolves true on confirm, false on cancel', async () => {
    render(DialogModal);
    let p = confirmDialog({ title: 'Sure?', confirmLabel: 'Do it' });
    await tick();
    screen.getByText('Do it').click();
    expect(await p).toBe(true);

    p = confirmDialog({ title: 'Sure?', confirmLabel: 'Do it' });
    await tick();
    screen.getByText('Cancel').click();
    expect(await p).toBe(false);
  });

  test('inputDialog resolves the edited value, null on cancel', async () => {
    render(DialogModal);
    let p = inputDialog({ title: 'Name', value: 'abc', confirmLabel: 'Save' });
    await tick();
    const input = document.querySelector('.dialog-input');
    input.value = 'xyz';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await tick();
    screen.getByText('Save').click();
    expect(await p).toBe('xyz');

    p = inputDialog({ title: 'Name', value: 'abc' });
    await tick();
    screen.getByText('Cancel').click();
    expect(await p).toBe(null);
  });
});

describe('ContextMenu', () => {
  const ev = (x = 40, y = 40) => ({ clientX: x, clientY: y, preventDefault() {}, stopPropagation() {} });

  test('opens with the given items and runs the one clicked', async () => {
    render(ContextMenu);
    let ran = null;
    openContextMenu(ev(), [
      { id: 'read', label: 'Mark read', run: () => { ran = 'read'; } },
      'sep',
      { id: 'rm', label: 'Remove', danger: true, run: () => { ran = 'rm'; } },
    ]);
    await tick();
    screen.getByText('Mark read').click();
    await tick();
    expect(ran).toBe('read');
    // clicking an item closes the menu
    expect(screen.queryByText('Remove')).toBeNull();
  });

  test('a disabled item does not run and does not close the menu', async () => {
    render(ContextMenu);
    let ran = false;
    openContextMenu(ev(), [{ id: 'x', label: 'Download', disabled: true, run: () => { ran = true; } }]);
    await tick();
    const btn = screen.getByText('Download').closest('button');
    expect(btn.disabled).toBe(true);
    btn.click();
    await tick();
    expect(ran).toBe(false);
    closeContextMenu();
  });

  test('an empty item list opens nothing', async () => {
    render(ContextMenu);
    expect(openContextMenu(ev(), [])).toBe(false);
    expect(openContextMenu(ev(), [false, null, undefined])).toBe(false);
    await tick();
    expect(document.querySelector('.ctxmenu')).toBeNull();
  });

  test('falsy entries are dropped so callers can build lists inline', async () => {
    render(ContextMenu);
    openContextMenu(ev(), [
      { id: 'a', label: 'Keep me', run() {} },
      false,
      null,
    ]);
    await tick();
    expect(screen.getByText('Keep me')).toBeTruthy();
    expect(document.querySelectorAll('.ctxmenu .menu__item').length).toBe(1);
    closeContextMenu();
  });
});

describe('ContextMenu long-press (touch)', () => {
  const touch = (type, x = 30, y = 30) => new (class extends Event {
    constructor() { super(type, { bubbles: true, cancelable: true }); }
    touches = type === 'touchend' ? [] : [{ clientX: x, clientY: y }];
    changedTouches = [{ clientX: x, clientY: y }];
    clientX = undefined;
    clientY = undefined;
  })();

  function mount() {
    const node = document.createElement('div');
    document.body.appendChild(node);
    const handle = contextMenu(node, () => [{ id: 'a', label: 'Mark as read', run() {} }]);
    return { node, handle };
  }

  test('a press held past the threshold opens the menu', async () => {
    vi.useFakeTimers();
    render(ContextMenu);
    const { node, handle } = mount();
    node.dispatchEvent(touch('touchstart'));
    vi.advanceTimersByTime(600);
    vi.useRealTimers();
    await tick();
    expect(screen.getByText('Mark as read')).toBeTruthy();
    closeContextMenu();
    handle.destroy();
    node.remove();
  });

  test('a quick tap does not open it', async () => {
    vi.useFakeTimers();
    render(ContextMenu);
    const { node, handle } = mount();
    node.dispatchEvent(touch('touchstart'));
    vi.advanceTimersByTime(120);
    node.dispatchEvent(touch('touchend'));
    vi.advanceTimersByTime(600);
    vi.useRealTimers();
    await tick();
    expect(document.querySelector('.ctxmenu')).toBeNull();
    handle.destroy();
    node.remove();
  });

  test('sliding a finger (a scroll) cancels the press', async () => {
    vi.useFakeTimers();
    render(ContextMenu);
    const { node, handle } = mount();
    node.dispatchEvent(touch('touchstart', 30, 30));
    vi.advanceTimersByTime(200);
    node.dispatchEvent(touch('touchmove', 30, 200));   // well past the 10px slop
    vi.advanceTimersByTime(600);
    vi.useRealTimers();
    await tick();
    expect(document.querySelector('.ctxmenu')).toBeNull();
    handle.destroy();
    node.remove();
  });

  test('the action marks its node so iOS does not run its own long press', () => {
    const { node, handle } = mount();
    expect(node.classList.contains('has-longpress')).toBe(true);
    handle.destroy();
    expect(node.classList.contains('has-longpress')).toBe(false);
    node.remove();
  });
});

describe('choiceDialog with many options', () => {
  // Earlier tests in this file leave their DialogModal mounted; a second live
  // instance makes the queries below ambiguous.
  beforeEach(() => cleanup());

  test('a long choice set becomes a scrollable list, not a row of footer buttons', async () => {
    render(DialogModal);
    choiceDialog({ title: 'Add to reading list', buttons: Array.from({ length: 12 }, (_, i) => ({ label: `List ${i + 1}`, value: i + 1 })) });
    await tick();
    // Every option is in the scrollable body. They used to be laid out as one
    // unwrapping row in the footer, which put most of them off-screen.
    const box = document.querySelector('.dialog-choices');
    expect(box).toBeTruthy();
    expect(box.querySelectorAll('button').length).toBe(12);
    // and the footer is left holding only Cancel
    expect([...document.querySelectorAll('.modal__foot button')].map((b) => b.textContent.trim())).toEqual(['Cancel']);
  });

  test('a short choice set stays as footer buttons', async () => {
    render(DialogModal);
    choiceDialog({ title: 'Pick', buttons: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }] });
    await tick();
    expect(document.querySelector('.dialog-choices')).toBeNull();
    expect([...document.querySelectorAll('.modal__foot button')].map((b) => b.textContent.trim())).toEqual(['Cancel', 'A', 'B']);
  });
});
