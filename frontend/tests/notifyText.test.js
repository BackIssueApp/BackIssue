import { describe, test, expect, afterEach } from 'vitest';
import '../src/lib/i18n.svelte.js'; // boots the English catalog
import { _setCatalogForTests } from '../src/lib/i18n.js';
import { notificationText } from '../src/lib/notifyText.js';
import en from '../src/locales/en/notifications.json';

afterEach(() => _setCatalogForTests('en', { notifications: en }));

describe('notificationText()', () => {
  test('renders core events from their params, picking the variant the facts allow', () => {
    expect(notificationText({ type: 'import.done', title: 'Downloaded', body: 'x', params: { title: 'Saga #1', source: 'usenet' } }))
      .toEqual({ title: 'Downloaded', body: 'Saga #1 · usenet' });
    expect(notificationText({ type: 'import.done', params: { title: 'Saga #1', source: '' } }).body).toBe('Saga #1');
    expect(notificationText({ type: 'pack.done', params: { title: 'Pack', count: 1, failed: 0 } }).body).toBe('Pack — 1 new issue');
    expect(notificationText({ type: 'pack.done', params: { title: 'Pack', count: 3, failed: 2 } }).body).toBe('Pack — 3 new issues, 2 failed');
    expect(notificationText({ type: 'release.week', params: { count: 2, named: 'A #1, B #2', more: 0 } }).body)
      .toBe('2 issues from series you follow ship this week: A #1, B #2.');
    expect(notificationText({ type: 'release.week', params: { count: 5, named: 'A #1', more: 4 } }).body)
      .toBe('5 issues from series you follow ship this week: A #1 and 4 more.');
    expect(notificationText({ type: 'pick.arrived', params: { series: 'Saga', number: 7, name: '' } }).body).toBe('Saga #7');
  });

  test('falls back to the stored text for unknown types and rows without params', () => {
    expect(notificationText({ type: 'request.created', title: 'New request', body: 'Someone asked', params: null }))
      .toEqual({ title: 'New request', body: 'Someone asked' });
    expect(notificationText({ type: 'import.done', title: 'Downloaded', body: 'Old row' }))
      .toEqual({ title: 'Downloaded', body: 'Old row' });
  });

  test('uses the active language', () => {
    _setCatalogForTests('fr', { notifications: { importDone: { title: 'Téléchargé', body: '{title}' } } });
    expect(notificationText({ type: 'import.done', title: 'Downloaded', params: { title: 'Saga #1', source: 'x' } }))
      .toEqual({ title: 'Téléchargé', body: 'Saga #1 · x' }); // bodySource falls back to English
  });
});
