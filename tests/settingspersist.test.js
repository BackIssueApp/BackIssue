// saveSettings must not destroy the config of a plugin that happens to be
// unloaded at save time (disabled, mid-update via the catalog, or load-failed).
// Its keys aren't "known" then, but they must survive on disk — otherwise the
// next save wipes them permanently. Isolated in its own file so it can redirect
// config.dataDir to a temp dir BEFORE settings.js binds its FILE constant.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bi-settings-'));
const config = (await import('../src/config.js')).default;
config.dataDir = tmp;
const FILE = path.join(tmp, 'settings.json');
const settings = await import('../src/settings.js');

test('saveSettings preserves settings for a plugin that is not currently loaded', () => {
  // Pre-seed the file with an unloaded plugin's keys (nothing registered them).
  fs.writeFileSync(FILE, JSON.stringify({
    airdcppHost: 'dchub://keep.me:411', airdcppUser: 'me', getcomicsUrl: 'https://x',
    downloadConcurrency: 3,
  }));
  // Saving an unrelated core field must not drop the unknown plugin keys.
  settings.saveSettings({ downloadConcurrency: 5 });
  const onDisk = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  assert.equal(onDisk.airdcppHost, 'dchub://keep.me:411', 'airdcpp key survives');
  assert.equal(onDisk.airdcppUser, 'me');
  assert.equal(onDisk.getcomicsUrl, 'https://x', 'getcomics key survives');
  assert.equal(onDisk.downloadConcurrency, 5, 'known core field still updates');
});

test('a FlareSolverr address already set on a source becomes the shared setting, once, on disk', () => {
  // An install from before the shared setting existed: one source carries it.
  fs.writeFileSync(FILE, JSON.stringify({ somesourceFlaresolverrUrl: 'http://flare.lan:8191/v1', downloadConcurrency: 3 }, null, 2));
  delete config.flaresolverrUrl;
  config.somesourceFlaresolverrUrl = 'http://flare.lan:8191/v1'; // as the source's own registration would load it
  settings.loadSettings();
  assert.equal(config.flaresolverrUrl, 'http://flare.lan:8191/v1', 'carried over, so nobody retypes it');
  const onDisk = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  assert.equal(onDisk.flaresolverrUrl, 'http://flare.lan:8191/v1', 'written back so the field shows it');
  assert.equal(onDisk.somesourceFlaresolverrUrl, 'http://flare.lan:8191/v1', 'the source keeps its own value as an override');
  assert.equal(onDisk.downloadConcurrency, 3, 'nothing else on disk is touched');

  // An address already chosen for the shared setting is never overwritten.
  fs.writeFileSync(FILE, JSON.stringify({ flaresolverrUrl: 'http://mine:8191/v1', somesourceFlaresolverrUrl: 'http://other:8191/v1' }, null, 2));
  config.flaresolverrUrl = 'http://mine:8191/v1';
  settings.loadSettings();
  assert.equal(config.flaresolverrUrl, 'http://mine:8191/v1');
});
