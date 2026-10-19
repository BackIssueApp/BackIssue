// An unreadable settings.json must not be silently replaced by defaults: the
// original is kept beside it, and saves never leave a half-written file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bi-settings-'));
process.env.DATA_DIR = dir;
const FILE = path.join(dir, 'settings.json');
const broken = '{ "cvApiKey": "keep-me", "indexers": [ }';
fs.writeFileSync(FILE, broken);
const { loadSettings, saveSettings } = await import('../src/settings.js');

test('an unreadable settings.json is kept before defaults replace it', () => {
  loadSettings();
  const kept = fs.readdirSync(dir).filter((f) => f.startsWith('settings.json.unreadable-'));
  assert.equal(kept.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, kept[0]), 'utf8'), broken);
  // The live file is valid JSON again, and no temp file is left behind.
  JSON.parse(fs.readFileSync(FILE, 'utf8'));
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
});

test('saving writes a complete file', () => {
  saveSettings({});
  const onDisk = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  assert.equal(typeof onDisk, 'object');
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
});
