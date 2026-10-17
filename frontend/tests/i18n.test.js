import { describe, test, expect, afterEach } from 'vitest';
import { t, th, matchLanguage, addMessages, hasMessage, languageName, _setCatalogForTests, LANGUAGES } from '../src/lib/i18n.svelte.js';
import { translateServerMessage, serverText } from '../src/lib/i18n.js';
import en from '../src/locales/en/common.json';

afterEach(() => _setCatalogForTests('en', { common: en }));

describe('t()', () => {
  test('looks up a dotted key and interpolates named params', () => {
    _setCatalogForTests('en', { x: { hi: 'Hello {name}, {n} new' } });
    expect(t('x.hi', { name: 'Ana', n: 3 })).toBe('Hello Ana, 3 new');
    // An unknown placeholder is left visible rather than blanked.
    expect(t('x.hi', { name: 'Ana' })).toBe('Hello Ana, {n} new');
  });

  test('picks plural forms with the language rules on count', () => {
    _setCatalogForTests('en', { x: { f: { one: '{count} file', other: '{count} files', zero: 'No files' } } });
    expect(t('x.f', { count: 1 })).toBe('1 file');
    expect(t('x.f', { count: 2 })).toBe('2 files');
    expect(t('x.f', { count: 0 })).toBe('No files');
    // French treats 0 and 1 as singular; an explicit zero form still wins.
    _setCatalogForTests('fr', { x: { f: { one: '{count} fichier', other: '{count} fichiers' } } });
    expect(t('x.f', { count: 0 })).toBe('0 fichier');
    expect(t('x.f', { count: 5 })).toBe('5 fichiers');
  });

  test('falls back to English for a key the active language lacks, then to the key', () => {
    _setCatalogForTests('fr', { common: { save: 'Enregistrer' } });
    expect(t('common.save')).toBe('Enregistrer');
    expect(t('common.cancel')).toBe('Cancel');
    expect(t('common.noSuchKey')).toBe('common.noSuchKey');
    // A namespace is not a message.
    expect(t('common')).toBe('common');
  });

  test('hasMessage says whether a key resolves', () => {
    expect(hasMessage('common.save')).toBe(true);
    expect(hasMessage('common.nope')).toBe(false);
    expect(hasMessage('common')).toBe(false);
  });
});

describe('th()', () => {
  test('escapes params and the message, keeping a small inline subset', () => {
    _setCatalogForTests('en', { x: { m: 'Since <b>{date}</b> & <script>x</script> <code>{k}</code>' } });
    expect(th('x.m', { date: '<i>1 Jan</i>', k: 'a&b' }))
      .toBe('Since <b>&lt;i&gt;1 Jan&lt;/i&gt;</b> &amp; &lt;script&gt;x&lt;/script&gt; <code>a&amp;b</code>');
  });
});

describe('language matching', () => {
  test('matches exact tags, then the base language, else null', () => {
    expect(matchLanguage('en')).toBe('en');
    expect(matchLanguage('EN-GB')).toBe('en');
    expect(matchLanguage(['xx', 'en-US'])).toBe('en');
    expect(matchLanguage('xx')).toBe(null);
    expect(matchLanguage(undefined)).toBe(null);
  });
  test('Simplified Chinese is found from zh, zh-CN and zh-Hans tags but not Traditional ones', () => {
    if (!LANGUAGES.includes('zh-hans')) return; // catalog not present in this build
    for (const tag of ['zh', 'zh-CN', 'zh-SG', 'zh-Hans', 'zh-Hans-CN']) expect(matchLanguage(tag)).toBe('zh-hans');
    expect(matchLanguage('zh-TW')).toBe(null);
  });
  test('pt-BR finds Brazilian Portuguese while pt-PT keeps European', () => {
    if (!LANGUAGES.includes('pt-br')) return;
    expect(matchLanguage('pt-BR')).toBe('pt-br');
    expect(matchLanguage('pt-PT')).toBe('pt');
  });
  test('English is always first in the catalog list and names itself', () => {
    expect(LANGUAGES[0]).toBe('en');
    expect(languageName('en')).toBe('English');
  });
});

describe('serverText()', () => {
  test('translates server labels by their English across nested namespaces, with a detail suffix', () => {
    _setCatalogForTests('de', {
      permissions: { library: { view: { label: 'Bibliothek durchsuchen' } } },
      jobs: { refreshDetails: 'Heftdetails aktualisieren · {detail}' },
      tools: { 'scan-library': { label: 'Gesamte Bibliothek scannen' } },
    });
    expect(serverText('permissions', 'Browse the library')).toBe('Bibliothek durchsuchen');
    expect(serverText('jobs', 'Refresh issue details · Blacksad')).toBe('Heftdetails aktualisieren · Blacksad');
    expect(serverText(['jobs', 'tools'], 'Scan entire library')).toBe('Gesamte Bibliothek scannen');
    expect(serverText('jobs', 'Something a plugin named')).toBe('Something a plugin named');
    expect(serverText('jobs', '')).toBe('');
  });
  test('sees messages a plugin added to a shared namespace', () => {
    _setCatalogForTests('en', { permissions: {} });
    addMessages({ en: { permissions: { reader: { read: { label: 'Read comics' } } } } });
    expect(serverText('permissions', 'Read comics')).toBe('Read comics');
    _setCatalogForTests('fr', { permissions: { reader: { read: { label: 'Lire des comics' } } } });
    expect(serverText('permissions', 'Read comics')).toBe('Lire des comics');
  });
});

describe('translateServerMessage()', () => {
  test('recognises the English of a known server message, with a trailing detail', () => {
    _setCatalogForTests('fr', { errors: { signInFirst: 'Connectez-vous d’abord', installFailed: 'Échec de l’installation : {detail}' } });
    expect(translateServerMessage('sign in with a real account first')).toBe('Connectez-vous d’abord');
    expect(translateServerMessage('install failed: disk full')).toBe('Échec de l’installation : disk full');
    expect(translateServerMessage('something a plugin said')).toBe('something a plugin said');
    expect(translateServerMessage(null)).toBe(null);
  });
});

describe('addMessages()', () => {
  test('adds plugin namespaces without overriding core keys', () => {
    _setCatalogForTests('en', { common: { save: 'Save' } });
    addMessages({ en: { myplugin: { go: 'Go' }, common: { save: 'HIJACKED', extra: 'Extra' } } });
    expect(t('myplugin.go')).toBe('Go');
    expect(t('common.save')).toBe('Save');
    expect(t('common.extra')).toBe('Extra');
  });
});
