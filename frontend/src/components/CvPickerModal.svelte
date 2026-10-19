<script module>
  import { openModal, closeModal, modals } from '../lib/modals.svelte.js';
  import { t } from '../lib/i18n.svelte.js';

  const m = $state({ seriesId: null, onPick: null, files: null, query: '', results: null, pinned: null, note: '', searching: false });

  // onPick(volume): optional override — called with the chosen CV volume instead
  // of the default "link this collection series" behavior (used by the import
  // picker). context.files: how many comic files are on disk for this comic —
  // shown in the modal and used to rank candidates whose issue count is closest.
  export function openCvPicker(seriesId, title, onPick = null, context = {}) {
    m.seriesId = seriesId;
    m.onPick = onPick;
    m.files = Number.isFinite(context.files) && context.files > 0 ? context.files : null;
    m.query = title || '';
    m.results = null;
    m.pinned = null;
    m.note = '';
    openModal('cv');
    if (title) doSearch(title);
  }

  // Debounced, and last query wins: a broad, slow search ("batman") must not
  // land over the results for the newer one ("batman beyond").
  const searchSeq = latestGuard();
  async function doSearch(q) {
    const isLatest = searchSeq();
    if (q.trim().length < 2) { m.results = null; m.pinned = null; m.searching = false; m.note = ''; return; }

    // A pasted CV URL or bare volume id resolves that exact volume. A URL means
    // precisely one volume — skip the name search. Bare digits also fall through
    // to a name search underneath, in case they were a title (e.g. "2000 AD").
    const refId = parseCvVolumeRef(q);
    const isUrl = isExactCvRef(q);
    m.searching = true; m.results = null; m.pinned = null; m.note = t(refId ? 'cvPickerModal.lookingUp' : 'cvPickerModal.searching');
    let pinned = null;
    if (refId) {
      try {
        const v = await apiGet('/api/cv/volume/' + refId);
        if (v && !v.error) pinned = v;
      } catch { /* fall through to search */ }
      if (!isLatest()) return;
      if (isUrl) {
        m.searching = false; m.note = pinned ? '' : t('cvPickerModal.noVolumeWithId');
        m.pinned = pinned; m.results = [];
        return;
      }
    }

    let list = [];
    try { list = await apiGet('/api/cv/search?q=' + encodeURIComponent(q) + (m.seriesId ? '&seriesId=' + m.seriesId : '')); }
    catch { list = { error: t('cvPickerModal.searchFailed') }; }
    if (!isLatest()) return;
    // A failed search says so (with the reason) instead of "no volumes".
    if (list?.error && !pinned) { m.searching = false; m.results = []; m.note = list.error; return; }
    if (list?.error) list = [];
    // Everything the server returned, no cutoff: ComicVine lists same-name
    // volumes oldest-first, so a cap hides exactly the newest series.
    const rows = rankCvResults((Array.isArray(list) ? list : []).filter((v) => v.id !== refId), m.files);
    m.searching = false;
    m.pinned = pinned;
    m.results = rows;
    m.note = (!rows.length && !pinned) ? t('cvPickerModal.noVolumes') : '';
  }

  import { parseCvVolumeRef, isExactCvRef, rankCvResults, latestGuard } from '../lib/util.js';
  import { apiGet } from '../lib/api.js';
</script>

<script>
  import { apiPost } from '../lib/api.js';
  import { loadCollection, detail, reloadDetail } from '../lib/store.svelte.js';
  import { notify } from '../lib/toasts.svelte.js';
  import { fmt, stripTags, safeUrl } from '../lib/util.js';
  import { can } from '../lib/auth.svelte.js';
  import { trapFocus } from '../lib/dom.js';
  import Icon from '../lib/Icon.svelte';

  const open = $derived(modals.stack.includes('cv'));

  let searchEl = $state(null);
  $effect(() => { if (open && searchEl) searchEl.focus(); });

  let timer;
  function onInput() { clearTimeout(timer); timer = setTimeout(() => doSearch(m.query), 250); }

  let linkBusyId = $state(null);
  async function use(v) {
    linkBusyId = v.id;
    try {
      if (m.onPick) { await m.onPick(v); closeModal('cv'); return; }
      const r = await apiPost('/api/collection/' + m.seriesId + '/cv', { comicvineId: v.id });
      if (r.error) { notify(t('cvPickerModal.linkFailedWith', { error: r.error }), 'error'); return; }
      notify(v.start_year ? t('cvPickerModal.matchedToYear', { name: v.name, year: v.start_year }) : t('cvPickerModal.matchedTo', { name: v.name }), 'ok');
      closeModal('cv');
      loadCollection();
      if (detail.series && detail.series.id === m.seriesId) reloadDetail();
    } catch { notify(t('cvPickerModal.linkFailed'), 'error'); }
    finally { linkBusyId = null; }
  }

  // Closeness hint: exact/near matches to the on-disk file count get a badge.
  function closeness(v) {
    if (m.files == null || v.count_of_issues == null) return null;
    const d = Math.abs(v.count_of_issues - m.files);
    if (d === 0) return 'exact';
    if (d <= Math.max(2, m.files * 0.1)) return 'near';
    return null;
  }
  // The record's page at its metadata source — only for those who manage
  // settings, where sources are named anyway; everyone else sees no link.
  const cvUrl = (v) => (can('settings.manage') ? safeUrl(v.site_detail_url) : '');
</script>

{#snippet cvpRow(v, pinned)}
  <div class="cvp-row" class:cvp-row--pinned={pinned}>
    {#if v.image_url}
      <img class="cvp-cover" src={v.image_url} alt="" loading="lazy" referrerpolicy="no-referrer" />
    {:else}
      <div class="cvp-cover cvp-cover--none">?</div>
    {/if}
    <div class="cvp-info">
      <div class="cvp-name">{v.name || '?'}
        {#if v.start_year}<span class="cvp-year">({v.start_year})</span>{/if}
        {#if pinned}<span class="cvp-fit cvp-fit--exact">{t('cvPickerModal.idBadge', { id: fmt(v.id) })}</span>{/if}</div>
      <div class="cvp-meta">{v.publisher || t('cvPickerModal.unknownPublisher')} · {t('common.nIssues', { count: fmt(v.count_of_issues || 0) })}
        {#if closeness(v) === 'exact'}<span class="cvp-fit cvp-fit--exact">{t('cvPickerModal.equalsFiles', { count: fmt(m.files) })}</span>
        {:else if closeness(v) === 'near'}<span class="cvp-fit">{t('cvPickerModal.nearFiles', { count: fmt(m.files) })}</span>{/if}
        {#if cvUrl(v)}· <a href={cvUrl(v)} target="_blank" rel="noreferrer" class="cvp-link" onclick={(e) => e.stopPropagation()}>{t('cvPickerModal.sourceLink')} <Icon name="external-link" /></a>{/if}</div>
      {#if stripTags(v.deck || v.description || '')}
        <div class="cvp-deck">{stripTags(v.deck || v.description || '')}</div>
      {/if}
    </div>
    <div class="cvp-act">
      <button class="btn btn--primary btn--sm" disabled={linkBusyId != null} onclick={() => use(v)}>{linkBusyId === v.id ? t('cvPickerModal.linking') : t('cvPickerModal.use')}</button>
    </div>
  </div>
{/snippet}

{#if open}
  <div id="cv-modal" class="modal" onclick={(e) => { if (e.target === e.currentTarget) closeModal('cv'); }}>
    <div class="modal__panel" use:trapFocus role="dialog" aria-modal="true" aria-label={t('cvPickerModal.title')}>
      <div class="modal__head" style="display:flex;justify-content:space-between;align-items:center;">
        <h3 style="margin:0;">{t('cvPickerModal.title')}</h3>
        <button id="cv-modal-x" class="modal__x" aria-label={t('common.close')} onclick={() => closeModal('cv')}><Icon name="close" /></button>
      </div>
      <p id="cv-picker-note" class="modal__note" style="margin:6px 0 0;">
        {m.files ? t('cvPickerModal.filesNote', { count: m.files }) : ''}</p>
      <input id="cv-search" type="search" spellcheck="false" placeholder={t('cvPickerModal.searchPlaceholder')} bind:this={searchEl} bind:value={m.query} oninput={onInput}
        style="width:100%;margin:10px 0;padding:8px 11px;background:var(--ink);border:1px solid var(--line);border-radius:6px;color:var(--text);" />
      <div id="cv-results" class="add-results">
        {#if m.searching || m.note}
          <div class="list-note">{m.searching ? m.note : m.note}</div>
        {/if}
        {#if !m.searching}
          {#if m.pinned}{@render cvpRow(m.pinned, true)}{/if}
          {#each m.results || [] as v (v.id)}
            {@render cvpRow(v, false)}
          {/each}
        {/if}
      </div>
    </div>
  </div>
{/if}
