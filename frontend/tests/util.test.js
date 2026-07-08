import { describe, test, expect } from 'vitest';
import {
  fmt, pad3, initials, humanBytes, spct, fmtIn, fmtAgo,
  parseCvVolumeRef, parseIndexerString, serializeIndexers,
  rankCvResults, issueMatchesFilter, sanitizeHtml, stripTags,
  weekOfYear, shiftWeek,
} from '../src/lib/util.js';

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
