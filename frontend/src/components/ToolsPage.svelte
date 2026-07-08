<script>
  import { goBack } from '../lib/router.svelte.js';
  import { apiGet, apiPost } from '../lib/api.js';
  import { subscribe } from '../lib/events.svelte.js';
  import { notify } from '../lib/toasts.svelte.js';
  import { fmt } from '../lib/util.js';
  import Icon from '../lib/Icon.svelte';

  let { active = false } = $props();

  let st = $state(null);
  // The 1.2s poll re-render can't reset this while the user is deciding.
  let verifyCorruptOnly = $state(false);

  async function renderTools() {
    try { st = await apiGet('/api/tools'); } catch { /* keep last */ }
  }

  $effect(() => {
    if (!active) return;
    renderTools();
    return subscribe('tools', renderTools, 1200);
  });

  const runningTool = $derived(st?.running ? st.tool : null);
  const busy = $derived(!!st?.running);

  function summarizeToolResult(s) {
    const r = s.result || {};
    return Object.entries(r).map(([k, v]) => `${fmt(v)} ${k.replace(/([A-Z])/g, ' $1').toLowerCase()}`).join(' · ');
  }
  const summary = $derived.by(() => {
    if (!st) return '';
    if (busy) return `Running: ${(st.catalog?.find((t) => t.id === runningTool)?.label) || runningTool}${st.total ? ` · ${fmt(st.done || 0)}/${fmt(st.total)}` : ''}`;
    return st.ranAt ? `Last: ${summarizeToolResult(st)}` : '';
  });

  let startingId = $state(null);
  async function run(t) {
    startingId = t.id;
    const body = t.id === 'verify' && verifyCorruptOnly ? { corruptOnly: true } : {};
    const r = await apiPost('/api/tools/' + t.id, body);
    if (r.error) notify(r.error, 'error');
    startingId = null;
    renderTools();
  }
</script>

<main id="tools-page" class="scan-page tools-page">
  <div class="scan-page__bar">
    <button id="tools-back" class="btn btn--ghost" onclick={goBack}><Icon name="arrow-left" /> Back</button>
    <h2 class="scan-page__title">Tools</h2>
    <span id="tools-summary" class="scan-summary">{summary}</span>
  </div>
  <div class="tools-scroll">
    <p class="modal__note">Library-wide maintenance. Each runs in the background — you can leave this page and watch progress on the Jobs page.</p>
    <div id="tools-list" class="tools-list">
      {#each st?.catalog || [] as t (t.id)}
        <div class="tool-card" class:is-running={runningTool === t.id}>
          <div class="tool-info">
            <div class="tool-name">{t.label}</div>
            <div class="tool-desc">{t.desc}</div>
            {#if runningTool === t.id && st.total}
              <div class="tool-prog"><div class="tool-prog__fill" style="width:{Math.round(((st.done || 0) / st.total) * 100)}%"></div></div>
              <div class="tool-prog__meta">{st.message || ''} · {fmt(st.done || 0)}/{fmt(st.total)}</div>
            {/if}
            {#if runningTool !== t.id && st?.ranAt && st.tool === t.id && st.result}
              <div class="tool-result"><Icon name="check" /> {summarizeToolResult(st)}</div>
            {/if}
            {#if runningTool !== t.id && st?.tool === t.id && st.error}
              <div class="tool-result tool-result--err"><Icon name="close" /> {st.error}</div>
            {/if}
            {#if t.id === 'verify'}
              <!-- Verify gets a "corrupt only" checkbox — a fast pass over just the flagged files. -->
              <label class="tool-opt">
                <input type="checkbox" bind:checked={verifyCorruptOnly} disabled={busy} />
                {' '}Only re-check corrupt files{st?.corruptCount ? ` (${fmt(st.corruptCount)})` : ''}</label>
            {/if}
          </div>
          <button class="btn btn--primary btn--sm" disabled={busy || startingId === t.id} onclick={() => run(t)}>
            {runningTool === t.id ? 'Running…' : startingId === t.id ? 'Starting…' : 'Run'}</button>
        </div>
      {/each}
    </div>
    <!-- Plugin-provided tools inject here (plain DOM — the page stays mounted,
         so element refs plugins keep for live labels survive navigation). -->
    <div id="tools-plugin-actions" class="tools-list tools-list--plugins"></div>
  </div>
</main>
