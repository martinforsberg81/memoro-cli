/**
 * The way back for a lease whose holder never came back (lease-owner.js),
 * The refusal itself is the asker's sentence now: the file-and-knock that
 * also told the holder went with the inbox channel it was carried on.
 *
 * The incident: a gate round killed by its own shell's timeout, the suite
 * right held for 2h 25m with nothing running, a track waiting twenty minutes
 * and writing a letter, and the board saying so to nobody (2026-08-23).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { orphanLine, ownerState, processAlive } from '../../src/mc/lease-owner.js';
import { claimLease, leaseLogPath, readLease, releaseLease } from '../../src/mc/repo-lease.js';

const A = { name: 'alpha', kind: 'work-area' };
const B = { name: 'beta', kind: 'work-area' };
const home = () => mkdtempSync(join(tmpdir(), 'mc-lease-owner-'));

/** A kernel that knows exactly which pids exist, and one it will not let us signal. */
const kernelWith = (alive, { foreign = [] } = {}) => (pid) => {
  if (foreign.includes(pid)) { const e = new Error('EPERM'); e.code = 'EPERM'; throw e; }
  if (!alive.includes(pid)) { const e = new Error('ESRCH'); e.code = 'ESRCH'; throw e; }
};

describe('a lease knows whether the process that took it is still there', () => {
  it('asks the kernel, and reads EPERM as alive — the one false answer that matters is "dead"', () => {
    const kill = kernelWith([100], { foreign: [200] });
    assert.equal(processAlive(100, { kill }), true);
    assert.equal(processAlive(200, { kill }), true, 'somebody else\'s process is still a process');
    assert.equal(processAlive(300, { kill }), false);
    assert.equal(processAlive(null, { kill }), null, 'no pid, no answer');
    assert.equal(processAlive(0, { kill }), null);
    // The real kernel, on the one pid that is certainly alive.
    assert.equal(processAlive(process.pid), true);
  });

  it('a lease without a pid is a hold by hand and is never orphaned', () => {
    assert.deepEqual(ownerState({}), { owner_pid: null, owner_alive: null, orphaned: false });
    assert.deepEqual(ownerState({ owner_pid: 'x' }), { owner_pid: null, owner_alive: null, orphaned: false });
    assert.equal(orphanLine({ held: true, orphaned: false }), null);
    assert.match(orphanLine({ held: true, orphaned: true, owner_pid: 4242 }), /pid 4242.*gone.*next claim takes it/u);
  });
});

describe('the repository lease, the same way', () => {
  it('records the pid, reports the orphan, and is reaped by the next claim', () => {
    const root = home();
    const repoPath = '/srv/repo';
    try {
      claimLease({ repoPath, errand: 'gate round for #2', holder: A, ownerPid: 777, root, kill: kernelWith([777]) });
      assert.equal(readLease(repoPath, { root, kill: kernelWith([777]) }).orphaned, false);
      assert.equal(claimLease({ repoPath, errand: 'x', holder: B, root, kill: kernelWith([777]) }).ok, false);
      const orphan = readLease(repoPath, { root, kill: kernelWith([]) });
      assert.equal(orphan.orphaned, true);
      assert.equal(orphan.owner_pid, 777);
      const next = claimLease({ repoPath, errand: 'x', holder: B, root, kill: kernelWith([]) });
      assert.equal(next.ok, true);
      assert.equal(next.reaped.holder, 'alpha');
      assert.match(readFileSync(leaseLogPath(root), 'utf8'), /reap {5}\/srv\/repo {2}by=beta {2}was=alpha {2}pid=777 gone/u);
      // And release of an orphan by a stranger is a reap, not a refusal.
      claimLease({ repoPath: '/srv/other', errand: 'y', holder: A, ownerPid: 778, root, kill: kernelWith([778]) });
      const cleared = releaseLease({ repoPath: '/srv/other', holder: B, root, kill: kernelWith([]) });
      assert.equal(cleared.reaped, true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
