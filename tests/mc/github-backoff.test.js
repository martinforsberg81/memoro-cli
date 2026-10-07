import { test } from 'node:test';
import assert from 'node:assert/strict';

import { backoffMs, diagnoseGithub } from '../../src/mc/github-backoff.js';

test('the wait after each failure in a row is 1, 2, 5, then 15 minutes for good', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 9].map((n) => backoffMs(n) / 60_000), [1, 2, 5, 15, 15, 15]);
});

/**
 * A locked keychain hangs `security show-keychain-info` (the runner stops it
 * after two seconds, which is a failed call); an open one answers at once, and
 * then `gh auth status` failing is the token.
 */
test('the diagnosis tells a locked keychain from a bad token', () => {
  const asked = [];
  const runWith = (answers) => (cmd, args) => { asked.push([cmd, ...args]); return { ok: answers[cmd], stdout: '', stderr: '' }; };
  assert.deepEqual(diagnoseGithub({ platform: 'darwin', run: runWith({ security: false, gh: true }) }), { cause: 'keychain' });
  assert.deepEqual(asked, [['security', 'show-keychain-info']], 'a locked keychain is not asked through gh as well');
  assert.deepEqual(diagnoseGithub({ platform: 'darwin', run: runWith({ security: true, gh: false }) }), { cause: 'token' });
  assert.deepEqual(diagnoseGithub({ platform: 'darwin', run: runWith({ security: true, gh: true }) }), { cause: null });
  // No keychain to ask off a Mac: only gh.
  asked.length = 0;
  assert.deepEqual(diagnoseGithub({ platform: 'linux', run: runWith({ gh: false }) }), { cause: 'token' });
  assert.deepEqual(asked, [['gh', 'auth', 'status']]);
});
