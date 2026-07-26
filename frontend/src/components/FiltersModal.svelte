<script>
  // Generic faceted Filters modal. Core owns the UI; a plugin supplies the facet
  // groups + counts for the current library type (registerLibraryFilters). The
  // selected facets are an opaque object core hands back on Apply; the plugin's
  // server half resolves them into the series the real grid then shows.
  import { libraryFilterFor } from '../lib/plugins.svelte.js';
  import { apiGet } from '../lib/api.js';
  import Icon from '../lib/Icon.svelte';

  let { open = false, type = null, libraryId = null, selection = {}, onapply, onclose } = $props();

  let local = $state({});
  let groups = $state([]);
  let loading = $state(false);
  let search = $state({}); // per-group search text (groups with search:true)
  const provider = $derived(type ? libraryFilterFor(type) : null);

  async function loadGroups() {
    if (!provider) { groups = []; return; }
    loading = true;
    try {
      groups = (await provider.groups($state.snapshot(local), { get: apiGet, type, libraryId, search: $state.snapshot(search) })) || [];
    } catch { groups = []; }
    loading = false;
  }

  // Clone the incoming selection when the modal opens, then load counts.
  let wasOpen = false;
  $effect(() => {
    if (open && !wasOpen) { local = structuredClone($state.snapshot(selection)) || {}; search = {}; loadGroups(); }
    wasOpen = open;
  });

  function isOn(g, value) {
    return g.multi ? (Array.isArray(local[g.key]) && local[g.key].includes(value)) : local[g.key] === value;
  }
  function toggle(g, value) {
    if (g.multi) {
      const arr = Array.isArray(local[g.key]) ? [...local[g.key]] : [];
      const i = arr.indexOf(value);
      if (i >= 0) arr.splice(i, 1); else arr.push(value);
      if (arr.length) local[g.key] = arr; else delete local[g.key];
    } else if (local[g.key] === value) { delete local[g.key]; } else { local[g.key] = value; }
    local = { ...local };
    loadGroups();
  }
  let searchDeb;
  function onSearch(gkey, val) { search[gkey] = val; search = { ...search }; clearTimeout(searchDeb); searchDeb = setTimeout(loadGroups, 250); }

  const activeCount = $derived(Object.values(local).reduce((n, v) => n + (Array.isArray(v) ? v.length : (v ? 1 : 0)), 0));
  function clearAll() { local = {}; loadGroups(); }
  function apply() { onapply?.($state.snapshot(local)); onclose?.(); }
</script>

<svelte:window onkeydown={(e) => { if (open && e.key === 'Escape') onclose?.(); }} />

{#if open}
  <div class="modal" onclick={(e) => { if (e.target === e.currentTarget) onclose?.(); }}>
    <div class="modal__panel filt" role="dialog" aria-label="Filters">
      <div class="modal__head"><h3>Filters</h3>
        <button class="modal__x" aria-label="Close" onclick={() => onclose?.()}><Icon name="close" /></button>
      </div>
      <div class="modal__body filt__body">
        {#if loading && !groups.length}
          <p class="filt__dim">Loading…</p>
        {:else if !groups.length}
          <p class="filt__dim">No filters available for this library.</p>
        {/if}
        {#each groups as g (g.key)}
          <div class="filt__group">
            <div class="filt__label">{g.label}</div>
            {#if g.search}
              <input class="filt__search" placeholder="Search {g.label.toLowerCase()}…"
                value={search[g.key] || ''} oninput={(e) => onSearch(g.key, e.currentTarget.value)} />
            {/if}
            <div class="filt__opts">
              {#each g.options as o (o.value)}
                <button class="filt__opt" class:is-on={isOn(g, o.value)} onclick={() => toggle(g, o.value)}>
                  <span class="filt__opt-l">{o.label}</span><span class="filt__opt-c">{(o.count || 0).toLocaleString()}</span>
                </button>
              {/each}
              {#if !g.options.length}<span class="filt__dim">None</span>{/if}
            </div>
          </div>
        {/each}
      </div>
      <div class="modal__foot">
        <button class="filt__clear" onclick={clearAll} disabled={!activeCount}>Clear{activeCount ? ` (${activeCount})` : ''}</button>
        <span class="modal__foot-spacer"></span>
        <button class="btn btn--primary" onclick={apply}>Apply</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .filt.modal__panel { width: min(560px, 94vw); }
  .filt__body { max-height: min(70vh, 640px); overflow-y: auto; gap: 18px; }
  .filt__group { display: flex; flex-direction: column; gap: 8px; }
  .filt__label { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
  .filt__search { background: var(--panel-2); border: 1px solid var(--line); color: var(--text); border-radius: 8px; padding: 6px 10px; font: inherit; }
  .filt__opts { display: flex; flex-wrap: wrap; gap: 6px; }
  .filt__opt { display: inline-flex; align-items: center; gap: 7px; border: 1px solid var(--line); background: transparent; color: var(--text);
    font: inherit; font-size: 12.5px; padding: 5px 11px; border-radius: 999px; cursor: pointer; }
  .filt__opt:hover { border-color: var(--accent); }
  .filt__opt.is-on { background: var(--accent); border-color: var(--accent); color: #fff; }
  .filt__opt-c { font-size: 11px; font-variant-numeric: tabular-nums; opacity: .7; }
  .filt__opt.is-on .filt__opt-c { opacity: .85; }
  .filt__dim { color: var(--faint); font-size: 13px; margin: 0; }
  .filt__clear { background: transparent; border: 1px solid var(--line); color: var(--muted); border-radius: 8px; padding: 8px 14px; font: 600 12.5px var(--font-body); cursor: pointer; }
  .filt__clear:disabled { opacity: .4; cursor: default; }
</style>
