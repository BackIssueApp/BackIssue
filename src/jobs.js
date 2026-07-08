// Job registry: every discrete background operation (crawl, CV match, folder
// scan, tagging, release check, 0-day grab, pack import…) registers a run here so
// the Jobs page can show what's running, its progress, and how it finished.
// Finished runs persist to the database (jobs_history) and survive restarts;
// live progress stays in memory (no DB write per progress tick). On boot,
// attachJobsDb() marks any rows a crashed/killed session left 'running' as failed.

const RUNNING = [];            // live jobs, newest first (hot progress, memory only)
const MEM_FINISHED = [];       // fallback ring when no DB is attached (tests/standalone)
const MEM_MAX = 60;
let seq = 0;
let dbh = null;
let clock = () => Date.now();

// Injectable clock (tests). Production uses Date.now.
export function _setClock(fn) { clock = fn; }

// Attach the app database. Reconciles orphans: a row still 'running' can only
// mean the previous session died mid-job.
export function attachJobsDb(database) {
  dbh = database;
  dbh.prepare("UPDATE jobs_history SET status='failed', error='app restarted mid-run', finished_at=? WHERE status='running'").run(clock());
}

function persistStart(job) {
  if (!dbh) return null;
  return dbh.prepare('INSERT INTO jobs_history (type, label, status, started_at) VALUES (?,?,?,?)')
    .run(job.type, job.label, 'running', job.startedAt).lastInsertRowid;
}

function persistEnd(job) {
  if (!dbh || job.dbId == null) { finishToMemory(job); return; }
  dbh.prepare('UPDATE jobs_history SET status=?, done=?, total=?, message=?, result=?, error=?, finished_at=? WHERE id=?')
    .run(job.status, job.done, job.total, job.message, job.result != null ? JSON.stringify(job.result) : null, job.error, job.finishedAt, job.dbId);
}

function finishToMemory(job) {
  MEM_FINISHED.unshift(job);
  if (MEM_FINISHED.length > MEM_MAX) MEM_FINISHED.length = MEM_MAX;
}

// Start a job. Returns a handle to report progress and completion.
export function startJob(type, label) {
  const job = {
    id: ++seq, type, label, status: 'running',
    done: 0, total: 0, message: '',
    startedAt: clock(), finishedAt: null, result: null, error: null,
  };
  job.dbId = persistStart(job);
  RUNNING.unshift(job);
  const end = (status, { result = null, error = null } = {}) => {
    job.status = status; job.result = result; job.error = error; job.finishedAt = clock();
    const i = RUNNING.indexOf(job);
    if (i >= 0) RUNNING.splice(i, 1);
    persistEnd(job);
  };
  return {
    id: job.id,
    progress({ done, total, message } = {}) {
      if (done != null) job.done = done;
      if (total != null) job.total = total;
      if (message != null) job.message = message;
    },
    finish(result = null) { end('done', { result }); },
    fail(err) { end('failed', { error: String(err?.message || err) }); },
  };
}

// Run an async fn as a job: auto-starts, passes the handle, and records
// finish/fail. Returns the fn's result (or rethrows).
export async function runJob(type, label, fn) {
  const job = startJob(type, label);
  try {
    const result = await fn(job);
    job.finish(typeof result === 'object' ? result : null);
    return result;
  } catch (e) {
    job.fail(e);
    throw e;
  }
}

// Running (live, with hot progress) first, then finished runs newest-first.
export function listJobs(limit = 60) {
  const finished = dbh
    ? dbh.prepare("SELECT * FROM jobs_history WHERE status!='running' ORDER BY started_at DESC, id DESC LIMIT ?").all(limit)
        .map((r) => ({
          id: 'h' + r.id, type: r.type, label: r.label, status: r.status,
          done: r.done, total: r.total, message: r.message || '',
          startedAt: r.started_at, finishedAt: r.finished_at,
          result: r.result ? JSON.parse(r.result) : null, error: r.error,
        }))
    : MEM_FINISHED;
  return [...RUNNING, ...finished].slice(0, limit);
}

export function jobRunning(type) { return RUNNING.some((j) => j.type === type); }

export function clearFinishedJobs() {
  if (dbh) dbh.prepare("DELETE FROM jobs_history WHERE status!='running'").run();
  MEM_FINISHED.length = 0;
  return RUNNING.length;
}
