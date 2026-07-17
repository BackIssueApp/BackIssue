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
  import { status } from '../lib/status.svelte.js';
  import Cover from './Cover.svelte';

  // Manga lane: searches the metadata server's manga catalog instead of
  // ComicVine, and adds series into the Manga library (created on first add).
  let mangaMode = $state(false);
  const mangaLib = $derived((status.libraries || []).find((l) => l.type === 'manga'));
  const sourceLabel = $derived(mangaMode ? 'the manga catalog' : 'ComicVine');

  const open = $derived(modals.stack.includes('add'));

  let searchEl = $state(null);
  $effect(() => { if (open && searchEl) searchEl.focus(); });

  let timer;
  function onInput() { clearTimeout(timer); timer = setTimeout(() => search(m.query), 200); }
  function setManga(on) { if (mangaMode === on) return; mangaMode = on; search(m.query); }

  let searching = $state(false);
  let needsKey = $state(false); // missing-ComicVine-key dead end → guided fix
  // Debounced, but responses can still arrive out of order (a broad early query
  // like "hu" resolving after "hulk"). Tag each request; only the newest one may
  // write results, so a stale response can't clobber the current query's.
  let searchSeq = 0;
  async function search(q) {
    const seq = ++searchSeq;
    if (q.trim().length < 2) { m.results = null; m.error = ''; searching = false; return; }
    searching = true; m.error = ''; needsKey = false;
    let list;
    try { list = await apiGet('/api/cv/search?q=' + encodeURIComponent(q) + (mangaMode ? '&manga=1' : '')); }
    catch { if (seq === searchSeq) { m.error = 'Search failed — is the app reachable?'; searching = false; } return; }
    if (seq !== searchSeq) return; // superseded by a newer search — drop this response
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
      const r = await apiPost('/api/collection/add-cv', { comicvineId: v.id, manga: mangaMode });
      if (r.error) { notify('Add failed: ' + r.error, 'error'); v._busy = false; v._label = 'Add'; return; }
      // Say what actually happened: how many issues were queued, or why none.
      v._label = r.queued ? `Added — ${r.queued} queued` :
        r.noSources ? 'Added (no sources enabled)' :
        r.outcome === 'created' ? 'Added' : 'Already in library';
      v._done = true;
      if (r.noSources) notify('Added. Nothing was queued — no download sources are enabled (Settings → Download sources).', 'info');
      // The first manga add materializes the Manga library — without a folder
      // its downloads file into the comics root, so point at the fix.
      if (r.createdLibrary) notify(`Created the ${r.createdLibrary} library — give it a folder in Settings → Library so its downloads file separately.`, 'info');
      loadCollection();
    } catch { notify('Add failed', 'error'); v._busy = false; v._label = 'Add'; }
  }

  const ql = $derived(m.query.trim());
  const prompt = $derived(!needsKey && !m.error && ql.length < 2);
  const noResults = $derived(!needsKey && !m.error && !!m.results && !m.results.length);
</script>

{#if open}
  <div id="add-modal" class="modal addx-overlay" onclick={(e) => { if (e.target === e.currentTarget) closeModal('add'); }}>
    <div class="addx" use:trapFocus role="dialog" aria-label="Add series">
      <div class="addx__head">
        <div class="addx__icon"><Icon name="plus" size={18} /></div>
        <div class="addx__titles">
          <div class="addx__title">Add a series</div>
          <div class="addx__sub">Search {sourceLabel} and start tracking it</div>
        </div>
        <button id="add-modal-x" class="addx__x" aria-label="Close" onclick={() => closeModal('add')}><Icon name="close" size={16} /></button>
      </div>

      <div class="addx__switch-row">
        <div class="addx__switch" role="tablist">
          <button class="addx__seg" class:is-on={!mangaMode} role="tab" aria-selected={!mangaMode} onclick={() => setManga(false)}><Icon name="book" size={14} /> Comics</button>
          <button class="addx__seg" class:is-on={mangaMode} role="tab" aria-selected={mangaMode} title={mangaLib ? `Added series join the ${mangaLib.name} library` : 'Your Manga library is created on the first add'} onclick={() => setManga(true)}><Icon name="book" size={14} /> Manga</button>
        </div>
      </div>

      <div class="addx__search">
        <Icon name="search" size={16} />
        <input id="add-search" type="search" spellcheck="false" placeholder={`Search ${sourceLabel}…`} bind:this={searchEl} bind:value={m.query} oninput={onInput} />
        {#if searching}<span class="addx__spin"><Icon name="refresh" size={16} /></span>{/if}
      </div>

      <div id="add-results" class="addx__results">
        {#if needsKey}
          <div class="addx__keycard">
            <div class="addx__keyicon"><Icon name="shield" size={22} /></div>
            <div class="addx__keytitle">A ComicVine API key is required</div>
            <p class="addx__keybody">Searching identifies every series and issue via ComicVine. Add a free key to start.</p>
            <button class="addx__keycta" onclick={() => { closeModal('add'); navigate('/settings?tab=metadata'); }}>Open Settings → Metadata</button>
          </div>
        {:else if m.error}
          <div class="addx__empty">{m.error}</div>
        {:else if prompt}
          <div class="addx__prompt">
            <div class="addx__prompt-art"><Icon name="search" size={20} /></div>
            <div>Type at least 2 characters to search {sourceLabel}.</div>
          </div>
        {:else if noResults}
          <div class="addx__empty">No series found for “{ql}”.</div>
        {:else if m.results}
          {#each m.results as v (v.id)}
            <div class="addx__row" class:is-dim={v.inLibrary}>
              <Cover coverUrl={v.image_url} title={v.name || '?'} />
              <div class="addx__info">
                <div class="addx__name">
                  {#if v.site_detail_url}<a class="addx__link" href={v.site_detail_url} target="_blank" rel="noreferrer" title="View details">{v.name || '?'}</a>{:else}{v.name || '?'}{/if}
                  {#if v.start_year}<span class="addx__year">({v.start_year})</span>{/if}
                </div>
                <div class="addx__meta">{v.publisher || ''}{v.publisher ? ' · ' : ''}{fmt(v.count_of_issues || 0)} issues</div>
              </div>
              {#if v.inLibrary}
                <button class="addx__btn addx__btn--ghost" title="Already in your library — open it" onclick={() => { closeModal('add'); navigate('/series/' + v.seriesId); }}>In library</button>
              {:else if v._done}
                <button class="addx__btn addx__btn--done" disabled>{v._label}</button>
              {:else}
                <button class="addx__btn {v._label === 'Add' ? 'addx__btn--add' : 'addx__btn--ghost'}" disabled={v._busy || v._label !== 'Add'} onclick={() => add(v)}>{v._label}</button>
              {/if}
            </div>
          {/each}
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .addx-overlay { align-items: flex-start; padding: 64px 16px 16px; }
  .addx {
    width: 100%; max-width: 540px; max-height: calc(100vh - 90px);
    display: flex; flex-direction: column;
    background: var(--panel); border: 1px solid var(--line); border-radius: 16px;
    box-shadow: 0 24px 70px rgba(0,0,0,.6); overflow: hidden;
  }
  .addx__head { display: flex; align-items: center; gap: 12px; padding: 18px 20px 14px; }
  .addx__icon { width: 34px; height: 34px; border-radius: 9px; flex: none; display: grid; place-items: center; background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent); }
  .addx__titles { flex: 1; min-width: 0; }
  .addx__title { font-family: var(--font-display); font-size: 19px; letter-spacing: .03em; }
  .addx__sub { font-size: 12px; color: var(--faint); }
  .addx__x { width: 32px; height: 32px; display: grid; place-items: center; border: none; background: none; color: var(--faint); cursor: pointer; border-radius: 7px; flex: none; }
  .addx__x:hover { color: var(--text); background: var(--panel-2); }

  .addx__switch-row { padding: 0 20px 12px; }
  .addx__switch { display: inline-flex; background: var(--ink); border: 1px solid var(--line); border-radius: 9px; padding: 3px; }
  .addx__seg { display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 15px; border: none; border-radius: 7px; background: transparent; color: var(--faint); font: 600 12.5px var(--font-body); cursor: pointer; }
  .addx__seg.is-on { background: var(--panel-2); color: var(--text); }

  .addx__search { position: relative; display: flex; align-items: center; padding: 0 20px 14px; color: var(--faint); }
  /* Only the leading search icon (direct child) is pinned left — not the
     spinner's icon, which is nested in .addx__spin and pinned right. */
  .addx__search > :global(svg) { position: absolute; left: 33px; pointer-events: none; }
  .addx__search input { width: 100%; height: 44px; padding: 0 14px 0 40px; background: var(--ink); border: 1px solid var(--line); border-radius: 10px; color: var(--text); font: 15px var(--font-body); }
  .addx__search input:focus { outline: none; border-color: var(--accent); }
  .addx__spin { position: absolute; right: 34px; left: auto; color: var(--accent); display: flex; animation: addx-spin .9s linear infinite; }
  @keyframes addx-spin { to { transform: rotate(360deg); } }

  .addx__results { flex: 1; overflow-y: auto; padding: 0 12px 12px; min-height: 120px; }
  .addx__row { display: flex; align-items: center; gap: 13px; padding: 10px 12px; border-radius: 10px; transition: background .1s; }
  .addx__row:hover { background: rgba(255,255,255,.03); }
  .addx__row.is-dim .addx__info { opacity: .55; }
  .addx__row :global(.cover) { width: 38px; height: 52px; border-radius: 6px; }
  .addx__info { flex: 1; min-width: 0; }
  .addx__name { font-size: 13.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .addx__link { color: inherit; text-decoration: none; border-bottom: 1px dotted var(--line); }
  .addx__link:hover { color: var(--accent); border-bottom-color: var(--accent); }
  .addx__year { color: var(--faint); font-weight: 400; }
  .addx__meta { font-size: 12px; color: var(--faint); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .addx__btn { height: 32px; padding: 0 15px; border-radius: 8px; font: 600 12.5px var(--font-body); cursor: pointer; flex: none; white-space: nowrap; }
  .addx__btn--add { border: none; background: var(--accent); color: #fff; }
  .addx__btn--ghost { border: 1px solid var(--line); background: transparent; color: var(--muted); }
  .addx__btn--ghost:disabled { cursor: default; }
  .addx__btn--done { border: 1px solid rgba(95,211,138,.4); background: rgba(95,211,138,.1); color: var(--green); cursor: default; }

  .addx__prompt { padding: 44px 20px; text-align: center; color: var(--faint); font-size: 13px; }
  .addx__prompt-art { width: 46px; height: 46px; margin: 0 auto 12px; border-radius: 12px; background: var(--panel-2); display: grid; place-items: center; color: #6f6885; }
  .addx__empty { padding: 40px; text-align: center; color: var(--faint); font-size: 13px; }

  .addx__keycard { margin: 8px; padding: 18px; border: 1px solid rgba(255,194,75,.3); background: rgba(255,194,75,.06); border-radius: 12px; text-align: center; }
  .addx__keyicon { color: var(--amber); margin: 0 auto 10px; display: flex; justify-content: center; }
  .addx__keytitle { font-size: 13.5px; font-weight: 600; margin-bottom: 5px; }
  .addx__keybody { font-size: 12.5px; color: var(--muted); margin: 0 0 14px; line-height: 1.5; }
  .addx__keycta { height: 36px; padding: 0 16px; border: none; background: var(--accent); color: #fff; border-radius: 8px; font: 600 12.5px var(--font-body); cursor: pointer; }
</style>
