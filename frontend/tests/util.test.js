import { describe, test, expect, beforeEach } from 'vitest';
import { librarySort, setLibrarySort } from '../src/lib/store.svelte.js';
import {
  fmt, pad3, initials, humanBytes, spct, fmtIn, fmtAgo,
  parseCvVolumeRef, parseIndexerString, serializeIndexers,
  rankCvResults, issueMatchesFilter, sanitizeHtml, stripTags,
  weekOfYear, shiftWeek, windowRange,
} from '../src/lib/util.js';
import { arcModel, arcTicks, arcStatus, pickResume } from '../src/lib/arcs.js';

describe('formatting', () => {
  test('fmt localizes and tolerates nullish', () => {
    expect(fmt(1234567)).toBe('1,234,567');
    expect(fmt(null)).toBe('0');
  });
  test('pad3 pads plain numbers only', () => {
    expect(pad3(7)).toBe('007');
    expect(pad3('12.5')).toBe('12.5'); // decimals stay as-is
    expect(pad3(null)).toBe('');
  });
  test('initials skips parentheticals', () => {
    expect(initials('Batman (2016)')).toBe('B');
    expect(initials('Saga of the Swamp Thing')).toBe('SO');
  });
  test('humanBytes scales', () => {
    expect(humanBytes(0)).toBe('0 B');
    expect(humanBytes(1536)).toBe('1.5 KB');
    expect(humanBytes(3.2e9)).toBe('3.0 GB');
  });
  test('spct never lies at the edges', () => {
    expect(spct(0, 100)).toBe(0);
    expect(spct(1, 10000)).toBe(1);    // any progress shows ≥1
    expect(spct(9999, 10000)).toBe(99); // not-done never rounds to 100
    expect(spct(100, 100)).toBe(100);
    expect(spct(5, 0)).toBe(0);
  });
  test('fmtIn / fmtAgo', () => {
    expect(fmtIn(-5)).toBe('due now');
    expect(fmtIn(90 * 60000)).toBe('in 1h 30m');
    expect(fmtAgo(30_000)).toBe('30s');
    expect(fmtAgo(3 * 3600_000)).toBe('3h');
  });
});

describe('ComicVine helpers', () => {
  test('parseCvVolumeRef reads URLs and bare ids', () => {
    expect(parseCvVolumeRef('https://comicvine.gamespot.com/volume/4050-72763/')).toBe(72763);
    expect(parseCvVolumeRef('72763')).toBe(72763);
    expect(parseCvVolumeRef('7')).toBe(null);       // too short to be an id
    expect(parseCvVolumeRef('Batman')).toBe(null);
  });
  test('rankCvResults puts the closest issue count first, relevance breaks ties', () => {
    const rows = [
      { id: 1, count_of_issues: 300 },
      { id: 2, count_of_issues: 52 },
      { id: 3, count_of_issues: null },
      { id: 4, count_of_issues: 50 },
    ];
    expect(rankCvResults(rows, 51).map((v) => v.id)).toEqual([2, 4, 1, 3]);
    expect(rankCvResults(rows, null).map((v) => v.id)).toEqual([1, 2, 3, 4]); // no file count → untouched
  });
});

describe('indexer list parsing', () => {
  test('round-trips name | url | apikey lines', () => {
    const src = 'geek | https://api.nzbgeek.info | k1\nplain | https://x.example |';
    const list = parseIndexerString(src);
    expect(list).toEqual([
      { name: 'geek', url: 'https://api.nzbgeek.info', apiKey: 'k1' },
      { name: 'plain', url: 'https://x.example', apiKey: '' },
    ]);
    expect(parseIndexerString(serializeIndexers(list))).toEqual(list);
  });
  test('skips comments/blanks, strips trailing slashes from the url (name falls back to the raw url, matching src/newznab.js)', () => {
    expect(parseIndexerString('# nope\n\n| https://a.example/// | k')).toEqual([
      { name: 'https://a.example///', url: 'https://a.example', apiKey: 'k' },
    ]);
  });
});

describe('issueMatchesFilter', () => {
  test.each([
    ['all', 'pending', true],
    ['missing', 'pending', true],
    ['missing', 'failed', true],   // failed still needs a usable file
    ['missing', 'done', false],
    ['missing', 'corrupt', false], // a corrupt file exists — not "missing"
    ['saved', 'done', true],
    ['saved', 'untagged', true],   // owned, just untagged
    ['saved', 'queued', false],
    ['corrupt', 'corrupt', true],
    ['untagged', 'done', false],
    ['failed', 'failed', true],
  ])('filter=%s state=%s → %s', (filter, state, expected) => {
    expect(issueMatchesFilter(state, filter)).toBe(expected);
  });
});

describe('release week math (%U, Sunday-first — twin of src/releases.js)', () => {
  test('weekOfYear matches strftime %U', () => {
    expect(weekOfYear(new Date(Date.UTC(2026, 6, 3)))).toEqual({ week: '26', year: '2026' });   // Fri Jul 3 2026
    expect(weekOfYear(new Date(Date.UTC(2026, 0, 1)))).toEqual({ week: '00', year: '2026' });   // Jan 1 before first Sunday
    expect(weekOfYear(new Date(Date.UTC(2023, 11, 31)))).toEqual({ week: '53', year: '2023' }); // Sun Dec 31 2023
  });
  test('shiftWeek steps within a year', () => {
    expect(shiftWeek('26', '2026', 1)).toEqual({ week: '27', year: '2026' });
    expect(shiftWeek('26', '2026', -1)).toEqual({ week: '25', year: '2026' });
  });
  test('shiftWeek crosses year boundaries both ways', () => {
    expect(shiftWeek('53', '2023', 1)).toEqual({ week: '01', year: '2024' });
    expect(shiftWeek('01', '2026', -1)).toEqual({ week: '52', year: '2025' });
    // Week 00 IS the tail of the prior year's last week (the span containing
    // Jan 1) — so one step back is the previous distinct span, not its alias.
    expect(shiftWeek('00', '2026', -1)).toEqual({ week: '51', year: '2025' });
  });
  test('shiftWeek round-trips', () => {
    const start = { week: '01', year: '2026' };
    const there = shiftWeek(start.week, start.year, -3);
    const back = shiftWeek(there.week, there.year, 3);
    expect(back).toEqual(start);
  });
});

describe('sanitizeHtml', () => {
  test('strips active content but keeps formatting', () => {
    const dirty = '<p>Hi <b>there</b><script>alert(1)</script><img src="x" onerror="hack()"><a href="javascript:evil()">x</a></p>';
    const clean = sanitizeHtml(dirty);
    expect(clean).not.toMatch(/script|onerror|javascript:/);
    expect(clean).toContain('<b>there</b>');
  });
  test('stripTags flattens to text', () => {
    expect(stripTags('<p>A  <i>b</i>\nc</p>')).toBe('A b c');
  });
});

describe('library sort preference', () => {
  beforeEach(() => localStorage.removeItem('librarySort'));

  test('defaults to A–Z when nothing is stored', () => {
    expect(librarySort()).toBe('title');
  });

  test('round-trips a chosen sort', () => {
    setLibrarySort('added');
    expect(librarySort()).toBe('added');
    expect(localStorage.getItem('librarySort')).toBe('added');
  });

  test('a value that is not a real sort is ignored, both ways', () => {
    // writing junk never lands...
    setLibrarySort('; DROP TABLE series');
    expect(localStorage.getItem('librarySort')).toBe(null);
    // ...and junk already in storage (an old build, a hand-edit) reads as the default,
    // so it can never reach the API as a sort key
    localStorage.setItem('librarySort', 'whatever');
    expect(librarySort()).toBe('title');
  });

  test('survives storage being unavailable', () => {
    const real = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() { throw new Error('denied'); },   // private mode / site data blocked
    });
    expect(() => setLibrarySort('added')).not.toThrow();
    expect(librarySort()).toBe('title');
    Object.defineProperty(window, 'localStorage', real);
  });
});

// A route typo fails silently: navigate() accepts any string, and the app just
// shows "Page not found". That is how AddModal's "In library" button spent a
// while sending people to /series/:id, which has never been a route. Check
// every literal destination in the source against the routes that exist.
describe('every navigate() target is a real route', () => {
  test('no component links to a path the router does not serve', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');

    const walk = (dir) => readdirSync(dir).flatMap((f) => {
      const full = join(dir, f);
      return statSync(full).isDirectory() ? walk(full) : /\.(svelte|js)$/.test(f) ? [full] : [];
    });

    const router = readFileSync('src/lib/router.svelte.js', 'utf8');
    const overlays = JSON.parse(
      (/export const OVERLAY_PATHS = (\[[^\]]*\])/.exec(router)[1]).replace(/'/g, '"'),
    );
    // KNOWN_PATHS in App.svelte, plus the one parameterised route it matches.
    const known = new Set(['/', '/system', '/profile', '/jobs', '/tools', '/logs', '/volume', ...overlays]);

    const bad = [];
    for (const file of walk('src')) {
      const src = readFileSync(file, 'utf8');
      // navigate('/x…') and navigate(`/x…`) — the literal head is enough, since
      // the first segment is what the router dispatches on.
      for (const m of src.matchAll(/navigate\(\s*['"`](\/[a-z0-9-]*)/gi)) {
        const first = m[1] === '/' ? '/' : '/' + m[1].slice(1).split('/')[0];
        if (!known.has(first)) bad.push(file + ' -> ' + m[1]);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe('arc model', () => {
  // A six-issue run with a gap at index 3 (not owned).
  const rows = [
    { cv_issue_id: 1, owned: true },
    { cv_issue_id: 2, owned: true },
    { cv_issue_id: 3, owned: true },
    { cv_issue_id: 4, owned: false },
    { cv_issue_id: 5, owned: true },
    { cv_issue_id: 6, owned: true },
  ];
  const read = (...ids) => Object.fromEntries(ids.map((id) => [id, { page: 0, pages: 10, completed: 1 }]));

  test('without the reader it claims no progress at all', () => {
    const a = arcModel(rows, null);
    expect(a.hasReader).toBe(false);
    expect(a.readCount).toBe(0);
    expect(a.positionIndex).toBe(-1);
    expect(a.nextReadable).toBe(null);
    expect(a.done).toBe(false);
    // Only ownership is knowable, so no row is called read or current.
    expect(rows.map((r, i) => a.nodeKind(r, i)))
      .toEqual(['upcoming', 'upcoming', 'upcoming', 'missing', 'upcoming', 'upcoming']);
  });

  test('position is the first unread issue, and the spine fills up to it', () => {
    const a = arcModel(rows, read(1, 2));
    expect(a.readCount).toBe(2);
    expect(a.positionIndex).toBe(2);
    expect(a.nodeKind(rows[2], 2)).toBe('current');
    expect(rows.map((_, i) => a.spineDone(i))).toEqual([true, true, false, false, false, false]);
  });

  test('the position stops AT a gap rather than reading through it', () => {
    const a = arcModel(rows, read(1, 2, 3));
    expect(a.positionIndex).toBe(3);          // the unowned issue
    expect(a.nodeKind(rows[3], 3)).toBe('missing');  // shown as a gap, not as current
    expect(a.nextReadable.cv_issue_id).toBe(5);      // but Continue skips past it
    expect(a.spineDone(4)).toBe(false);              // nothing is filled past the gap
  });

  test('in-progress counts pages started but not finished', () => {
    const a = arcModel(rows, { 1: { page: 4, pages: 20, completed: 0 }, 2: { page: 0, pages: 20, completed: 0 } });
    expect(a.inProgressCount).toBe(1);
    expect(a.readCount).toBe(0);
  });

  test('done only when every issue is read', () => {
    expect(arcModel(rows, read(1, 2, 3, 4, 5)).done).toBe(false);
    const all = arcModel(rows, read(1, 2, 3, 4, 5, 6));
    expect(all.done).toBe(true);
    expect(all.nextReadable).toBe(null);
    expect(all.positionIndex).toBe(-1);
    expect(all.spineDone(5)).toBe(true);      // filled to the end
  });

  test('an empty run is not "done"', () => {
    expect(arcModel([], {}).done).toBe(false);
  });

  test('ticks scale onto a capped row', () => {
    expect(arcTicks(3, 6)).toEqual([true, true, true, false, false, false]);
    expect(arcTicks(0, 4)).toEqual([false, false, false, false]);
    const big = arcTicks(150, 300);
    expect(big.length).toBe(40);                       // capped
    expect(big.filter(Boolean).length).toBe(20);       // half lit
    expect(arcTicks(5, 0)).toEqual([]);
  });

  test('status reports done/reading/new, and nothing without the reader', () => {
    expect(arcStatus(null)).toBe(null);
    expect(arcStatus({ total: 5, read: 5, in_progress: 0 })).toBe('done');
    expect(arcStatus({ total: 5, read: 2, in_progress: 0 })).toBe('reading');
    expect(arcStatus({ total: 5, read: 0, in_progress: 1 })).toBe('reading');
    expect(arcStatus({ total: 5, read: 0, in_progress: 0 })).toBe('new');
  });

  test('resume picks the most recently read started arc that has a next', () => {
    const lists = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
    const progress = {
      1: { total: 5, read: 1, in_progress: 0, last_read_at: '2026-01-01T00:00:00Z', next: { cv_issue_id: 11 } },
      2: { total: 5, read: 3, in_progress: 0, last_read_at: '2026-02-01T00:00:00Z', next: { cv_issue_id: 22 } },
      3: { total: 5, read: 5, in_progress: 0, last_read_at: '2026-03-01T00:00:00Z', next: null },  // finished
      4: { total: 5, read: 0, in_progress: 0, last_read_at: null, next: { cv_issue_id: 44 } },     // not started
    };
    expect(pickResume(lists, progress).list.id).toBe(2);
    // Marked read by hand: no timestamp, but still resumable — it sorts last.
    expect(pickResume([{ id: 4 }], { 4: { read: 2, in_progress: 0, last_read_at: null, next: { cv_issue_id: 44 } } }).list.id).toBe(4);
    expect(pickResume(lists, null)).toBe(null);
    expect(pickResume([{ id: 3 }], progress)).toBe(null);   // nowhere left to go
  });
});

describe('windowRange', () => {
  // Governs both the series page and a reading list, where a four-figure run
  // is ordinary; the spacers must always add up to the rows left out.
  const base = { stride: 50, viewH: 500, listTop: 0 };

  test('at the top it mounts the viewport plus overscan, padded below', () => {
    const r = windowRange({ ...base, n: 1000, scrollTop: 0, overscan: 6 });
    expect(r.start).toBe(0);
    expect(r.end).toBe(16);          // 10 rows in view + 6 overscan
    expect(r.padTop).toBe(0);
    expect(r.padBottom).toBe((1000 - 16) * 50);
  });

  test('scrolled deep, the pads account for every row not mounted', () => {
    const n = 1000;
    const r = windowRange({ ...base, n, scrollTop: 25000, overscan: 6 });   // row 500
    expect(r.start).toBe(494);
    expect(r.end).toBe(516);
    // The whole column still measures the same, so the scrollbar doesn't lie.
    expect(r.padTop + (r.end - r.start) * 50 + r.padBottom).toBe(n * 50);
  });

  test('at the bottom nothing is padded past the end', () => {
    const r = windowRange({ ...base, n: 100, scrollTop: 100 * 50, overscan: 6 });
    expect(r.end).toBe(100);
    expect(r.padBottom).toBe(0);
  });

  test('a stale deep scroll after the set shrinks still mounts rows', () => {
    // Filtering 2,000 issues down to 3 while scrolled to the bottom used to
    // leave the window past the end, rendering nothing at all.
    const r = windowRange({ ...base, n: 3, scrollTop: 90000, overscan: 6 });
    expect(r.start).toBe(0);
    expect(r.end).toBe(3);
  });

  test('a grid windows whole rows of `cols` items', () => {
    const r = windowRange({ ...base, n: 100, cols: 5, scrollTop: 0, overscan: 1 });
    expect(r.start).toBe(0);
    expect(r.end).toBe(55);          // (10 + 1) rows x 5 columns
    expect(r.padBottom).toBe((20 - 11) * 50);
  });

  test('without a measured stride it renders everything rather than nothing', () => {
    expect(windowRange({ n: 40, stride: 0, viewH: 500, scrollTop: 0 })).toEqual({ start: 0, end: 40, padTop: 0, padBottom: 0 });
    expect(windowRange({ n: 0, stride: 50, viewH: 500, scrollTop: 0 }).end).toBe(0);
  });
});
