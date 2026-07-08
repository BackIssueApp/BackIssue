import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Writable data location — database, settings, downloads, browser profile, tag
// staging. Defaults to the app root; set DATA_DIR to relocate it onto a mounted
// volume (e.g. Docker's /data) so data survives image/container recreation.
// Fixtures ship WITH the app, so they stay under the app root regardless.
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : root;

const config = {
  dataDir,
  profileDir: path.join(dataDir, '.profile'),
  downloadsDir: path.join(dataDir, 'downloads'),
  dbPath: path.join(dataDir, 'catalog.db'),
  fixturesDir: path.join(root, 'fixtures'),
  port: 8787,
  // Express 'trust proxy'. Deploy concern (env, not the Settings UI): leave
  // unset for a DIRECT deploy so a spoofed X-Forwarded-For is never trusted;
  // behind a reverse proxy set TRUST_PROXY so req.ip is the real client —
  // making per-client rate limiting and the Secure-cookie decision correct.
  //   TRUST_PROXY=1        → trust one proxy hop (typical)
  //   TRUST_PROXY=true     → trust the immediate peer
  //   TRUST_PROXY=10.0.0.0/8 → trust a subnet
  trustProxy: (() => {
    const v = process.env.TRUST_PROXY;
    if (v == null || v === '' || v === 'false') return false;
    if (v === 'true') return true;
    return /^\d+$/.test(v) ? Number(v) : v;
  })(),
  // Optional HTTP Basic auth for the web UI + API (both must be set to enable).
  authUser: '',
  authPass: '',
  // Force SSO: disable the username/password login form (an SSO/OIDC auth
  // provider must be configured). Admins keep a password escape hatch so a
  // broken identity provider can't lock everyone out.
  passwordLoginDisabled: false,
  // Webhook POSTed on imports/failures (Discord-compatible JSON: { content }).
  // Blank = off. Also usable as a post-import hook (e.g. trigger a reader scan).
  notifyWebhookUrl: '',
  // Comma-separated notification categories the webhook fires for (see
  // notifications.js CATEGORIES). Empty = all. The in-app centre always
  // records everything regardless of this.
  notifyWebhookEvents: '',
  // Politeness delay after each page navigation (ms).
  actionDelayMs: 500,
  // Delay between fetching individual page images within an issue (ms).
  imageDelayMs: 150,
  // Concurrent browser tabs used while crawling the catalog.
  crawlConcurrency: 4,
  // Concurrent issues downloaded at once.
  downloadConcurrency: 4,
  // Output format: 'cbz' or 'pdf'.
  format: 'cbz',
  // Browser window: 'hidden' (real window parked off-screen — invisible but
  // safe), 'visible' (first-run login / debugging), or 'headless' (no window).
  // NOTE: sites behind Cloudflare hard-block true headless; on a headless server
  // use 'hidden' under a virtual display (xvfb-run node src/index.js on Linux).
  windowMode: 'visible',
  // ComicTagger tag-on-download.
  tagOnDownload: 'off',
  comicvineKeys: '',
  // Alternative ComicVine-compatible API base (a self-hosted CloneVine). Blank
  // = the official API (rate-limited, proxied, politeness-paced).
  cvBaseUrl: '',
  // Ask the metadata endpoint for enriched data (enrich=metron) — content
  // ratings, series status/end year. Supported by CloneVine; the real
  // ComicVine API ignores the parameter, so it's safe either way.
  cvEnrich: false,
  // Plugin catalog manifest URL — the app fetches this to offer installable
  // first-party plugins on the Plugins page and during onboarding. Blank uses
  // the default hosted catalog.
  pluginCatalogUrl: '',
  tagStagingDir: path.join(dataDir, '.staging'),
  tagConcurrency: 4,
  // Library scanner: default folder to scan for missing issues.
  scanDir: '',
  // Per-page navigation timeout (ms) so one stuck fetch can't wedge a crawl.
  navTimeoutMs: 45000,
  // "Check updates": how many date-sorted /comix/ pages to read per run.
  updatePages: 30,
  // Library health index: folder to index, and per-file read concurrency.
  libraryDir: '',
  libraryConcurrency: 8,
  // ComicVine matching: parallel series lookups (kept modest to be API-polite).
  cvConcurrency: 3,
  // Library tools (convert/verify/tag): how many files to process at once. Higher
  // overlaps network I/O across files; each in-flight file holds data in memory.
  toolsConcurrency: 4,
  // Weekly new-release list provider (a /newcomics.php list whose entries are
  // pre-tagged with ComicVine ids). Defaults to the hosted CloneVine mirror,
  // which read-through caches the upstream list.
  releaseProviderUrl: 'https://data.backissue.app',
  // Background task schedules: a 5-field cron pattern ("min hour day month
  // weekday") + an on/off toggle per task, editable on the Jobs page. Sensible
  // defaults ship disabled (except the cheap release check); last-run times
  // persist in the DB, so restarts don't re-fire tasks.
  releaseCheckCron: '0 */12 * * *',  // check this week's releases — twice daily
  releaseCheckEnabled: true,
  updatesCheckCron: '0 */6 * * *',   // catalog recent-updates crawl (plugin-provided)
  updatesCheckEnabled: false,
  cvMatchCron: '0 6 * * *',          // ComicVine match sweep — daily, 6am
  cvMatchEnabled: false,
  crawlCron: '0 3 * * 0',            // full catalog crawl (heavy) — Sundays 3am
  crawlEnabled: false,
  // Adding a volume implies wanting it: queue every missing issue for
  // download the moment a volume is added (Library +Add, Discover, Releases,
  // reading lists). Runs under the adding user's own download permission.
  autoDownloadOnAdd: true,
  // Scheduled backfill: queue the next batch of missing (wanted) issues of
  // followed series for download each run.
  wantedSearchCron: '0 2 * * *',   // nightly, 2am
  wantedSearchEnabled: false,
  wantedSearchBatch: 25,           // issues per run — be kind to the indexers
  // Legacy hour-cadence keys — migrated to Cron+Enabled on load (see settings.js).
  releaseCheckHours: 0,
  updatesCheckHours: 0,
  cvMatchHours: 0,
  crawlHours: 0,
  // Root folders where comics live on disk (newline/comma separated). The first
  // is the default root for new comics; downloads land in each comic's folder.
  rootFolders: '',

  // First-run onboarding wizard: set true once completed or skipped.
  onboardingDone: false,

  // ---- Download sources ------------------------------------------------
  // Order the queue tries sources in (comma-separated ids). First that can
  // serve an issue wins; the rest are fallbacks. Unlisted sources run last, in
  // registration order.
  sourcePriority: '',

  // Usenet source (Newznab indexers → SABnzbd/NZBGet → import).
  usenetEnabled: false,
  // One indexer per line: name | https://indexer/ | apikey
  newznabIndexers: '',
  // Download client: 'sabnzbd' or 'nzbget'.
  nzbClient: 'sabnzbd',
  nzbClientHost: '',      // hostname or IP, e.g. nas or 192.168.1.10
  nzbClientPort: '',      // SABnzbd default 8080, NZBGet default 6789
  nzbClientSsl: false,    // talk to the client over https
  nzbClientUrl: '',       // legacy: migrated to host/port on load (see settings.js)
  nzbClientApiKey: '',    // SABnzbd
  nzbClientUser: '',      // NZBGet basic-auth
  nzbClientPass: '',      // NZBGet basic-auth
  nzbCategory: 'backissue',
  // Completed-folder path mapping (like Mylar's drop-dir remap). The client
  // reports a finished download at a path on ITS filesystem; this app may see
  // that folder at a different path over the network. Leave both blank if the app
  // and client share the same path.
  usenetCompleteDir: '',        // path THIS app reads (e.g. \\NAS\dl\complete)
  usenetCompleteDirRemote: '',  // same folder as the CLIENT reports it (e.g. /downloads/complete)
  usenetPollSeconds: 15,
  usenetTimeoutMinutes: 60,

  // Torrent source (Torznab indexers → qBittorrent → import). Once imported, the
  // torrent is LEFT in qBittorrent so it keeps seeding — manage ratio/removal there.
  torrentEnabled: false,
  // One Torznab indexer per line: name | https://jackett/…/torznab | apikey
  torznabIndexers: '',
  torrentClient: 'qbittorrent',
  qbHost: '',            // hostname or IP, e.g. nas or 192.168.1.10
  qbPort: '',            // qBittorrent Web UI port (default 8080)
  qbSsl: false,          // talk to the Web UI over https
  qbUser: '',            // Web UI username
  qbPass: '',            // Web UI password
  torrentCategory: 'backissue',
  // Completed content path mapping (like the usenet remap): qBittorrent reports a
  // finished torrent's content at a path on ITS filesystem; this app may read that
  // folder at a different path over the network. Blank if they share a path.
  torrentCompleteDir: '',        // path THIS app reads
  torrentCompleteDirRemote: '',  // same folder as qBittorrent reports it
  torrentPollSeconds: 20,
  torrentTimeoutMinutes: 120,    // torrents can be slow to find peers

  // 0-Day weekly pack: a scheduled job searches Torznab for the newest "0-Day Week
  // of …" pack, grabs it to qBittorrent, and post-processes it — importing only the
  // missing issues of series already in your collection. 0 hours = off.
  zeroDayCron: '0 9 * * 3',  // Wednesdays 9am — new-comic-book day
  zeroDayEnabled: false,
  zeroDayCheckHours: 0,      // legacy — migrated to zeroDayCron+Enabled on load
  zeroDayQuery: '0-Day Week',
  // When true, a 0-Day pack also adds+follows NEW volumes it confidently matches to
  // ComicVine (not just issues of series you already have). Off by default.
  zeroDayAddNew: false,
};

export default config;
