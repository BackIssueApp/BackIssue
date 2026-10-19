<script>
  // System: the three admin surfaces — Jobs (scheduled tasks + recent runs),
  // Tools (library-wide maintenance), and Logs — unified under one tab rail.
  // Each tab keeps the exact data model, endpoints and helpers of the page it
  // replaced; this is a layout/UX change, not a data change. All three bodies
  // stay mounted (revealed by a class) so the #tools-plugin-actions mount point
  // plugins inject into is never torn down.
  import { untrack } from 'svelte';
  import { route, setQuery } from '../lib/router.svelte.js';
  import { apiGetOk, apiPost, errorText } from '../lib/api.js';
  import { subscribe } from '../lib/events.svelte.js';
  import { notify } from '../lib/toasts.svelte.js';
  import { confirmDialog } from './DialogModal.svelte';
  import { can } from '../lib/auth.svelte.js';
  import { fmt, fmtAgo, fmtIn, highlightHtml } from '../lib/util.js';
  import { t, th, hasMessage, currentLang, st as serverText } from '../lib/i18n.svelte.js';
  import Icon from '../lib/Icon.svelte';
  import LoadError from './LoadError.svelte';

  let { active = false } = $props();

  const canJobs = $derived(can('system.jobs'));
  const canLogs = $derived(can('system.logs'));
  const TAB_DEFS = $derived([
    ...(canJobs ? [{ id: 'jobs', label: t('systemPage.tabJobs'), icon: 'clock' }, { id: 'tools', label: t('systemPage.tabTools'), icon: 'tools' }] : []),
    ...(canLogs ? [{ id: 'logs', label: t('systemPage.tabLogs'), icon: 'file-text' }] : []),
  ]);

  let page = $state('jobs');
  // Read the tab from ?tab= on activation (the old /jobs·/tools·/logs routes
  // redirect here with it), defaulting to the first tab the user may see.
  $effect(() => {
    if (!active) return;
    const want = new URLSearchParams(route.search).get('tab');
    const ids = untrack(() => TAB_DEFS).map((tab) => tab.id);
    untrack(() => {
      page = ids.includes(want) ? want : (ids[0] || 'jobs');
    });
  });
  function selectTab(id) { page = id; setQuery({ tab: id }); }

  // ================= JOBS =================
  // Job type → catalog key under systemPage.job (resolved at render time).
  const JOB_LABELS = {
    crawl: 'catalog', 'cv-match': 'metadata', 'scan-folder': 'scan', 'tag-files': 'tag',
    releases: 'releases', updates: 'updates', tool: 'tool', 'zero-day': 'zeroDay', 'wanted-search': 'wanted',
    'pack-import': 'pack', 'import-scan': 'import', 'import-run': 'import',
  };
  const JOB_TONE = {
    catalog: 'var(--cyan)', metadata: 'var(--green)', scan: 'var(--cyan)', tag: 'var(--amber)',
    releases: 'var(--accent)', updates: 'var(--green)', tool: 'var(--muted)', zeroDay: 'var(--accent)',
    wanted: 'var(--accent)', pack: 'var(--amber)', import: 'var(--cyan)',
  };
  const jobLabel = (type) => (JOB_LABELS[type] ? t('systemPage.job.' + JOB_LABELS[type]) : type);
  const jobTone = (type) => JOB_TONE[JOB_LABELS[type]] || 'var(--muted)';

  let jobs = $state([]);
  let scheds = $state([]);
  let now = $state(Date.now());
  let jobsLoaded = $state(false);
  let jobsError = $state('');

  // A failed poll (server restarting, proxy 502) keeps the last good list.
  async function renderJobs() {
    try {
      const r = await apiGetOk('/api/jobs');
      if (Array.isArray(r)) { jobs = r; jobsLoaded = true; jobsError = ''; }
    } catch (e) { jobsError = errorText(e); }
  }
  async function renderSchedules() {
    if (document.activeElement?.classList?.contains('sched__cron')) return; // don't yank the input mid-type
    try { const r = await apiGetOk('/api/schedules'); if (Array.isArray(r)) scheds = r; } catch { /* keep last */ }
  }
  $effect(() => {
    if (!active || page !== 'jobs' || !canJobs) return;
    now = Date.now(); renderJobs(); renderSchedules();
    const unJobs = subscribe('jobs', renderJobs, 1500);
    const unScheds = subscribe('schedules', renderSchedules, 1500);
    const clock = setInterval(() => { now = Date.now(); }, 1000);
    return () => { unJobs(); unScheds(); clearInterval(clock); };
  });

  const runningJobs = $derived(jobs.filter((j) => j.status === 'running').length);

  function jobSummary(j) {
    if (j.status === 'failed') return j.error || t('systemPage.status.failed');
    if (j.status === 'running') return j.message || (j.total ? fmt(j.done) + '/' + fmt(j.total) : t('systemPage.status.working'));
    if (!j.result) return t('systemPage.status.done');
    return Object.entries(j.result).filter(([, val]) => val != null).map(([k, val]) => fmt(val) + ' ' + k.replace(/([A-Z])/g, ' $1').toLowerCase()).join(' · ') || t('systemPage.status.done');
  }
  const jobPct = (j) => j.status === 'running' && j.total ? Math.min(100, Math.round((j.done / j.total) * 100)) : (j.status === 'running' ? null : 100);

  async function saveSchedule(key, body) {
    const r = await apiPost('/api/schedules/' + key, body);
    if (r.error) notify(r.error, 'error'); else notify(t('systemPage.scheduleSaved'), 'ok');
    renderSchedules();
  }
  async function runNow(s) {
    s._starting = true;
    const r = await apiPost('/api/schedules/' + s.key + '/run');
    if (r?.error) notify(r.error, 'error'); else notify(t('systemPage.started', { name: s.label || s.key }), 'ok');
    renderSchedules(); renderJobs();
  }
  async function clearFinished() {
    const r = await apiPost('/api/jobs/clear');
    if (r?.error) notify(r.error, 'error');
    renderJobs();
  }

  // ================= TOOLS =================
  let st = $state(null);
  let verifyCorruptOnly = $state(false); // survives the 1.2s poll re-render
  let ghostsRemove = $state(false);      // unticked = preview only
  let dupesRemove = $state(false);       // extra good copies: unticked = preview only

  async function renderTools() { try { st = await apiGetOk('/api/tools'); } catch { /* keep last */ } }
  $effect(() => {
    if (!active || page !== 'tools' || !canJobs) return;
    renderTools();
    (async () => { // pick up a reorganize already running from before we arrived
      try { const s = await apiGetOk('/api/library/refile-status'); if (s?.running) { refileStatus = s; refileBusy = true; startRefilePoll(); } } catch { /* fine */ }
    })();
    return subscribe('tools', renderTools, 1200);
  });

  const runningTool = $derived(st?.running ? st.tool : null);
  const busy = $derived(!!st?.running);

  function summarizeToolResult(s) {
    const r = s.result || {};
    return Object.entries(r).map(([k, v]) => `${fmt(v)} ${k.replace(/([A-Z])/g, ' $1').toLowerCase()}`).join(' · ');
  }
  const TOOL_ICONS = {
    verify: 'shield', convert: 'convert', 'convert-cbz': 'convert', retag: 'tag', 'tag-files': 'tag',
    covers: 'image', 'refresh-covers': 'image', missing: 'search', 'find-missing': 'search',
    db: 'database', optimize: 'database', 'optimize-db': 'database',
  };
  const toolIcon = (id) => TOOL_ICONS[id] || 'tools';

  // ---- Reorganize library (dry-run preview, then execute) ----
  const segs = (p) => String(p || '').split(/[\\/]/);
  const tail = (p, n) => segs(p).slice(-n).join('/');
  let refilePlan = $state(null);
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
    try { refilePlan = await apiGetOk('/api/library/refile-plan'); }
    catch (e) { notify(t('systemPage.previewFailed', { error: errorText(e) }), 'error'); }
    refileBusy = false;
  }
  let refileStatus = $state(null);
  let refilePoll = null;
  function stopRefilePoll() { clearInterval(refilePoll); refilePoll = null; }
  function startRefilePoll() {
    stopRefilePoll();
    refilePoll = setInterval(async () => {
      try { refileStatus = await apiGetOk('/api/library/refile-status'); } catch { return; }
      if (!refileStatus?.running) {
        stopRefilePoll();
        refileBusy = false;
        if (refileStatus?.result) {
          const r = refileStatus.result;
          notify(t('systemPage.reorganizedResult', { count: r.moved, skipped: r.skipped ? t('systemPage.reorganizedSkipped', { count: fmt(r.skipped) }) : '' }), 'ok');
          refilePlan = null;
        } else if (refileStatus?.error) notify(t('systemPage.reorganizeFailed', { error: refileStatus.error }), 'error');
      }
    }, 1200);
  }
  $effect(() => () => stopRefilePoll()); // page teardown stops the poll
  async function runRefile() {
    const n = refilePlan?.counts?.move || 0;
    if (!n) return;
    if (!(await confirmDialog({
      title: t('systemPage.confirmReorganizeTitle', { count: n }),
      message: t('systemPage.confirmReorganizeMessage'),
      confirmLabel: t('systemPage.reorganize'),
    }))) return;
    refileBusy = true;
    let r;
    try { r = await apiPost('/api/library/refile', {}); } catch (e) { r = { error: String(e?.message || e) }; }
    if (r.error) { refileBusy = false; return notify(r.error, 'error'); }
    refileStatus = { running: true, done: 0, total: 0 };
    startRefilePoll();
  }

  let startingId = $state(null);
  async function runTool(tool) {
    startingId = tool.id;
    const body = tool.id === 'verify' && verifyCorruptOnly ? { corruptOnly: true }
      : tool.id === 'remove-ghosts' && ghostsRemove ? { remove: true }
      : tool.id === 'remove-duplicates' && dupesRemove ? { remove: true } : {};
    const r = await apiPost('/api/tools/' + tool.id, body);
    if (r.error) notify(r.error, 'error');
    startingId = null;
    renderTools();
  }

  // ================= LOGS =================
  let filter = $state('all');
  let category = $state('all');
  let logData = $state(null);
  let logsError = $state('');
  // A log line's level in the reader's language (unknown levels as sent).
  const levelName = (l) => (hasMessage('systemPage.logLevel.' + l) ? t('systemPage.logLevel.' + l) : l);
  let findText = $state('');
  let tail_ = $state(true); // live-tail on by default
  let expanded = $state({});
  let copiedId = $state('');
  let logScrollEl = $state(null);

  const dayOf = (ts) => new Date(ts).toDateString();
  const shownLogs = $derived.by(() => {
    const logs = logData?.logs || [];
    const q = findText.trim().toLowerCase();
    return q ? logs.filter((e) => `${e.message} ${e.category || ''}`.toLowerCase().includes(q)) : logs;
  });

  async function renderLogs() {
    try { logData = await apiGetOk(`/api/logs?level=${filter}&category=${encodeURIComponent(category)}`); logsError = ''; }
    catch (e) { logsError = errorText(e); } // keep the last good page
    // Live tail: hold to newest when on; when off, leave the scroll where it is.
    if (tail_ && logScrollEl) untrack(() => setTimeout(() => { if (logScrollEl) logScrollEl.scrollTop = logScrollEl.scrollHeight; }, 0));
  }
  $effect(() => {
    if (!active || page !== 'logs' || !canLogs) return;
    const p = new URLSearchParams(route.search);
    untrack(() => {
      filter = p.get('level') || 'all';
      category = p.get('cat') || 'all';
      renderLogs();
    });
    return subscribe('logs', renderLogs, 2000);
  });
  const cats = $derived(logData?.categories || []);
  $effect(() => { if (page === 'logs' && category !== 'all' && cats.length && !cats.includes(category)) setQuery({ cat: null }); });
  const counts = $derived(logData?.counts || {});

  const LEVELS = $derived([['all', t('systemPage.levelAll'), ''], ['error', t('systemPage.levelErrors'), 'var(--red)'], ['warn', t('systemPage.levelWarnings'), 'var(--amber)'], ['info', t('systemPage.levelInfo'), 'var(--cyan)']]);
  const levelCount = (id) => id === 'all' ? (logData?.logs?.length || 0) : (counts[id] || 0);

  const highlight = (text, q) => highlightHtml(text, q, 'sysx-mark');
  const toggleRow = (id) => { expanded = { ...expanded, [id]: !expanded[id] }; };
  function copyRow(id, text) {
    try { navigator.clipboard?.writeText(text); } catch { /* clipboard may be blocked */ }
    copiedId = id;
    clearTimeout(copyRow._t); copyRow._t = setTimeout(() => { copiedId = ''; }, 1200);
  }
  let supportBusy = $state(false), supportError = $state('');
  let sendBusy = $state(false), sendNote = $state(''), sendResult = $state(null), codeCopied = $state(false);
  async function sendSupport() {
    sendBusy = true; supportError = ''; sendResult = null;
    try {
      const r = await apiPost('/api/support/send', { note: sendNote });
      if (r.error) { supportError = r.error; return; }
      sendResult = r;
    } finally { sendBusy = false; }
  }
  async function copyCode() {
    if (!sendResult?.code) return;
    try { await navigator.clipboard.writeText(sendResult.code); codeCopied = true; setTimeout(() => { codeCopied = false; }, 1500); } catch { /* the code is on screen */ }
  }
  async function downloadSupport() {
    supportBusy = true; supportError = '';
    try {
      const r = await fetch('/api/support/package');
      if (!r.ok) {
        let msg = t('common.serverError', { status: r.status });
        try { msg = (await r.json()).error || msg; } catch { /* keep */ }
        supportError = msg;
        return;
      }
      const name = (r.headers.get('content-disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'backissue-support.zip';
      const url = URL.createObjectURL(await r.blob());
      const a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { supportError = String(e?.message || e); }
    finally { supportBusy = false; }
  }
  function exportLogs() {
    const lines = shownLogs.map((e) => `${new Date(e.ts).toISOString()} [${e.level}] ${e.category || ''} ${e.message}${e.detail ? '\n  ' + String(e.detail).replace(/\n/g, '\n  ') : ''}`);
    const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `backissue-logs-${new Date().toISOString().slice(0, 10)}.txt`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function clearLogs() {
    const r = await apiPost('/api/logs/clear');
    if (r?.error) return notify(r.error, 'error');
    notify(t('systemPage.logsCleared'), 'ok');
    renderLogs();
  }

  const headerSummary = $derived(
    page === 'jobs' ? (jobs.length ? t('systemPage.summaryJobs', { recent: fmt(jobs.length), running: fmt(runningJobs) }) : '')
    : page === 'logs' ? t('systemPage.summaryLogs', { errors: fmt(counts.error || 0), warnings: fmt(counts.warn || 0), info: fmt(counts.info || 0) })
    : t('systemPage.summaryTools'));
</script>

<main id="system-page" class="scan-page system-page sysx">
  <!-- header -->
  <div class="sysx__head">
    <h2 class="sysx__title">{t('systemPage.title')}</h2>
    <span class="sysx__summary">{headerSummary}</span>
    <div class="sysx__head-actions">
      {#if page === 'jobs'}<button class="sysx__ghost" onclick={clearFinished}>{t('systemPage.clearFinished')}</button>{/if}
      {#if page === 'logs'}<button class="sysx__ghost" onclick={clearLogs}>{t('systemPage.clearLogs')}</button>{/if}
    </div>
  </div>

  <!-- tab rail -->
  <div class="sysx__tabs">
    {#each TAB_DEFS as tab (tab.id)}
      <button class="sysx__tab" class:is-active={page === tab.id} onclick={() => selectTab(tab.id)}>
        <Icon name={tab.icon} size={15} />{tab.label}
        {#if tab.id === 'jobs' && runningJobs}<span class="sysx__tab-count">{runningJobs}</span>{/if}
      </button>
    {/each}
  </div>

  <!-- ============ JOBS ============ -->
  {#if canJobs}
    <div class="sysx__body" class:is-active={page === 'jobs'}>
      <div class="sysx__scroll"><div class="sysx__inner">
        <div class="sysx__h">{t('systemPage.scheduledTasks')}</div>
        <p class="sysx__note">{@html th('systemPage.cronNote')}</p>
        <div class="sysx__sched-table">
          {#each scheds as s (s.key)}
            <div class="sysx__sched" class:is-running={s.running} class:is-off={!s.enabled}>
              <label class="switch switch--sm"><input type="checkbox" checked={s.enabled} onchange={(e) => saveSchedule(s.key, { enabled: e.currentTarget.checked })} /><span class="switch__track"></span></label>
              <div class="sysx__sched-id">
                <div class="sysx__sched-label">{serverText(['jobs', 'tools'], s.label)}</div>
                <div class="sysx__sched-last">{s.lastRun ? t('systemPage.lastRunAgo', { time: fmtAgo(now - s.lastRun) }) : t('systemPage.neverRun')}</div>
              </div>
              <input class="sched__cron sysx__cron" type="text" spellcheck="false" value={s.cron} title={t('systemPage.cronTitle')}
                onchange={(e) => saveSchedule(s.key, { cron: e.currentTarget.value })} />
              {#if s.running}
                <span class="sysx__next sysx__next--run">{s.runningSince ? t('systemPage.runningFor', { time: fmtAgo(now - s.runningSince) }) : t('systemPage.running')}</span>
              {:else if !s.enabled}
                <span class="sysx__next sysx__next--off">{t('systemPage.off')}</span>
              {:else if s.invalid}
                <span class="sysx__next sysx__next--bad" title={s.invalid}>{t('systemPage.invalid')}</span>
              {:else if s.nextRun}
                <span class="sysx__next" title={new Date(s.nextRun).toLocaleString(currentLang())}>{fmtIn(s.nextRun - now)}</span>
              {:else}
                <span class="sysx__next sysx__next--off">{t('systemPage.never')}</span>
              {/if}
              <button class="sysx__ghost sysx__ghost--sm" disabled={s.running || s._starting} onclick={() => runNow(s)}>
                {s.running ? t('systemPage.runningEllipsis') : s._starting ? t('systemPage.startingEllipsis') : t('systemPage.runNow')}</button>
            </div>
          {/each}
        </div>

        <div class="sysx__h sysx__h--gap">{t('systemPage.recentRuns')} <span class="sysx__h-count">{jobs.length ? t('systemPage.nShown', { count: fmt(jobs.length) }) : ''}</span></div>
        {#if jobsError}
          <LoadError compact={jobsLoaded} error={jobsError} onretry={renderJobs} />
        {/if}
        {#if jobsLoaded && !jobs.length}
          <div class="sysx__empty-line">{t('systemPage.noJobs')}</div>
        {/if}
        {#each jobs as j (j.id ?? j.startedAt + j.type)}
          {@const pct = jobPct(j)}
          <div class="sysx__job" class:is-failed={j.status === 'failed'}>
            <div class="sysx__job-head">
              <span class="sysx__chip" style="color:{jobTone(j.type)}; background:color-mix(in srgb, {jobTone(j.type)} 15%, transparent);">{jobLabel(j.type)}</span>
              <span class="sysx__job-label">{serverText(['jobs', 'tools'], j.label)}</span>
              <span class="sysx__badge sysx__badge--{j.status}"><span class="sysx__bdot"></span>{j.status}</span>
              <span class="sysx__job-time">{j.status === 'running'
                ? t('systemPage.runningFor', { time: fmtAgo(now - j.startedAt) })
                : t('systemPage.agoTook', { ago: fmtAgo(now - (j.finishedAt || j.startedAt)), took: fmtAgo((j.finishedAt || now) - j.startedAt) })}</span>
            </div>
            {#if j.status === 'running'}
              <div class="sysx__track">
                {#if pct === null}<div class="sysx__bar sysx__bar--indet"></div>
                {:else}<div class="sysx__bar" style="width:{pct}%"></div>{/if}
              </div>
            {/if}
            <div class="sysx__job-summary">{jobSummary(j)}</div>
          </div>
        {/each}
      </div></div>
    </div>

    <!-- ============ TOOLS ============ -->
    <div class="sysx__body" class:is-active={page === 'tools'}>
      <div class="sysx__scroll"><div class="sysx__inner">
        <p class="sysx__note sysx__note--lead">{t('systemPage.toolsLead')}</p>

        <!-- Featured: reorganize -->
        <div class="sysx__refile">
          <div class="sysx__refile-head">
            <div class="sysx__refile-ico"><Icon name="folder" size={20} /></div>
            <div>
              <div class="sysx__refile-title">{t('systemPage.reorganizeTitle')}</div>
              <p class="sysx__refile-desc">{t('systemPage.reorganizeDesc')}</p>
            </div>
          </div>
          {#if refileStatus?.running}
            <div class="sysx__track sysx__track--lg"><div class="sysx__bar" style="width:{refileStatus.total ? Math.round(((refileStatus.done || 0) / refileStatus.total) * 100) : 0}%"></div></div>
            <div class="sysx__refile-meta">{t('systemPage.refileProgress', { message: refileStatus.message || t('systemPage.startingEllipsis'), done: fmt(refileStatus.done || 0), total: fmt(refileStatus.total || 0) })}{refileStatus.moved != null ? t('systemPage.refileMoved', { count: fmt(refileStatus.moved) }) : ''}</div>
          {/if}
          {#if refilePlan}
            <div class="sysx__refile-stats">
              <span class="sysx__stat"><b>{fmt(refilePlan.counts.move)}</b> {t('systemPage.toMove')}</span>
              <span class="sysx__stat"><b>{fmt(refilePlan.counts.unchanged)}</b> {t('systemPage.alreadyMatch')}</span>
              {#if refilePlan.counts.skip}<span class="sysx__stat"><b>{fmt(refilePlan.counts.skip)}</b> {t('systemPage.skipped')}</span>{/if}
              {#if refilePlan.counts.collision}<span class="sysx__stat sysx__stat--warn"><b>{fmt(refilePlan.counts.collision)}</b> {t('systemPage.nameCollisions')}</span>{/if}
            </div>
            {#if refileGroups.length}
              <div class="sysx__diff">
                {#each refileGroups as g (g.dir)}
                  <div class="sysx__diff-group">
                    <div class="sysx__diff-dir" title={g.dir}><Icon name="folder" size={14} /><span>{g.label}</span><span class="sysx__diff-count">{t('systemPage.nFiles', { count: g.items.length })}</span></div>
                    {#each g.items as it (it.fullFrom)}
                      <div class="sysx__diff-item" title={it.fullFrom + '\n→ ' + it.fullTo}>
                        <span class="sysx__diff-from">{it.from}</span>
                        <span class="sysx__diff-to">→ {it.to}</span>
                      </div>
                    {/each}
                  </div>
                {/each}
                {#if refilePlan.truncated}
                  <div class="sysx__diff-more">{t('systemPage.showingFirstMoves', { shown: fmt(refilePlan.moves.length), total: fmt(refilePlan.counts.move) })}</div>
                {/if}
              </div>
            {:else}
              <div class="sysx__note">{t('systemPage.nothingToMove')}</div>
            {/if}
          {/if}
          <div class="sysx__refile-actions">
            <button class="sysx__ghost" disabled={refileBusy} onclick={previewRefile}>{refileBusy && !refilePlan ? t('systemPage.previewing') : refilePlan ? t('systemPage.repreview') : t('systemPage.preview')}</button>
            {#if refilePlan && refilePlan.counts.move}
              <button class="sysx__primary" disabled={refileBusy} onclick={runRefile}>{refileBusy ? t('systemPage.reorganizing') : t('systemPage.reorganizeN', { count: fmt(refilePlan.counts.move) })}</button>
            {/if}
          </div>
        </div>

        <!-- support package -->
        <div class="sysx__h">{t('systemPage.gettingHelp')}</div>
        <div class="sysx__tools-grid">
          <div class="sysx__tool">
            <div class="sysx__tool-head">
              <div class="sysx__tool-ico"><Icon name="download" size={18} /></div>
              <div class="sysx__tool-id">
                <div class="sysx__tool-name">{t('systemPage.supportPackage')}</div>
                <p class="sysx__tool-desc">{t('systemPage.supportDesc')}</p>
              </div>
            </div>
            {#if supportError}
              <div class="sysx__tool-result sysx__tool-result--err"><Icon name="close" size={14} /> {supportError}</div>
            {/if}
            {#if sendResult?.code}
              <div class="sysx__tool-result sysx__support-code">
                <Icon name="check" size={14} />
                <span>{t('systemPage.sentQuoteCode')}</span>
                <code class="sysx__code">{sendResult.code}</code>
                <button class="sysx__ghost" onclick={copyCode}>{codeCopied ? t('common.copied') : t('common.copy')}</button>
                {#if sendResult.expiresInDays}<span class="sysx__muted">{t('systemPage.keptForDays', { count: sendResult.expiresInDays })}</span>{/if}
              </div>
            {/if}
            <div class="sysx__tool-actions">
              <button class="sysx__primary" disabled={supportBusy || sendBusy} onclick={downloadSupport}>{supportBusy ? t('systemPage.building') : t('systemPage.downloadSupport')}</button>
              <input class="sysx__support-note" placeholder={t('systemPage.supportNotePlaceholder')} maxlength="200" bind:value={sendNote} disabled={sendBusy} />
              <button class="sysx__ghost" disabled={supportBusy || sendBusy} onclick={sendSupport}>{sendBusy ? t('systemPage.sending') : t('systemPage.sendToSupport')}</button>
            </div>
          </div>
        </div>

        <!-- tool grid -->
        <div class="sysx__h">{t('systemPage.maintenance')}</div>
        <div class="sysx__tools-grid">
          {#each st?.catalog || [] as tool (tool.id)}
            <div class="sysx__tool" class:is-running={runningTool === tool.id}>
              <div class="sysx__tool-head">
                <div class="sysx__tool-ico"><Icon name={toolIcon(tool.id)} size={18} /></div>
                <div class="sysx__tool-id">
                  <div class="sysx__tool-name">{serverText('tools', tool.label)}</div>
                  <p class="sysx__tool-desc">{serverText('tools', tool.desc)}</p>
                </div>
              </div>
              {#if runningTool === tool.id && st.total}
                <div class="sysx__track"><div class="sysx__bar" style="width:{Math.round(((st.done || 0) / st.total) * 100)}%"></div></div>
                <div class="sysx__tool-meta">{st.message || ''} · {fmt(st.done || 0)}/{fmt(st.total)}</div>
              {/if}
              {#if runningTool !== tool.id && st?.ranAt && st.tool === tool.id && st.result}
                <div class="sysx__tool-result"><Icon name="check" size={14} /> {summarizeToolResult(st)}</div>
              {/if}
              {#if runningTool !== tool.id && st?.tool === tool.id && st.error}
                <div class="sysx__tool-result sysx__tool-result--err"><Icon name="close" size={14} /> {st.error}</div>
              {/if}
              {#if tool.id === 'verify'}
                <label class="sysx__tool-opt"><input type="checkbox" bind:checked={verifyCorruptOnly} disabled={busy} /> {st?.corruptCount ? t('systemPage.onlyCorruptCount', { count: fmt(st.corruptCount) }) : t('systemPage.onlyCorrupt')}</label>
              {/if}
              {#if tool.id === 'remove-ghosts'}
                <label class="sysx__tool-opt"><input type="checkbox" bind:checked={ghostsRemove} disabled={busy} /> {t('systemPage.ghostsDelete')}</label>
              {/if}
              {#if tool.id === 'remove-duplicates'}
                <label class="sysx__tool-opt"><input type="checkbox" bind:checked={dupesRemove} disabled={busy} /> {t('systemPage.dupesDelete')}</label>
              {/if}
              <div class="sysx__tool-foot">
                <button class="sysx__primary sysx__primary--sm" disabled={busy || startingId === tool.id} onclick={() => runTool(tool)}>
                  {runningTool === tool.id ? t('systemPage.runningEllipsis') : startingId === tool.id ? t('systemPage.startingEllipsis') : t('systemPage.run')}</button>
              </div>
            </div>
          {/each}
        </div>
        <!-- Plugin-provided tools inject here (plain DOM — kept mounted so plugin
             element refs for live labels survive tab switches). -->
        <div id="tools-plugin-actions" class="sysx__tools-grid sysx__tools-grid--plugins"></div>
      </div></div>
    </div>
  {/if}

  <!-- ============ LOGS ============ -->
  {#if canLogs}
    <div class="sysx__body sysx__body--logs" class:is-active={page === 'logs'}>
      <div class="sysx__logbar">
        {#each LEVELS as [id, label, dot] (id)}
          <button class="sysx__lvl" class:is-active={filter === id} onclick={() => setQuery({ level: id === 'all' ? null : id })}>
            {#if dot}<span class="sysx__lvl-dot" style="background:{dot};"></span>{/if}{label}
            {#if levelCount(id)}<span class="sysx__lvl-count">{levelCount(id)}</span>{/if}
          </button>
        {/each}
        <select class="sysx__catsel" value={category} onchange={(e) => setQuery({ cat: e.currentTarget.value === 'all' ? null : e.currentTarget.value })}>
          <option value="all">{t('systemPage.allCategories')}</option>
          {#each cats as c (c)}<option value={c}>{c}</option>{/each}
        </select>
        <div class="sysx__logfind">
          <Icon name="search" size={15} />
          <input placeholder={t('systemPage.filterMessages')} bind:value={findText} spellcheck="false" />
        </div>
        <label class="sysx__tail">
          <span class="switch switch--sm"><input type="checkbox" bind:checked={tail_} /><span class="switch__track"></span></span>
          <span class="sysx__tail-label">{t('systemPage.liveTail')}</span>
        </label>
        <button class="sysx__iconbtn" title={t('systemPage.downloadLogs')} onclick={exportLogs}><Icon name="download" size={14} /></button>
      </div>
      <div class="sysx__logscroll" bind:this={logScrollEl}>
        {#if logsError}
          <LoadError compact={!!logData} error={logsError} onretry={renderLogs} />
        {/if}
        {#if logData && !logData.logs?.length}
          <div class="sysx__log-empty">{t('systemPage.nothingLogged')}</div>
        {:else if logData && !shownLogs.length}
          <div class="sysx__log-empty">{t('systemPage.nothingMatches', { query: findText })}</div>
        {/if}
        {#each shownLogs as e, i (i)}
          {#if i === 0 || dayOf(e.ts) !== dayOf(shownLogs[i - 1].ts)}
            <div class="sysx__logday">{new Date(e.ts).toLocaleDateString(currentLang(), { weekday: 'short', month: 'short', day: 'numeric' })}</div>
          {/if}
          {@const lid = 'log' + i}
          {@const exp = !!expanded[lid]}
          <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
          <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
          <div class="sysx__logrow sysx__logrow--{e.level}" class:has-detail={!!e.detail} onclick={() => { if (e.detail) toggleRow(lid); }} role={e.detail ? 'button' : undefined} tabindex={e.detail ? 0 : undefined} onkeydown={(ev) => { if (e.detail && ev.key === 'Enter') toggleRow(lid); }}>
            {#if e.detail}<span class="sysx__chev" class:is-open={exp}><Icon name="chevron-right" size={13} /></span>{:else}<span class="sysx__chev-sp"></span>{/if}
            <span class="sysx__logtime">{new Date(e.ts).toLocaleTimeString(currentLang())}</span>
            <span class="sysx__loglevel">{levelName(e.level)}</span>
            {#if e.category}<span class="sysx__logcat">{e.category}</span>{/if}
            <span class="sysx__logmsg">{@html highlight(e.message, findText.trim().toLowerCase())}</span>
            {#if copiedId === lid}<span class="sysx__copied">{t('systemPage.copied')}</span>{/if}
            <button class="sysx__copybtn" title={t('systemPage.copyLine')} onclick={(ev) => { ev.stopPropagation(); copyRow(lid, `[${e.level}] ${e.category || ''} — ${e.message}` + (e.detail ? '\n' + e.detail : '')); }}><Icon name="copy" size={13} /></button>
          </div>
          {#if e.detail && exp}
            <pre class="sysx__detail">{e.detail}</pre>
          {/if}
        {/each}
      </div>
    </div>
  {/if}
</main>

<style>
  .sysx { min-width: 0; }
  .sysx__head { display: flex; align-items: center; gap: 12px; padding: 12px 18px; border-bottom: 1px solid var(--line); flex: none; flex-wrap: wrap; }
  .sysx__title { margin: 0; font-family: var(--font-display); font-size: 22px; letter-spacing: .03em; font-weight: 400; }
  .sysx__summary { font-size: 12.5px; color: var(--faint); }
  .sysx__head-actions { margin-left: auto; display: flex; gap: 8px; }

  .sysx__tabs { display: flex; gap: 6px; padding: 11px 18px; border-bottom: 1px solid var(--line); overflow-x: auto; flex: none; scrollbar-width: none; }
  .sysx__tabs::-webkit-scrollbar { display: none; }
  .sysx__tab { display: flex; align-items: center; gap: 7px; height: 34px; padding: 0 15px; border-radius: 8px; border: 1px solid var(--line); background: transparent; color: var(--muted); font: 600 12.5px var(--font-body); cursor: pointer; white-space: nowrap; flex: none; }
  .sysx__tab.is-active { background: var(--accent); border-color: var(--accent); color: #fff; }
  .sysx__tab-count { font: 600 11px var(--font-mono); background: var(--cyan); color: var(--ink); border-radius: 999px; padding: 1px 7px; }
  .sysx__tab.is-active .sysx__tab-count { background: rgba(255,255,255,.2); color: #fff; }

  /* Tab bodies: all mounted, only the active one shown (keeps plugin mount alive). */
  .sysx__body { display: none; flex: 1; min-height: 0; }
  .sysx__body.is-active { display: flex; flex-direction: column; }
  .sysx__scroll { flex: 1; overflow-y: auto; padding: 22px 18px 60px; }
  .sysx__inner { max-width: 900px; margin: 0 auto; }

  .sysx__ghost { height: 36px; padding: 0 14px; border: 1px solid var(--line); background: transparent; color: var(--muted); border-radius: 8px; font: 600 13px var(--font-body); cursor: pointer; }
  .sysx__ghost:hover:not(:disabled) { color: var(--text); border-color: var(--muted); }
  .sysx__ghost:disabled { opacity: .5; cursor: default; }
  .sysx__ghost--sm { height: 32px; padding: 0 13px; font-size: 12px; flex: none; }
  .sysx__primary { height: 34px; padding: 0 16px; border: none; background: var(--accent); color: #fff; border-radius: 8px; font: 600 12.5px var(--font-body); cursor: pointer; }
  .sysx__primary:disabled { opacity: .6; cursor: default; }
  .sysx__primary--sm { height: 32px; }

  .sysx__h { font-family: var(--font-display); font-size: 16px; letter-spacing: .03em; margin: 0 2px 6px; display: flex; align-items: baseline; gap: 10px; }
  .sysx__h--gap { margin-top: 28px; }
  .sysx__h-count { font-family: var(--font-body); font-size: 12px; color: var(--faint); font-weight: 400; }
  .sysx__note { font-size: 12.5px; color: var(--faint); margin: 0 0 14px; line-height: 1.55; max-width: 640px; }
  .sysx__note--lead { margin-bottom: 18px; }
  .sysx__note :global(code) { font-family: var(--font-mono); color: var(--muted); }

  /* schedules */
  .sysx__sched-table { border: 1px solid var(--line); border-radius: 12px; overflow: hidden; background: rgba(255,255,255,.015); margin-bottom: 4px; }
  .sysx__sched { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-bottom: 1px solid #2a2536; flex-wrap: wrap; }
  .sysx__sched:last-child { border-bottom: none; }
  .sysx__sched.is-running { background: rgba(43,212,217,.04); }
  .sysx__sched-id { min-width: 150px; flex: 1; }
  .sysx__sched-label { font-size: 13.5px; font-weight: 600; }
  .sysx__sched.is-off .sysx__sched-label { color: var(--faint); }
  .sysx__sched-last { font-size: 11.5px; color: var(--faint); margin-top: 2px; }
  .sysx__cron { width: 132px; height: 32px; padding: 0 10px; background: var(--ink); border: 1px solid var(--line); border-radius: 7px; color: var(--text); font: 12.5px var(--font-mono); flex: none; }
  .sysx__cron:focus { outline: none; border-color: var(--accent); }
  .sysx__next { font: 12px var(--font-mono); flex: none; min-width: 96px; text-align: right; color: #c4bdd4; }
  .sysx__next--run { color: var(--cyan); }
  .sysx__next--off { color: #6f6885; }
  .sysx__next--bad { color: var(--red); }

  /* recent runs */
  .sysx__job { border: 1px solid var(--line); border-radius: 11px; background: rgba(255,255,255,.015); padding: 14px 16px; margin-bottom: 10px; }
  .sysx__job.is-failed { border-color: rgba(255,90,82,.25); }
  .sysx__job-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .sysx__chip { font: 600 11px var(--font-body); text-transform: uppercase; letter-spacing: .05em; border-radius: 5px; padding: 3px 8px; }
  .sysx__job-label { font-size: 13.5px; font-weight: 600; flex: 1; min-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sysx__job-time { font: 11.5px var(--font-mono); color: var(--faint); }
  .sysx__badge { display: inline-flex; align-items: center; gap: 6px; font: 600 10.5px var(--font-body); text-transform: uppercase; letter-spacing: .04em; border-radius: 6px; padding: 4px 9px; }
  .sysx__bdot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  .sysx__badge--running { color: var(--cyan); background: rgba(43,212,217,.1); border: 1px solid rgba(43,212,217,.35); }
  .sysx__badge--done { color: var(--green); background: rgba(95,211,138,.1); border: 1px solid rgba(95,211,138,.3); }
  .sysx__badge--failed { color: var(--red); background: rgba(255,90,82,.1); border: 1px solid rgba(255,90,82,.3); }
  .sysx__job-summary { font-size: 12px; color: var(--muted); margin-top: 9px; }

  .sysx__track { height: 5px; border-radius: 5px; background: var(--ink); overflow: hidden; position: relative; margin-top: 11px; }
  .sysx__track--lg { margin-top: 13px; }
  .sysx__bar { height: 100%; border-radius: 5px; background: var(--cyan); }
  .sysx__bar--indet { position: absolute; top: 0; left: 0; width: 32%; animation: sysx-indet 1.3s ease-in-out infinite; }
  @keyframes sysx-indet { 0% { transform: translateX(-100%); } 100% { transform: translateX(320%); } }

  .sysx__empty-line { color: var(--muted); padding: 24px; text-align: center; font-size: 13px; }

  /* reorganize */
  .sysx__refile { border: 1px solid rgba(255,45,111,.28); border-radius: 14px; background: linear-gradient(180deg, rgba(255,45,111,.05), rgba(255,255,255,.012)); padding: 18px 20px; margin-bottom: 22px; }
  .sysx__refile-head { display: flex; align-items: flex-start; gap: 13px; }
  .sysx__refile-ico { width: 42px; height: 42px; border-radius: 11px; flex: none; display: grid; place-items: center; background: rgba(255,45,111,.14); color: var(--accent); }
  .sysx__refile-title { font-size: 15px; font-weight: 600; }
  .sysx__refile-desc { font-size: 12.5px; color: var(--muted); margin: 6px 0 0; line-height: 1.5; }
  .sysx__refile-stats { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
  .sysx__stat { font-size: 12px; color: #c4bdd4; background: var(--panel-2); border-radius: 7px; padding: 6px 11px; }
  .sysx__stat b { color: var(--text); }
  .sysx__stat--warn { color: var(--amber); background: rgba(255,194,75,.08); border: 1px solid rgba(255,194,75,.25); }
  .sysx__refile-meta { font-size: 11.5px; color: var(--faint); margin-top: 6px; }
  .sysx__diff { border: 1px solid var(--line); border-radius: 10px; background: var(--ink); margin-top: 14px; overflow: hidden; }
  .sysx__diff-group { border-bottom: 1px solid #241f30; }
  .sysx__diff-group:last-child { border-bottom: none; }
  .sysx__diff-dir { display: flex; align-items: center; gap: 8px; padding: 9px 12px; background: rgba(255,255,255,.02); font: 12px var(--font-mono); color: #c4bdd4; }
  .sysx__diff-dir span:first-of-type { flex: 1; }
  .sysx__diff-dir :global(svg) { color: var(--faint); }
  .sysx__diff-count { font-family: var(--font-body); font-size: 11px; color: var(--faint); }
  .sysx__diff-item { padding: 7px 12px 7px 32px; font: 11.5px var(--font-mono); line-height: 1.5; }
  .sysx__diff-from { color: var(--faint); text-decoration: line-through; }
  .sysx__diff-to { color: var(--green); display: block; }
  .sysx__diff-more { padding: 8px 12px; font-size: 11.5px; color: var(--faint); }
  .sysx__refile-actions { display: flex; gap: 8px; margin-top: 14px; }

  /* tools grid */
  .sysx__tools-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  .sysx__tools-grid--plugins:empty { display: none; }
  .sysx__tools-grid--plugins { margin-top: 14px; }
  .sysx__tool { border: 1px solid var(--line); border-radius: 12px; background: rgba(255,255,255,.015); padding: 16px; display: flex; flex-direction: column; }
  .sysx__tool.is-running { border-color: rgba(43,212,217,.3); }
  .sysx__tool-head { display: flex; align-items: flex-start; gap: 12px; }
  .sysx__tool-ico { width: 38px; height: 38px; border-radius: 10px; flex: none; display: grid; place-items: center; background: var(--panel-2); color: var(--muted); }
  .sysx__tool-id { flex: 1; min-width: 0; }
  .sysx__tool-name { font-size: 14px; font-weight: 600; }
  .sysx__tool-desc { font-size: 12px; color: var(--faint); margin: 5px 0 0; line-height: 1.5; }
  .sysx__tool-meta { font-size: 11.5px; color: var(--faint); margin-top: 6px; }
  .sysx__tool-result { font-size: 12px; color: var(--green); margin-top: 11px; display: flex; align-items: center; gap: 6px; }
  .sysx__tool-result--err { color: var(--red); }
  .sysx__tool-actions { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; align-items: center; }
  .sysx__support-note { flex: 1 1 220px; min-width: 0; padding: 7px 10px; border-radius: 8px; border: 1px solid var(--line, #2a2a30); background: var(--panel, #17171b); color: inherit; font: inherit; font-size: 13px; }
  .sysx__support-code { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .sysx__code { font-size: 15px; font-weight: 700; letter-spacing: 0.08em; padding: 3px 8px; border-radius: 6px; background: var(--panel, #17171b); border: 1px solid var(--line, #2a2a30); }
  .sysx__muted { opacity: 0.7; font-size: 12px; }
  .sysx__tool-opt { display: flex; align-items: center; gap: 8px; margin-top: 11px; cursor: pointer; font-size: 12px; color: var(--muted); }
  .sysx__tool-opt input { accent-color: var(--accent); width: 15px; height: 15px; }
  .sysx__tool-foot { margin-top: 14px; padding-top: 13px; border-top: 1px solid var(--line); display: flex; }

  /* logs */
  .sysx__body--logs.is-active { display: flex; flex-direction: column; }
  .sysx__logbar { display: flex; align-items: center; gap: 8px; padding: 11px 18px; border-bottom: 1px solid var(--line); flex: none; flex-wrap: wrap; }
  .sysx__lvl { display: flex; align-items: center; gap: 6px; height: 32px; padding: 0 12px; border-radius: 7px; border: 1px solid var(--line); background: transparent; color: var(--muted); font: 600 12px var(--font-body); cursor: pointer; white-space: nowrap; }
  .sysx__lvl.is-active { background: var(--accent); border-color: var(--accent); color: #fff; }
  .sysx__lvl-dot { width: 7px; height: 7px; border-radius: 50%; }
  .sysx__lvl-count { font: 600 10.5px var(--font-mono); background: var(--panel-2); color: var(--faint); border-radius: 999px; padding: 1px 6px; }
  .sysx__lvl.is-active .sysx__lvl-count { background: rgba(255,255,255,.2); color: #fff; }
  .sysx__catsel { height: 32px; padding: 0 10px; background: var(--ink); border: 1px solid var(--line); border-radius: 8px; color: var(--text); font: 12.5px var(--font-body); margin-left: 6px; }
  .sysx__catsel:focus { outline: none; border-color: var(--accent); }
  .sysx__logfind { position: relative; display: flex; align-items: center; margin-left: auto; color: var(--faint); }
  .sysx__logfind :global(svg) { position: absolute; left: 10px; pointer-events: none; }
  .sysx__logfind input { height: 32px; width: 200px; max-width: 42vw; padding: 0 11px 0 32px; background: var(--ink); border: 1px solid var(--line); border-radius: 8px; color: var(--text); font: 12.5px var(--font-body); }
  .sysx__logfind input:focus { outline: none; border-color: var(--accent); }
  .sysx__tail { display: flex; align-items: center; gap: 8px; cursor: pointer; }
  .sysx__tail-label { font-size: 12px; color: var(--muted); white-space: nowrap; }
  .sysx__iconbtn { width: 32px; height: 32px; display: grid; place-items: center; border: 1px solid var(--line); background: transparent; color: var(--muted); border-radius: 7px; cursor: pointer; flex: none; }
  .sysx__iconbtn:hover { color: var(--text); border-color: var(--muted); }

  .sysx__logscroll { flex: 1; overflow-y: auto; padding: 8px 0 60px; background: #100e17; }
  .sysx__log-empty { padding: 48px 24px; text-align: center; color: var(--faint); font-size: 13px; }
  .sysx__logday { padding: 12px 18px 6px; font: 600 11px var(--font-body); text-transform: uppercase; letter-spacing: .08em; color: var(--faint); position: sticky; top: 0; background: #100e17; z-index: 1; }
  .sysx__logrow { display: flex; align-items: baseline; gap: 10px; padding: 6px 14px 6px 18px; border-left: 2px solid var(--line); }
  .sysx__logrow.has-detail { cursor: pointer; }
  .sysx__logrow--error { border-left-color: var(--red); background: rgba(255,90,82,.04); }
  .sysx__logrow--warn { border-left-color: var(--amber); }
  .sysx__logrow--info { border-left-color: var(--cyan); }
  .sysx__chev { display: flex; flex: none; color: #6f6885; transition: transform .15s; }
  .sysx__chev.is-open { transform: rotate(90deg); }
  .sysx__chev-sp { width: 13px; flex: none; }
  .sysx__logtime { font: 11.5px var(--font-mono); color: #6f6885; flex: none; width: 74px; }
  .sysx__loglevel { font: 600 10px var(--font-body); text-transform: uppercase; letter-spacing: .05em; flex: none; width: 46px; }
  .sysx__logrow--error .sysx__loglevel { color: var(--red); }
  .sysx__logrow--warn .sysx__loglevel { color: var(--amber); }
  .sysx__logrow--info .sysx__loglevel { color: var(--cyan); }
  .sysx__logcat { font: 11px var(--font-mono); color: var(--faint); flex: none; }
  .sysx__logmsg { font: 12.5px var(--font-mono); color: #c4bdd4; flex: 1; min-width: 0; line-height: 1.5; word-break: break-word; }
  .sysx__logrow--error .sysx__logmsg { color: #f4c9c6; }
  .sysx__logrow--warn .sysx__logmsg { color: #ecdcc0; }
  :global(.sysx-mark) { background: rgba(255,45,111,.35); color: #fff; border-radius: 2px; padding: 0 1px; }
  .sysx__copied { font-size: 10.5px; color: var(--green); flex: none; }
  .sysx__copybtn { width: 24px; height: 24px; display: grid; place-items: center; background: none; border: none; color: #6f6885; cursor: pointer; flex: none; border-radius: 5px; }
  .sysx__copybtn:hover { color: var(--text); }
  .sysx__detail { margin: 0 14px 8px 44px; padding: 11px 13px; background: #0b0910; border: 1px solid #241f30; border-radius: 8px; font: 11.5px var(--font-mono); color: var(--muted); line-height: 1.6; white-space: pre-wrap; word-break: break-word; }

  @media (max-width: 820px) {
    .sysx__tools-grid { grid-template-columns: 1fr; }
    .sysx__logfind { margin-left: 0; order: 5; }
  }
</style>
