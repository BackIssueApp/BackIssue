<script>
  import { goBack } from '../lib/router.svelte.js';
  import { apiGet, apiPost } from '../lib/api.js';
  import { subscribe } from '../lib/events.svelte.js';
  import { notify } from '../lib/toasts.svelte.js';
  import { confirmDialog } from './DialogModal.svelte';
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
    // A reorganize may be running from before we navigated here — pick it up.
    (async () => {
      try {
        const st = await apiGet('/api/library/refile-status');
        if (st?.running) { refileStatus = st; refileBusy = true; startRefilePoll(); }
      } catch { /* fine */ }
    })();
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

  // ---- Reorganize library (dry-run preview, then execute) ----
  const segs = (p) => String(p || '').split(/[\\/]/);
  const tail = (p, n) => segs(p).slice(-n).join('/');
  let refilePlan = $state(null);
  // The sample moves grouped by destination folder, so the preview reads as
  // "this folder gets these files" instead of a wall of raw paths.
  const refileGroups = $derived.by(() => {
    const map = new Map();
    for (const m of refilePlan?.moves || []) {
      const dir = segs(m.to).slice(0, -1).join('/');
      if (!map.has(dir)) map.set(dir, { dir, label: tail(dir, 2), items: [] });
      map.get(dir).items.push({ from: segs(m.from).at(-1), to: segs(m.to).at(-1), fullFrom: m.from, fullTo: m.to });
    }
    return [...map.values()];
  });
  let refileBusy = $state(false);
  async function previewRefile() {
    refileBusy = true;
    try { refilePlan = await apiGet('/api/library/refile-plan'); }
    catch (e) { notify('Preview failed: ' + (e?.message || e), 'error'); }
    refileBusy = false;
  }
  // The execute runs as a background job — poll its status while it works.
  let refileStatus = $state(null);
  let refilePoll = null;
  function stopRefilePoll() { clearInterval(refilePoll); refilePoll = null; }
  function startRefilePoll() {
    stopRefilePoll();
    refilePoll = setInterval(async () => {
      try { refileStatus = await apiGet('/api/library/refile-status'); } catch { return; }
      if (!refileStatus?.running) {
        stopRefilePoll();
        refileBusy = false;
        if (refileStatus?.result) {
          const r = refileStatus.result;
          notify(`Reorganized ${fmt(r.moved)} file${r.moved === 1 ? '' : 's'}${r.skipped ? `, ${fmt(r.skipped)} skipped` : ''}.`, 'ok');
          refilePlan = null;
        } else if (refileStatus?.error) notify('Reorganize failed: ' + refileStatus.error, 'error');
      }
    }, 1200);
  }
  $effect(() => () => stopRefilePoll()); // page teardown stops the poll
  async function runRefile() {
    const n = refilePlan?.counts?.move || 0;
    if (!n) return;
    if (!(await confirmDialog({
      title: `Reorganize ${fmt(n)} file${n === 1 ? '' : 's'}?`,
      message: 'Every ComicVine-matched series is moved/renamed to match your folder and file patterns. This changes files on disk and runs in the background — progress shows here and on the Jobs page.',
      confirmLabel: 'Reorganize',
    }))) return;
    refileBusy = true;
    let r;
    try { r = await apiPost('/api/library/refile', {}); } catch (e) { r = { error: String(e?.message || e) }; }
    if (r.error) { refileBusy = false; return notify(r.error, 'error'); }
    refileStatus = { running: true, done: 0, total: 0 };
    startRefilePoll();
  }

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

    <div class="tool-card tool-card--refile">
      <div class="tool-info">
        <div class="tool-name">Reorganize library</div>
        <div class="tool-desc">Move &amp; rename every matched series' files to match your folder and file patterns (Settings → Library → File organization). Preview first — nothing changes until you reorganize.</div>
        {#if refileStatus?.running}
          <div class="tool-prog"><div class="tool-prog__fill" style="width:{refileStatus.total ? Math.round(((refileStatus.done || 0) / refileStatus.total) * 100) : 0}%"></div></div>
          <div class="tool-prog__meta">{refileStatus.message || 'Starting…'} · {fmt(refileStatus.done || 0)}/{fmt(refileStatus.total || 0)} series{refileStatus.moved != null ? ` · ${fmt(refileStatus.moved)} moved` : ''}</div>
        {/if}
        {#if refilePlan}
          <div class="refile-stats">
            <span class="refile-stat"><b>{fmt(refilePlan.counts.move)}</b> to move</span>
            <span class="refile-stat"><b>{fmt(refilePlan.counts.unchanged)}</b> already match</span>
            {#if refilePlan.counts.skip}<span class="refile-stat"><b>{fmt(refilePlan.counts.skip)}</b> skipped</span>{/if}
            {#if refilePlan.counts.collision}<span class="refile-stat refile-stat--warn"><b>{fmt(refilePlan.counts.collision)}</b> name collisions (left in place)</span>{/if}
          </div>
          {#if refileGroups.length}
            <div class="refile-preview">
              {#each refileGroups as g (g.dir)}
                <div class="refile-group">
                  <div class="refile-group__dir" title={g.dir}>
                    {g.label}
                    <span class="refile-group__count">{g.items.length} file{g.items.length === 1 ? '' : 's'}</span>
                  </div>
                  {#each g.items as it (it.fullFrom)}
                    <div class="refile-item" title={it.fullFrom + '\n→ ' + it.fullTo}>
                      <div class="refile-item__from">{it.from}</div>
                      <div class="refile-item__to">{it.to}</div>
                    </div>
                  {/each}
                </div>
              {/each}
              {#if refilePlan.truncated}
                <div class="refile-more">Showing the first {fmt(refilePlan.moves.length)} of {fmt(refilePlan.counts.move)} moves — the rest follow the same patterns.</div>
              {/if}
            </div>
          {:else}
            <div class="modal__note">Nothing to move — files already match your patterns.</div>
          {/if}
        {/if}
      </div>
      <div class="tool-refile-actions">
        <button class="btn btn--ghost btn--sm" disabled={refileBusy} onclick={previewRefile}>{refileBusy && !refilePlan ? 'Previewing…' : refilePlan ? 'Re-preview' : 'Preview'}</button>
        {#if refilePlan && refilePlan.counts.move}
          <button class="btn btn--primary btn--sm" disabled={refileBusy} onclick={runRefile}>{refileBusy ? 'Reorganizing…' : `Reorganize ${fmt(refilePlan.counts.move)}`}</button>
        {/if}
      </div>
    </div>

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
