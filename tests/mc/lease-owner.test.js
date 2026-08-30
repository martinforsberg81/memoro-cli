/**
 * The way back for a lease whose holder never came back (lease-owner.js),
 * and a refused claim told to the one who holds it (lease-refusal.js).
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
import { refusalText, tellHolder } from '../../src/mc/lease-refusal.js';
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

describe('a refused claim is told to the holder', () => {
  const lease = {
    held: true, holder: 'pm', holder_kind: 'work-area', errand: 'gate round for #10861',
    since: '2026-08-23T08:00:00Z', age_ms: 145 * 60000, owner_pid: 4242, owner_alive: false, orphaned: true,
  };

  it('sends one file with a wake to the holder, naming who asked, for what, how long, and the way out', () => {
    const sent = [];
    const told = tellHolder({
      lease, asker: { name: 'track-1', kind: 'work-area' }, what: '/srv/repo', errand: 'gate round for #485',
      send: (message) => { sent.push(message); return { ok: true, woke: true, file: '/x' }; },
    });
    assert.deepEqual(told, { told: true, woke: true, reason: null, file: '/x' });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].name, 'pm');
    assert.equal(sent[0].wake, true);
    assert.equal(sent[0].sender.name, 'track-1');
    const text = sent[0].message;
    assert.match(text, /CLAIM REFUSED on your account — track-1 asked for \/srv\/repo for “gate round for #485”/u);
    assert.match(text, /held it for 2h 25m for “gate round for #10861”; nothing running under it/u);
    assert.match(text, /pid 4242\) is gone/u);
    assert.match(text, /mc repo release/u);
  });

  it('says what is running under the lease, and names the repository release for a repository lease', () => {
    const text = refusalText({
      lease: { ...lease, orphaned: false, owner_pid: null, repo: '/srv/repo' }, asker: { name: 'x' }, what: '/srv/repo', errand: '',
      running: [{ command: 'npm test', area: 'pm', pid: 9, elapsed: '03:00' }],
    });
    assert.match(text, /running: npm test in pm \(pid 9, 03:00\)/u);
    assert.match(text, /mc repo release \/srv\/repo/u);
    assert.doesNotMatch(text, /is gone/u);
  });

  it('does not tell a shell holder, the asker itself, or nobody — and says which', () => {
    const never = () => { throw new Error('must not send'); };
    assert.match(tellHolder({ lease: { ...lease, holder_kind: 'shell', holder: 'me@host' }, asker: A, what: 'x', send: never }).reason, /shell/u);
    assert.match(tellHolder({ lease: { ...lease, holder: 'alpha' }, asker: A, what: 'x', send: never }).reason, /asker is the holder/u);
    assert.match(tellHolder({ lease: { held: false }, asker: A, what: 'x', send: never }).reason, /nobody/u);
    // A send that fails is reported, never thrown past the refusal.
    assert.equal(tellHolder({ lease, asker: A, what: 'x', send: () => ({ ok: false, reason: 'no-such-area' }) }).reason, 'no-such-area');
    assert.match(tellHolder({ lease, asker: A, what: 'x', send: () => { throw new Error('tmux gone'); } }).reason, /tmux gone/u);
  });
});
