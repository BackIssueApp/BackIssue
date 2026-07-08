import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderPattern, seriesFolderFromPattern, fileStemFromPattern,
  DEFAULT_FOLDER_PATTERN, DEFAULT_FILE_PATTERN,
} from '../src/naming.js';

const batman = { title: 'Batman', publisher: 'DC Comics', year: '2011' };

test('default folder pattern: Publisher/Series (Year)', () => {
  assert.equal(seriesFolderFromPattern(batman, DEFAULT_FOLDER_PATTERN), 'DC Comics/Batman (2011)');
});

test('folder pattern drops an empty publisher segment and an empty year', () => {
  assert.equal(seriesFolderFromPattern({ title: 'Bone', publisher: '', year: '1991' }, DEFAULT_FOLDER_PATTERN), 'Bone (1991)');
  assert.equal(seriesFolderFromPattern({ title: 'Bone', publisher: 'Cartoon Books', year: '' }, DEFAULT_FOLDER_PATTERN), 'Cartoon Books/Bone');
});

test('default file pattern: regular issue → Series VYYYY #NNN', () => {
  assert.equal(fileStemFromPattern(batman, { issue_number: '1' }, DEFAULT_FILE_PATTERN), 'Batman V2011 #001');
});

test('file pattern: empty year drops the dangling V', () => {
  assert.equal(fileStemFromPattern({ title: 'Bone', publisher: '', year: '' }, { issue_number: '3' }, DEFAULT_FILE_PATTERN), 'Bone #003');
  assert.equal(fileStemFromPattern(batman, { issue_number: '12' }, DEFAULT_FILE_PATTERN), 'Batman V2011 #012');
});

test('a {date} token, when added, renders the cover date as "Month YYYY"', () => {
  assert.equal(fileStemFromPattern(batman, { issue_number: '1', cover_date: '2011-09-01' }, '{series} #{issue} ({date})'), 'Batman #001 (September 2011)');
  // empty date drops the ()
  assert.equal(fileStemFromPattern(batman, { issue_number: '1' }, '{series} #{issue} ({date})'), 'Batman #001');
});

test('file pattern: an Annual edition fills {edition} and uses its own number', () => {
  const stem = fileStemFromPattern(batman, { issue_number: '1', title: 'Annual #2' }, DEFAULT_FILE_PATTERN);
  assert.equal(stem, 'Batman V2011 Annual #002');
});

test('{issue} padding is configurable via {issue:N}', () => {
  assert.equal(renderPattern('#{issue:2}', { issue: '7' }), '#07');
  assert.equal(renderPattern('#{issue:5}', { issue: '42' }), '#00042');
  assert.equal(renderPattern('#{issue}', { issue: '9' }), '#009');
});

test('non-numeric issue numbers are kept as-is (not padded)', () => {
  assert.equal(renderPattern('#{issue}', { issue: '½' }), '#½');
});

test('token values are sanitized — illegal chars stripped, no path escape', () => {
  // A slash or ".." inside a value can never create sub-folders or traverse.
  assert.equal(renderPattern('{series}', { series: 'Ka/Zar: ..\\evil' }), 'Ka Zar .. evil');
  assert.equal(seriesFolderFromPattern({ title: 'A/B', publisher: 'X:Y', year: '2000' }, '{publisher}/{series} ({year})'),
    'X Y/A B (2000)');
});

test('custom patterns work end to end', () => {
  assert.equal(seriesFolderFromPattern(batman, '{series}'), 'Batman');
  assert.equal(fileStemFromPattern(batman, { issue_number: '5' }, '{series} {year} {issue}'), 'Batman 2011 005');
});
