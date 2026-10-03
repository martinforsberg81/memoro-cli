import assert from 'node:assert/strict';
import test from 'node:test';

import { KEYCHAIN_TIMEOUT_MS, run } from '../../src/lib/keychain.js';

// A keychain tool that does not answer — `security` behind a locked keychain's
// modal, with nobody there. It must be stopped, and the error must say so. The
// fake gives up by itself after 8 s, so without the limit the test fails on
// its 5 s budget instead of holding the suite open.
const HANGS = ['-e', 'setTimeout(() => {}, 8000)'];

test('a keychain tool that never answers is stopped at the timeout', { timeout: 5000 }, async () => {
  const started = Date.now();
  await assert.rejects(
    run(process.execPath, HANGS, null, { timeoutMs: 200 }),
    (err) => {
      assert.equal(err.code, 'ETIMEDOUT');
      assert.match(err.message, /did not answer in 200 ms and was stopped/);
      assert.match(err.message, /security unlock-keychain/);
      return true;
    },
  );
  assert.ok(Date.now() - started < 5000, 'returned well before the test budget');
});

test('a keychain tool that answers in time resolves as before', async () => {
  const { stdout } = await run(process.execPath, ['-e', 'process.stdout.write("ok")'], null, { timeoutMs: 10_000 });
  assert.equal(stdout, 'ok');
});

test('the default gives a person at the machine time to answer the modal', () => {
  assert.equal(KEYCHAIN_TIMEOUT_MS, 30_000);
});
