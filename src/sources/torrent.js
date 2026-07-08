// Deferred download source: torrents via Torznab indexers + qBittorrent.
// Mirrors the usenet source — grab() hands a magnet/.torrent to qBittorrent under
// our category and returns immediately; the background monitor (downloadmonitor.js)
// polls the client by category and imports each torrent when it finishes.
import { parseIndexers, searchTorznab } from '../torznab.js';
import { makeTorrentClient } from '../torrentclients.js';
import { scoreRelease, issueToken, suspiciouslySmall, manualQueries, manualTarget } from './usenet.js';

export const torrent = {
  id: 'torrent',
  label: 'torrent',
  kind: 'deferred',
  isEnabled: (config) =>
    !!config?.torrentEnabled && parseIndexers(config.torznabIndexers).length > 0 && !!config.qbHost,

  async find(ctx) {
    const indexers = parseIndexers(ctx.config.torznabIndexers);
    if (!indexers.length) return null;
    // Search under every known name for this volume (title + CV/user aliases).
    const names = (ctx.seriesNames && ctx.seriesNames.length) ? ctx.seriesNames : [ctx.seriesTitle];
    const token = issueToken(ctx.issue);
    const byUrl = new Map();
    for (const name of names) {
      const query = [name, token].filter(Boolean).join(' ').trim();
      if (!query) continue;
      // No category filter: torrent trackers categorize comics inconsistently (many
      // don't tag them 7030 at all), and our strict series+issue matcher is the real
      // filter — so search broadly and let scoreRelease reject the noise.
      const results = await searchTorznab(indexers, query, { cat: '' });
      for (const r of results) if (r.downloadUrl && !byUrl.has(r.downloadUrl)) byUrl.set(r.downloadUrl, r);
    }
    const target = { series: ctx.seriesTitle, names, number: ctx.issue?.issue_number, year: ctx.seriesYear };
    // Keep only true matches (series matches any alias + number) that aren't
    // suspiciously small — public trackers carry tiny fake/malware "comics" with
    // inflated seeders, which would otherwise win the seeder sort. Rank by year
    // match first (scoreRelease), then seeders, then size.
    const scored = [...byUrl.values()]
      .filter((r) => !suspiciouslySmall(r.size))
      .map((r) => ({ r, score: scoreRelease(r.title, target) }))
      .filter((x) => x.score != null)
      .sort((a, b) => (b.score - a.score) || (b.r.seeders - a.r.seeders) || (b.r.size - a.r.size));
    const best = scored[0]?.r;
    return best ? { source: 'torrent', ...best } : null;
  },

  // Add the magnet/.torrent to qBittorrent under our category; return the infohash
  // so the monitor can match it later. Does not wait for the download.
  async grab(candidate, ctx) {
    const client = makeTorrentClient(ctx.config, {});
    const downloadId = await client.add(candidate.downloadUrl, { name: candidate.title, category: ctx.config.torrentCategory });
    return { downloadId, client: ctx.config.torrentClient || 'qbittorrent', category: ctx.config.torrentCategory, title: candidate.title };
  },

  // Multi-result manual search: torrents matching the query, ranked. Seeders are
  // shown so the user can judge health. A pick grabs that single torrent (not a
  // pack) — the per-series pack search is a separate feature.
  async manualSearch(ctx) {
    const indexers = parseIndexers(ctx.config.torznabIndexers);
    if (!indexers.length) return { results: [] };
    const queries = manualQueries(ctx);
    const target = manualTarget(ctx);
    const byUrl = new Map();
    for (const q of queries) {
      for (const r of await searchTorznab(indexers, q, { cat: '' })) if (r.downloadUrl && !byUrl.has(r.downloadUrl)) byUrl.set(r.downloadUrl, r);
    }
    const results = [...byUrl.values()]
      .filter((r) => !suspiciouslySmall(r.size))
      .map((r) => ({ source: 'torrent', downloadUrl: r.downloadUrl, title: r.title, size: r.size, seeders: r.seeders, meta: `${r.seeders >= 0 ? r.seeders + ' seeders · ' : ''}${r.indexer || 'indexer'}`, score: scoreRelease(r.title, target) }));
    return { results, searched: queries };
  },
};
