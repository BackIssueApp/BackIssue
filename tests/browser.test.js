import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as browser from '../src/browser.js';

test('browser module exposes expected API', () => {
  for (const fn of ['launchContext', 'newPage', 'gotoPolite', 'isLoggedIn', 'closeContext', 'isChallenged', 'waitForChallengeClear']) {
    assert.equal(typeof browser[fn], 'function', `${fn} should be a function`);
  }
});
