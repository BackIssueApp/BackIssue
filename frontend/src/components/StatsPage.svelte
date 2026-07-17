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
  const completionPct = $derived(comp ? spct(c.ownedIssues, comp.cvIssuesTotal) : 0);

  // Publisher links filter the collection rail (search matches publisher too).
  function pickPublisher(e, pub) { e.preventDefault(); navigate('/?q=' + encodeURIComponent(pub)); }
  function openVolumeLink(e, id) { e.preventDefault(); navigate('/volume/' + id); }

  const PUB_DOTS = ['#ff2d6f', '#2bd4d9', '#5fd38a', '#ffc24b', '#a78bfa'];
  const FMT = [
    { key: 'cbz', label: 'CBZ', color: 'var(--accent)' },
    { key: 'cbr', label: 'CBR', color: 'var(--amber)' },
    { key: 'pdf', label: 'PDF', color: 'var(--cyan)' },
    { key: 'other', label: 'Other', color: '#6f6885' },
  ];
  const formatSegs = $derived(f ? FMT.filter((x) => f.formats[x.key]).map((x) => ({
    label: x.label, color: x.color, count: f.formats[x.key], pct: ((f.formats[x.key] / fmTotal) * 100).toFixed(1) + '%',
  })) : []);
</script>

<main id="stats-page" class="scan-page stats-page statx">
  <div class="statx__head">
    <button id="stats-back" class="statx__iconbtn" aria-label="Back" onclick={goBack}><Icon name="arrow-left" size={16} /></button>
    <h2 class="statx__title">Stats</h2>
    <span id="stats-summary" class="statx__summary">{s ? `${fmt(c.series)} series · ${fmt(c.ownedIssues)} issues · ${humanBytes(f.bytes)}` : ''}</span>
    <button id="stats-refresh" class="statx__refresh" onclick={renderStats}><Icon name="refresh" size={14} /> Refresh</button>
  </div>

  <div class="statx__scroll" id="stats-body">
    {#if failed}
      <div class="statx__note">Could not load stats — is the app running?</div>
    {:else if !s}
      <div class="statx__note">Loading…</div>
    {:else}
      <div class="statx__inner">

        <!-- HERO: completion ring + KPI tiles -->
        <div class="statx__hero">
          <div class="statx__ring-card">
            <div class="statx__ring" style="background:conic-gradient(var(--accent) {completionPct}%, #2c2740 {completionPct}% 100%);">
              <div class="statx__ring-hole">
                <span class="statx__ring-pct">{completionPct}<span class="statx__ring-sym">%</span></span>
                <span class="statx__ring-cap">Complete</span>
              </div>
            </div>
            <div class="statx__ring-side">
              <div class="statx__ring-copy">You own <b>{fmt(c.ownedIssues)}</b> of <b>{fmt(comp.cvIssuesTotal)}</b> known issues.</div>
              <div class="statx__ring-breakdown">
                <div><div class="statx__bd-num" style="color:var(--green);">{fmt(comp.complete)}</div><div class="statx__bd-lbl">Complete</div></div>
                <div><div class="statx__bd-num" style="color:var(--amber);">{fmt(comp.incomplete)}</div><div class="statx__bd-lbl">Incomplete</div></div>
                <div><div class="statx__bd-num" style="color:var(--red);">{fmt(comp.missingIssues)}</div><div class="statx__bd-lbl">Missing</div></div>
              </div>
            </div>
          </div>
          <div class="statx__kpis">
            <div class="statx__kpi"><div class="statx__kpi-head" style="color:var(--accent);"><Icon name="book" size={15} /><span class="statx__kpi-lbl">Series</span></div><div class="statx__kpi-val">{fmt(c.series)}</div><div class="statx__kpi-sub">{fmt(cv.seriesMatched)} matched</div></div>
            <div class="statx__kpi"><div class="statx__kpi-head" style="color:var(--cyan);"><Icon name="layers" size={15} /><span class="statx__kpi-lbl">Issues owned</span></div><div class="statx__kpi-val">{fmt(c.ownedIssues)}</div><div class="statx__kpi-sub">of {fmt(comp.cvIssuesTotal)} known</div></div>
            <div class="statx__kpi"><div class="statx__kpi-head" style="color:var(--green);"><Icon name="hard-drive" size={15} /><span class="statx__kpi-lbl">Library size</span></div><div class="statx__kpi-val">{humanBytes(f.bytes)}</div><div class="statx__kpi-sub">{fmt(f.total)} files · {fmt(f.pages)} pp</div></div>
            <div class="statx__kpi"><div class="statx__kpi-head" style="color:{f.corrupt ? 'var(--red)' : '#a78bfa'};"><Icon name={f.corrupt ? 'alert-triangle' : 'tag'} size={15} /><span class="statx__kpi-lbl">Tagged</span></div><div class="statx__kpi-val">{spct(f.tagged, f.valid)}%</div><div class="statx__kpi-sub">{f.corrupt ? `${fmt(f.corrupt)} corrupt` : 'all valid'}</div></div>
          </div>
        </div>

        <!-- gaps + format/CV -->
        <div class="statx__mid">
          <div class="statx__panel">
            <div class="statx__panel-head"><span class="statx__panel-title">Biggest gaps</span><span class="statx__panel-note">issues missing</span></div>
            {#if comp.topGaps.length}
              {#each comp.topGaps as g (g.id)}
                {@const p = spct(g.owned, g.total)}
                <a class="statx__gap" href={'/volume/' + g.id} onclick={(e) => openVolumeLink(e, g.id)}>
                  <span class="statx__gap-title">{g.title}</span>
                  <span class="statx__gap-have">{fmt(g.owned)}/{fmt(g.total)}</span>
                  <span class="statx__gap-bar"><span class="statx__gap-fill" style="width:{p}%; background:{p >= 90 ? 'var(--amber)' : 'var(--red)'};"></span></span>
                  <span class="statx__gap-miss">{fmt(g.missing)}</span>
                </a>
              {/each}
            {:else}
              <div class="statx__empty">Every matched series is complete. 🎉</div>
            {/if}
          </div>

          <div class="statx__midcol">
            <div class="statx__panel statx__panel--pad">
              <div class="statx__panel-title statx__mb">Format mix</div>
              <div class="statx__fmtbar">
                {#each formatSegs as fs (fs.label)}<div style="width:{fs.pct}; background:{fs.color};"></div>{/each}
              </div>
              <div class="statx__fmtlegend">
                {#each formatSegs as fs (fs.label)}<span class="statx__fmtkey"><span class="statx__fmtdot" style="background:{fs.color};"></span>{fs.label} <b>{fmt(fs.count)}</b></span>{/each}
              </div>
            </div>
            <div class="statx__panel statx__panel--pad">
              <div class="statx__cvhead"><span class="statx__panel-title">ComicVine</span><span class="statx__cvkey" class:is-off={!cv.keys}>{cv.keys ? 'Key set' : 'No key'}</span></div>
              <div class="statx__cvrows">
                <div class="statx__cvrow"><span class="statx__cvlbl">Series matched</span><span class="statx__cvval">{fmt(cv.seriesMatched)}</span><span class="statx__cvsub">{fmt(cv.seriesUnmatched)} unmatched</span></div>
                <div class="statx__cvrow"><span class="statx__cvlbl">Issues cached</span><span class="statx__cvval">{fmt(cv.issues)}</span><span class="statx__cvsub">{spct(cv.detailed, cv.issues)}% detailed</span></div>
                <div class="statx__cvrow"><span class="statx__cvlbl">Files linked</span><span class="statx__cvval">{fmt(cv.filesLinked)}</span><span class="statx__cvsub">{fmt(cv.filesUnlinked)} unlinked</span></div>
              </div>
            </div>
          </div>
        </div>

        <!-- by publisher -->
        <div class="statx__panel">
          <div class="statx__panel-head"><span class="statx__panel-title">By publisher</span></div>
          <div class="statx__pubhead"><span>Publisher</span><span class="statx__r">Series</span><span class="statx__r">Issues</span><span class="statx__r">Files</span><span class="statx__r">Size</span></div>
          {#each c.byPublisher as p, i (p.publisher)}
            <div class="statx__pubrow">
              <span class="statx__pubname"><span class="statx__pubdot" style="background:{PUB_DOTS[i % PUB_DOTS.length]};"></span><a href={'/?q=' + encodeURIComponent(p.publisher)} onclick={(e) => pickPublisher(e, p.publisher)}>{p.publisher}</a></span>
              <span class="statx__r statx__mono">{fmt(p.series)}</span>
              <span class="statx__r statx__mono">{fmt(p.issues)}</span>
              <span class="statx__r statx__mono">{fmt(p.files)}</span>
              <span class="statx__r statx__mono">{humanBytes(p.bytes)}</span>
            </div>
          {/each}
        </div>

        <!-- downloads -->
        <div class="statx__panel statx__panel--pad">
          <div class="statx__dlhead">
            <span class="statx__panel-title">Downloads</span>
            <div class="statx__dlkpis">
              <span>Imported <b style="color:var(--green);">{fmt(act.grabs.imported)}</b></span>
              <span>In progress <b style="color:var(--cyan);">{fmt(act.grabs.active)}</b></span>
              <span>Failed <b style="color:var(--red);">{fmt(act.grabs.failed)}</b></span>
            </div>
          </div>
          <div class="statx__eyebrow">Imports · last 14 days</div>
          <div class="statx__spark">
            {#each act.perDay as d, i (d.day)}
              <div class="statx__sparkbar" style="height:{Math.max(4, Math.round((d.n / sparkMax) * 100))}%; background:{i === act.perDay.length - 1 ? 'var(--accent)' : '#4a4266'};" title="{d.day}: {d.n}"></div>
            {/each}
          </div>
          <div class="statx__eyebrow statx__eyebrow--gap">Recent imports</div>
          {#if act.recent.length}
            {#each act.recent as r, i (i)}
              <div class="statx__recent"><span class="statx__recent-t">{r.title || 'download'}</span><span class="statx__recent-d">{String(r.imported_at || '').slice(0, 10)}</span></div>
            {/each}
          {:else}
            <div class="statx__empty">No downloads imported yet.</div>
          {/if}
          <p class="statx__foot">Tracks downloads handled by the background monitor (sources that download via a client, like usenet and torrents).</p>
        </div>

      </div>
    {/if}
  </div>
</main>

<style>
  /* Layout comes from the route reveal rule `body.stats .stats-page`; setting
     display here would override the `.scan-page` hide and show on every route. */
  .statx { min-height: 0; }
  .statx__head { display: flex; align-items: center; gap: 12px; padding: 14px 24px; border-bottom: 1px solid var(--line); flex: none; flex-wrap: wrap; }
  .statx__iconbtn { width: 36px; height: 36px; display: grid; place-items: center; border: 1px solid var(--line); background: transparent; color: var(--muted); border-radius: 8px; cursor: pointer; }
  .statx__iconbtn:hover { color: var(--text); }
  .statx__title { margin: 0; font-family: var(--font-display); font-size: 24px; letter-spacing: .03em; font-weight: 400; }
  .statx__summary { font: 12px var(--font-mono); color: var(--faint); }
  .statx__refresh { margin-left: auto; height: 36px; padding: 0 15px; border: 1px solid var(--line); background: transparent; color: var(--muted); border-radius: 8px; font: 600 13px var(--font-body); cursor: pointer; display: inline-flex; align-items: center; gap: 7px; }
  .statx__refresh:hover { color: var(--text); }
  .statx__scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 22px 24px 60px; }
  .statx__inner { max-width: 1080px; margin: 0 auto; display: flex; flex-direction: column; gap: 20px; }
  .statx__note { padding: 40px; text-align: center; color: var(--faint); }

  .statx__hero { display: grid; grid-template-columns: 1.15fr 1fr; gap: 16px; }
  .statx__ring-card { background: linear-gradient(150deg, #221c30, #191622); border: 1px solid #3a3350; border-radius: 16px; padding: 22px; display: flex; align-items: center; gap: 22px; }
  .statx__ring { position: relative; width: 132px; height: 132px; flex: none; border-radius: 50%; }
  .statx__ring-hole { position: absolute; inset: 13px; border-radius: 50%; background: #191521; display: flex; flex-direction: column; align-items: center; justify-content: center; }
  .statx__ring-pct { font: 700 30px var(--font-body); line-height: 1; }
  .statx__ring-sym { font-size: 15px; color: var(--faint); }
  .statx__ring-cap { font-size: 10.5px; text-transform: uppercase; letter-spacing: .09em; color: var(--faint); margin-top: 4px; }
  .statx__ring-side { flex: 1; min-width: 0; }
  .statx__ring-copy { font-size: 13px; color: var(--muted); line-height: 1.5; }
  .statx__ring-copy b { color: var(--text); }
  .statx__ring-breakdown { display: flex; gap: 20px; margin-top: 16px; flex-wrap: wrap; }
  .statx__bd-num { font: 700 20px var(--font-body); }
  .statx__bd-lbl { font-size: 11px; color: var(--faint); text-transform: uppercase; letter-spacing: .06em; margin-top: 2px; }
  .statx__kpis { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .statx__kpi { background: rgba(255,255,255,.015); border: 1px solid var(--line); border-radius: 13px; padding: 14px 16px; }
  .statx__kpi-head { display: flex; align-items: center; gap: 8px; }
  .statx__kpi-lbl { font-size: 10.5px; text-transform: uppercase; letter-spacing: .07em; color: var(--faint); }
  .statx__kpi-val { font: 700 22px var(--font-body); margin-top: 8px; }
  .statx__kpi-sub { font-size: 11.5px; color: var(--faint); margin-top: 3px; }

  .statx__mid { display: grid; grid-template-columns: 1.1fr 1fr; gap: 16px; }
  .statx__midcol { display: flex; flex-direction: column; gap: 16px; }
  .statx__panel { border: 1px solid var(--line); border-radius: 14px; background: rgba(255,255,255,.012); overflow: hidden; }
  .statx__panel--pad { padding: 16px; }
  .statx__panel-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; border-bottom: 1px solid var(--line); }
  .statx__panel-title { font-family: var(--font-display); font-size: 15px; letter-spacing: .03em; }
  .statx__panel-note { font-size: 11px; color: var(--faint); }
  .statx__mb { margin-bottom: 14px; display: block; }

  .statx__gap { display: flex; align-items: center; gap: 12px; padding: 11px 16px; border-bottom: 1px solid #221e2c; color: var(--text); text-decoration: none; }
  .statx__gap:last-child { border-bottom: none; }
  .statx__gap:hover { background: rgba(255,255,255,.025); color: var(--text); }
  .statx__gap-title { flex: 1; min-width: 0; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .statx__gap-have { font: 11px var(--font-mono); color: var(--faint); flex: none; }
  .statx__gap-bar { width: 80px; height: 6px; border-radius: 3px; background: var(--panel-2); overflow: hidden; flex: none; }
  .statx__gap-fill { display: block; height: 100%; }
  .statx__gap-miss { font: 600 12px var(--font-mono); color: var(--red); width: 34px; text-align: right; flex: none; }
  .statx__empty { padding: 24px 16px; color: var(--faint); font-size: 13px; }

  .statx__fmtbar { display: flex; height: 14px; border-radius: 7px; overflow: hidden; background: var(--panel-2); }
  .statx__fmtbar > div { height: 100%; }
  .statx__fmtlegend { display: flex; gap: 16px; margin-top: 12px; flex-wrap: wrap; }
  .statx__fmtkey { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); }
  .statx__fmtkey b { color: var(--text); }
  .statx__fmtdot { width: 9px; height: 9px; border-radius: 2px; }
  .statx__cvhead { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; }
  .statx__cvkey { font: 600 10px var(--font-body); text-transform: uppercase; letter-spacing: .04em; color: var(--green); border: 1px solid rgba(95,211,138,.4); border-radius: 5px; padding: 2px 7px; }
  .statx__cvkey.is-off { color: var(--red); border-color: rgba(255,90,82,.4); }
  .statx__cvrows { display: flex; flex-direction: column; gap: 10px; }
  .statx__cvrow { display: flex; align-items: center; gap: 10px; }
  .statx__cvlbl { font-size: 12.5px; color: var(--muted); flex: 1; }
  .statx__cvval { font: 600 13px var(--font-mono); }
  .statx__cvsub { font-size: 11px; color: #6f6885; width: 96px; text-align: right; }

  .statx__pubhead, .statx__pubrow { display: grid; grid-template-columns: 2fr 1fr 1fr 1fr 1fr; gap: 12px; padding: 10px 16px; align-items: center; }
  .statx__pubhead { padding: 9px 16px; border-bottom: 1px solid var(--line); font: 600 10px var(--font-body); text-transform: uppercase; letter-spacing: .06em; color: var(--faint); }
  .statx__pubrow { border-bottom: 1px solid #221e2c; }
  .statx__pubrow:last-child { border-bottom: none; }
  .statx__pubrow:hover { background: rgba(255,255,255,.025); }
  .statx__r { text-align: right; }
  .statx__mono { font: 12px var(--font-mono); color: var(--muted); }
  .statx__pubname { display: flex; align-items: center; gap: 9px; min-width: 0; }
  .statx__pubname a { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); }
  .statx__pubname a:hover { color: var(--accent); }
  .statx__pubdot { width: 8px; height: 8px; border-radius: 2px; flex: none; }

  .statx__dlhead { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-bottom: 16px; }
  .statx__dlkpis { display: flex; gap: 16px; margin-left: auto; font-size: 12.5px; color: var(--faint); }
  .statx__eyebrow { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: #6f6885; margin-bottom: 8px; }
  .statx__eyebrow--gap { margin-top: 18px; }
  .statx__spark { display: flex; align-items: flex-end; gap: 5px; height: 76px; padding: 2px 0; }
  .statx__sparkbar { flex: 1; min-height: 3px; border-radius: 3px 3px 0 0; }
  .statx__recent { display: flex; align-items: center; gap: 12px; padding: 7px 0; border-bottom: 1px solid #221e2c; }
  .statx__recent-t { flex: 1; min-width: 0; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .statx__recent-d { font: 11px var(--font-mono); color: #6f6885; }
  .statx__foot { font-size: 11.5px; color: #6f6885; margin: 14px 0 0; line-height: 1.5; }

  @media (max-width: 780px) {
    .statx__hero, .statx__mid { grid-template-columns: 1fr; }
  }
</style>
