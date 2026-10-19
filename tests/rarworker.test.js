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
