<script module>
  import { openModal, closeModal, modals } from '../lib/modals.svelte.js';
  import { detail } from '../lib/store.svelte.js';
  import { apiPost } from '../lib/api.js';

  const m = $state({ title: '', query: '', results: null, errors: [], note: '', searching: false });

  export function openPackSearch() {
    if (!detail.series) return;
    m.title = `Search packs · ${detail.series.title || ''}`;
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
    m.searching = true; m.note = 'Searching enabled sources for packs…'; m.results = null; m.errors = [];
    let data;
    try { data = await apiPost('/api/packs/search', body); }
    catch (e) { m.searching = false; m.note = String(e); return; }
    m.searching = false;
    m.errors = data.errors || [];
    if (!data.sources || !data.sources.length) { m.note = 'No pack-capable sources are enabled.'; m.results = []; return; }
    const results = data.results || [];
    m.results = results.map((r) => ({ ...r, _busy: false }));
    m.note = results.length ? '' : 'No packs found across your sources. Try a broader query (series name only).';
  }
</script>

<script>
  import { notify } from '../lib/toasts.svelte.js';
  import { humanBytes } from '../lib/util.js';
  import { trapFocus } from '../lib/dom.js';
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
      notify(`Pack queued via ${r.source} — this series’ missing issues import automatically (watch the queue / Jobs).`, 'ok');
    } else {
      notify('Download failed: ' + (res?.error || 'unknown error'), 'error');
      r._busy = false;
    }
  }
</script>

{#if open}
  <div id="packs-modal" class="modal" onclick={(e) => { if (e.target === e.currentTarget) closeModal('packs'); }}>
    <div class="modal__panel modal__panel--wide" use:trapFocus role="dialog" aria-label="Search packs">
      <div class="modal__head" style="display:flex;justify-content:space-between;align-items:center;">
        <h3 style="margin:0;">{m.title}</h3>
        <button class="modal__x" aria-label="Close" onclick={() => closeModal('packs')}><Icon name="close" /></button>
      </div>
      <p class="modal__note" style="margin:6px 0 0;">Multi-issue packs (whole series, TPBs, issue ranges) across every enabled source. Download one — every issue this series is <b>missing</b> is imported from it; owned issues are skipped. Torrents/usenet download via your client; other sources download in-app.</p>
      <div class="usenet-search-row">
        <input type="search" spellcheck="false" placeholder="Series name…" bind:value={m.query}
          onkeydown={(e) => { if (e.key === 'Enter') runPackSearch(); }} />
        <button class="btn btn--primary" type="button" onclick={runPackSearch}>Search</button>
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
              <button class="btn btn--primary btn--sm" disabled={r._busy} onclick={() => grab(r)}>{r._busy ? 'Sending…' : 'Download'}</button>
            </div>
          </div>
        {/each}
      </div>
    </div>
  </div>
{/if}
