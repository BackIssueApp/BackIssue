import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zeroDayDate, pickZeroDayGrab } from '../src/zeroday.js';

test('zeroDayDate: parses the week out of title variants', () => {
  assert.equal(zeroDayDate('0-Day Week of 2026.06.24 by Marvel, DC [ENG / CBR CBZ] [VIP]'), '2026-06-24');
  assert.equal(zeroDayDate('0-day Week of 2015.04.29 by DC'), '2015-04-29');
  assert.equal(zeroDayDate('0-Day Week of 2016.10.26 (late) by Image'), '2016-10-26');
  assert.equal(zeroDayDate('Batman 001 (2016)'), null);
});

const R = (title, url = title) => ({ title, downloadUrl: 'magnet:' + url });

test('pickZeroDayGrab: picks the newest week', () => {
  const best = pickZeroDayGrab([R('0-Day Week of 2026.06.10 by X'), R('0-Day Week of 2026.06.24 by Y'), R('0-Day Week of 2026.06.17 by Z')], []);
  assert.equal(best.date, '2026-06-24');
});

test('pickZeroDayGrab: same week under a different title variant is NOT re-grabbed', () => {
  // Already grabbed the [VIP] variant of 2026.06.24; a plain variant is newest now.
  const grabbed = ['0-Day Week of 2026.06.24 by Dark Horse, Image, Marvel [ENG / CBR CBZ] [VIP]'];
  const best = pickZeroDayGrab([R('0-Day Week of 2026.06.24 by DC, Marvel [ENG / CBR CBZ]')], grabbed);
  assert.equal(best, null); // same week → skip despite the different title string
});

test('pickZeroDayGrab: grabs a genuinely newer week than what we hold', () => {
  const grabbed = ['0-Day Week of 2026.06.24 by X'];
  const best = pickZeroDayGrab([R('0-Day Week of 2026.07.01 by Y'), R('0-Day Week of 2026.06.24 by X2')], grabbed);
  assert.equal(best.date, '2026-07-01');
});

test('pickZeroDayGrab: nothing found or nothing newer → null', () => {
  assert.equal(pickZeroDayGrab([], []), null);
  assert.equal(pickZeroDayGrab([R('not a pack')], []), null);
  assert.equal(pickZeroDayGrab([R('0-Day Week of 2026.06.24 by X')], ['0-Day Week of 2026.06.24 by Y']), null);
});

test('pickZeroDayGrab: a tiny "weekly pack" is ignored as fake', () => {
  const best = pickZeroDayGrab([
    { title: '0-Day Week of 2026.07.08 by X', downloadUrl: 'magnet:fake', size: 2 * 1024 * 1024 },   // 2MB "weekly pack" = fake
    { title: '0-Day Week of 2026.07.01 by Y', downloadUrl: 'magnet:real', size: 9 * 1024 * 1024 * 1024 },
  ], []);
  assert.equal(best.date, '2026-07-01'); // older but real wins; the fake newest is skipped
});
