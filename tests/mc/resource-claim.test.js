import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { takeGateLock, releaseGateLock, runningRound } from '../../src/mc/gate-lock.js';
import { readClaim, releaseClaim, takeClaim } from '../../src/mc/resource-claim.js';

it('simultaneous processes get exactly one lane owner, and a killed owner is recoverable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mc-claim-race-'));
  const module = new URL('../../src/mc/gate-lock.js', import.meta.url).href;
  const script = `import {takeGateLock} from ${JSON.stringify(module)};
    process.send('ready');
    process.on('message', () => process.send(takeGateLock({root:${JSON.stringify(root)}, repo:'test', lane:'test'})));`;
  const children = Array.from({ length: 4 }, () => spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] }));
  // A child that dies never answers: its death is the test's failure, not a wait for the ceiling.
  const answer = (child) => Promise.race([
    once(child, 'message').then(([message]) => message),
    once(child, 'exit').then(([code, signal]) => { throw new Error(`a claimant died before it answered (${signal || code})`); }),
  ]);
  try {
    await Promise.all(children.map(answer));
    const answers = children.map(answer);
    children.forEach((child) => child.send('take'));
    const results = await Promise.all(answers);
    assert.equal(results.filter((result) => result.ok).length, 1);
    const winner = children[results.findIndex((result) => result.ok)];
    assert.equal(runningRound({ root, lane: 'test' }).pid, winner.pid);
    const exited = once(winner, 'exit');
    winner.kill('SIGKILL');
    await exited;
    assert.equal(takeGateLock({ root, repo: 'recovered', lane: 'test' }).ok, true);
    assert.equal(runningRound({ root, lane: 'test' }).pid, process.pid);
    releaseGateLock({ root, lane: 'test' });
  } finally {
    await Promise.all(children.map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    }));
    rmSync(root, { recursive: true, force: true });
  }
});

it('cleanup from an old generation cannot remove its successor', () => {
  const root = mkdtempSync(join(tmpdir(), 'mc-claim-owner-'));
  const path = join(root, 'resource');
  try {
    const old = takeClaim(path, { pid: 999999 });
    const next = takeClaim(path, { pid: process.pid }, { alive: (pid) => pid === process.pid });
    assert.equal(next.ok, true);
    assert.equal(releaseClaim(path, old.marker), false);
    assert.equal(readClaim(path).pid, process.pid);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
