<script module>
  import { openModal, closeModal, modals } from '../lib/modals.svelte.js';
  import { detail } from '../lib/store.svelte.js';
  import { apiPost } from '../lib/api.js';

  const m = $state({ target: null, title: '', query: '', results: null, searched: null, errors: [], note: '', searching: false });

  export function openSourceSearch(cvIssueId, number) {
    m.target = { cvIssueId, number };
    m.title = `Search sources — ${detail.series?.title || 'Issue'} #${number ?? '?'}`;
    m.query = '';
    m.results = null; m.searched = null; m.errors = []; m.note = ''; m.searching = false;
    openModal('search');
    // Auto-search from the issue's identity; a typed query overrides it.
    doSearch({ seriesId: detail.series?.id, cvIssueId, number });
  }

  export function runSearch() {
    const q = m.query.trim();
    doSearch({ query: q || undefined, seriesId: detail.series?.id, cvIssueId: m.target?.cvIssueId, number: m.target?.number });
  }

  async function doSearch(body) {
    m.searching = true; m.note = 'Searching enabled sources…'; m.results = null; m.errors = [];
    let data;
    try { data = await apiPost('/api/search', body); }
    catch { m.searching = false; m.note = 'Search failed — is the app running?'; return; }
    m.searching = false;
    m.errors = data.errors || [];
    if (!data.sources || !data.sources.length) { m.note = 'No download sources are enabled (Settings → Download sources).'; m.results = []; return; }
    const results = data.results || [];
    m.searched = (data.searched && data.searched.length) ? data.searched : null;
    m.results = results.map((r) => ({ ...r, _busy: false }));
    m.note = results.length ? '' : 'No releases found across your sources. Try a broader query, or add an alt name to the series.';
  }
</script>

<script>
  import { reloadDetail } from '../lib/store.svelte.js';
  import { notify } from '../lib/toasts.svelte.js';
  import { fmt, humanBytes } from '../lib/util.js';
  import Icon from '../lib/Icon.svelte';

  const open = $derived(modals.stack.includes('search'));

  let searchEl = $state(null);
  $effect(() => { if (open && searchEl) searchEl.focus(); });

  // Per-source badge tint (reuses existing hist-src color classes).
  const sourceClass = (s) => `srcbadge srcbadge--${s}`;

  async function grab(r) {
    r._busy = true;
    let res;
    try {
      res = await apiPost('/api/search/grab', {
        result: r,
        seriesId: detail.series?.id,
        cvIssueId: m.target?.cvIssueId,
        number: m.target?.number,
        name: detail.series?.title ? `${detail.series.title} #${m.target?.number}` : r.title,
      });
    } catch (e) { res = { error: String(e) }; }
    if (res && (res.queued || res.grabbed)) {
      closeModal('search');
      notify(r.isPack
        ? `Pack queued via ${r.source} — its missing issues import automatically (watch the queue).`
        : `Download queued via ${r.source} — watch the queue.`, 'ok');
      reloadDetail();
    } else {
      notify('Download failed: ' + (res?.error || 'unknown error'), 'error');
      r._busy = false;
    }
  }
</script>

{#if open}
  <div id="search-modal" class="modal" onclick={(e) => { if (e.target === e.currentTarget) closeModal('search'); }}>
    <div class="modal__panel modal__panel--wide" role="dialog" aria-label="Search sources">
      <div class="modal__head" style="display:flex;justify-content:space-between;align-items:center;">
        <h3 style="margin:0;">{m.title}</h3>
        <button class="modal__x" aria-label="Close" onclick={() => closeModal('search')}><Icon name="close" /></button>
      </div>
      <p class="modal__note" style="margin:6px 0 0;">Searches every enabled source and merges the results, best match first. Pick one to download it — torrents and usenet download via your client; other sources download in-app.</p>
      <div class="usenet-search-row">
        <input id="search-input" type="search" spellcheck="false" placeholder="Series and issue, or any query…" bind:this={searchEl} bind:value={m.query}
          onkeydown={(e) => { if (e.key === 'Enter') runSearch(); }} />
        <button class="btn btn--primary" type="button" onclick={runSearch}>Search</button>
      </div>
      <div id="search-results" class="usenet-results">
        {#if m.searched}
          <div class="modal__note" style="margin:0 0 8px;">Searched: {m.searched.join(' · ')}</div>
        {/if}
        {#each m.errors as err, i (i)}
          <div class="list-note list-note--warn"><Icon name="alert-triangle" /> {err}</div>
        {/each}
        {#if m.note}
          <div class="list-note">{m.note}</div>
        {/if}
        {#each m.results || [] as r (r.rid)}
          <div class="un-row">
            <div class="un-info">
              <div class="un-title"><span class={sourceClass(r.source)}>{r.source}</span>{#if r.isPack}<span class="srcbadge srcbadge--pack">pack</span>{/if} {r.title}</div>
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
