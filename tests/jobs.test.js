import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startJob, runJob, listJobs, jobRunning, clearFinishedJobs, _setClock } from '../src/jobs.js';

test('startJob tracks progress and completion, newest-first', () => {
  clearFinishedJobs();
  let t = 1000; _setClock(() => t);
  const j = startJob('cv-match', 'Match ComicVine');
  let job = listJobs().find((x) => x.id === j.id);
  assert.equal(job.status, 'running');
  assert.equal(jobRunning('cv-match'), true);

  j.progress({ done: 3, total: 10, message: '3 matched' });
  job = listJobs().find((x) => x.id === j.id);
  assert.equal(job.done, 3);
  assert.equal(job.total, 10);
  assert.equal(job.message, '3 matched');

  t = 5000;
  j.finish({ matched: 7 });
  job = listJobs().find((x) => x.id === j.id);
  assert.equal(job.status, 'done');
  assert.deepEqual(job.result, { matched: 7 });
  assert.equal(job.finishedAt, 5000);
  assert.equal(jobRunning('cv-match'), false);

  // newest-first ordering
  const j2 = startJob('scan-folder', 'Scan');
  assert.equal(listJobs()[0].id, j2.id);
  j2.finish(); // don't leak a running job into other tests (shared registry)
});

test('runJob records success and failure', async () => {
  clearFinishedJobs();
  _setClock(() => 0);
  const r = await runJob('releases', 'Check releases', async (job) => { job.progress({ total: 100 }); return { newIssues: 2 }; });
  assert.deepEqual(r, { newIssues: 2 });
  assert.equal(listJobs()[0].status, 'done');
  assert.deepEqual(listJobs()[0].result, { newIssues: 2 });

  await assert.rejects(() => runJob('crawl', 'Catalog', async () => { throw new Error('boom'); }), /boom/);
  const failed = listJobs().find((j) => j.type === 'crawl');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'boom');
});

test('clearFinishedJobs removes finished but keeps running', () => {
  clearFinishedJobs();
  _setClock(() => 0);
  startJob('crawl', 'x').finish();
  const running = startJob('cv-match', 'y'); // still running
  clearFinishedJobs();
  const left = listJobs();
  assert.equal(left.length, 1);
  assert.equal(left[0].id, running.id);
  assert.equal(left[0].status, 'running');
});

test('jobs persist to the db: finished runs survive, orphaned running rows fail on reattach', async () => {
  const { openDb } = await import('../src/db.js');
  const { attachJobsDb } = await import('../src/jobs.js');
  const db = openDb(':memory:');
  _setClock(() => 111);
  attachJobsDb(db);
  clearFinishedJobs();

  startJob('zero-day', 'Grab weekly 0-Day pack').finish({ grabbedWeek: '2026-07-01' });
  const orphan = startJob('pack-import', 'Import pack · X'); // left running = crash
  void orphan;

  // "Restart": reattach the same db → the orphan is marked failed.
  _setClock(() => 222);
  attachJobsDb(db);
  const rows = db.prepare('SELECT type, status, error FROM jobs_history ORDER BY id').all();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].status, 'done');
  assert.equal(rows[1].status, 'failed');
  assert.match(rows[1].error, /restarted/);

  // listJobs serves the persisted history (result JSON round-trips).
  const all = listJobs();
  const done = all.find((j) => j.type === 'zero-day');
  assert.deepEqual(done.result, { grabbedWeek: '2026-07-01' });
});
