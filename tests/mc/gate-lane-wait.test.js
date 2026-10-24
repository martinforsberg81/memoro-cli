/**
 * A session's `mc gate` takes the gate lane for its shell (`gate-lane-wait.js`):
 * waits while anybody holds it, holds it for the pid it is given, gives it back
 * only when that pid still holds it.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { releaseGateLock, runningRound, takeGateLock } from '../../src/mc/gate-lock.js';
import { SESSION_GATE_MODE, takeLane } from '../../src/mc/gate-lane-wait.js';

const SCRIPT = fileURLToPath(new URL('../../src/mc/gate-lane-wait.js', import.meta.url));

function home() {
  const root = mkdtempSync(join(tmpdir(), 'mc-gate-lane-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe('takeLane', () => {
  it('a free lane is taken at once for the pid it is given, and nothing is said', async () => {
    const fx = home();
    try {
      const said = [];
      const polls = await takeLane({ lane: 'heavy', pid: process.pid, repo: 'memoro', root: fx.root, write: (l) => said.push(l), sleep: async () => {} });
      assert.equal(polls, 0);
      assert.deepEqual(said, []);
      const held = runningRound({ root: fx.root, lane: 'heavy' });
      assert.deepEqual([held.pid, held.repo, held.mode], [process.pid, 'memoro', SESSION_GATE_MODE]);
    } finally { fx.cleanup(); }
  });

  it('a held lane is waited for, said once, and taken when it is given back', async () => {
    const fx = home();
    try {
      // The merger's round holds the heavy lane, as this process.
      assert.equal(takeGateLock({ repo: 'memoro', pr: 7, mode: 'merge', root: fx.root, lane: 'heavy' }).ok, true);
      const said = [];
      let slept = 0;
      const polls = await takeLane({
        lane: 'heavy', pid: 1, repo: 'memoro', root: fx.root, write: (l) => said.push(l),
        // The round ends after two polls; pid 1 is alive on every machine this runs on.
        sleep: async () => { slept += 1; if (slept === 2) releaseGateLock({ root: fx.root, lane: 'heavy' }); },
      });
      assert.equal(polls, 2);
      assert.equal(said.length, 2);
      assert.match(said[0], /^mc gate: waiting for the merge round \(pid \d+, since [^)]+\) in the heavy lane — the tests start when it is done\n$/u);
      assert.equal(said[1], 'mc gate: the heavy lane is free — starting\n');
      assert.equal(runningRound({ root: fx.root, lane: 'heavy' }).pid, 1);
    } finally { fx.cleanup(); }
  });

  it('the other lane is no reason to wait', async () => {
    const fx = home();
    try {
      takeGateLock({ repo: 'memoro', mode: 'merge', root: fx.root, lane: 'heavy' });
      assert.equal(await takeLane({ lane: 'light', pid: process.pid, repo: 'memoro-cli', root: fx.root, sleep: async () => { throw new Error('waited'); } }), 0);
    } finally { fx.cleanup(); }
  });
});

describe('gate-lane-wait.js, as the gate\'s shell runs it', () => {
  it('take holds the lane for the named pid; release gives back only that pid\'s', () => {
    const fx = home();
    try {
      const env = { ...process.env, MC_HOME: fx.root };
      execFileSync(process.execPath, [SCRIPT, 'take', 'light', String(process.pid), 'memoro-cli'], { env });
      assert.equal(runningRound({ root: fx.root, lane: 'light' }).pid, process.pid);
      execFileSync(process.execPath, [SCRIPT, 'release', 'light', '1'], { env });
      assert.equal(runningRound({ root: fx.root, lane: 'light' }).pid, process.pid);
      execFileSync(process.execPath, [SCRIPT, 'release', 'light', String(process.pid)], { env });
      assert.equal(runningRound({ root: fx.root, lane: 'light' }), null);
    } finally { fx.cleanup(); }
  });
});
