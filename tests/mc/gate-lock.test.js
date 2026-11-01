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
  BUILD_LANE, describeRunning, gateLockPath, noteGatePhase, releaseGateLock, runningRound, runningRounds, takeGateLock,
} from '../../src/mc/gate-lock.js';

const home = () => mkdtempSync(join(tmpdir(), 'mc-gate-lock-'));
const lane = 'memoro';
const ALIVE = () => true;
const DEAD = () => false;

describe('taking it', () => {
  it('an empty machine gives it up, and records who has it and for what', () => {
    const root = home();
    try {
      const out = takeGateLock({ repo: 'memoro-cli', pr: 485, root, lane });
      assert.equal(out.ok, true);
      assert.equal(out.took, true);
      const written = JSON.parse(readFileSync(gateLockPath(root, lane), 'utf8'));
      assert.equal(written.pid, process.pid);
      assert.equal(written.repo, 'memoro-cli');
      assert.equal(written.pr, 485);
      assert.ok(written.since);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('a round that is running refuses the next one, and says which round', () => {
    const root = home();
    try {
      writeFileSync(gateLockPath(root, lane), JSON.stringify({ pid: 4242, repo: 'memoro', pr: 11082, since: '2026-08-30T09:00:00.000Z' }));
      const out = takeGateLock({ repo: 'memoro-cli', pr: 485, root, alive: ALIVE, lane });
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
      writeFileSync(gateLockPath(root, lane), JSON.stringify({ pid: 4242, repo: 'memoro', pr: 11082 }));
      assert.equal(runningRound({ root, alive: DEAD, lane }), null);
      const out = takeGateLock({ repo: 'memoro-cli', pr: 485, root, alive: DEAD, lane });
      assert.equal(out.ok, true);
      assert.equal(JSON.parse(readFileSync(gateLockPath(root, lane), 'utf8')).pr, 485);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('a file that will not parse is nobody, not a permanent block', () => {
    const root = home();
    try {
      writeFileSync(gateLockPath(root, lane), '{ not json');
      assert.equal(runningRound({ root, alive: ALIVE, lane }), null);
      assert.equal(takeGateLock({ repo: 'x', pr: 1, root, lane }).ok, true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('records what kind of round it is', () => {
    const root = home();
    try {
      const out = takeGateLock({ repo: 'memoro-cli', pr: 485, mode: 'check', root, lane });
      assert.equal(out.ok, true);
      assert.equal(JSON.parse(readFileSync(gateLockPath(root, lane), 'utf8')).mode, 'check');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('a lock it cannot write refuses the run', () => {
    const root = home();
    try {
      const file = join(root, 'not-a-directory');
      writeFileSync(file, 'x');
      const out = takeGateLock({ repo: 'x', pr: 1, root: file, lane });
      assert.equal(out.ok, false);
      assert.match(out.error, /cannot reserve/u);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('one round per repository', () => {
  it('the lane is the repository, in its own file, and a lane must name one', () => {
    assert.equal(gateLockPath('/h', 'memoro-cli'), join('/h', 'gate-running-memoro-cli.json'));
    assert.equal(gateLockPath('/h', 'memoro'), join('/h', 'gate-running-memoro.json'));
    assert.equal(BUILD_LANE, 'memoro');
    assert.throws(() => gateLockPath('/h'), /repository's name/u);
    assert.throws(() => gateLockPath('/h', '../x'), /repository's name/u);
  });

  it('two repositories hold their lanes at once, and each is read in its own', () => {
    const root = home();
    try {
      assert.equal(takeGateLock({ repo: 'memoro', pr: 1, root, alive: ALIVE, lane: 'memoro' }).ok, true);
      assert.equal(takeGateLock({ repo: 'memoro-cli', pr: 2, root, alive: ALIVE, lane: 'memoro-cli' }).ok, true);
      const rounds = runningRounds({ root, alive: ALIVE });
      assert.deepEqual(Object.keys(rounds).sort(), ['memoro', 'memoro-cli']);
      assert.equal(rounds.memoro.pr, 1);
      assert.equal(rounds['memoro-cli'].lane, 'memoro-cli');
      releaseGateLock({ root, lane: 'memoro-cli' });
      assert.equal(runningRounds({ root, alive: ALIVE })['memoro-cli'] ?? null, null);
      assert.equal(runningRounds({ root, alive: ALIVE }).memoro.pr, 1, 'giving one back left the other');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('with no home there are no rounds', () => {
    assert.deepEqual(runningRounds({ root: join(tmpdir(), 'mc-gate-lock-no-such-home') }), {});
  });

  it('a second round of one repository is refused while one runs, and the refusal names the lane', () => {
    const root = home();
    try {
      writeFileSync(gateLockPath(root, 'memoro-cli'), JSON.stringify({ pid: 4242, repo: 'memoro-cli', pr: 7 }));
      const out = takeGateLock({ repo: 'memoro-cli', pr: 8, root, alive: ALIVE, lane: 'memoro-cli' });
      assert.equal(out.ok, false);
      assert.equal(out.running.pr, 7);
      assert.match(describeRunning(out.running), /in the memoro-cli lane \(pid 4242, memoro-cli #7\)/u);
      assert.equal(takeGateLock({ repo: 'memoro', pr: 9, root, alive: ALIVE, lane: 'memoro' }).ok, true, 'another repository is free');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('a phase is written to its own lane\'s round', () => {
    const root = home();
    try {
      takeGateLock({ repo: 'memoro-cli', pr: 2, root, alive: ALIVE, lane: 'memoro-cli' });
      noteGatePhase({ root, message: 'the suite', lane: 'memoro-cli' });
      assert.match(runningRounds({ root, alive: ALIVE })['memoro-cli'].phase || '', /the suite/u);
      assert.equal(existsSync(gateLockPath(root, 'memoro')), false, 'nothing written to another lane');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('narrating what it is doing', () => {
  it('rewrites phase and phase_at, and keeps the fields already there', () => {
    const root = home();
    try {
      takeGateLock({ repo: 'memoro-cli', pr: 485, root, lane });
      const before = JSON.parse(readFileSync(gateLockPath(root, lane), 'utf8'));
      const later = new Date(Date.parse(before.since) + 5000);
      const took = noteGatePhase({ root, message: 'running the suite', now: later, lane });
      assert.equal(took, true);
      const after = JSON.parse(readFileSync(gateLockPath(root, lane), 'utf8'));
      assert.equal(after.phase, 'running the suite');
      assert.equal(after.phase_at, later.toISOString());
      assert.equal(after.pid, before.pid);
      assert.equal(after.repo, before.repo);
      assert.equal(after.pr, before.pr);
      assert.equal(after.since, before.since);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('never writes into a lock another pid holds', () => {
    const root = home();
    try {
      writeFileSync(gateLockPath(root, lane), JSON.stringify({ pid: 4242, repo: 'memoro', pr: 1, since: '2026-09-12T09:00:00.000Z' }));
      assert.equal(noteGatePhase({ root, message: 'running the suite', lane }), false);
      assert.equal(JSON.parse(readFileSync(gateLockPath(root, lane), 'utf8')).phase, undefined);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('with no lock at all, there is nothing to note', () => {
    const root = home();
    try { assert.equal(noteGatePhase({ root, message: 'running the suite', lane }), false); } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('giving it back', () => {
  it('removes it when it is ours', () => {
    const root = home();
    try {
      takeGateLock({ repo: 'x', pr: 1, root, lane });
      assert.equal(releaseGateLock({ root, lane }), true);
      assert.equal(existsSync(gateLockPath(root, lane)), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('never removes somebody else\'s', () => {
    const root = home();
    try {
      // A round whose pid was reaped may have had the lock taken over while it
      // was dying. Deleting blindly would then release the round that took it
      // — the one way a lock this simple could do real damage.
      writeFileSync(gateLockPath(root, lane), JSON.stringify({ pid: 4242, repo: 'memoro', pr: 1 }));
      assert.equal(releaseGateLock({ root, lane }), false);
      assert.equal(JSON.parse(readFileSync(gateLockPath(root, lane), 'utf8')).pid, 4242);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('an absent lock is not an error', () => {
    const root = home();
    try { assert.equal(releaseGateLock({ root, lane }), false); } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('what it does not do', () => {
  it('has no force, no holder, no errand, no verbs — the whole surface is the round and its phase', async () => {
    const module = await import('../../src/mc/gate-lock.js');
    assert.deepEqual(Object.keys(module).sort(), [
      'BUILD_LANE', 'describeRunning', 'gateLockPath', 'noteGatePhase', 'releaseGateLock', 'runningRound', 'runningRounds', 'takeGateLock',
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
      writeFileSync(gateLockPath(root, lane), JSON.stringify({ pid: 4242, repo: 'memoro', pr: 1 }));
      // Every option the function accepts, and none of them yields it.
      for (const options of [{}, { force: true }, { holder: 'somebody' }, { errand: 'urgent' }]) {
        assert.equal(takeGateLock({ repo: 'x', pr: 2, root, alive: ALIVE, lane, ...options }).ok, false);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
