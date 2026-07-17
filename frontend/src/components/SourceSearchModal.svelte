<script module>
  import { openModal, closeModal, modals } from '../lib/modals.svelte.js';
  import { detail } from '../lib/store.svelte.js';
  import { apiPost } from '../lib/api.js';

  const m = $state({ target: null, title: '', context: '', query: '', results: null, searched: null, errors: [], note: '', searching: false });

  export function openSourceSearch(cvIssueId, number) {
    m.target = { cvIssueId, number };
    m.context = `${detail.series?.title || 'Issue'} #${number ?? '?'}`;
    m.title = `Search sources — ${m.context}`;
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
    m.searching = true; m.note = ''; m.results = null; m.errors = [];
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
  import { humanBytes } from '../lib/util.js';
  import { trapFocus } from '../lib/dom.js';
  import Icon from '../lib/Icon.svelte';

  const open = $derived(modals.stack.includes('search'));

  let searchEl = $state(null);
  $effect(() => { if (open && searchEl) searchEl.focus(); });

  // Source badge tint: usenet green, torrent cyan, everything else (in-app/web
  // download sources) accent.
  const srcTone = (s) => s === 'usenet' ? 'var(--green)' : s === 'torrent' ? 'var(--cyan)' : 'var(--accent)';
  // Seeders read at a glance: healthy ≥100 green, ok ≥20 amber, thin below.
  const seedTone = (n) => n >= 100 ? 'var(--green)' : n >= 20 ? 'var(--amber)' : 'var(--faint)';
  // When we show the ▲seeders badge, drop the duplicated "N seeders · " that the
  // torrent source prefixes onto its meta line.
  const metaText = (r) => (r.seeders != null && r.seeders >= 0) ? String(r.meta || '').replace(/^\d+\s*seeders\s*·\s*/, '') : (r.meta || '');

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
  <div id="search-modal" class="modal srchx-overlay" onclick={(e) => { if (e.target === e.currentTarget) closeModal('search'); }}>
    <div class="srchx" use:trapFocus role="dialog" aria-label="Search sources">
      <div class="srchx__head">
        <div class="srchx__icon"><Icon name="search" size={16} /></div>
        <div class="srchx__titles">
          <div class="srchx__title">Search sources</div>
          <div class="srchx__sub">{m.context}</div>
        </div>
        <button class="srchx__x" aria-label="Close" onclick={() => closeModal('search')}><Icon name="close" size={16} /></button>
      </div>

      <div class="srchx__searchrow">
        <div class="srchx__field">
          <Icon name="search" size={16} />
          <input id="search-input" type="search" spellcheck="false" placeholder="Series and issue, or any query…" bind:this={searchEl} bind:value={m.query}
            onkeydown={(e) => { if (e.key === 'Enter') runSearch(); }} />
        </div>
        <button class="srchx__go" type="button" onclick={runSearch}>Search</button>
      </div>
      {#if m.searched}
        <div class="srchx__searched"><span class="srchx__searched-label">Searched</span>{#each m.searched as c (c)}<span class="srchx__chip">{c}</span>{/each}</div>
      {/if}

      <div id="search-results" class="srchx__results">
        {#if m.searching}
          <div class="srchx__busy"><span class="srchx__spin"><Icon name="refresh" size={16} /></span><div>Searching enabled sources…</div></div>
        {:else}
          {#each m.errors as err, i (i)}
            <div class="srchx__err"><Icon name="alert-triangle" size={14} /> {err}</div>
          {/each}
          {#each m.results || [] as r (r.rid)}
            <div class="srchx__row">
              <div class="srchx__info">
                <div class="srchx__toprow">
                  <span class="srchx__srcbadge" style="color:{srcTone(r.source)}; border-color:color-mix(in srgb, {srcTone(r.source)} 45%, transparent); background:color-mix(in srgb, {srcTone(r.source)} 12%, transparent);">{r.source}</span>
                  {#if r.isPack}<span class="srchx__pack">Pack</span>{/if}
                  <span class="srchx__rtitle">{r.title}</span>
                </div>
                <div class="srchx__rmeta">
                  {#if r.size}<span>{humanBytes(r.size)}</span>{/if}
                  {#if r.seeders != null && r.seeders >= 0}<span style="color:{seedTone(r.seeders)};">▲ {r.seeders}</span>{/if}
                  {#if metaText(r)}<span>{metaText(r)}</span>{/if}
                </div>
              </div>
              <button class="srchx__grab" disabled={r._busy} onclick={() => grab(r)}>{r._busy ? 'Sending…' : 'Download'}</button>
            </div>
          {/each}
          {#if m.note}<div class="srchx__note">{m.note}</div>{/if}
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .srchx-overlay { align-items: flex-start; padding: 64px 16px 16px; }
  .srchx {
    width: 100%; max-width: 720px; max-height: calc(100vh - 90px);
    display: flex; flex-direction: column;
    background: var(--panel); border: 1px solid var(--line); border-radius: 16px;
    box-shadow: 0 24px 70px rgba(0,0,0,.6); overflow: hidden;
  }
  .srchx__head { display: flex; align-items: center; gap: 12px; padding: 18px 20px 12px; }
  .srchx__icon { width: 34px; height: 34px; border-radius: 9px; flex: none; display: grid; place-items: center; background: color-mix(in srgb, var(--cyan) 14%, transparent); color: var(--cyan); }
  .srchx__titles { flex: 1; min-width: 0; }
  .srchx__title { font-family: var(--font-display); font-size: 19px; letter-spacing: .03em; }
  .srchx__sub { font-size: 12px; color: var(--faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .srchx__x { width: 32px; height: 32px; display: grid; place-items: center; border: none; background: none; color: var(--faint); cursor: pointer; border-radius: 7px; flex: none; }
  .srchx__x:hover { color: var(--text); background: var(--panel-2); }

  .srchx__searchrow { display: flex; gap: 8px; padding: 0 20px 12px; }
  .srchx__field { position: relative; flex: 1; display: flex; align-items: center; color: var(--faint); }
  .srchx__field :global(svg) { position: absolute; left: 13px; pointer-events: none; }
  .srchx__field input { width: 100%; height: 42px; padding: 0 14px 0 40px; background: var(--ink); border: 1px solid var(--line); border-radius: 10px; color: var(--text); font: 14px var(--font-body); }
  .srchx__field input:focus { outline: none; border-color: var(--accent); }
  .srchx__go { height: 42px; padding: 0 20px; border: none; background: var(--accent); color: #fff; border-radius: 10px; font: 600 13.5px var(--font-body); cursor: pointer; flex: none; }

  .srchx__searched { display: flex; align-items: center; gap: 8px; padding: 0 20px 12px; flex-wrap: wrap; }
  .srchx__searched-label { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: #6f6885; }
  .srchx__chip { font: 11px var(--font-mono); color: var(--muted); background: var(--panel-2); border-radius: 5px; padding: 3px 8px; }

  .srchx__results { flex: 1; overflow-y: auto; padding: 0 12px 12px; min-height: 140px; }
  .srchx__busy { padding: 44px; text-align: center; color: var(--faint); font-size: 13px; }
  .srchx__spin { display: inline-flex; color: var(--accent); animation: srchx-spin .9s linear infinite; margin-bottom: 10px; }
  @keyframes srchx-spin { to { transform: rotate(360deg); } }
  .srchx__err { display: flex; align-items: center; gap: 8px; margin: 6px 8px; padding: 8px 11px; border: 1px solid rgba(255,194,75,.28); background: rgba(255,194,75,.06); border-radius: 8px; font-size: 12px; color: var(--amber); }

  .srchx__row { display: flex; align-items: center; gap: 13px; padding: 11px 12px; border-radius: 10px; transition: background .1s; }
  .srchx__row:hover { background: rgba(255,255,255,.03); }
  .srchx__info { flex: 1; min-width: 0; }
  .srchx__toprow { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
  .srchx__srcbadge { font: 600 10px var(--font-body); text-transform: uppercase; letter-spacing: .04em; border: 1px solid; border-radius: 5px; padding: 2px 7px; }
  .srchx__pack { font: 600 9.5px var(--font-body); text-transform: uppercase; letter-spacing: .04em; color: var(--amber); border: 1px solid rgba(255,194,75,.4); border-radius: 4px; padding: 2px 6px; }
  .srchx__rtitle { font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .srchx__rmeta { display: flex; align-items: center; gap: 10px; margin-top: 5px; font: 11.5px var(--font-mono); color: var(--faint); flex-wrap: wrap; }
  .srchx__grab { height: 32px; padding: 0 15px; border: none; background: var(--accent); color: #fff; border-radius: 8px; font: 600 12.5px var(--font-body); cursor: pointer; flex: none; }
  .srchx__grab:disabled { background: var(--panel-2); color: var(--faint); cursor: default; }
  .srchx__note { padding: 40px 20px; text-align: center; color: var(--faint); font-size: 13px; line-height: 1.5; }
</style>
