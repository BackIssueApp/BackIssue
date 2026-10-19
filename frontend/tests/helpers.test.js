// Boots the English catalog the helpers format with.
import '../src/lib/i18n.svelte.js';
import { describe, test, expect, vi, afterEach } from 'vitest';
import { apiGet, apiGetOk, apiPost, isFailure, errorText, ApiError } from '../src/lib/api.js';
import { latestGuard, measureGrid, highlightHtml } from '../src/lib/util.js';
import { metaSlug, metaValue } from '../src/lib/metaValues.js';
import { seriesTitle, PLACEHOLDER_TITLE } from '../src/lib/store.svelte.js';

const reply = (status, body, { json = true } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => { if (!json) throw new SyntaxError('not json'); return body; },
});

describe('api wrappers', () => {
  afterEach(() => vi.unstubAllGlobals());

  test('a 502 HTML page resolves a marked failure; apiGetOk throws it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(502, null, { json: false })));
    const r = await apiGet('/api/x');
    expect(isFailure(r)).toBe(true);
    expect(r.error).toMatch(/502/);
    expect(Object.keys(r)).toEqual(['error']); // the mark is not enumerable
    await expect(apiGetOk('/api/x')).rejects.toBeInstanceOf(ApiError);
    await expect(apiGetOk('/api/x')).rejects.toMatchObject({ status: 502 });
  });

  test('a non-OK JSON error keeps its fields and its message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(409, { error: 'already running', running: true })));
    const r = await apiPost('/api/x', {});
    expect(isFailure(r)).toBe(true);
    expect(r).toMatchObject({ error: 'already running', running: true });
  });

  test('a non-OK array body still reads as a failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(500, [])));
    expect(isFailure(await apiGet('/api/x'))).toBe(true);
  });

  test('a payload that merely carries an error field is data, not a failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(200, { running: false, error: 'last scan failed' })));
    const r = await apiGetOk('/api/scan-folder');
    expect(r).toEqual({ running: false, error: 'last scan failed' });
    expect(isFailure(r)).toBe(false);
  });

  test('a bare { error } body is a failure even with 200', () => {
    expect(isFailure({ error: 'nope' })).toBe(true);
    expect(isFailure([])).toBe(false);
    expect(isFailure(null)).toBe(false);
  });

  test('errorText: server text when there is one, else the reachability hint', () => {
    expect(errorText(new ApiError('boom'))).toBe('boom');
    expect(errorText({ error: 'denied' })).toBe('denied');
    expect(errorText(new TypeError('Failed to fetch'))).toMatch(/reachable/i);
  });
});

describe('latestGuard', () => {
  test('only the most recent call stays current', async () => {
    const seq = latestGuard();
    const a = seq();
    const b = seq();
    expect(a()).toBe(false);
    expect(b()).toBe(true);
  });
  test('a slow older response is dropped', async () => {
    const seq = latestGuard();
    let shown = null;
    const load = async (value, ms) => {
      const isLatest = seq();
      await new Promise((r) => setTimeout(r, ms));
      if (isLatest()) shown = value;
    };
    await Promise.all([load('slow A', 30), load('fast B', 5)]);
    expect(shown).toBe('fast B');
  });
});

describe('measureGrid', () => {
  const items = (tops) => tops.map((offsetTop) => ({ offsetTop }));
  test('columns share the first top; stride is the gap to the next row', () => {
    expect(measureGrid(items([0, 0, 0, 260, 260]))).toEqual({ cols: 3, stride: 260 });
    expect(measureGrid(items([0, 42, 84]))).toEqual({ cols: 1, stride: 42 });
  });
  test('needs two items; a zero gap gives no stride', () => {
    expect(measureGrid(items([0]))).toBe(null);
    expect(measureGrid(null)).toBe(null);
    expect(measureGrid(items([0, 0]))).toEqual({ cols: 2, stride: null });
  });
});

describe('highlightHtml', () => {
  test('marks matches and escapes everything else', () => {
    expect(highlightHtml('a <b> & b', 'b', 'm')).toBe('a &lt;<mark class="m">b</mark>&gt; &amp; <mark class="m">b</mark>');
  });
  test('never splits an entity: a search for "amp" matches the text only', () => {
    expect(highlightHtml('Tom & Jerry', 'amp')).toBe('Tom &amp; Jerry');
    expect(highlightHtml('example', 'AMP')).toBe('ex<mark>amp</mark>le');
  });
  test('regex characters in the query are literal', () => {
    expect(highlightHtml('a.b axb', '.')).toBe('a<mark>.</mark>b axb');
  });
});

describe('metadata values', () => {
  test('slugs', () => {
    expect(metaSlug('Ongoing Series')).toBe('ongoingSeries');
    expect(metaSlug('One-Shot')).toBe('oneShot');
    expect(metaSlug('Teen Plus')).toBe('teenPlus');
  });
  test('known values come from the catalog, unknown ones pass through', () => {
    expect(metaValue('status', 'Completed')).toBe('Completed');
    expect(metaValue('rating', 'Teen Plus')).toBe('Teen Plus');
    expect(metaValue('seriesType', 'Webtoon Special')).toBe('Webtoon Special');
    expect(metaValue('status', '')).toBe('');
  });
});

describe('seriesTitle', () => {
  test('the placeholder sentinel never reaches the page', () => {
    expect(seriesTitle({ title: PLACEHOLDER_TITLE })).toBe('Untitled series');
    expect(seriesTitle({ title: 'Saga' })).toBe('Saga');
    expect(seriesTitle({ title: '' })).toBe('');
    expect(seriesTitle(null)).toBe('');
  });
});
