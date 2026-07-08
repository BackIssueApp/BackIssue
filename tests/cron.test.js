import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCron, validateCron, cronMatches, nextCronTime, hoursToCron } from '../src/cron.js';

const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi).getTime();

test('validateCron: accepts good patterns, explains bad ones', () => {
  for (const ok of ['* * * * *', '0 */12 * * *', '30 9 * * 1-5', '0 9 1,15 * *', '*/5 0-6 * * 0', '0 8 */3 * *', '0 9 * * 7']) {
    assert.equal(validateCron(ok), null, ok);
  }
  assert.match(validateCron('0 9 * *'), /5 fields/);
  assert.match(validateCron('61 * * * *'), /minute/);
  assert.match(validateCron('* 25 * * *'), /hour/);
  assert.match(validateCron('* * 0 * *'), /day of month/);
  assert.match(validateCron('* * * 13 *'), /month/);
  assert.match(validateCron('* * * * 8'), /day of week/);
  assert.match(validateCron('a b c d e'), /minute/);
});

test('cronMatches: fields, ranges, steps, lists, Sunday as 0 and 7', () => {
  const p = parseCron('30 9 * * 1-5');
  assert.equal(cronMatches(p, at(2026, 7, 6, 9, 30)), true);   // Monday 9:30
  assert.equal(cronMatches(p, at(2026, 7, 4, 9, 30)), false);  // Saturday
  assert.equal(cronMatches(p, at(2026, 7, 6, 9, 31)), false);  // wrong minute
  const sun0 = parseCron('0 12 * * 0'), sun7 = parseCron('0 12 * * 7');
  assert.equal(cronMatches(sun0, at(2026, 7, 5, 12, 0)), true); // Sunday
  assert.equal(cronMatches(sun7, at(2026, 7, 5, 12, 0)), true);
  const steps = parseCron('*/15 */6 * * *');
  assert.equal(cronMatches(steps, at(2026, 7, 1, 6, 45)), true);
  assert.equal(cronMatches(steps, at(2026, 7, 1, 7, 0)), false);
});

test('cronMatches: vixie dom/dow rule — both restricted is OR', () => {
  const p = parseCron('0 9 13 * 5'); // the 13th OR any Friday
  assert.equal(cronMatches(p, at(2026, 7, 13, 9, 0)), true);  // Monday the 13th → dom matches
  assert.equal(cronMatches(p, at(2026, 7, 10, 9, 0)), true);  // Friday the 10th → dow matches
  assert.equal(cronMatches(p, at(2026, 7, 14, 9, 0)), false); // Tuesday the 14th → neither
  const domOnly = parseCron('0 9 13 * *');
  assert.equal(cronMatches(domOnly, at(2026, 7, 10, 9, 0)), false); // dow unrestricted → dom gates
});

test('nextCronTime: strictly after, minute-aligned, month skipping', () => {
  // From Wednesday 2026-07-01 10:00, next "Wednesdays 9am" is 2026-07-08 09:00.
  assert.equal(nextCronTime('0 9 * * 3', at(2026, 7, 1, 10, 0)), at(2026, 7, 8, 9, 0));
  // Exactly AT a match → strictly after → next week.
  assert.equal(nextCronTime('0 9 * * 3', at(2026, 7, 8, 9, 0)), at(2026, 7, 15, 9, 0));
  // Month-restricted pattern jumps to that month.
  assert.equal(nextCronTime('0 0 1 12 *', at(2026, 7, 1, 0, 0)), at(2026, 12, 1, 0, 0));
});

test('hoursToCron: sensible legacy migrations', () => {
  assert.equal(hoursToCron(0), '');
  assert.equal(hoursToCron(12), '0 */12 * * *');
  assert.equal(hoursToCron(24), '0 8 * * *');
  assert.equal(hoursToCron(72), '0 8 */3 * *');
  assert.equal(hoursToCron(168), '0 8 * * 1');
});
