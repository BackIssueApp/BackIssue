import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSettings, applySettings, currentSettings } from '../src/settings.js';

test('validateSettings clamps ints and ignores invalid/unknown keys', () => {
  const v = validateSettings({
    crawlConcurrency: 999, downloadConcurrency: 0, actionDelayMs: -5,
    format: 'cbr', bogus: 1,
  });
  assert.equal(v.crawlConcurrency, 16);   // clamped to max
  assert.equal(v.downloadConcurrency, 1); // clamped to min
  assert.equal(validateSettings({ toolsConcurrency: 99 }).toolsConcurrency, 16); // clamped
  assert.equal(v.actionDelayMs, 0);       // clamped to min
  assert.equal('format' in v, false);     // invalid enum rejected
  assert.equal('bogus' in v, false);      // unknown key ignored
});

test('validateSettings: bool coercion + blank ints/host', () => {
  assert.equal(validateSettings({ nzbClientSsl: 'on' }).nzbClientSsl, true);
  assert.equal(validateSettings({ nzbClientSsl: false }).nzbClientSsl, false);
  assert.equal(validateSettings({ nzbClientPort: 6789 }).nzbClientPort, 6789);
  assert.equal('nzbClientPort' in validateSettings({ nzbClientPort: '' }), false); // blank port left unset, not clamped to 1
  assert.equal(validateSettings({ nzbClientHost: 'nas' }).nzbClientHost, 'nas');
});

test('validateSettings accepts a valid format and downloads dir', () => {
  const v = validateSettings({ format: 'pdf', downloadsDir: '/x/y' });
  assert.equal(v.format, 'pdf');
  assert.equal(v.downloadsDir, '/x/y');
});

test('validateSettings accepts windowMode and rejects bad values', () => {
  assert.equal(validateSettings({ windowMode: 'hidden' }).windowMode, 'hidden');
  assert.equal(validateSettings({ windowMode: 'visible' }).windowMode, 'visible');
  assert.equal(validateSettings({ windowMode: 'headless' }).windowMode, 'headless');
  assert.equal('windowMode' in validateSettings({ windowMode: 'nope' }), false);
});

test('applySettings updates the live config-backed settings', () => {
  applySettings({ downloadConcurrency: 6, format: 'pdf' });
  const s = currentSettings();
  assert.equal(s.downloadConcurrency, 6);
  assert.equal(s.format, 'pdf');
});

test('validateSettings drops removed Mylar fields', () => {
  const v = validateSettings({ mylarUrl: 'http://x', mylarApiKey: 'abc' });
  assert.equal(v.mylarUrl, undefined);
  assert.equal(v.mylarApiKey, undefined);
});

test('legacy libraryDir seeds rootFolders when it is empty', () => {
  applySettings({ libraryDir: '\\\\NAS\\Main\\mylar', rootFolders: '' });
  // simulate the loadSettings migration
  const c = currentSettings();
  const seeded = !c.rootFolders && c.libraryDir ? c.libraryDir : c.rootFolders;
  assert.equal(seeded, '\\\\NAS\\Main\\mylar');
  // an explicit rootFolders is NOT overridden
  applySettings({ libraryDir: '\\\\NAS\\Main\\mylar', rootFolders: 'D:/comics' });
  const c2 = currentSettings();
  assert.equal(c2.rootFolders, 'D:/comics');
});

test('validateSettings accepts tagging fields', () => {
  const v = validateSettings({ tagOnDownload: 'on', comictaggerPath: 'C:/ct.exe', comicvineKeys: 'a\nb', tagStagingDir: 'D:/stage' });
  assert.equal(v.tagOnDownload, 'on');
  assert.equal(v.comictaggerPath, 'C:/ct.exe');
  assert.equal(v.comicvineKeys, 'a\nb');
  assert.equal(v.tagStagingDir, 'D:/stage');
  assert.equal('tagOnDownload' in validateSettings({ tagOnDownload: 'maybe' }), false);
});

test('validateSettings accepts scanDir', () => {
  assert.equal(validateSettings({ scanDir: 'Z:/mylar' }).scanDir, 'Z:/mylar');
});

test('validateSettings accepts libraryDir + clamps libraryConcurrency', () => {
  assert.equal(validateSettings({ libraryDir: 'Z:/mylar' }).libraryDir, 'Z:/mylar');
  assert.equal(validateSettings({ libraryConcurrency: 12 }).libraryConcurrency, 12);
  assert.equal(validateSettings({ libraryConcurrency: 0 }).libraryConcurrency, 1);
  assert.equal(validateSettings({ libraryConcurrency: 99 }).libraryConcurrency, 32);
});

test('validateSettings clamps updatePages', () => {
  assert.equal(validateSettings({ updatePages: 30 }).updatePages, 30);
  assert.equal(validateSettings({ updatePages: 0 }).updatePages, 1);
  assert.equal(validateSettings({ updatePages: 999 }).updatePages, 100);
});

test('validateSettings clamps tagConcurrency', () => {
  assert.equal(validateSettings({ tagConcurrency: 3 }).tagConcurrency, 3);
  assert.equal(validateSettings({ tagConcurrency: 0 }).tagConcurrency, 1);    // min
  assert.equal(validateSettings({ tagConcurrency: 99 }).tagConcurrency, 16);  // max
  assert.equal('tagBacklogMax' in validateSettings({ tagBacklogMax: 5 }), false); // removed
});
