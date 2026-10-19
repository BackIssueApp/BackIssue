<script>
  import { goBack } from '../lib/router.svelte.js';
  import { apiGetOk, apiPost } from '../lib/api.js';
  import { subscribe } from '../lib/events.svelte.js';
  import { fmt } from '../lib/util.js';
  import { openCvPicker } from './CvPickerModal.svelte';
  import { confirmDialog } from './DialogModal.svelte';
  import { notify } from '../lib/toasts.svelte.js';
  import { t } from '../lib/i18n.svelte.js';
  import Icon from '../lib/Icon.svelte';

  let { active = false } = $props();

  // Catalog keys; resolved with t() where rendered.
  const IMPORT_CONF = {
    high: { key: 'importPage.confHigh', cls: 'conf--high' },
    medium: { key: 'importPage.confMedium', cls: 'conf--med' },
    low: { key: 'importPage.confLow', cls: 'conf--low' },
    manual: { key: 'importPage.confManual', cls: 'conf--high' },
    none: { key: 'importPage.confNone', cls: 'conf--none' },
    error: { key: 'importPage.confError', cls: 'conf--low' },
  };

  let st = $state(null);
  let filter = $state('all');

  async function renderImport() {
    try { st = await apiGetOk('/api/import'); } catch { /* keep last */ }
  }

  $effect(() => {
    if (!active) return;
    renderImport();
    return subscribe('import', renderImport, 1500);
  });

  const cands = $derived(st?.candidates || []);
  const ready = $derived(cands.filter((c) => c.status === 'ready').length);
  const review = $derived(cands.filter((c) => c.status === 'review').length);
  const busy = $derived(!!st?.running);
  const shown = $derived(cands.filter((c) => filter === 'all' || c.status === filter));
  const summary = $derived.by(() => {
    const bits = [];
    if (cands.length) bits.push(t('importPage.nFound', { count: fmt(cands.length) }));
    if (review) bits.push(t('importPage.nToReview', { count: fmt(review) }));
    if (ready) bits.push(t('importPage.nReady', { count: fmt(ready) }));
    return bits.join(' · ');
  });

  async function scan() {
    // A rejected scan (e.g. no root folders configured) must say so, not no-op.
    const r = await apiPost('/api/import/scan', {});
    if (r?.error) return notify(r.error, 'error');
    renderImport();
  }
  async function rescan() {
    if (!(await confirmDialog({
      title: t('importPage.rescanTitle'),
      message: t('importPage.rescanMessage'),
      confirmLabel: t('importPage.rescanConfirm'), danger: true,
    }))) return;
    const r = await apiPost('/api/import/scan', { fresh: true });
    if (r?.error) return notify(r.error, 'error');
    renderImport();
  }
  async function run() {
    if (!(await confirmDialog({
      title: t('importPage.importTitle'),
      message: t('importPage.importMessage'),
      confirmLabel: t('importPage.import'),
    }))) return;
    const r = await apiPost('/api/import/run');
    if (r?.error) return notify(r.error, 'error');
    notify(t('importPage.importing'), 'info');
    renderImport();
  }
  async function candidateAction(id, action) {
    const r = await apiPost(`/api/import/candidate/${id}/${action}`);
    if (r?.error) return notify(r.error, 'error');
    renderImport();
  }
  function changeMatch(c) {
    openCvPicker(c.id, c.name, async (v) => {
      const r = await apiPost(`/api/import/candidate/${c.id}/match`, { cvId: v.id, cvName: v.name, cvYear: v.start_year, cvImage: v.image_url });
      if (r?.error) return notify(r.error, 'error');
      notify(v.start_year ? t('importPage.matchedToYear', { name: v.name, year: v.start_year }) : t('importPage.matchedTo', { name: v.name }), 'ok');
      renderImport();
    }, { files: c.file_count });
  }
</script>

<main id="import-page" class="scan-page import-page">
  <div class="scan-page__bar">
    <button id="import-back" class="btn btn--ghost" onclick={goBack}><Icon name="arrow-left" /> {t('common.back')}</button>
    <h2 class="scan-page__title">{t('importPage.title')}</h2>
    <span id="import-summary" class="scan-summary">{summary}{#if st?.error}{summary ? ' · ' : ''}<span class="import-err"><Icon name="alert-triangle" size={13} /> {st.error}</span>{/if}</span>
    <span class="settings-spacer"></span>
    <button id="import-scan" class="btn btn--ghost" title={t('importPage.scanTitle')} disabled={busy} onclick={scan}>
      {#if busy && st?.phase === 'scanning'}{t('importPage.scanning', { done: fmt(st.done || 0), total: fmt(st.total || 0) })}{:else}<Icon name="refresh" /> {t('importPage.scanForNew')}{/if}</button>
    <button id="import-rescan" class="btn btn--ghost" title={t('importPage.rescanButtonTitle')} disabled={busy} onclick={rescan}>{t('importPage.fullRescan')}</button>
    <button id="import-run" class="btn btn--primary" disabled={busy || ready === 0} onclick={run}>
      {busy && st?.phase === 'importing' ? t('importPage.importingProgress', { done: fmt(st.done || 0), total: fmt(st.total || 0) }) : (ready ? t('importPage.importN', { count: fmt(ready) }) : t('importPage.import'))}</button>
  </div>
  <div class="import-scroll">
    <p class="modal__note" id="import-intro">{t('importPage.intro')}</p>
    <div class="filter" id="import-filter">
      {#each [['all', 'common.all'], ['review', 'importPage.filterReview'], ['ready', 'importPage.filterReady'], ['skipped', 'importPage.filterSkipped']] as [key, label] (key)}
        <button class="filter__btn" class:is-active={filter === key} onclick={() => { filter = key; }}>{t(label)}</button>
      {/each}
    </div>
    <div id="import-list" class="import-list">
      {#if st && !cands.length}
        <div class="list-note">{t('importPage.noCandidates')}</div>
      {:else if st && !shown.length}
        <div class="list-note">{t('importPage.nothingInFilter')}</div>
      {/if}
      {#each shown as c (c.id)}
        {@const conf = IMPORT_CONF[c.confidence] || IMPORT_CONF.none}
        <div class="import-row status--{c.status}">
          {#if c.cv_image}
            <img class="import-cover" src={c.cv_image} alt="" loading="lazy" referrerpolicy="no-referrer" />
          {:else}
            <div class="import-cover import-cover--none">?</div>
          {/if}
          <div class="import-info">
            <div class="import-folder">{c.name || c.folder}
              {#if c.year}<span class="scan-muted">({c.year})</span>{/if}
              <span class="scan-muted">· {t('common.nFiles', { count: fmt(c.file_count || 0) })}</span></div>
            {#if c.cv_id || (c.handler && c.cv_name)}
              <!-- Matched: to ComicVine, or (handler candidates, e.g. ebook
                   files) to the handler's own metadata source. -->
              <div class="import-match"><b>{c.cv_name || t('importPage.matchedFallback')}</b>
                {#if c.cv_year}<span class="scan-muted">({c.cv_year})</span>{/if}
                <span class="conf {conf.cls}">{t(conf.key)}</span></div>
            {:else if c.confidence === 'error'}
              <div class="import-match import-match--none">{t('importPage.searchFailed')} <span class="conf conf--low">{t('importPage.searchFailedHint')}</span></div>
            {:else if c.handler}
              <div class="import-match import-match--none">{t('importPage.noMetadataMatch')} <span class="conf conf--none">{t('importPage.importsWithFileInfo')}</span></div>
            {:else}
              <div class="import-match import-match--none">{t('importPage.noMatch')} <span class="conf conf--none">{t('importPage.willImportUnmatched')}</span></div>
            {/if}
            <div class="import-path" title={c.folder}>{c.folder}</div>
          </div>
          <div class="import-actions">
            {#if c.status === 'imported'}
              <span class="conf conf--high"><Icon name="check" /> {t('importPage.imported')}</span>
            {:else}
              {#if c.status !== 'ready'}
                <button class="btn btn--sm btn--primary" onclick={() => candidateAction(c.id, 'confirm')}>{t('importPage.confirm')}</button>
              {/if}
              {#if !c.handler}
                <!-- The CV picker only applies to comic candidates; handler
                     candidates re-identify from the file on import. -->
                <button class="btn btn--sm btn--ghost" onclick={() => changeMatch(c)}>{t('importPage.changeMatch')}</button>
              {/if}
              {#if c.status !== 'skipped'}
                <button class="btn btn--sm btn--ghost" onclick={() => candidateAction(c.id, 'skip')}>{t('importPage.skip')}</button>
              {:else}
                <button class="btn btn--sm btn--ghost" onclick={() => candidateAction(c.id, 'confirm')}>{t('importPage.unskip')}</button>
              {/if}
            {/if}
          </div>
        </div>
      {/each}
    </div>
  </div>
</main>

<style>
  .import-err { display: inline-flex; align-items: center; gap: 4px; color: var(--red); }
</style>
