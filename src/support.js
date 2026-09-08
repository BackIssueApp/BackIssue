// Support package: one zip an admin downloads from System → Tools and
// attaches to a bug report or a support thread. It gathers what we ask for
// first in every diagnosis — version and build, runtime and host, settings,
// plugins, libraries and counts, jobs and schedules, recent downloads, and
// the application log — with every secret redacted before it leaves the
// server. Each section is collected independently: a broken piece is noted
// in summary.json under `errors` and never blocks the rest.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import JSZip from 'jszip';

// A setting is a secret when its name says so. Keys, passwords, tokens,
// cookies, credentials: replaced by a marker that keeps the length, so
// "is it set, and is it the right length" is still answerable.
export const SECRET_KEY_RE = /(key|keys|pass|passwd|password|token|secret|cookie|credential|auth)(?!or|orised|orized|entic)/i;
const KEEP_KEY_RE = /^(passwordLoginDisabled|metadataSource|keepSharing|.*(Enabled|Disabled|Events|Mode|Hours|Cron|Count|Path|Dir|Placement|Url|Host|Port|Ssl|UrlBase|Base|Kind|Provider|Name|Label))$/;

export function redactValue(key, value) {
  if (typeof value !== 'string' || !value.length) return value;
  // Indexer lists are "name|url|apikey" lines: keep the name and host, blank the key.
  if (/indexers$/i.test(String(key))) {
    return value.split(/\r?\n/).map((line) => {
      const parts = line.split('|');
      if (parts.length >= 3 && parts[2].trim()) parts[2] = ` [redacted ${parts[2].trim().length} chars]`;
      return parts.join('|');
    }).join('\n');
  }
  if (SECRET_KEY_RE.test(String(key)) && !KEEP_KEY_RE.test(String(key))) return `[redacted ${value.length} chars]`;
  return value;
}

/** "name|url|apikey" lines → [{ name, url, keyLength }] with the key dropped. */
export function describeIndexers(str) {
  return String(str || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((line) => {
    const [name, url, apiKey] = line.split('|').map((s) => (s || '').trim());
    return { name: name || url || '', url: url || '', keyLength: (apiKey || '').length };
  }).filter((i) => i.url);
}

// Secrets that hide inside strings: query parameters (apikey=…, token=…),
// user:password@ in URLs, and bearer/basic authorization values.
const TEXT_PATTERNS = [
  [/([?&](?:api_?key|apikey|key|token|access_token|secret|password|pass|passkey|auth)=)([^&\s"'<>]+)/gi, '$1[redacted]'],
  [/(https?:\/\/)([^\s\/@"']+):([^\s\/@"']+)@/gi, '$1[redacted]@'],
  [/((?:bearer|basic)\s+)[A-Za-z0-9+\/=._-]{8,}/gi, '$1[redacted]'],
];
export function redactText(s) {
  let out = String(s ?? '');
  for (const [re, rep] of TEXT_PATTERNS) out = out.replace(re, rep);
  return out;
}

/** Deep copy with secret-named fields and secret-bearing strings redacted. */
export function redactSecrets(value, key = '') {
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v, key));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactSecrets(v, k);
    return out;
  }
  if (typeof value === 'string') return redactText(redactValue(key, value));
  return value;
}

const mb = (n) => Math.round((n || 0) / 1048576);

async function diskInfo(p) {
  try {
    const st = await fsp.statfs(p);
    return { path: p, totalMb: mb(st.blocks * st.bsize), freeMb: mb(st.bavail * st.bsize) };
  } catch (e) { return { path: p, error: String(e?.message || e) }; }
}

async function fileSize(p) { try { return (await fsp.stat(p)).size; } catch { return null; } }

/**
 * Build the package. Everything is passed in so this stays testable with an
 * in-memory database and stub providers.
 *   db, config, settings()        — the live database, config, current settings
 *   version, build                — package version, build.json attestation (or null)
 *   dataDir, dbPath, pluginsDir
 *   plugins(), jobs(), schedules(), logs(), sources(), notifiers(), libraries(), libraryStats(), state
 * Returns { buffer, filename, manifest }.
 */
export async function buildSupportPackage(opts = {}) {
  const {
    db, config = {}, settings = () => ({}), version = '0.0.0', build = null,
    dataDir = '', dbPath = '', pluginsDir = '',
    plugins = () => [], jobs = () => [], schedules = () => [], logs = () => ({ logs: [] }),
    sources = () => [], notifiers = () => [], libraries = () => [], libraryStats = () => null,
    importHistory = () => [], state = {}, now = () => new Date(),
  } = opts;
  const generatedAt = now().toISOString();
  const errors = [];
  const section = (name, fn) => { try { return fn(); } catch (e) { errors.push(`${name}: ${e?.message || e}`); return null; } };
  const q = (sql, ...args) => { try { return db.prepare(sql).all(...args); } catch (e) { errors.push(`query: ${sql.slice(0, 60)}… ${e?.message || e}`); return null; } };
  const q1 = (sql, ...args) => { try { return db.prepare(sql).get(...args); } catch (e) { errors.push(`query: ${sql.slice(0, 60)}… ${e?.message || e}`); return null; } };

  const mem = process.memoryUsage();
  let heapLimit = null;
  try { heapLimit = (await import('node:v8')).default.getHeapStatistics().heap_size_limit; } catch { /* ignore */ }
  const libs = section('libraries', () => libraries()) || [];

  const summary = {
    generatedAt,
    app: {
      version,
      commit: build?.commit || process.env.BUILD_SHA || null,
      channel: build?.channel || process.env.BUILD_CHANNEL || null,
      builtAt: build?.built_at || null,
      attested: !!build?.sig,
    },
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      os: `${os.type()} ${os.release()}`,
      docker: fs.existsSync('/.dockerenv'),
      uptimeSeconds: Math.round(process.uptime()),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      cpus: os.cpus().length,
      totalMemoryMb: mb(os.totalmem()),
      memory: { rssMb: mb(mem.rss), heapUsedMb: mb(mem.heapUsed), heapLimitMb: heapLimit ? mb(heapLimit) : null },
      env: {
        DATA_DIR: process.env.DATA_DIR || null, PLUGINS_DIR: process.env.PLUGINS_DIR || null,
        TRUST_PROXY: process.env.TRUST_PROXY || null, NODE_OPTIONS: process.env.NODE_OPTIONS || null,
        PUID: process.env.PUID || null, PGID: process.env.PGID || null, TZ: process.env.TZ || null,
        watchdog: process.env.BACKISSUE_WATCHDOG ?? null,
      },
    },
    paths: { dataDir, dbPath, pluginsDir },
    disk: await Promise.all([dataDir, ...libs.flatMap((l) => String(l.root_folder || l.root || '').split('\n').map((s) => s.trim()).filter(Boolean))]
      .filter(Boolean).filter((p, i, a) => a.indexOf(p) === i).map(diskInfo)),
    database: {
      sizeMb: mb(await fileSize(dbPath)),
      walMb: mb(await fileSize(dbPath + '-wal')),
      journalMode: q1('PRAGMA journal_mode')?.journal_mode ?? null,
      pageSize: q1('PRAGMA page_size')?.page_size ?? null,
      userVersion: q1('PRAGMA user_version')?.user_version ?? null,
    },
    counts: {
      seriesByType: q("SELECT COALESCE(NULLIF(type,''),'comic') type, COUNT(*) n FROM series GROUP BY 1 ORDER BY n DESC"),
      collectionSeries: q1('SELECT COUNT(*) n FROM series s WHERE s.followed=1 OR s.id IN (SELECT series_id FROM library_files WHERE valid=1)')?.n ?? null,
      issuesByStatus: q('SELECT status, COUNT(*) n FROM issues GROUP BY status ORDER BY n DESC'),
      files: section('libraryStats', () => libraryStats()),
      usersByRole: q('SELECT role, COUNT(*) n FROM users GROUP BY role'),
      sessions: q1('SELECT COUNT(*) n FROM sessions')?.n ?? null,
      apiKeys: q1('SELECT COUNT(*) n FROM api_keys')?.n ?? null,
      notifications: q1('SELECT COUNT(*) n FROM notifications')?.n ?? null,
      blocklist: q1('SELECT COUNT(*) n FROM release_blacklist')?.n ?? null,
    },
    state: redactSecrets({ queue: state.queue || null, crawl: state.crawl || null }),
    errors,
  };

  const settingsOut = section('settings', () => redactSecrets(settings()));
  const pluginsOut = section('plugins', () => ({
    disabled: String(config.disabledPlugins || '').split(',').map((s) => s.trim()).filter(Boolean),
    installed: plugins().map((p) => ({
      name: p.name, version: p.version ?? null, enabled: p.enabled ?? null, loaded: p.loaded ?? null,
      error: p.error ?? null, pending: p.pending ?? null, pendingVersion: p.pendingVersion ?? null,
      restartRequired: p.restartRequired ?? null, counts: p.counts ?? null,
    })),
  }));
  const librariesOut = section('libraries', () => redactSecrets(libs));
  const jobsOut = section('jobs', () => redactSecrets({ recent: jobs(), schedules: schedules() }));
  const sourcesOut = section('sources', () => ({
    sources: sources().map((s) => ({ id: s.id, label: s.label ?? null, enabled: typeof s.isEnabled === 'function' ? !!s.isEnabled(config) : null, immediate: !!s.immediate })),
    notifiers: notifiers().map((n) => ({ id: n.id ?? n.key ?? null, label: n.label ?? null })),
    newznab: { enabled: !!config.usenetEnabled, client: config.nzbClient || null, indexers: describeIndexers(config.newznabIndexers) },
    torznab: { enabled: !!config.torrentEnabled, client: config.torrentClient || null, indexers: describeIndexers(config.torznabIndexers) },
  }));
  const historyOut = section('history', () => redactSecrets({
    imports: importHistory(),
    grabs: q('SELECT id, issue_id, source, client, category, title, status FROM grabs ORDER BY id DESC LIMIT 100') || [],
  }));
  const queueOut = section('queue', () => redactSecrets(q("SELECT id, series_id, issue_number, status, error FROM issues WHERE status IN ('queued','downloading','grabbed','tagging','failed') ORDER BY id DESC LIMIT 200") || []));

  const logLines = section('logs', () => {
    const r = logs({ level: 'all', category: 'all', limit: 2000 });
    const rows = [...(r?.logs || [])].reverse(); // oldest first, like a log file
    return rows.map((e) => `${new Date(e.ts).toISOString()} [${e.level}] ${e.category || ''} ${redactText(e.message)}${e.detail ? '\n  ' + redactText(String(e.detail)).replace(/\n/g, '\n  ') : ''}`).join('\n') + '\n';
  }) || '';

  const readme = `BackIssue support package
Generated ${generatedAt} by BackIssue ${version}.

What is inside
  summary.json    version and build, runtime and host, disk space, database size, counts, errors met while collecting
  settings.json   every setting, with keys, passwords and tokens replaced by "[redacted N chars]"
  plugins.json    installed plugins, versions, enabled/loaded state, pending changes
  libraries.json  libraries and their folders
  sources.json    download sources, indexers and notification channels (names and hosts only)
  jobs.json       recent jobs and the schedule table
  queue.json      issues currently queued, downloading or failed
  history.json    the last 100 import history rows and the last 100 grabs
  logs.txt        the last 2,000 application log entries

What is NOT inside
  No comic files, covers or pages. No user names, e-mail addresses or password hashes.
  No API keys, passwords, tokens or cookies: values are redacted by name, and
  secrets inside URLs and query strings are blanked in every file, logs included.

Please attach the whole zip to your bug report or support thread.
`;

  const zip = new JSZip();
  zip.file('README.txt', readme);
  zip.file('summary.json', JSON.stringify(summary, null, 2));
  zip.file('settings.json', JSON.stringify(settingsOut, null, 2));
  zip.file('plugins.json', JSON.stringify(pluginsOut, null, 2));
  zip.file('libraries.json', JSON.stringify(librariesOut, null, 2));
  zip.file('sources.json', JSON.stringify(sourcesOut, null, 2));
  zip.file('jobs.json', JSON.stringify(jobsOut, null, 2));
  zip.file('queue.json', JSON.stringify(queueOut, null, 2));
  zip.file('history.json', JSON.stringify(historyOut, null, 2));
  zip.file('logs.txt', logLines);
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  const stamp = generatedAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace('T', '-');
  const filename = `backissue-support-${version}-${stamp}.zip`;
  return { buffer, filename, manifest: { files: Object.keys(zip.files), bytes: buffer.length, errors } };
}
