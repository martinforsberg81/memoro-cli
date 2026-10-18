/**
 * A gate started while a deploy holds the heavy lane waits for it
 * (`await-deploy.js`): only a deploy's hold, said once, and gone when its pid is.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { awaitDeploy, DEPLOY_MODE, deployHolding } from '../../src/mc/await-deploy.js';
import { takeGateLock } from '../../src/mc/gate-lock.js';

describe('a gate behind a deploy', () => {
  it('deployHolding is the heavy lock only when a live deployer wrote it', () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-await-deploy-'));
    try {
      assert.equal(deployHolding({ root }), null);
      takeGateLock({ repo: 'memoro', pr: 1, mode: 'merge', root, lane: 'heavy' });
      assert.equal(deployHolding({ root }), null, 'a merge round is not waited for');
      rmSync(join(root, 'gate-running.json'));
      takeGateLock({ repo: 'deploy', mode: DEPLOY_MODE, root, lane: 'heavy' });
      assert.equal(deployHolding({ root })?.pid, process.pid);
      assert.equal(deployHolding({ root, alive: () => false }), null, 'a dead deployer holds nothing');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('awaitDeploy polls until the hold is gone and says so once each way', async () => {
    let reads = 0;
    const lines = [];
    const polls = await awaitDeploy({
      holding: () => (reads++ < 3 ? { pid: 5, since: '2026-10-18T16:00:00Z' } : null),
      sleep: async () => {},
      write: (line) => lines.push(line),
    });
    assert.equal(polls, 3);
    assert.deepEqual(lines, [
      'mc gate: waiting for the deploy (pid 5, since 2026-10-18T16:00:00Z) — the tests start when it is done\n',
      'mc gate: the deploy is done — starting\n',
    ]);
    assert.equal(await awaitDeploy({ holding: () => null, sleep: async () => {}, write: (line) => lines.push(line) }), 0);
    assert.equal(lines.length, 2, 'nothing said when there was nothing to wait for');
  });
});
