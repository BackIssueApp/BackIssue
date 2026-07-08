import { test } from 'node:test';
import assert from 'node:assert/strict';
import config from '../src/config.js';

test('config exposes required fields with sane defaults', () => {
  assert.equal(config.port, 8787);
  assert.ok(config.actionDelayMs > 0);
  assert.ok(config.crawlConcurrency >= 1);
  assert.ok(config.downloadConcurrency >= 1);
  assert.match(config.profileDir, /\.profile$/);
  assert.match(config.downloadsDir, /downloads$/);
  assert.match(config.dbPath, /\.db$/);
});
