// Background monitor for deferred downloads (usenet + torrent). Radarr-style:
// everything we grab goes into a per-source category; this polls each source's
// client for that category, matches finished items back to their grab (by the
// client's own id), imports them (convert/tag/file/index via finishImport), and
// then cleans up per the source's policy. Because it works off the persisted
// `grabs` table + each client's own state, it survives restarts — on boot it
// reconciles whatever finished while we were down.
import config from './config.js';
import { activeGrabs, setGrabStatus, setIssueStatus, getIssueById, blacklistRelease } from './db.js';
import { makeNzbClient } from './nzbclients.js';
import { makeTorrentClient } from './torrentclients.js';
import { importCompleted } from './sources/usenet.js';
import { buildIssueContext, finishImport } from './downloader.js';
import { makeCvClient } from './cv.js';
import { processPack } from './pack.js';
import { refreshCvVolume } from './cvmatch.js';
import { startJob } from './jobs.js';

const grabbedAtMs = (s) => Date.parse(String(s).replace(' ', 'T') + 'Z');

// Remove a finished/failed download from its client, deleting the files. Logs
// failures instead of silently swallowing them, so a client that refuses the
// delete (auth, permissions, a logical error) is visible rather than leaving
// files to pile up.
async function cleanup(client, downloadId, why, grabId) {
  try {
    await client.remove(downloadId, { deleteFiles: true });
  } catch (e) {
    console.warn(`download monitor: client cleanup (${why}) failed for grab ${grabId}:`, e?.message || e);
  }
}

// Import a finished pack: post-process its folder, importing every wanted, still-
// missing issue. A per-series pack (series_id set) forces one volume; a 0-day pack
// (series_id null) matches across the whole collection. Left in the client to seed.
async function handlePackGrab({ db, grab, item, client, policy, source, cvClient, onProgress, now, record = () => {} }) {
  try {
    if (!item) {
      if (now() - grabbedAtMs(grab.grabbed_at) > policy.timeoutMs) {
        setGrabStatus(db, grab.id, 'failed', { error: 'pack not found on client before timeout' });
        onProgress({ event: 'pack-failed', source, title: grab.title, seriesId: grab.series_id ?? null, error: 'download disappeared' });
      }
      return;
    }
    if (item.state === 'downloading') {
      record(grab.id, { state: 'downloading', progress: item.progress || 0, seeders: item.seeders });
      onProgress({ event: 'pack-progress', source, title: grab.title, progress: item.progress || 0, seeders: item.seeders });
      return;
    }
    if (item.state === 'failed') {
      setGrabStatus(db, grab.id, 'failed', { error: item.error || 'client reported failure' });
      onProgress({ event: 'pack-failed', source, title: grab.title, seriesId: grab.series_id ?? null, error: item.error || 'download failed' });
      if (policy.removeOnFailed) await cleanup(client, grab.download_id, 'failed', grab.id);
      return;
    }
    if (item.state === 'done') {
      onProgress({ event: 'pack-start', source, title: grab.title, path: item.path });
      const job = startJob('pack-import', `Import pack · ${grab.title}`);
      const scope = grab.series_id
        ? { type: 'series', seriesId: grab.series_id }
        : { type: 'collection', addNew: !!config.zeroDayAddNew };
      let summary;
      try {
        summary = await processPack(db, {
          dir: item.path, scope, cvClient,
          refreshVolume: (sid) => refreshCvVolume(db, cvClient(), sid),
          onProgress: (p) => { job.progress({ done: p.done, total: p.total, message: `${p.imported} imported` }); onProgress({ event: 'pack-import', source, title: grab.title, ...p }); },
        });
      } catch (e) { job.fail(e); throw e; }
      job.finish({ imported: summary.imported, skipped: summary.skipped, unmatched: summary.unmatched, failed: summary.failed });
      setGrabStatus(db, grab.id, 'imported', { importedAt: new Date(now()).toISOString() });
      onProgress({ event: 'pack-done', source, title: grab.title, seriesId: grab.series_id ?? null, summary });
      if (policy.removeOnDone) await cleanup(client, grab.download_id, 'done', grab.id);
    }
  } catch (e) {
    setGrabStatus(db, grab.id, 'failed', { error: String(e?.message || e) });
    onProgress({ event: 'pack-failed', source, title: grab.title, error: String(e?.message || e) });
  }
}

// Per-source client + policy. Torrents are LEFT in the client after import so they
// keep seeding (manage ratio/removal in qBittorrent); usenet downloads are removed.
function sourcePolicy(source) {
  if (source === 'usenet') {
    return {
      makeClient: () => makeNzbClient(config, {}),
      category: config.nzbCategory,
      timeoutMs: Math.max(1, Number(config.usenetTimeoutMinutes) || 60) * 60_000,
      removeOnDone: true, removeOnFailed: true,
    };
  }
  if (source === 'torrent') {
    return {
      makeClient: () => makeTorrentClient(config, {}),
      category: config.torrentCategory,
      timeoutMs: Math.max(1, Number(config.torrentTimeoutMinutes) || 120) * 60_000,
      removeOnDone: false, removeOnFailed: true, // keep seeding after import
    };
  }
  return null;
}

export function createDownloadMonitor({ db, onProgress = () => {}, now = () => Date.now() }) {
  let running = false;
  // Live per-issue status from the last poll (issue_id → { source, state,
  // progress, seeders }), surfaced in the download queue. Rebuilt each tick.
  let snapshot = {};
  let packSnapshot = {}; // grab_id → { state, progress, seeders } for active packs
  const getProgress = () => snapshot;
  const getPackProgress = () => packSnapshot;
  // Per-source outage tracking: when a client can't be polled (down, config
  // removed), warn ONCE instead of every tick, and once the outage outlives the
  // source's timeout, fail its active grabs rather than spinning forever.
  const outages = new Map(); // source → since-ts

  async function tick() {
    if (running) return;               // never let ticks overlap
    const grabs = activeGrabs(db);
    if (!grabs.length) { snapshot = {}; packSnapshot = {}; return; }
    running = true;
    const next = {};
    const nextPacks = {};
    let cvc = null;
    const cvClient = () => (cvc ||= makeCvClient(config));
    try {
      // Group active grabs by source, so we poll each client (and its category)
      // just once per tick.
      const bySource = new Map();
      for (const g of grabs) {
        if (!bySource.has(g.source)) bySource.set(g.source, []);
        bySource.get(g.source).push(g);
      }

      for (const [source, sourceGrabs] of bySource) {
        const policy = sourcePolicy(source);
        if (!policy) { console.warn('download monitor: no policy for source', source); continue; }
        let client, items;
        try {
          client = policy.makeClient();
          items = await client.listByCategory(policy.category);
          outages.delete(source); // reachable again
        } catch (e) {
          if (!outages.has(source)) {
            outages.set(source, now());
            console.warn(`download monitor: ${source} client poll failed —`, e?.message || e);
          }
          // Client unreachable past the source's own timeout → its grabs aren't
          // coming back through this monitor; fail them so they stop pinning the
          // queue (the user can re-grab once the client is fixed).
          if (now() - outages.get(source) > policy.timeoutMs) {
            for (const grab of sourceGrabs) {
              setGrabStatus(db, grab.id, 'failed', { error: `client unreachable: ${e?.message || e}` });
              if (grab.kind !== 'pack' && grab.issue_id) setIssueStatus(db, grab.issue_id, 'failed', { error: `${source}: download client unreachable` });
              onProgress({ event: grab.kind === 'pack' ? 'pack-failed' : 'failed', source, title: grab.title, issue: grab.kind !== 'pack' ? getIssueById(db, grab.issue_id) : undefined, error: 'download client unreachable' });
            }
            outages.delete(source);
          }
          continue;
        }
        const byId = new Map(items.map((it) => [String(it.id), it]));

        for (const grab of sourceGrabs) {
          const item = byId.get(String(grab.download_id));
          // Pack grabs (per-series or 0-day) have no single issue — on completion
          // they post-process the whole download and import every wanted issue.
          if (grab.kind === 'pack') { await handlePackGrab({ db, grab, item, client, policy, source, cvClient, onProgress, now, record: (id, d) => { nextPacks[id] = d; } }); continue; }
          const issue = getIssueById(db, grab.issue_id);
          if (!issue) { setGrabStatus(db, grab.id, 'orphan', { error: 'issue no longer exists' }); continue; }
          try {
            if (!item) {
              // Not on the client yet (still fetching metadata/NZB) or vanished.
              // Only give up once the whole grab has outlived the timeout.
              if (now() - grabbedAtMs(grab.grabbed_at) > policy.timeoutMs) {
                setGrabStatus(db, grab.id, 'failed', { error: 'not found on client before timeout' });
                setIssueStatus(db, issue.id, 'failed', { error: `${source}: download disappeared from the client` });
                onProgress({ event: 'failed', issue, source, error: 'download disappeared' });
              }
              continue;
            }
            if (item.state === 'downloading') {
              next[issue.id] = { source, state: 'downloading', progress: item.progress || 0, seeders: item.seeders };
              onProgress({ event: 'page', issue, source, phase: 'downloading', page: item.progress || 0, pages: 100 });
              continue;
            }
            if (item.state === 'failed') {
              setGrabStatus(db, grab.id, 'failed', { error: item.error || 'client reported failure' });
              setIssueStatus(db, issue.id, 'failed', { error: `${source}: ${item.error || 'download failed'}` });
              onProgress({ event: 'failed', issue, source, error: item.error || 'download failed' });
              // The client itself reported the download broken (failed par2/repair,
              // missing articles) — blacklist this exact release so a retry picks a
              // different one instead of re-grabbing the same dud. Only usenet: this
              // is the "bad NZB" signal, not an import error or an offline client.
              if (source === 'usenet') {
                // Best-effort: a bookkeeping failure here must never replace the
                // real failure reason already recorded on the issue row.
                try {
                  blacklistRelease(db, { source, guid: grab.release_guid, title: grab.title, issueId: grab.issue_id, reason: item.error || 'download failed' });
                  console.warn(`download monitor: blacklisted failed usenet release "${grab.title}"`);
                } catch (e) {
                  console.warn(`download monitor: blacklisting failed for grab ${grab.id}:`, e?.stack || e?.message || e);
                }
              }
              if (policy.removeOnFailed) await cleanup(client, grab.download_id, 'failed', grab.id);
              continue;
            }
            if (item.state === 'done') {
              onProgress({ event: 'page', issue, source, phase: 'done', page: 100, pages: 100 });
              const ic = await buildIssueContext(db, issue, cvClient);
              const fetched = await importCompleted(item.path, item.name || grab.title);
              await finishImport(db, { issue, ic, fetched, source, onProgress });
              setGrabStatus(db, grab.id, 'imported', { importedAt: new Date(now()).toISOString() });
              // Cleanup per policy (usenet: remove + delete; torrent: keep seeding).
              if (policy.removeOnDone) await cleanup(client, grab.download_id, 'done', grab.id);
            }
          } catch (e) {
            console.warn('download monitor: import failed for grab', grab.id, e?.stack || e?.message || e);
            setGrabStatus(db, grab.id, 'failed', { error: String(e?.message || e) });
            setIssueStatus(db, issue.id, 'failed', { error: `${source} import: ${e?.message || e}` });
            onProgress({ event: 'failed', issue, source, error: String(e?.message || e) });
          }
        }
      }
      snapshot = next;
      packSnapshot = nextPacks;
    } finally { running = false; }
  }

  // Poll on an interval. Cheap no-op when there are no active grabs. Uses the
  // shorter of the two source poll intervals.
  function start(intervalMs) {
    const ms = intervalMs || Math.max(5, Math.min(
      Number(config.usenetPollSeconds) || 15,
      Number(config.torrentPollSeconds) || 20,
    )) * 1000;
    tick().catch((e) => console.warn('download monitor tick failed', e?.message || e)); // reconcile on boot
    const t = setInterval(() => tick().catch((e) => console.warn('download monitor tick failed', e?.message || e)), ms);
    if (t.unref) t.unref();
    return t;
  }

  return { tick, start, getProgress, getPackProgress };
}
