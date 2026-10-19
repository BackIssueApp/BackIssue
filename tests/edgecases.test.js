// Edge-case correctness: qBittorrent's settle states, half issues in release
// names, the temp-file sweep's reach, and the client path remap's boundary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeQbClient } from '../src/torrentclients.js';
import { parseReleaseName } from '../src/sources/usenet.js';
import { TEMP_FILE_RE } from '../src/tools.js';
import { remapClientPath } from '../src/paths.js';

test('a qBittorrent torrent still moving or re-checking is not done yet', async () => {
  const list = [
    { hash: 'A', name: 'a', progress: 1, state: 'moving', content_path: '/tmp/a' },
    { hash: 'B', name: 'b', progress: 1, state: 'checkingUP', content_path: '/dl/b' },
    { hash: 'C', name: 'c', progress: 1, state: 'stalledUP', content_path: '/dl/c' },
  ];
  const fetchImpl = async (url) => ({
    ok: true, status: 200, headers: new Headers(),
    text: async () => 'Ok.', json: async () => (String(url).includes('torrents/info') ? list : {}),
  });
  const got = await makeQbClient({ qbHost: 'qb' }, { fetchImpl }).listByCategory('comics');
  const st = Object.fromEntries(got.map((t) => [t.id, t.state]));
  assert.deepEqual(st, { a: 'downloading', b: 'downloading', c: 'done' });
});

test('a half issue in a release name is one number', () => {
  assert.deepEqual(parseReleaseName('Wizard 1/2 (1999) (digital)'), { series: 'Wizard', number: '0.5', year: '1999' });
  assert.deepEqual(parseReleaseName('Wizard 001 (1999)'), { series: 'Wizard', number: '1', year: '1999' });
});

test('the temp sweep only matches the app\'s own temp names', () => {
  for (const n of ['Batman 001.cbz.part', 'x.cbr.part', 'x.pdf.part', 'x.xml.part', '.tag-1234-Batman 001.cbz']) assert.ok(TEMP_FILE_RE.test(n), n);
  for (const n of ['movie.mkv.part', 'setup.exe.part', 'file.part', '.tag-notes']) assert.ok(!TEMP_FILE_RE.test(n), n);
});

test('client path remap matches on a folder boundary', () => {
  assert.equal(remapClientPath('/data/torrents/x/y.cbz', '/data/torrents', '/mnt/t'), '/mnt/t/x/y.cbz');
  assert.equal(remapClientPath('/data/torrents', '/data/torrents/', '/mnt/t'), '/mnt/t');
  assert.equal(remapClientPath('/data/torrents-old/x.cbz', '/data/torrents', '/mnt/t'), '/data/torrents-old/x.cbz');
});
