/**
 * "One at a time", as a file and a pid.
 *
 * What this replaced was "the suite right": a machine-wide lease with a
 * holder, an errand, a liveness verdict derived from the work board, a
 * `--force` release, an inbox message to whoever held it, a row on the status
 * page, and four verbs of its own (`mc suite run|claim|release|who`). Four
 * hundred lines for one sentence, under a name nobody could say out loud
 * without explaining it — Martin, 2026-08-30: *"Svit-rätten är ett mycket
 * märkligt namn/begrepp… En instans kan köra åt gången. Det löser hela
 * problemet."*
 *
 * The big suites have exactly one door — the gate round, reached by `mc test`
 * and `mc merge` — so the guard sits on that door and nowhere else.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  describeRunning, gateLockPath, releaseGateLock, runningRound, takeGateLock,
} from '../../src/mc/gate-lock.js';

const home = () => mkdtempSync(join(tmpdir(), 'mc-gate-lock-'));
const ALIVE = () => true;
const DEAD = () => false;

describe('taking it', () => {
  it('an empty machine gives it up, and records who has it and for what', () => {
    const root = home();
    try {
      const out = takeGateLock({ repo: 'memoro-cli', pr: 485, root });
      assert.equal(out.ok, true);
      assert.equal(out.took, true);
      const written = JSON.parse(readFileSync(gateLockPath(root), 'utf8'));
      assert.equal(written.pid, process.pid);
      assert.equal(written.repo, 'memoro-cli');
      assert.equal(written.pr, 485);
      assert.ok(written.since);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('a round that is running refuses the next one, and says which round', () => {
    const root = home();
    try {
      writeFileSync(gateLockPath(root), JSON.stringify({ pid: 4242, repo: 'memoro', pr: 11082, since: '2026-08-30T09:00:00.000Z' }));
      const out = takeGateLock({ repo: 'memoro-cli', pr: 485, root, alive: ALIVE });
      assert.equal(out.ok, false);
      assert.equal(out.running.pid, 4242);
      const said = describeRunning(out.running);
      assert.match(said, /pid 4242/u);
      assert.match(said, /memoro #11082/u);
      assert.match(said, /one at a time/u);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  /**
   * There is no expiry, and there must not be one: a gate round is *supposed*
   * to take minutes, so no threshold separates a slow round from a dead one.
   * Asking the operating system whether the pid exists is the only honest
   * question — and it is the same question `mc log --open` asks.
   */
  it('a round whose process is gone is litter, and the next round takes it', () => {
    const root = home();
    try {
      writeFileSync(gateLockPath(root), JSON.stringify({ pid: 4242, repo: 'memoro', pr: 11082 }));
      assert.equal(runningRound({ root, alive: DEAD }), null);
      const out = takeGateLock({ repo: 'memoro-cli', pr: 485, root, alive: DEAD });
      assert.equal(out.ok, true);
      assert.equal(JSON.parse(readFileSync(gateLockPath(root), 'utf8')).pr, 485);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('a file that will not parse is nobody, not a permanent block', () => {
    const root = home();
    try {
      writeFileSync(gateLockPath(root), '{ not json');
      assert.equal(runningRound({ root, alive: ALIVE }), null);
      assert.equal(takeGateLock({ repo: 'x', pr: 1, root }).ok, true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('a lock it cannot write lets the round run anyway', () => {
    // The worst case is the contention it was avoiding. A guard that refuses
    // to measure anything because it could not write a file has made the
    // failure it exists to prevent look mild.
    const out = takeGateLock({ repo: 'x', pr: 1, root: '/proc/definitely/not/writable' });
    assert.equal(out.ok, true);
    assert.equal(out.took, false);
  });
});

describe('giving it back', () => {
  it('removes it when it is ours', () => {
    const root = home();
    try {
      takeGateLock({ repo: 'x', pr: 1, root });
      assert.equal(releaseGateLock({ root }), true);
      assert.equal(existsSync(gateLockPath(root)), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('never removes somebody else\'s', () => {
    const root = home();
    try {
      // A round whose pid was reaped may have had the lock taken over while it
      // was dying. Deleting blindly would then release the round that took it
      // — the one way a lock this simple could do real damage.
      writeFileSync(gateLockPath(root), JSON.stringify({ pid: 4242, repo: 'memoro', pr: 1 }));
      assert.equal(releaseGateLock({ root }), false);
      assert.equal(JSON.parse(readFileSync(gateLockPath(root), 'utf8')).pid, 4242);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('an absent lock is not an error', () => {
    const root = home();
    try { assert.equal(releaseGateLock({ root }), false); } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('what it does not do', () => {
  it('has no force, no holder, no errand, no verbs — the whole surface is two functions', async () => {
    const module = await import('../../src/mc/gate-lock.js');
    assert.deepEqual(Object.keys(module).sort(), [
      'describeRunning', 'gateLockPath', 'releaseGateLock', 'runningRound', 'takeGateLock',
    ]);
  });

  it('blocks nothing but a gate round, and inspects no process but by pid', () => {
    // A person running `npm test` in their own worktree is not asking mc's
    // permission and is not refused it. The old suite right read the process
    // table to say what was running under it; this asks one question about one
    // pid and nothing else.
    const source = readFileSync(new URL('../../src/mc/gate-lock.js', import.meta.url), 'utf8');
    assert.equal(/spawn|execFile|execSync|processesIn/u.test(source), false, 'no process table is read');
    assert.ok(/process\.kill\(pid, 0\)/u.test(source), 'the liveness question is the one-line one');
  });

  it('cannot be taken from a live round at all — there is no override', () => {
    const root = home();
    try {
      writeFileSync(gateLockPath(root), JSON.stringify({ pid: 4242, repo: 'memoro', pr: 1 }));
      // Every option the function accepts, and none of them yields it.
      for (const options of [{}, { force: true }, { holder: 'somebody' }, { errand: 'urgent' }]) {
        assert.equal(takeGateLock({ repo: 'x', pr: 2, root, alive: ALIVE, ...options }).ok, false);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
