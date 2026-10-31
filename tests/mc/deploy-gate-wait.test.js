/**
 * A deploy goes when the round in flight is done. A session's gate is no round.
 */
import assert from 'node:assert/strict';
import { it } from 'node:test';

import { holdHeavyLane, waitForGate } from '../../src/mc/commands/deploy.js';

const quiet = { write: () => {} };
const job = { root: '/nowhere', lockRoot: '/nowhere' };

it('session gates in both lanes are not waited for', async () => {
  const gate = { pid: 2, repo: 'memoro.git', mode: 'session-gate' };
  await waitForGate(job, {
    stdout: quiet, readMerger: () => null,
    runningRounds: () => ({ heavy: gate, light: { ...gate, repo: 'memoro-cli.git' } }),
    sleep: async () => { throw new Error('waited'); },
  });
});

it('the merge round in flight is waited for, and then the deploy goes', async () => {
  let reads = 0;
  const said = [];
  await waitForGate(job, {
    stdout: { write: (line) => said.push(line) }, readMerger: () => ({ pid: 1 }),
    runningRounds: () => { reads += 1; return { heavy: reads < 3 ? { pid: 3, repo: 'memoro', pr: 7, mode: 'merge' } : { pid: 4, mode: 'session-gate' }, light: null }; },
    sleep: async () => {},
  });
  assert.equal(reads, 3);
  assert.match(said[0], /gate round of memoro #7/u);
  assert.match(said[1], /the gate is free/u);
});

it('an old session gate on the heavy lock is polled, not spun on', async () => {
  let takes = 0;
  let sleeps = 0;
  const took = await holdHeavyLane(job, {
    stdout: quiet, readMerger: () => null, runningRounds: () => ({}), sleep: async () => { sleeps += 1; },
    takeGateLock: () => { takes += 1; return takes < 2 ? { ok: false, running: { pid: 2 } } : { ok: true, took: true }; },
  });
  assert.equal(took, true);
  assert.equal(sleeps, 1);
});
