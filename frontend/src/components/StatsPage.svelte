<script>
  import Icon from '../lib/Icon.svelte';
  import { goBack, navigate } from '../lib/router.svelte.js';
  import { apiGet } from '../lib/api.js';
  import { fmt, humanBytes, spct } from '../lib/util.js';

  let { active = false } = $props();

  let s = $state(null);
  let failed = $state(false);

  async function renderStats() {
    failed = false;
    try { s = await apiGet('/api/stats'); }
    catch { failed = true; }
  }

  $effect(() => { if (active) renderStats(); });

  const f = $derived(s?.files);
  const c = $derived(s?.collection);
  const comp = $derived(s?.completion);
  const cv = $derived(s?.comicvine);
  const act = $derived(s?.activity);

  const fmTotal = $derived(f ? Math.max(1, f.formats.cbz + f.formats.cbr + f.formats.pdf + f.formats.other) : 1);
  const sparkMax = $derived(act ? Math.max(1, ...act.perDay.map((d) => d.n)) : 1);

  // Publisher links filter the collection rail (search matches publisher too).
  function pickPublisher(pub) {
    navigate('/?q=' + encodeURIComponent(pub));
  }
  function openVolumeLink(e, id) {
    e.preventDefault();
    navigate('/volume/' + id);
  }
</script>

{#snippet statCard(value, label, sub)}
  <div class="stat-card"><div class="stat-card__val">{value}</div><div class="stat-card__label">{label}</div>{#if sub}<div class="stat-card__sub">{sub}</div>{/if}</div>
{/snippet}

<main id="stats-page" class="scan-page stats-page">
  <div class="scan-page__bar">
    <button id="stats-back" class="btn btn--ghost" onclick={goBack}><Icon name="arrow-left" /> Back</button>
    <h2 class="scan-page__title">Stats</h2>
    <span id="stats-summary" class="scan-summary">{s ? `${fmt(c.series)} series · ${fmt(c.ownedIssues)} issues · ${humanBytes(f.bytes)}` : ''}</span>
    <button id="stats-refresh" class="btn btn--ghost" onclick={renderStats}>Refresh</button>
  </div>
  <div class="stats-scroll" id="stats-body">
    {#if failed}
      <div class="list-note">Could not load stats — is the app running?</div>
    {:else if !s}
      <div class="loading">Loading…</div>
    {:else}
      <div class="stat-grid">
        {@render statCard(fmt(c.series), 'Series', `${fmt(cv.seriesMatched)} matched to ComicVine`)}
        {@render statCard(fmt(c.ownedIssues), 'Issues owned', comp.cvIssuesTotal ? `of ${fmt(comp.cvIssuesTotal)} known` : '')}
        {@render statCard(fmt(f.total), 'Files', `${fmt(f.pages)} pages`)}
        {@render statCard(humanBytes(f.bytes), 'Library size', '')}
        {@render statCard(spct(f.tagged, f.valid) + '%', 'Tagged', `${fmt(f.tagged)}/${fmt(f.valid)} files`)}
        {@render statCard(fmt(f.corrupt), 'Corrupt', f.corrupt ? 'needs attention' : 'all good')}
      </div>

      <section class="stat-section">
        <h3 class="stat-section__title">Completion &amp; gaps</h3>
        <div class="stat-row">
          {@render statCard(fmt(comp.complete), 'Complete series', '')}
          {@render statCard(fmt(comp.incomplete), 'Incomplete', '')}
          {@render statCard(fmt(comp.missingIssues), 'Missing issues', '')}
        </div>
        <div class="stat-prog"><div class="stat-prog__fill" style="width:{spct(c.ownedIssues, comp.cvIssuesTotal)}%"></div></div>
        <div class="stat-prog__meta">{spct(c.ownedIssues, comp.cvIssuesTotal)}% of known issues owned ({fmt(c.ownedIssues)}/{fmt(comp.cvIssuesTotal)})</div>
        <p class="modal__subhead modal__subhead--sub">Biggest gaps</p>
        {#if comp.topGaps.length}
          <div class="stat-tablewrap">
          <table class="stat-table"><thead><tr><th>Series</th><th>Have</th><th>Missing</th><th class="stat-table__bar"></th></tr></thead><tbody>
            {#each comp.topGaps as g (g.id)}
              <tr><td><a class="stat-link" href={'/volume/' + g.id} onclick={(e) => openVolumeLink(e, g.id)}>{g.title}</a></td>
                <td>{fmt(g.owned)}/{fmt(g.total)}</td><td>{fmt(g.missing)}</td>
                <td><div class="stat-bar"><div class="stat-bar__fill" style="width:{spct(g.owned, g.total)}%"></div></div></td></tr>
            {/each}
          </tbody></table>
          </div>
        {:else}
          <div class="list-note">Every matched series is complete. 🎉</div>
        {/if}
      </section>

      <section class="stat-section">
        <h3 class="stat-section__title">By publisher</h3>
        <div class="stat-tablewrap">
        <table class="stat-table"><thead><tr><th>Publisher</th><th>Series</th><th>Issues</th><th>Files</th><th>Size</th></tr></thead><tbody>
          {#each c.byPublisher as p (p.publisher)}
            <tr><td><a class="stat-link" onclick={() => pickPublisher(p.publisher)} href={'/?q=' + encodeURIComponent(p.publisher)}>{p.publisher}</a></td>
              <td>{fmt(p.series)}</td><td>{fmt(p.issues)}</td><td>{fmt(p.files)}</td><td>{humanBytes(p.bytes)}</td></tr>
          {/each}
        </tbody></table>
        </div>
      </section>

      <section class="stat-section">
        <h3 class="stat-section__title">Format mix</h3>
        <div class="fmt-bar">
          {#if f.formats.cbz}<div class="fmt-seg fmt--cbz" style="width:{(f.formats.cbz / fmTotal) * 100}%" title="CBZ: {fmt(f.formats.cbz)}"></div>{/if}
          {#if f.formats.cbr}<div class="fmt-seg fmt--cbr" style="width:{(f.formats.cbr / fmTotal) * 100}%" title="CBR: {fmt(f.formats.cbr)}"></div>{/if}
          {#if f.formats.pdf}<div class="fmt-seg fmt--pdf" style="width:{(f.formats.pdf / fmTotal) * 100}%" title="PDF: {fmt(f.formats.pdf)}"></div>{/if}
          {#if f.formats.other}<div class="fmt-seg fmt--other" style="width:{(f.formats.other / fmTotal) * 100}%" title="Other: {fmt(f.formats.other)}"></div>{/if}
        </div>
        <div class="fmt-legend"><span class="fmt-key fmt--cbz"></span>CBZ {fmt(f.formats.cbz)}<span class="fmt-key fmt--cbr"></span>CBR {fmt(f.formats.cbr)}<span class="fmt-key fmt--pdf"></span>PDF {fmt(f.formats.pdf)}<span class="fmt-key fmt--other"></span>Other {fmt(f.formats.other)}</div>
      </section>

      <section class="stat-section">
        <h3 class="stat-section__title">ComicVine</h3>
        <div class="stat-grid">
          {@render statCard(cv.keys ? 'Yes' : 'No', 'API key', 'configured')}
          {@render statCard(fmt(cv.seriesMatched), 'Series matched', `${fmt(cv.seriesUnmatched)} unmatched`)}
          {@render statCard(fmt(cv.volumes), 'Series cached', '')}
          {@render statCard(fmt(cv.issues), 'Issues cached', `${spct(cv.detailed, cv.issues)}% detailed`)}
          {@render statCard(fmt(cv.filesLinked), 'Files linked', `${fmt(cv.filesUnlinked)} unlinked`)}
        </div>
      </section>

      <section class="stat-section">
        <h3 class="stat-section__title">Downloads</h3>
        <div class="stat-row">
          {@render statCard(fmt(act.grabs.imported), 'Imported', '')}
          {@render statCard(fmt(act.grabs.active), 'In progress', '')}
          {@render statCard(fmt(act.grabs.failed), 'Failed', '')}
        </div>
        <p class="modal__subhead modal__subhead--sub">Imports · last 14 days</p>
        <div class="spark">
          {#each act.perDay as d (d.day)}
            <div class="spark-bar" style="height:{Math.max(3, Math.round((d.n / sparkMax) * 100))}%" title="{d.day}: {d.n}"></div>
          {/each}
        </div>
        <p class="modal__subhead modal__subhead--sub">Recent imports</p>
        {#if act.recent.length}
          {#each act.recent as r, i (i)}
            <div class="stat-recent"><span class="stat-recent__t">{r.title || 'download'}</span><span class="stat-recent__d">{String(r.imported_at || '').slice(0, 10)}</span></div>
          {/each}
        {:else}
          <div class="list-note">No downloads imported yet.</div>
        {/if}
        <p class="modal__note">Tracks downloads handled by the background monitor (sources that download via a client, like usenet and torrents).</p>
      </section>
    {/if}
  </div>
</main>
