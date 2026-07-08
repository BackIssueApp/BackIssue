// User-tunable settings, persisted to settings.json and merged over config.
// Mutating the shared `config` object lets every module pick up changes live.
import fs from 'node:fs';
import path from 'node:path';
import config from './config.js';
import { registeredSettings } from './plugins.js';
import { hoursToCron } from './cron.js';

// settings.json lives alongside the database in the writable data dir (config
// resolves DATA_DIR), so a relocated/mounted data volume keeps settings too.
const FILE = path.join(config.dataDir, 'settings.json');

export const SETTING_FIELDS = {
  crawlConcurrency:    { type: 'int', min: 1, max: 16 },
  downloadConcurrency: { type: 'int', min: 1, max: 16 },
  toolsConcurrency:    { type: 'int', min: 1, max: 16 },
  actionDelayMs:       { type: 'int', min: 0, max: 10000 },
  imageDelayMs:        { type: 'int', min: 0, max: 10000 },
  downloadsDir:        { type: 'string' },
  format:              { type: 'enum', values: ['cbz', 'pdf'] },
  windowMode:          { type: 'enum', values: ['visible', 'hidden', 'headless'] },
  tagOnDownload:       { type: 'enum', values: ['off', 'on'] },
  comictaggerPath:     { type: 'string' }, // legacy (ComicTagger removed); tolerated so old settings.json loads
  comicvineKeys:       { type: 'string' },
  cvBaseUrl:           { type: 'string', allowEmpty: true },
  cvEnrich:            { type: 'bool' },
  disabledPlugins:     { type: 'string', allowEmpty: true }, // comma-separated plugin names skipped at boot
  allowRegistration:   { type: 'bool' }, // self-service signups (new accounts start as viewers)
  passwordLoginDisabled: { type: 'bool' }, // SSO-only: hide the password form (admins keep an escape hatch)
  // Legacy single-account basic auth — replaced by the user system. Tolerated
  // so old settings.json files load; the boot migration converts them to the
  // first admin user and then blanks them.
  authUser:            { type: 'string', allowEmpty: true },
  authPass:            { type: 'string', allowEmpty: true },
  notifyWebhookUrl:    { type: 'string', allowEmpty: true },
  notifyWebhookEvents: { type: 'string', allowEmpty: true }, // enabled categories (empty = all)
  releaseProviderUrl:  { type: 'string' },
  releaseCheckCron:    { type: 'string', allowEmpty: true },
  releaseCheckEnabled: { type: 'bool' },
  updatesCheckCron:    { type: 'string', allowEmpty: true },
  updatesCheckEnabled: { type: 'bool' },
  cvMatchCron:         { type: 'string', allowEmpty: true },
  cvMatchEnabled:      { type: 'bool' },
  crawlCron:           { type: 'string', allowEmpty: true },
  crawlEnabled:        { type: 'bool' },
  wantedSearchCron:    { type: 'string', allowEmpty: true },
  wantedSearchEnabled: { type: 'bool' },
  wantedSearchBatch:   { type: 'int', min: 1, max: 200 },
  recentSearchCron:    { type: 'string', allowEmpty: true },
  recentSearchEnabled: { type: 'bool' },
  recentSearchDays:    { type: 'int', min: 1, max: 90 },
  rssWatchCron:        { type: 'string', allowEmpty: true },
  rssWatchEnabled:     { type: 'bool' },
  backupCron:          { type: 'string', allowEmpty: true },
  backupEnabled:       { type: 'bool' },
  autoDownloadOnAdd:   { type: 'bool' }, // adding a volume queues its issues immediately
  zeroDayCron:         { type: 'string', allowEmpty: true },
  zeroDayEnabled:      { type: 'bool' },
  // Legacy hour-cadence keys, tolerated so old settings.json files load; migrated
  // to the Cron keys in loadSettings.
  releaseCheckHours:   { type: 'int', min: 0, max: 720 },
  updatesCheckHours:   { type: 'int', min: 0, max: 720 },
  cvMatchHours:        { type: 'int', min: 0, max: 720 },
  crawlHours:          { type: 'int', min: 0, max: 720 },
  tagStagingDir:       { type: 'string' }, // legacy
  tagConcurrency:      { type: 'int', min: 1, max: 16 }, // legacy
  scanDir:             { type: 'string' },
  updatePages:         { type: 'int', min: 1, max: 100 },
  libraryDir:          { type: 'string' }, // legacy: seeds rootFolders (see loadSettings)
  libraryConcurrency:  { type: 'int', min: 1, max: 32 },
  rootFolders:         { type: 'string' },
  folderPattern:       { type: 'string', allowEmpty: true }, // library org (blank = default)
  filePattern:         { type: 'string', allowEmpty: true },
  renameDownloads:     { type: 'bool' }, // off = downloads keep the source's filename
  onboardingDone:      { type: 'bool' },
  // Download sources
  sourcePriority:          { type: 'string' },
  usenetEnabled:           { type: 'bool' },
  newznabIndexers:         { type: 'string', allowEmpty: true },
  nzbClient:               { type: 'enum', values: ['sabnzbd', 'nzbget'] },
  nzbClientHost:           { type: 'string', allowEmpty: true },
  nzbClientPort:           { type: 'int', min: 1, max: 65535 },
  nzbClientSsl:            { type: 'bool' },
  nzbClientUrl:            { type: 'string', allowEmpty: true }, // legacy: migrated to host/port (see loadSettings)
  nzbClientApiKey:         { type: 'string', allowEmpty: true },
  nzbClientUser:           { type: 'string', allowEmpty: true },
  nzbClientPass:           { type: 'string', allowEmpty: true },
  nzbCategory:             { type: 'string', allowEmpty: true },
  usenetCompleteDir:       { type: 'string', allowEmpty: true },
  usenetCompleteDirRemote: { type: 'string', allowEmpty: true },
  usenetPollSeconds:       { type: 'int', min: 5, max: 600 },
  usenetTimeoutMinutes:    { type: 'int', min: 1, max: 1440 },
  // Torrent source
  torrentEnabled:          { type: 'bool' },
  torznabIndexers:         { type: 'string', allowEmpty: true },
  torrentClient:           { type: 'enum', values: ['qbittorrent'] },
  qbHost:                  { type: 'string', allowEmpty: true },
  qbPort:                  { type: 'int', min: 1, max: 65535 },
  qbSsl:                   { type: 'bool' },
  qbUser:                  { type: 'string', allowEmpty: true },
  qbPass:                  { type: 'string', allowEmpty: true },
  torrentCategory:         { type: 'string', allowEmpty: true },
  torrentCompleteDir:      { type: 'string', allowEmpty: true },
  torrentCompleteDirRemote:{ type: 'string', allowEmpty: true },
  torrentPollSeconds:      { type: 'int', min: 5, max: 600 },
  torrentTimeoutMinutes:   { type: 'int', min: 1, max: 1440 },
  zeroDayCheckHours:       { type: 'int', min: 0, max: 720 },
  zeroDayQuery:            { type: 'string', allowEmpty: true },
  zeroDayAddNew:           { type: 'bool' },
};

// All settable fields: the core set plus any a plugin registered (e.g. a private
// source's credentials). Recomputed each call so plugins loaded after import count.
function allFields() {
  return { ...SETTING_FIELDS, ...registeredSettings() };
}

export function currentSettings() {
  const out = {};
  for (const k of Object.keys(allFields())) out[k] = config[k];
  return out;
}

// Coerce + clamp incoming values to valid ones; ignore unknown/invalid keys.
export function validateSettings(input = {}) {
  const out = {};
  for (const [k, spec] of Object.entries(allFields())) {
    if (!(k in input)) continue;
    let v = input[k];
    if (spec.type === 'int') {
      if (v === '' || v == null) continue; // leave unset (e.g. a blank port)
      v = Math.round(Number(v));
      if (!Number.isFinite(v)) continue;
      v = Math.max(spec.min, Math.min(spec.max, v));
    } else if (spec.type === 'bool') {
      v = v === true || v === 'true' || v === 'on' || v === 1 || v === '1';
    } else if (spec.type === 'enum') {
      if (!spec.values.includes(v)) continue;
    } else {
      v = String(v).trim();
      if (!v && !spec.allowEmpty) continue; // allowEmpty fields can be cleared
    }
    out[k] = v;
  }
  return out;
}

export function applySettings(input) {
  Object.assign(config, validateSettings(input));
  // TEMPORARY: metadata enrichment (enrich=metron) is force-disabled while we
  // sort out reliable access to the enrichment source. This overrides any
  // saved/incoming value on every load and save, so no request appends
  // &enrich=metron and no enrichment refetch fires. The Settings checkbox is
  // hidden to match. To re-enable: delete this line and unhide the checkbox in
  // SettingsPage.svelte (search "TEMPORARY: enrichment disabled").
  config.cvEnrich = false;
  return currentSettings();
}

export function loadSettings() {
  try { applySettings(JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch { /* first run */ }
  // The 'Library folder' setting was folded into 'Root folders'. Seed it from
  // the old value so existing libraries keep organizing correctly.
  if (!config.rootFolders && config.libraryDir) config.rootFolders = config.libraryDir;
  // Schedules moved from every-N-hours cadences to cron patterns + an enabled
  // toggle. Convert any configured legacy cadence once (best effort): the hours
  // value becomes the pattern and the task comes over enabled.
  const LEGACY_CRON = {
    releaseCheckHours: ['releaseCheckCron', 'releaseCheckEnabled'],
    updatesCheckHours: ['updatesCheckCron', 'updatesCheckEnabled'],
    cvMatchHours: ['cvMatchCron', 'cvMatchEnabled'],
    crawlHours: ['crawlCron', 'crawlEnabled'],
    zeroDayCheckHours: ['zeroDayCron', 'zeroDayEnabled'],
  };
  for (const [hoursKey, [cronKey, enabledKey]] of Object.entries(LEGACY_CRON)) {
    if (Number(config[hoursKey]) > 0) {
      config[cronKey] = hoursToCron(config[hoursKey]);
      config[enabledKey] = true;
    }
    config[hoursKey] = 0; // consumed — cron + enabled are the source of truth now
  }
  // The download client used to be a single URL; it's now host + port (+ ssl).
  // Migrate any old value so the fields populate and downstream keeps working.
  if (config.nzbClientUrl && !config.nzbClientHost) {
    try {
      const u = new URL(config.nzbClientUrl);
      config.nzbClientHost = u.hostname;
      config.nzbClientPort = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
      config.nzbClientSsl = u.protocol === 'https:';
    } catch { /* leave as-is */ }
  }
  return currentSettings();
}

export function saveSettings(input) {
  applySettings(input);
  // Preserve keys we don't currently recognize. A plugin's setting keys are only
  // "known" (registered) while that plugin is loaded; if it is disabled, mid-
  // update via the catalog, or failed to load, its keys are absent from
  // currentSettings(). Writing just currentSettings() would then drop them —
  // permanently wiping that plugin's saved config from disk. Merge over whatever
  // is already on disk so an unloaded plugin's settings survive until it's back.
  let onDisk = {};
  try { onDisk = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { /* first run: nothing to preserve */ }
  fs.writeFileSync(FILE, JSON.stringify({ ...onDisk, ...currentSettings() }, null, 2));
  return currentSettings();
}
