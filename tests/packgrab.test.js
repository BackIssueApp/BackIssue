import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import config from '../src/config.js';
import {
  openDb, upsertSeries, setSeriesCv, setFollowed, upsertCvSeries, upsertCvIssue,
  upsertLibraryFile, linkFileCvIssue, recordGrab, packGrabbed, activeGrabs, setGrabStatus,
} from '../src/db.js';
import { createDownloadMonitor } from '../src/downloadmonitor.js';

async function cbz(p) {
  const z = new JSZip(); z.file('001.jpg', Buffer.from([0xff, 0xd8, 0xff, 1]));
  await fs.writeFile(p, await z.generateAsync({ type: 'nodebuffer', compression: 'STORE' }));
}

test('recordGrab/packGrabbed: pack grabs carry kind + series_id and dedupe by title', () => {
  const db = openDb(':memory:');
  assert.equal(packGrabbed(db, '0-Day Week of 2026.06.24'), false);
  const id = recordGrab(db, { source: 'torrent', downloadId: 'abc', title: '0-Day Week of 2026.06.24', kind: 'pack', seriesId: null });
  assert.equal(packGrabbed(db, '0-Day Week of 2026.06.24'), true);
  const g = activeGrabs(db).find((x) => x.id === id);
  assert.equal(g.kind, 'pack');
  assert.equal(g.issue_id, 0);      // sentinel — no single issue
  assert.equal(g.series_id, null);  // collection-scope 0-day pack
  // A failed pack no longer counts as grabbed (so it can be retried).
  setGrabStatus(db, id, 'failed', { error: 'x' });
  assert.equal(packGrabbed(db, '0-Day Week of 2026.06.24'), false);
});

test('monitor: a completed 0-Day pack imports the missing collection issue', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zdpack-'));
  await cbz(path.join(dir, 'Saga 001 (2012) (Empire).cbz')); // owned → skip
  await cbz(path.join(dir, 'Saga 002 (2012) (Empire).cbz')); // missing → import
  await cbz(path.join(dir, 'Not Mine 003 (2026).cbz'));      // not in collection
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'zdlib-'));

  const db = openDb(':memory:');
  const saga = upsertSeries(db, { title: 'Saga (2012)', url: 'cv:46568' });
  setSeriesCv(db, saga, 46568, { locked: 0 }); setFollowed(db, saga, 1);
  upsertCvSeries(db, { id: 46568, name: 'Saga', publisher: 'Image', start_year: '2012', count_of_issues: 2 });
  upsertCvIssue(db, { id: 1, cv_series_id: 46568, number: '1', name: 'a' });
  upsertCvIssue(db, { id: 2, cv_series_id: 46568, number: '2', name: 'b' });
  upsertLibraryFile(db, { path: '/lib/s1.cbz', dir: '/lib', name: 's1.cbz', size: 1, mtime: 1, valid: 1, series_id: saga });
  linkFileCvIssue(db, '/lib/s1.cbz', 1);
  const hash = 'abcdef0123456789abcdef0123456789abcdef01';
  recordGrab(db, { source: 'torrent', client: 'qbittorrent', downloadId: hash, category: 'bc', title: '0-Day Week of 2026.06.24', kind: 'pack', seriesId: null });

  const saved = { host: config.qbHost, port: config.qbPort, tc: config.torrentClient, cat: config.torrentCategory, dl: config.downloadsDir, roots: config.rootFolders };
  Object.assign(config, { qbHost: 'h', qbPort: 8080, torrentClient: 'qbittorrent', torrentCategory: 'bc', downloadsDir: out, rootFolders: '' });
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    const resp = (text, json) => ({ ok: true, status: 200, text: async () => text, json: async () => json, headers: { get: () => null, getSetCookie: () => ['QBT_SID_8080=s'] } });
    if (u.includes('/auth/login')) return resp('Ok.');
    if (u.includes('/torrents/info')) return resp('', [{ hash, name: '0-Day', state: 'stalledUP', progress: 1, content_path: dir, num_complete: 9 }]);
    return resp('', {});
  };
  try {
    const events = [];
    const mon = createDownloadMonitor({ db, onProgress: (p) => events.push(p) });
    await mon.tick();
    // Saga #2 imported; #1 (owned) and "Not Mine" skipped/unmatched.
    assert.ok(db.prepare('SELECT 1 FROM library_files WHERE cv_issue_id=2 AND valid=1').get(), 'Saga #2 should be imported: ' + JSON.stringify(events.filter((e) => e.event === 'pack-import' || e.event === 'pack-failed')));
    assert.ok(events.some((e) => e.event === 'pack-start'), 'logs a start event');
    assert.ok(events.some((e) => e.event === 'pack-import' && e.outcome === 'imported' && /Saga #2/.test(e.reason)), 'logs the per-import');
    const done = events.find((e) => e.event === 'pack-done');
    assert.equal(done.summary.imported, 1);
    assert.equal(done.summary.skipped, 1);
    assert.equal(done.summary.unmatched, 1);
    // Grab marked imported; pack files left in place (seeding-safe).
    assert.equal(activeGrabs(db).length, 0);
    assert.equal(await fs.access(path.join(dir, 'Saga 002 (2012) (Empire).cbz')).then(() => true, () => false), true);
  } finally {
    globalThis.fetch = origFetch;
    Object.assign(config, { qbHost: saved.host, qbPort: saved.port, torrentClient: saved.tc, torrentCategory: saved.cat, downloadsDir: saved.dl, rootFolders: saved.roots });
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(out, { recursive: true, force: true });
  }
});
