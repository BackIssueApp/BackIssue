// Static consistency checks for the frontend (a Svelte SPA in frontend/src) —
// no browser or build needed. These guard the contracts that break silently:
// settings fields that map to no config key, and the plugin client API/slots
// that external plugin scripts inject into.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SRC = 'frontend/src';

function sourceFiles(dir = SRC, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(p, out);
    else if (/\.(svelte|js)$/.test(e.name)) out.push(p);
  }
  return out;
}
const files = sourceFiles();
const allSource = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');

test('every set-<key> settings field in the UI is a real config key', async () => {
  const config = (await import('../src/config.js')).default;
  const { SETTING_FIELDS } = await import('../src/settings.js');
  const unknown = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/\bid="set-([A-Za-z0-9]+)"/g)) {
      const key = m[1];
      if (!(key in config) && !(key in SETTING_FIELDS)) unknown.push(`${key} (${f})`);
    }
  }
  assert.deepEqual(unknown, [], 'settings inputs that map to no config key are silently dropped on save');
});

test('plugin bridge exposes the documented client API', () => {
  // window.BackIssue is a public contract with plugin client scripts (e.g.
  // plugins/<name>/client/ui.js) — renaming any of these breaks them at runtime.
  const bridge = fs.readFileSync('frontend/src/lib/plugins.svelte.js', 'utf8');
  for (const name of ['registerClient', 'slot', 'addMenuAction', 'onStatus', 'onSourcesSync', 'onSettingsLoad', 'refreshSourceUI', 'escapeHtml', 'fmt',
    'registerIssueAction', 'registerSeriesAction', 'registerIssueCover', 'registerSeriesView', 'refreshIssueActions']) {
    assert.ok(bridge.includes(name), `plugin client api lost "${name}"`);
  }
  assert.ok(bridge.includes('window.BackIssue'), 'bridge must be published as window.BackIssue');
});

test('plugin series views replace the issue area, and their ctx carries the documented helpers', () => {
  // registerSeriesView is a public contract: the owning plugin draws the
  // issue area of its type's series pages into a plain container, with a ctx
  // of { series, issues, refresh, can, icon, get, post }.
  const bridge = fs.readFileSync('frontend/src/lib/plugins.svelte.js', 'utf8');
  const ctxBlock = bridge.match(/renderSeriesView[\s\S]*?\n\}/)?.[0] || '';
  for (const key of ['series', 'issues', 'refresh', 'can:', 'icon:', 'get:', 'post:']) {
    assert.ok(ctxBlock.includes(key), `series-view ctx lost "${key.replace(':', '')}"`);
  }
  // SeriesDetail must delegate to the view (container + re-render signal) and
  // keep the hero: the plugin container replaces chips + list, nothing more.
  const detail = fs.readFileSync('frontend/src/components/SeriesDetail.svelte', 'utf8');
  assert.ok(detail.includes('renderSeriesView('), 'SeriesDetail must render registered plugin views');
  assert.ok(detail.includes('plugin-series-view'), 'SeriesDetail must mount a plain container for the view');
  assert.ok(detail.includes('issueActionsTick.n') && detail.includes('host.replaceChildren()'),
    'plugin views must re-render on the actions tick and be cleared on teardown');
});

test('plugin DOM slots exist in the UI markup', () => {
  // Plugins inject UI into these ids with plain getElementById — the elements
  // must exist (and stay mounted for the app's lifetime).
  for (const id of ['menu-plugin-actions', 'header-plugin-slot', 'settings-plugin-sources', 'settings-plugin-priority', 'tools-plugin-actions']) {
    assert.ok(allSource.includes(`id="${id}"`), `plugin slot #${id} is missing from the UI`);
  }
});

test('frontend indexer parser stays in sync with src/newznab.js parseIndexers', async () => {
  // The browser can't import Node modules, so the parser is duplicated by
  // design — this pins the two implementations to identical behavior.
  const { parseIndexerString } = await import('../frontend/src/lib/util.js');
  const { parseIndexers } = await import('../src/newznab.js');
  const samples = [
    'geek | https://api.nzbgeek.info | abc123',
    'slash | https://api.example.com/// | k',
    '# comment line\nnameless-url-only | https://x.example |',
    '   \n\n',
    'https://bare-url.example',
    'a|b|c|d',
  ];
  for (const s of samples) {
    assert.deepEqual(parseIndexerString(s), parseIndexers(s), `parsers disagree on: ${JSON.stringify(s)}`);
  }
});

test('overlay routes are wired consistently (router vs App pages)', () => {
  const router = fs.readFileSync('frontend/src/lib/router.svelte.js', 'utf8');
  const app = fs.readFileSync('frontend/src/App.svelte', 'utf8');
  const m = router.match(/OVERLAY_PATHS = \[([^\]]+)\]/);
  assert.ok(m, 'OVERLAY_PATHS not found in router');
  const paths = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  assert.ok(paths.length >= 8, 'unexpectedly few overlay paths');
  for (const p of paths) {
    assert.ok(app.includes(`'${p}'`), `overlay route ${p} is not handled in App.svelte`);
  }
});

test('windowRange virtualizes list & grid without dropping items', async () => {
  const { windowRange } = await import('../frontend/src/lib/util.js');

  // List (cols=1): at the top, render only the viewport + overscan, not all 3000.
  const top = windowRange({ n: 3000, cols: 1, stride: 40, viewH: 800, scrollTop: 0, listTop: 0, overscan: 6 });
  assert.equal(top.start, 0);
  assert.ok(top.end < 60, `windowed count should be small, got ${top.end}`);
  assert.equal(top.padTop, 0);
  assert.ok(top.padBottom > 100000, 'reserves height for the ~3000 unrendered rows');

  // Grid (cols=6): scrolled halfway, the window is centred and row-aligned.
  const mid = windowRange({ n: 3000, cols: 6, stride: 220, viewH: 800, scrollTop: 22000, listTop: 0, overscan: 6 });
  assert.equal(mid.start % 6, 0, 'start snaps to a full grid row');
  assert.ok(mid.start > 0 && mid.end < 3000, 'a middle window, not the whole set');
  assert.ok(mid.end - mid.start < 200, `rendered card count stays bounded, got ${mid.end - mid.start}`);
  // Spacers reserve the full scroll height so the scrollbar stays honest.
  const totalRows = Math.ceil(3000 / 6);
  assert.equal(mid.padTop + (mid.end - mid.start) / 6 * 220 + mid.padBottom, totalRows * 220);

  // A set that fits entirely within the viewport (+overscan) renders in full.
  const small = windowRange({ n: 20, cols: 1, stride: 40, viewH: 2000, scrollTop: 0 });
  assert.deepEqual(small, { start: 0, end: 20, padTop: 0, padBottom: 0 });

  // Degenerate inputs never throw or drop items.
  assert.deepEqual(windowRange({ n: 0, cols: 1, stride: 40, viewH: 800, scrollTop: 0 }), { start: 0, end: 0, padTop: 0, padBottom: 0 });
  assert.deepEqual(windowRange({ n: 100, cols: 3, stride: 0, viewH: 800, scrollTop: 0 }), { start: 0, end: 100, padTop: 0, padBottom: 0 });
});

test('iconSvg tolerates null/undefined opts (plugins call api.icon(name, null))', async () => {
  const { iconSvg, ICON_PATHS } = await import('../frontend/src/lib/icons.js');
  // The reader plugin passes null opts — this crashed the volume page render.
  assert.match(iconSvg('check', null), /^<svg /);
  assert.match(iconSvg('play'), /^<svg /);
  assert.equal(iconSvg('no-such-icon', null), '');
  // Every icon in the set renders under both call styles.
  for (const name of Object.keys(ICON_PATHS)) {
    assert.match(iconSvg(name, null), /^<svg /, `${name} with null opts`);
    assert.match(iconSvg(name, { fill: true, size: 14 }), /fill="currentColor"/, `${name} filled`);
  }
});
