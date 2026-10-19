<script module>
  import { openModal, closeModal, modals } from '../lib/modals.svelte.js';
  import { detail, seriesTitle } from '../lib/store.svelte.js';
  import { apiPost } from '../lib/api.js';
  import { t } from '../lib/i18n.svelte.js';

  const m = $state({ title: '', query: '', results: null, errors: [], note: '', searching: false });

  export function openPackSearch() {
    if (!detail.series) return;
    m.title = t('packSearchModal.title', { series: seriesTitle(detail.series) });
    m.query = '';
    m.results = null; m.errors = []; m.note = '';
    openModal('packs');
    doSearch({ seriesId: detail.series.id }); // seeded with the series' names + aliases
  }

  export function runPackSearch() {
    const q = m.query.trim();
    doSearch({ seriesId: detail.series?.id, query: q || undefined });
  }

  async function doSearch(body) {
    m.searching = true; m.note = t('packSearchModal.searching'); m.results = null; m.errors = [];
    let data;
    try { data = await apiPost('/api/packs/search', body); }
    catch (e) { m.searching = false; m.note = String(e); return; }
    m.searching = false;
    m.errors = data.errors || [];
    if (!data.sources || !data.sources.length) { m.note = t('packSearchModal.noSources'); m.results = []; return; }
    const results = data.results || [];
    m.results = results.map((r) => ({ ...r, _busy: false }));
    m.note = results.length ? '' : t('packSearchModal.noneFound');
  }
</script>

<script>
  import { notify } from '../lib/toasts.svelte.js';
  import { humanBytes } from '../lib/util.js';
  import { trapFocus } from '../lib/dom.js';
  import { th } from '../lib/i18n.svelte.js';
  import Icon from '../lib/Icon.svelte';

  const open = $derived(modals.stack.includes('packs'));
  const sourceClass = (s) => `srcbadge srcbadge--${s}`;

  async function grab(r) {
    r._busy = true;
    let res;
    try { res = await apiPost('/api/packs/grab', { result: r, seriesId: detail.series?.id }); }
    catch (e) { res = { error: String(e) }; }
    if (res && res.grabbed) {
      closeModal('packs');
      notify(t('packSearchModal.queued', { source: r.source }), 'ok');
    } else {
      notify(t('packSearchModal.failed', { error: res?.error || t('packSearchModal.unknownError') }), 'error');
      r._busy = false;
    }
  }
</script>

{#if open}
  <div id="packs-modal" class="modal" onclick={(e) => { if (e.target === e.currentTarget) closeModal('packs'); }}>
    <div class="modal__panel modal__panel--wide" use:trapFocus role="dialog" aria-modal="true" aria-label={t('packSearchModal.dialogLabel')}>
      <div class="modal__head" style="display:flex;justify-content:space-between;align-items:center;">
        <h3 style="margin:0;">{m.title}</h3>
        <button class="modal__x" aria-label={t('common.close')} onclick={() => closeModal('packs')}><Icon name="close" /></button>
      </div>
      <p class="modal__note" style="margin:6px 0 0;">{@html th('packSearchModal.intro')}</p>
      <div class="usenet-search-row">
        <input type="search" spellcheck="false" placeholder={t('packSearchModal.queryPlaceholder')} bind:value={m.query}
          onkeydown={(e) => { if (e.key === 'Enter') runPackSearch(); }} />
        <button class="btn btn--primary" type="button" onclick={runPackSearch}>{t('common.search')}</button>
      </div>
      <div class="usenet-results">
        {#each m.errors as err, i (i)}
          <div class="list-note list-note--warn"><Icon name="alert-triangle" /> {err}</div>
        {/each}
        {#if m.note}
          <div class="list-note">{m.note}</div>
        {/if}
        {#each m.results || [] as r (r.rid)}
          <div class="un-row">
            <div class="un-info">
              <div class="un-title"><span class={sourceClass(r.source)}>{r.source}</span> {r.title}</div>
              <div class="un-meta">{r.size ? humanBytes(r.size) + ' · ' : ''}{r.meta || ''}</div>
            </div>
            <div class="un-act">
              <button class="btn btn--primary btn--sm" disabled={r._busy} onclick={() => grab(r)}>{r._busy ? t('packSearchModal.sending') : t('packSearchModal.download')}</button>
            </div>
          </div>
        {/each}
      </div>
    </div>
  </div>
{/if}
