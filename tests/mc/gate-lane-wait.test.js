/**
 * A docs gate waits for its repository's lane (`gate-lane-wait.js`): waits while
 * anybody holds it and holds it for the pid it is given.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { releaseGateLock, runningRound, takeGateLock } from '../../src/mc/gate-lock.js';
import { takeLane } from '../../src/mc/gate-lane-wait.js';

function home() {
  const root = mkdtempSync(join(tmpdir(), 'mc-gate-lane-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe('takeLane', () => {
  it('a free lane is taken at once for the pid it is given, and nothing is said', async () => {
    const fx = home();
    try {
      const said = [];
      const polls = await takeLane({ lane: 'memoro', pid: process.pid, repo: 'memoro', mode: 'docs-gate', root: fx.root, write: (l) => said.push(l), sleep: async () => {} });
      assert.equal(polls, 0);
      assert.deepEqual(said, []);
      const held = runningRound({ root: fx.root, lane: 'memoro' });
      assert.deepEqual([held.pid, held.repo, held.mode], [process.pid, 'memoro', 'docs-gate']);
    } finally { fx.cleanup(); }
  });

  it('a held lane is waited for, said once, and taken when it is given back', async () => {
    const fx = home();
    try {
      assert.equal(takeGateLock({ repo: 'memoro', pr: 7, mode: 'merge', root: fx.root, lane: 'memoro' }).ok, true);
      const said = [];
      let slept = 0;
      const polls = await takeLane({
        lane: 'memoro', pid: 1, repo: 'memoro', root: fx.root, write: (l) => said.push(l),
        // The round ends after two polls; pid 1 is alive on every machine this runs on.
        sleep: async () => { slept += 1; if (slept === 2) releaseGateLock({ root: fx.root, lane: 'memoro' }); },
      });
      assert.equal(polls, 2);
      assert.equal(said.length, 2);
      assert.match(said[0], /^mc gate: waiting — another gate round is running on this machine in the memoro lane \(pid \d+, memoro #7/u);
      assert.equal(said[1], 'mc gate: the memoro lane is free — starting\n');
      assert.equal(runningRound({ root: fx.root, lane: 'memoro' }).pid, 1);
    } finally { fx.cleanup(); }
  });

  it('another repository is no reason to wait', async () => {
    const fx = home();
    try {
      takeGateLock({ repo: 'memoro', mode: 'merge', root: fx.root, lane: 'memoro' });
      assert.equal(await takeLane({ lane: 'memoro-cli', pid: process.pid, repo: 'memoro-cli', root: fx.root, sleep: async () => { throw new Error('waited'); } }), 0);
    } finally { fx.cleanup(); }
  });
});
