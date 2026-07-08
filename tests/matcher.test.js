import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractYear, normalizeTitle, scoreMatch, normalizeNumber, matchIssueNumber } from '../src/matcher.js';

test('normalizeTitle strips year, volume, leading the, punctuation', () => {
  assert.equal(normalizeTitle('The Amazing Spider-Man (1963)'), 'amazing spider man');
  assert.equal(normalizeTitle('Invincible Vol. 2'), 'invincible');
  assert.equal(normalizeTitle('Blade: Red Band'), 'blade red band');
});

test('extractYear finds a 4-digit year', () => {
  assert.equal(extractYear('Invincible (2003)'), '2003');
  assert.equal(extractYear('Invincible (2005-)'), '2005');
  assert.equal(extractYear('Saga'), null);
});

test('scoreMatch: name+year => high, name only => medium, partial => low, else none', () => {
  assert.equal(scoreMatch({ name: 'Invincible', year: '2003' }, 'Invincible (2003)').confidence, 'high');
  assert.equal(scoreMatch({ name: 'Invincible', year: '2003' }, 'Invincible (2005-)').confidence, 'medium');
  assert.equal(scoreMatch({ name: 'Invincible', year: null }, 'Invincible').confidence, 'medium');
  assert.equal(scoreMatch({ name: 'Invincible', year: '2003' }, 'Invincible Universe').confidence, 'low');
  assert.equal(scoreMatch({ name: 'Batman', year: '2025' }, 'Superman (2025)').confidence, 'none');
});

test('normalizeNumber strips hash, leading zeros, trailing .0', () => {
  assert.equal(normalizeNumber('#4'), '4');
  assert.equal(normalizeNumber('004'), '4');
  assert.equal(normalizeNumber('4.00'), '4');
  assert.equal(normalizeNumber('4.1'), '4.1');
  assert.equal(normalizeNumber('Annual 1'), 'annual 1');
});

test('normalizeNumber maps fractional/half issues to a decimal', () => {
  assert.equal(normalizeNumber('½'), '0.5');
  assert.equal(normalizeNumber('1/2'), '0.5');
  assert.equal(normalizeNumber('.5'), '0.5');
  assert.equal(normalizeNumber('000.5'), '0.5');
  assert.equal(normalizeNumber('¼'), '0.25');
  assert.equal(normalizeNumber('#½'), '0.5');
});

test('matchIssueNumber finds the issue by normalized number', () => {
  const issues = [{ id: 1, issue_number: '004' }, { id: 2, issue_number: '5' }];
  assert.equal(matchIssueNumber(issues, '4').id, 1);
  assert.equal(matchIssueNumber(issues, '#5').id, 2);
  assert.equal(matchIssueNumber(issues, '6'), null);
});
