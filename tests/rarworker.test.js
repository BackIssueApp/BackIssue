// RAR decoding runs on worker threads: results match the inline decoder, a
// failed job doesn't take the pool down, and a stopped pool comes back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runRar, closeRarWorkers } from '../src/rarWorker.js';
import { readArchiveInfo, cbrBufferToCbz } from '../src/archive.js';

const FIXTURE = 'tests/fixtures/sample.cbr';

test('the worker lists a RAR and converts it to a CBZ', async () => {
  const r = await runRar('info', { path: FIXTURE });
  assert.ok(r.names.length > 0);
  const zip = await cbrBufferToCbz(fs.readFileSync(FIXTURE));
  assert.equal(zip.subarray(0, 2).toString('latin1'), 'PK');
});

test('a failed job rejects alone, and the pool keeps working', async () => {
  await assert.rejects(runRar('info', { path: 'tests/fixtures/no-such.cbr' }));
  assert.ok((await readArchiveInfo(FIXTURE)).ok);
});

test('workers stopped mid-life are replaced on the next job', async () => {
  await closeRarWorkers();
  assert.ok((await readArchiveInfo(FIXTURE)).ok);
  await closeRarWorkers();
});

test('PDF pages are counted across read chunks', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  const { readArchiveInfo } = await import('../src/archive.js');
  const CH = 4 * 1024 * 1024;
  const parts = [];
  let len = 0;
  const put = (s) => { parts.push(s); len += s.length; };
  const padTo = (at) => put(' '.repeat(at - len));
  put('%PDF-1.4 /Type /Page ');
  padTo(CH - 6); put('/Type /Page ');      // straddles the first chunk boundary
  padTo(2 * CH - 11); put('/Type /Pages ');  // its "s" lands in the next chunk: not a page
  put('/Type/Page>>');
  padTo(3 * CH + 100); put('/Type /Page');   // the very last bytes of the file
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bi-pdf-')), 'x.pdf');
  fs.writeFileSync(p, parts.join(''), 'latin1');
  assert.equal((await readArchiveInfo(p)).pageCount, 4);
});

test('listRarEntries / extractRarEntries: names as stored, chosen entries or all', async () => {
  const { listRarEntries, extractRarEntries } = await import('../src/archive.js');
  const names = await listRarEntries(FIXTURE);
  assert.ok(names.length >= 2);
  const pages = names.filter((n) => /\.jpe?g$/i.test(n));
  const one = await extractRarEntries(FIXTURE, [pages[0]]);
  assert.deepEqual([...one.keys()], [pages[0]]);
  assert.ok(one.get(pages[0]).length > 0);
  const all = await extractRarEntries(FIXTURE);
  assert.deepEqual([...all.keys()].sort(), [...names].sort());
  assert.ok(all.get(pages[0]).equals(one.get(pages[0])), 'the same bytes either way');
  await assert.rejects(listRarEntries('tests/fixtures/no-such.cbr'));
});

test('with worker threads unavailable, every RAR call decodes inline with the same results', async () => {
  const { setRarWorkersEnabled } = await import('../src/rarWorker.js');
  const { listRarEntries, extractRarEntries, readArchiveInfo: info, cbrBufferToCbz: toCbz } = await import('../src/archive.js');
  const viaWorker = { names: await listRarEntries(FIXTURE), all: await extractRarEntries(FIXTURE), info: await info(FIXTURE) };
  setRarWorkersEnabled(false);
  try {
    assert.deepEqual(await listRarEntries(FIXTURE), viaWorker.names);
    const all = await extractRarEntries(FIXTURE);
    for (const [n, b] of viaWorker.all) assert.ok(all.get(n).equals(b), n);
    assert.deepEqual(await info(FIXTURE), viaWorker.info);
    assert.equal((await toCbz(fs.readFileSync(FIXTURE))).subarray(0, 2).toString('latin1'), 'PK');
  } finally { setRarWorkersEnabled(true); }
});

test('a worker that cannot start falls back to inline decoding instead of failing the archive', async () => {
  // Node refuses this flag in a worker, so the thread dies before it is online.
  const { closeRarWorkers } = await import('../src/rarWorker.js');
  await closeRarWorkers();
  const saved = process.execArgv.slice();
  process.execArgv.push('--input-type=module');
  try {
    const { listRarEntries } = await import('../src/archive.js');
    assert.ok((await listRarEntries(FIXTURE)).length >= 2);
  } finally {
    process.execArgv.length = 0; process.execArgv.push(...saved);
    (await import('../src/rarWorker.js')).setRarWorkersEnabled(true);
  }
});
