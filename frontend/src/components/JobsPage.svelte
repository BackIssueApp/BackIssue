<script>
  import Icon from '../lib/Icon.svelte';
  import { goBack } from '../lib/router.svelte.js';
  import { apiGet, apiPost } from '../lib/api.js';
  import { subscribe } from '../lib/events.svelte.js';
  import { notify } from '../lib/toasts.svelte.js';
  import { fmt, fmtAgo, fmtIn } from '../lib/util.js';

  let { active = false } = $props();

  const JOB_LABELS = {
    crawl: 'Catalog', 'cv-match': 'ComicVine', 'scan-folder': 'Scan', 'tag-files': 'Tag',
    releases: 'Releases', updates: 'Updates', tool: 'Tool', 'zero-day': '0-Day', 'wanted-search': 'Wanted',
    'pack-import': 'Pack', 'import-scan': 'Import', 'import-run': 'Import',
  };

  let jobs = $state([]);
  let scheds = $state([]);
  let now = $state(Date.now());
  let loaded = $state(false);

  async function renderJobs() {
    try { jobs = await apiGet('/api/jobs'); loaded = true; } catch { /* keep last */ }
  }
  async function renderSchedules() {
    // Rebuild only when not editing the cron field (don't yank the input mid-type).
    if (document.activeElement?.classList?.contains('sched__cron')) return;
    try { scheds = await apiGet('/api/schedules'); } catch { /* keep last */ }
  }
  $effect(() => {
    if (!active) return;
    now = Date.now(); renderJobs(); renderSchedules();
    const unJobs = subscribe('jobs', renderJobs, 1500);
    const unScheds = subscribe('schedules', renderSchedules, 1500);
    // The countdown/duration labels derive from `now` — tick it locally, no fetch.
    const clock = setInterval(() => { now = Date.now(); }, 1000);
    return () => { unJobs(); unScheds(); clearInterval(clock); };
  });

  const running = $derived(jobs.filter((j) => j.status === 'running').length);

  function jobSummary(j) {
    if (j.status === 'failed') return j.error || 'failed';
    if (j.status === 'running') return j.message || (j.total ? fmt(j.done) + '/' + fmt(j.total) : 'working…');
    if (!j.result) return 'done';
    return Object.entries(j.result).filter(([, val]) => val != null).map(([k, val]) => fmt(val) + ' ' + k.replace(/([A-Z])/g, ' $1').toLowerCase()).join(' · ') || 'done';
  }
  const jobPct = (j) => j.status === 'running' && j.total ? Math.min(100, Math.round((j.done / j.total) * 100)) : (j.status === 'running' ? null : 100);

  async function saveSchedule(key, body) {
    const r = await apiPost('/api/schedules/' + key, body);
    if (r.error) notify(r.error, 'error');
    else notify('Schedule saved.', 'ok');
    renderSchedules();
  }
  async function runNow(s) {
    s._starting = true;
    const r = await apiPost('/api/schedules/' + s.key + '/run');
    if (r?.error) notify(r.error, 'error');
    else notify(`Started "${s.label || s.key}".`, 'ok');
    renderSchedules();
    renderJobs();
  }
  async function clearFinished() {
    const r = await apiPost('/api/jobs/clear');
    if (r?.error) notify(r.error, 'error');
    renderJobs();
  }
</script>

<main id="jobs-page" class="scan-page jobs-page">
  <div class="scan-page__bar">
    <button id="jobs-back" class="btn btn--ghost" onclick={goBack}><Icon name="arrow-left" /> Back</button>
    <h2 class="scan-page__title">Jobs</h2>
    <span id="jobs-summary" class="scan-summary">{jobs.length ? `${fmt(jobs.length)} recent · ${fmt(running)} running` : ''}</span>
    <button id="jobs-clear" class="btn btn--ghost" onclick={clearFinished}>Clear finished</button>
  </div>
  <div class="jobs-scroll">
    <div class="jobs-section">
      <p class="modal__subhead">Scheduled tasks</p>
      <p class="modal__note">Toggle a task on and set when it runs with a cron pattern — <code>minute hour day month weekday</code>. Examples: <code>0 9 * * 3</code> = Wednesdays 9am · <code>0 */12 * * *</code> = every 12 hours · <code>0 6 * * *</code> = daily 6am. A run missed while the app was off catches up once at the next start.</p>
      <div id="schedules-list" class="schedules-list">
        {#each scheds as s (s.key)}
          <div class="sched" class:is-running={s.running} class:is-off={!s.enabled}>
            <label class="switch switch--sm"><input type="checkbox" class="sched__on" checked={s.enabled} onchange={(e) => saveSchedule(s.key, { enabled: e.currentTarget.checked })} /><span class="switch__track"></span></label>
            <span class="sched__label">{s.label}</span>
            <input class="sched__cron mono" type="text" spellcheck="false" value={s.cron} title="min hour day month weekday — e.g. 0 9 * * 3 = Wednesdays 9am"
              onchange={(e) => saveSchedule(s.key, { cron: e.currentTarget.value })} />
            {#if s.running}
              <span class="badge badge--downloading"><span class="dot"></span>running{s.runningSince ? ' · ' + fmtAgo(now - s.runningSince) : ''}</span>
            {:else if !s.enabled}
              <span class="sched__next sched__off">off</span>
            {:else if s.invalid}
              <span class="sched__next sched__bad" title={s.invalid}>invalid pattern</span>
            {:else if s.nextRun}
              <span class="sched__next" title={new Date(s.nextRun).toLocaleString()}>{fmtIn(s.nextRun - now)}</span>
            {:else}
              <span class="sched__next sched__off">never</span>
            {/if}
            {#if s.lastRun}
              <span class="sched__last">last {fmtAgo(now - s.lastRun)} ago</span>
            {:else}
              <span class="sched__last">never run</span>
            {/if}
            <button class="btn btn--ghost btn--sm" disabled={s.running || s._starting} onclick={() => runNow(s)}>
              {s.running ? 'Running…' : s._starting ? 'Starting…' : 'Run now'}</button>
          </div>
        {/each}
      </div>
    </div>
    <div class="jobs-section">
      <p class="modal__subhead">Recent runs</p>
      <div id="jobs-list" class="jobs-list">
        {#if loaded && !jobs.length}
          <div class="jobs-empty">No jobs yet. Background tasks (crawl, ComicVine match, scans, tagging, release checks) show up here.</div>
        {/if}
        {#each jobs as j (j.id ?? j.startedAt + j.type)}
          {@const pct = jobPct(j)}
          <div class="job {j.status === 'failed' ? 'is-failed' : j.status === 'running' ? 'is-running' : 'is-done'}">
            <div class="job__head"><span class="job__type">{JOB_LABELS[j.type] || j.type}</span>
              <span class="job__label">{j.label}</span>
              <span class="job__status badge {j.status === 'failed' ? 'badge--failed' : j.status === 'running' ? 'badge--downloading' : 'badge--done'}"><span class="dot"></span>{j.status}</span>
              <span class="job__time">{j.status === 'running'
                ? `running ${fmtAgo(now - j.startedAt)}`
                : `${fmtAgo(now - (j.finishedAt || j.startedAt))} ago · took ${fmtAgo((j.finishedAt || now) - j.startedAt)}`}</span></div>
            <div class="job__track">
              {#if pct === null}<div class="job__bar job__bar--indef"></div>
              {:else}<div class="job__bar" style="width:{pct}%"></div>{/if}
            </div>
            <div class="job__summary">{jobSummary(j)}</div>
          </div>
        {/each}
      </div>
    </div>
  </div>
</main>
