import { describe, test, expect } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import Badge from '../src/components/Badge.svelte';
import Toasts from '../src/components/Toasts.svelte';
import DialogModal from '../src/components/DialogModal.svelte';
import { confirmDialog, inputDialog } from '../src/components/DialogModal.svelte';
import { notify, toasts } from '../src/lib/toasts.svelte.js';

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
