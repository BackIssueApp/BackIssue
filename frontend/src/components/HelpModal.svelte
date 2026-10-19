<script module>
  // Contextual help: the header's "?" opens this, showing what the CURRENT
  // page does and how to use it. openHelp() from Header.
  let openFn = () => {};
  export function openHelp() { openFn(); }

  // Help content keyed by route. `test` picks the entry for a path; the first
  // match wins, so put more specific patterns first. Each entry names its
  // catalog namespace under helpModal.<key> (title, s1h/s1p … sNh/sNp) and how
  // many sections it has, so the text itself lives with the translations.
  export const HELP = [
    { test: (p) => /^\/volume\//.test(p), key: 'series', n: 4 },
    { test: (p) => p === '/', key: 'library', n: 4 },
    { test: (p) => p === '/wanted', key: 'wanted', n: 2 },
    { test: (p) => p === '/queue', key: 'queue', n: 3 },
    { test: (p) => p === '/releases', key: 'releases', n: 1 },
    { test: (p) => p === '/lists', key: 'lists', n: 3 },
    { test: (p) => p === '/history', key: 'history', n: 1 },
    { test: (p) => p === '/stats', key: 'stats', n: 1 },
    { test: (p) => p === '/users', key: 'users', n: 2 },
    { test: (p) => p === '/plugins', key: 'plugins', n: 2 },
    { test: (p) => p === '/jobs', key: 'jobs', n: 1 },
    { test: (p) => p === '/tools', key: 'tools', n: 1 },
    { test: (p) => p === '/logs', key: 'logs', n: 1 },
    { test: (p) => p === '/settings', key: 'settings', n: 2 },
    { test: (p) => p === '/import', key: 'import', n: 1 },
  ];
</script>

<script>
  import { route } from '../lib/router.svelte.js';
  import Icon from '../lib/Icon.svelte';
  import { trapFocus } from '../lib/dom.js';
  import { openModal, closeModal, modals } from '../lib/modals.svelte.js';
  import { t, th } from '../lib/i18n.svelte.js';

  // In the modals stack so the app's Escape handler closes it like other modals.
  openFn = () => openModal('help');
  const open = $derived(modals.stack.includes('help'));
  const close = () => closeModal('help');

  const entry = $derived(HELP.find((h) => h.test(route.path)) || { key: 'fallback', n: 1 });
  const sections = $derived(Array.from({ length: entry.n }, (_, i) => ({
    h: t(`helpModal.${entry.key}.s${i + 1}h`),
    p: t(`helpModal.${entry.key}.s${i + 1}p`),
  })));
</script>

{#if open}
  <div class="modal" onclick={(e) => { if (e.target === e.currentTarget) close(); }} role="presentation">
    <div class="modal__panel help-panel" use:trapFocus role="dialog" aria-modal="true" aria-label={t('common.help')}>
      <div class="modal__head"><h3>{t('helpModal.title', { page: t(`helpModal.${entry.key}.title`) })}</h3>
        <button class="modal__x" aria-label={t('common.close')} onclick={close}><Icon name="close" /></button></div>
      <div class="modal__body help-body">
        {#each sections as s (s.h)}
          <div class="help-sec">
            <div class="help-sec__h">{s.h}</div>
            <p class="help-sec__p">{s.p}</p>
          </div>
        {/each}
        <p class="help-foot">{@html th('helpModal.footer')}</p>
      </div>
    </div>
  </div>
{/if}
