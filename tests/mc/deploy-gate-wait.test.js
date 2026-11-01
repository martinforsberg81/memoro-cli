/**
 * A deploy goes when the round in flight is done.
 */
import assert from 'node:assert/strict';
import { it } from 'node:test';

import { holdBuildLane, waitForGate } from '../../src/mc/commands/deploy.js';

const quiet = { write: () => {} };
const job = { root: '/nowhere', lockRoot: '/nowhere' };

it('the merge round in flight is waited for, and then the deploy goes', async () => {
  let reads = 0;
  const said = [];
  await waitForGate(job, {
    stdout: { write: (line) => said.push(line) }, readMerger: () => ({ pid: 1 }),
    runningRounds: () => { reads += 1; return { memoro: reads < 3 ? { pid: 3, repo: 'memoro', pr: 7, mode: 'merge' } : null }; },
    sleep: async () => {},
  });
  assert.equal(reads, 3);
  assert.match(said[0], /gate round of memoro #7/u);
  assert.match(said[1], /the gate is free/u);
});

it('a round that took the lane first is polled, not spun on', async () => {
  let takes = 0;
  let sleeps = 0;
  const took = await holdBuildLane(job, {
    stdout: quiet, readMerger: () => null, runningRounds: () => ({}), sleep: async () => { sleeps += 1; },
    takeGateLock: () => { takes += 1; return takes < 2 ? { ok: false, running: { pid: 2 } } : { ok: true, took: true }; },
  });
  assert.equal(took, true);
  assert.equal(sleeps, 1);
});
