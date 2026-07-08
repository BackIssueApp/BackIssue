<script>
  import { goBack } from '../lib/router.svelte.js';
  import { apiGet, apiPost } from '../lib/api.js';
  import { subscribe } from '../lib/events.svelte.js';
  import { fmt } from '../lib/util.js';
  import { openCvPicker } from './CvPickerModal.svelte';
  import { confirmDialog } from './DialogModal.svelte';
  import { notify } from '../lib/toasts.svelte.js';
  import Icon from '../lib/Icon.svelte';

  let { active = false } = $props();

  const IMPORT_CONF = {
    high: { label: 'strong match', cls: 'conf--high' },
    medium: { label: 'likely', cls: 'conf--med' },
    low: { label: 'low confidence', cls: 'conf--low' },
    manual: { label: 'you picked', cls: 'conf--high' },
    none: { label: 'no match', cls: 'conf--none' },
    error: { label: 'search failed — rescan retries', cls: 'conf--low' },
  };

  let st = $state(null);
  let filter = $state('all');

  async function renderImport() {
    try { st = await apiGet('/api/import'); } catch { /* keep last */ }
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
    if (cands.length) bits.push(`${fmt(cands.length)} found`);
    if (review) bits.push(`${fmt(review)} to review`);
    if (ready) bits.push(`${fmt(ready)} ready`);
    if (st?.error) bits.push('⚠ ' + st.error);
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
      title: 'Full rescan?',
      message: 'The current list is cleared — unimported review work (confirms, skips, manual matches) is discarded.',
      confirmLabel: 'Rescan everything', danger: true,
    }))) return;
    const r = await apiPost('/api/import/scan', { fresh: true });
    if (r?.error) return notify(r.error, 'error');
    renderImport();
  }
  async function run() {
    if (!(await confirmDialog({
      title: 'Import all ready series?',
      message: 'Files stay where they are; matched folders become ComicVine series in your collection.',
      confirmLabel: 'Import',
    }))) return;
    const r = await apiPost('/api/import/run');
    if (r?.error) return notify(r.error, 'error');
    notify('Importing ready series…', 'info');
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
      notify(`Matched to ${v.name}${v.start_year ? ` (${v.start_year})` : ''}.`, 'ok');
      renderImport();
    }, { files: c.file_count });
  }
</script>

<main id="import-page" class="scan-page import-page">
  <div class="scan-page__bar">
    <button id="import-back" class="btn btn--ghost" onclick={goBack}><Icon name="arrow-left" /> Back</button>
    <h2 class="scan-page__title">Import library</h2>
    <span id="import-summary" class="scan-summary">{summary}</span>
    <span class="settings-spacer"></span>
    <button id="import-scan" class="btn btn--ghost" title="Find series added since the last scan — keeps your review work" disabled={busy} onclick={scan}>
      {#if busy && st?.phase === 'scanning'}Scanning… {fmt(st.done || 0)}/{fmt(st.total || 0)}{:else}<Icon name="refresh" /> Scan for new{/if}</button>
    <button id="import-rescan" class="btn btn--ghost" title="Clear the list and rescan everything (discards unimported review work)" disabled={busy} onclick={rescan}>Full rescan</button>
    <button id="import-run" class="btn btn--primary" disabled={busy || ready === 0} onclick={run}>
      {busy && st?.phase === 'importing' ? `Importing… ${fmt(st.done || 0)}/${fmt(st.total || 0)}` : (ready ? `Import ${fmt(ready)}` : 'Import')}</button>
  </div>
  <div class="import-scroll">
    <p class="modal__note" id="import-intro">Scan your root folders for series not yet in the collection. Each is matched to ComicVine — confirm or fix the matches, then import. Files stay where they are.</p>
    <div class="filter" id="import-filter">
      {#each [['all', 'All'], ['review', 'Needs review'], ['ready', 'Ready'], ['skipped', 'Skipped']] as [key, label] (key)}
        <button class="filter__btn" class:is-active={filter === key} onclick={() => { filter = key; }}>{label}</button>
      {/each}
    </div>
    <div id="import-list" class="import-list">
      {#if st && !cands.length}
        <div class="list-note">No candidates yet. Click “Scan for new” to find series to import.</div>
      {:else if st && !shown.length}
        <div class="list-note">Nothing in this filter.</div>
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
              <span class="scan-muted">· {fmt(c.file_count || 0)} files</span></div>
            {#if c.cv_id}
              <div class="import-match"><b>{c.cv_name || 'ComicVine'}</b>
                {#if c.cv_year}<span class="scan-muted">({c.cv_year})</span>{/if}
                <span class="conf {conf.cls}">{conf.label}</span></div>
            {:else if c.confidence === 'error'}
              <div class="import-match import-match--none">ComicVine search failed <span class="conf conf--low">“Scan for new” retries it</span></div>
            {:else}
              <div class="import-match import-match--none">No ComicVine match <span class="conf conf--none">will import unmatched</span></div>
            {/if}
            <div class="import-path" title={c.folder}>{c.folder}</div>
          </div>
          <div class="import-actions">
            {#if c.status === 'imported'}
              <span class="conf conf--high"><Icon name="check" /> imported</span>
            {:else}
              {#if c.status !== 'ready'}
                <button class="btn btn--sm btn--primary" onclick={() => candidateAction(c.id, 'confirm')}>Confirm</button>
              {/if}
              <button class="btn btn--sm btn--ghost" onclick={() => changeMatch(c)}>Change match</button>
              {#if c.status !== 'skipped'}
                <button class="btn btn--sm btn--ghost" onclick={() => candidateAction(c.id, 'skip')}>Skip</button>
              {:else}
                <button class="btn btn--sm btn--ghost" onclick={() => candidateAction(c.id, 'confirm')}>Un-skip</button>
              {/if}
            {/if}
          </div>
        </div>
      {/each}
    </div>
  </div>
</main>
