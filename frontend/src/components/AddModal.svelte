<script module>
  import Icon from '../lib/Icon.svelte';
  import { openModal, closeModal, modals } from '../lib/modals.svelte.js';

  const m = $state({ query: '', results: null, error: '' });

  export function openAddModal() {
    m.query = ''; m.results = null; m.error = '';
    openModal('add');
  }
</script>

<script>
  import { apiGet, apiPost } from '../lib/api.js';
  import { navigate } from '../lib/router.svelte.js';
  import { loadCollection } from '../lib/store.svelte.js';
  import { notify } from '../lib/toasts.svelte.js';
  import { fmt } from '../lib/util.js';
  import { trapFocus } from '../lib/dom.js';

  const open = $derived(modals.stack.includes('add'));

  let searchEl = $state(null);
  $effect(() => { if (open && searchEl) searchEl.focus(); });

  let timer;
  function onInput() { clearTimeout(timer); timer = setTimeout(() => search(m.query), 200); }

  let searching = $state(false);
  let needsKey = $state(false); // missing-ComicVine-key dead end → guided fix
  async function search(q) {
    if (q.trim().length < 2) { m.results = null; m.error = ''; return; }
    searching = true; m.error = ''; needsKey = false;
    let list;
    try { list = await apiGet('/api/cv/search?q=' + encodeURIComponent(q)); }
    catch { m.error = 'Search failed — is the app reachable?'; searching = false; return; }
    searching = false;
    if (list.error) {
      // The #1 first-run dead end: no ComicVine key. Point at the fix.
      if (/comicvine|api key/i.test(String(list.error))) { needsKey = true; m.error = ''; m.results = null; return; }
      m.error = list.error; m.results = null; return;
    }
    m.results = (Array.isArray(list) ? list : []).slice(0, 25).map((v) => ({ ...v, _label: 'Add', _busy: false }));
  }

  async function add(v) {
    v._busy = true; v._label = 'Adding…';
    try {
      const r = await apiPost('/api/collection/add-cv', { comicvineId: v.id });
      if (r.error) { notify('Add failed: ' + r.error, 'error'); v._busy = false; v._label = 'Add'; return; }
      // Say what actually happened: how many issues were queued, or why none.
      v._label = r.queued ? `Added — ${r.queued} queued` :
        r.noSources ? 'Added (no sources enabled)' :
        r.outcome === 'created' ? 'Added' : 'Already in library';
      if (r.noSources) notify('Added. Nothing was queued — no download sources are enabled (Settings → Download sources).', 'info');
      loadCollection();
    } catch { notify('Add failed', 'error'); v._busy = false; v._label = 'Add'; }
  }
</script>

{#if open}
  <div id="add-modal" class="modal" onclick={(e) => { if (e.target === e.currentTarget) closeModal('add'); }}>
    <div class="modal__panel" use:trapFocus role="dialog" aria-label="Add series">
      <div class="modal__head" style="display:flex;justify-content:space-between;align-items:center;">
        <h3 style="margin:0;">Add a series from ComicVine</h3>
        <button id="add-modal-x" class="modal__x" aria-label="Close" onclick={() => closeModal('add')}><Icon name="close" /></button>
      </div>
      <input id="add-search" type="search" spellcheck="false" placeholder="Search ComicVine…" bind:this={searchEl} bind:value={m.query} oninput={onInput}
        style="width:100%;margin:10px 0;padding:8px 11px;background:var(--ink);border:1px solid var(--line);border-radius:6px;color:var(--text);" />
      <div id="add-results" class="add-results">
        {#if searching}
          <div class="list-note">Searching ComicVine…</div>
        {:else if needsKey}
          <div class="list-note">Searching needs a free ComicVine API key — it identifies every series and issue.
            <button class="btn btn--primary btn--sm" style="margin-left:8px" onclick={() => { closeModal('add'); navigate('/settings'); }}>Open Settings</button></div>
        {:else if m.error}
          <div class="list-note">{m.error}</div>
        {:else if m.results && !m.results.length}
          <div class="list-note">No series found.</div>
        {:else if m.results}
          {#each m.results as v (v.id)}
            <div class="add-row">
              <span>{v.name || '?'}
                {#if v.start_year}<span class="scan-muted">({v.start_year})</span>{/if}
                <span class="scan-muted">{v.publisher || ''} · {fmt(v.count_of_issues || 0)} issues</span></span>
              <button class="btn btn--ghost btn--sm" disabled={v._busy || v._label !== 'Add'} onclick={() => add(v)}>{v._label}</button>
            </div>
          {/each}
        {/if}
      </div>
    </div>
  </div>
{/if}
