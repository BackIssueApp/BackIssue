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
  import Icon from '../lib/Icon.svelte';

  const open = $derived(modals.stack.includes('editmeta'));
  const RATINGS = ['', 'Everyone', 'Teen', 'Teen Plus', 'Mature', 'Explicit', 'Adult'];
  const STATUSES = ['', 'Ongoing', 'Completed', 'Cancelled', 'Hiatus'];
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
        if (r?.error) { m.saving = false; return notify('Location: ' + r.error, 'error'); }
        saved++;
      }
      if (aliases !== undefined) {
        const r = await apiPost(`/api/collection/${m.seriesId}/aliases`, { aliases });
        if (r?.error) { m.saving = false; return notify('Alt names: ' + r.error, 'error'); }
        saved++;
      }
    } catch { m.saving = false; return notify('Save failed — is the app reachable?', 'error'); }
    m.saving = false;
    notify(`Saved ${saved} field(s).`, 'ok');
    closeModal('editmeta');
    await reloadDetail();
    loadCollection();
  }

  async function reset() {
    m.saving = true;
    const r = await apiPost(`/api/collection/${m.seriesId}/metadata`, { reset: true });
    m.saving = false;
    if (r?.error) return notify(r.error, 'error');
    notify('Edits reset — refresh metadata to restore source values.', 'ok');
    closeModal('editmeta');
    await reloadDetail();
  }
</script>

{#snippet edited(key)}
  {#if isEdited(key)}<span class="em-edited" title="Hand-edited — refreshes won't overwrite it">edited</span>{/if}
{/snippet}

{#if open}
  <div class="modal" onclick={(e) => { if (e.target === e.currentTarget) closeModal('editmeta'); }}>
    <div class="modal__panel editmeta__panel" use:trapFocus role="dialog" aria-label="Edit metadata">
      <div class="modal__head" style="display:flex;justify-content:space-between;align-items:center;">
        <h3 style="margin:0;">Edit metadata — {m.cv?.name || 'series'}</h3>
        <button class="modal__x" aria-label="Close" onclick={() => closeModal('editmeta')}><Icon name="close" /></button>
      </div>
      <div class="em-form">
        <label class="em-field">
          <span>Title {@render edited('name')}</span>
          <input type="text" bind:this={firstInput} bind:value={m.fields.name} />
        </label>
        <div class="em-grid">
          <label class="em-field">
            <span>Publisher {@render edited('publisher')}</span>
            <input type="text" bind:value={m.fields.publisher} />
          </label>
          <label class="em-field">
            <span>Imprint {@render edited('metron_imprint')}</span>
            <input type="text" bind:value={m.fields.metron_imprint} placeholder="e.g. Vertigo" />
          </label>
        </div>
        <div class="em-grid em-grid--quad">
          <label class="em-field">
            <span>Start year {@render edited('start_year')}</span>
            <input type="text" inputmode="numeric" bind:value={m.fields.start_year} placeholder="2012" />
          </label>
          <label class="em-field">
            <span>End year {@render edited('metron_year_end')}</span>
            <input type="text" inputmode="numeric" bind:value={m.fields.metron_year_end} placeholder="—" />
          </label>
          <label class="em-field">
            <span>Status {@render edited('metron_status')}</span>
            <select bind:value={m.fields.metron_status}>{#each STATUSES as s (s)}<option value={s}>{s || '—'}</option>{/each}</select>
          </label>
          <label class="em-field">
            <span>Content rating {@render edited('metron_rating')}</span>
            <select bind:value={m.fields.metron_rating}>{#each RATINGS as r (r)}<option value={r}>{r || '—'}</option>{/each}</select>
          </label>
        </div>
        <div class="em-grid">
          <label class="em-field">
            <span>Series type {@render edited('metron_series_type')}</span>
            <input type="text" bind:value={m.fields.metron_series_type} placeholder="e.g. Limited Series" />
          </label>
          <label class="em-field">
            <span>Genres {@render edited('metron_genres')}</span>
            <input type="text" bind:value={m.fields.metron_genres} placeholder="comma-separated" />
          </label>
        </div>
        <label class="em-field">
          <span>Description {@render edited('description')}</span>
          <textarea rows="6" bind:value={m.fields.description}></textarea>
        </label>
        <label class="em-field">
          <span>Location on disk</span>
          <input type="text" spellcheck="false" bind:value={m.fields.location}
            placeholder={m.derivedLocation ? `auto: ${m.derivedLocation}` : 'blank = derived from your root folder'} />
        </label>
        <label class="em-field">
          <span>Alternative names</span>
          <textarea rows="2" spellcheck="false" bind:value={m.fields.aliases}
            placeholder={'Used when searching download sources — one per line or comma-separated (e.g. 2000AD)'}></textarea>
          {#if m.series?.cv_aliases?.length}
            <span class="em-subnote">ComicVine already knows: {m.series.cv_aliases.join(', ')} (searched automatically)</span>
          {/if}
        </label>
      </div>
      <div class="editmeta__actions">
        {#if editedSet.size}<button class="btn btn--ghost" disabled={m.saving} title="Drop every edit on this series — the next refresh restores source values" onclick={reset}>Reset all edits</button>{/if}
        <span class="em-hint">{dirty ? 'Unsaved changes' : ''}</span>
        <span style="flex:1"></span>
        <button class="btn btn--ghost" onclick={() => closeModal('editmeta')}>Cancel</button>
        <button class="btn btn--primary" disabled={m.saving || !dirty} onclick={save}>{m.saving ? 'Saving…' : 'Save'}</button>
      </div>
    </div>
  </div>
{/if}
