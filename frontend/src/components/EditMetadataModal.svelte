<script module>
  import { openModal, closeModal, modals } from '../lib/modals.svelte.js';

  const m = $state({ seriesId: null, cv: null, series: {}, derivedLocation: '', fields: {}, saving: false });

  /** Open the series metadata editor with the current values pre-filled.
   *  `series` = det.series (path/aliases live there, not on the CV row);
   *  `derivedLocation` = the auto-derived folder shown when no explicit path. */
  export function openEditMetadata(seriesId, cv, series = {}, derivedLocation = '') {
    m.seriesId = seriesId;
    m.cv = cv || {};
    m.series = series || {};
    m.derivedLocation = derivedLocation || '';
    m.fields = {
      name: cv?.name || '',
      publisher: cv?.publisher || '',
      start_year: cv?.start_year || '',
      metron_year_end: cv?.metron_year_end || '',
      metron_status: cv?.metron_status || '',
      metron_rating: cv?.metron_rating || '',
      metron_series_type: cv?.metron_series_type || '',
      metron_imprint: cv?.metron_imprint || '',
      metron_genres: (cv?.metron_genres || []).join(', '),
      description: String(cv?.description || ''),
      location: series?.path || '',
      aliases: series?.aliases || '',
    };
    m.saving = false;
    openModal('editmeta');
  }
</script>

<script>
  import { apiPost } from '../lib/api.js';
  import { notify } from '../lib/toasts.svelte.js';
  import { reloadDetail, loadCollection } from '../lib/store.svelte.js';
  import { trapFocus } from '../lib/dom.js';
  import { t } from '../lib/i18n.svelte.js';
  import Icon from '../lib/Icon.svelte';

  const open = $derived(modals.stack.includes('editmeta'));
  // Stored values stay English (the server and tags expect them); only the
  // option labels are translated.
  const RATINGS = [['', ''], ['Everyone', 'ratingEveryone'], ['Teen', 'ratingTeen'], ['Teen Plus', 'ratingTeenPlus'], ['Mature', 'ratingMature'], ['Explicit', 'ratingExplicit'], ['Adult', 'ratingAdult']];
  const STATUSES = [['', ''], ['Ongoing', 'statusOngoing'], ['Completed', 'statusCompleted'], ['Cancelled', 'statusCancelled'], ['Hiatus', 'statusHiatus']];
  const editedSet = $derived(new Set(m.cv?.user_fields || []));
  const isEdited = (k) => editedSet.has(k);

  let firstInput = $state(null);
  $effect(() => { if (open && firstInput) firstInput.focus(); });

  // Send only what actually changed from the values the modal opened with.
  // location + aliases are series-level (their own endpoints); the rest goes
  // to the lock-aware metadata endpoint.
  function changedFields() {
    const orig = {
      name: m.cv?.name || '', publisher: m.cv?.publisher || '', start_year: m.cv?.start_year || '',
      metron_year_end: m.cv?.metron_year_end || '', metron_status: m.cv?.metron_status || '',
      metron_rating: m.cv?.metron_rating || '', metron_series_type: m.cv?.metron_series_type || '',
      metron_imprint: m.cv?.metron_imprint || '', metron_genres: (m.cv?.metron_genres || []).join(', '),
      description: String(m.cv?.description || ''),
      location: m.series?.path || '', aliases: m.series?.aliases || '',
    };
    const out = {};
    for (const [k, v] of Object.entries(m.fields)) {
      if (String(v) === String(orig[k])) continue;
      out[k] = k === 'metron_genres'
        ? String(v).split(',').map((g) => g.trim()).filter(Boolean)
        : v;
    }
    return out;
  }
  const dirty = $derived(open && Object.keys(changedFields()).length > 0);

  async function save() {
    const all = changedFields();
    if (!Object.keys(all).length) { closeModal('editmeta'); return; }
    const { location, aliases, ...fields } = all;
    m.saving = true;
    let saved = 0;
    try {
      if (Object.keys(fields).length) {
        const r = await apiPost(`/api/collection/${m.seriesId}/metadata`, { fields });
        if (r?.error) { m.saving = false; return notify(r.error, 'error'); }
        saved += r.updated?.length || 0;
      }
      if (location !== undefined) {
        const r = await apiPost(`/api/collection/${m.seriesId}/path`, { path: String(location).trim() });
        if (r?.error) { m.saving = false; return notify(t('editMetadataModal.locationError', { error: r.error }), 'error'); }
        saved++;
      }
      if (aliases !== undefined) {
        const r = await apiPost(`/api/collection/${m.seriesId}/aliases`, { aliases });
        if (r?.error) { m.saving = false; return notify(t('editMetadataModal.altNamesError', { error: r.error }), 'error'); }
        saved++;
      }
    } catch { m.saving = false; return notify(t('editMetadataModal.saveFailed'), 'error'); }
    m.saving = false;
    notify(t('editMetadataModal.savedFields', { count: saved }), 'ok');
    closeModal('editmeta');
    await reloadDetail();
    loadCollection();
  }

  async function reset() {
    m.saving = true;
    const r = await apiPost(`/api/collection/${m.seriesId}/metadata`, { reset: true });
    m.saving = false;
    if (r?.error) return notify(r.error, 'error');
    notify(t('editMetadataModal.resetDone'), 'ok');
    closeModal('editmeta');
    await reloadDetail();
  }
</script>

{#snippet edited(key)}
  {#if isEdited(key)}<span class="em-edited" title={t('editMetadataModal.editedTitle')}>{t('editMetadataModal.edited')}</span>{/if}
{/snippet}

{#if open}
  <div class="modal" onclick={(e) => { if (e.target === e.currentTarget) closeModal('editmeta'); }}>
    <div class="modal__panel editmeta__panel" use:trapFocus role="dialog" aria-modal="true" aria-label={t('editMetadataModal.title', { name: m.cv?.name || t('editMetadataModal.seriesFallback') })}>
      <div class="modal__head" style="display:flex;justify-content:space-between;align-items:center;">
        <h3 style="margin:0;">{t('editMetadataModal.title', { name: m.cv?.name || t('editMetadataModal.seriesFallback') })}</h3>
        <button class="modal__x" aria-label={t('common.close')} onclick={() => closeModal('editmeta')}><Icon name="close" /></button>
      </div>
      <div class="em-form">
        <label class="em-field">
          <span>{t('common.title')} {@render edited('name')}</span>
          <input type="text" bind:this={firstInput} bind:value={m.fields.name} />
        </label>
        <div class="em-grid">
          <label class="em-field">
            <span>{t('common.publisher')} {@render edited('publisher')}</span>
            <input type="text" bind:value={m.fields.publisher} />
          </label>
          <label class="em-field">
            <span>{t('editMetadataModal.imprint')} {@render edited('metron_imprint')}</span>
            <input type="text" bind:value={m.fields.metron_imprint} placeholder={t('editMetadataModal.imprintPlaceholder')} />
          </label>
        </div>
        <div class="em-grid em-grid--quad">
          <label class="em-field">
            <span>{t('editMetadataModal.startYear')} {@render edited('start_year')}</span>
            <input type="text" inputmode="numeric" bind:value={m.fields.start_year} placeholder="2012" />
          </label>
          <label class="em-field">
            <span>{t('editMetadataModal.endYear')} {@render edited('metron_year_end')}</span>
            <input type="text" inputmode="numeric" bind:value={m.fields.metron_year_end} placeholder="—" />
          </label>
          <label class="em-field">
            <span>{t('common.status')} {@render edited('metron_status')}</span>
            <select bind:value={m.fields.metron_status}>{#each STATUSES as [s, k] (s)}<option value={s}>{k ? t('editMetadataModal.' + k) : '—'}</option>{/each}</select>
          </label>
          <label class="em-field">
            <span>{t('editMetadataModal.contentRating')} {@render edited('metron_rating')}</span>
            <select bind:value={m.fields.metron_rating}>{#each RATINGS as [r, k] (r)}<option value={r}>{k ? t('editMetadataModal.' + k) : '—'}</option>{/each}</select>
          </label>
        </div>
        <div class="em-grid">
          <label class="em-field">
            <span>{t('editMetadataModal.seriesType')} {@render edited('metron_series_type')}</span>
            <input type="text" bind:value={m.fields.metron_series_type} placeholder={t('editMetadataModal.seriesTypePlaceholder')} />
          </label>
          <label class="em-field">
            <span>{t('editMetadataModal.genres')} {@render edited('metron_genres')}</span>
            <input type="text" bind:value={m.fields.metron_genres} placeholder={t('editMetadataModal.genresPlaceholder')} />
          </label>
        </div>
        <label class="em-field">
          <span>{t('editMetadataModal.description')} {@render edited('description')}</span>
          <textarea rows="6" bind:value={m.fields.description}></textarea>
        </label>
        <label class="em-field">
          <span>{t('editMetadataModal.location')}</span>
          <input type="text" spellcheck="false" bind:value={m.fields.location}
            placeholder={m.derivedLocation ? t('editMetadataModal.locationAuto', { path: m.derivedLocation }) : t('editMetadataModal.locationBlank')} />
        </label>
        <label class="em-field">
          <span>{t('editMetadataModal.altNames')}</span>
          <textarea rows="2" spellcheck="false" bind:value={m.fields.aliases}
            placeholder={t('editMetadataModal.altNamesPlaceholder')}></textarea>
          {#if m.series?.cv_aliases?.length}
            <span class="em-subnote">{t('editMetadataModal.knownAliases', { names: m.series.cv_aliases.join(', ') })}</span>
          {/if}
        </label>
      </div>
      <div class="editmeta__actions">
        {#if editedSet.size}<button class="btn btn--ghost" disabled={m.saving} title={t('editMetadataModal.resetTitle')} onclick={reset}>{t('editMetadataModal.resetAll')}</button>{/if}
        <span class="em-hint">{dirty ? t('editMetadataModal.unsaved') : ''}</span>
        <span style="flex:1"></span>
        <button class="btn btn--ghost" onclick={() => closeModal('editmeta')}>{t('common.cancel')}</button>
        <button class="btn btn--primary" disabled={m.saving || !dirty} onclick={save}>{m.saving ? t('editMetadataModal.saving') : t('common.save')}</button>
      </div>
    </div>
  </div>
{/if}
