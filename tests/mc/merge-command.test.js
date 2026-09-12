/**
 * `mc merge <repo> <pr>` — what becomes of a round that did not land.
 *
 * The round itself is `tests/mc/repo-merge.test.js`; this drives the verb over
 * a fake one, because what is asserted here is the half the round knows
 * nothing about: a refusal the runner's merge lane can act on is written to
 * `~/mc/runner/merges.json` and said in one line, and a machine with no runner
 * on it is left exactly as it was — the whole point of the queue is that
 * nobody has to type the command again, and a queue nothing drains would be a
 * promise mc could not keep.
 *
 * Since step-lands-itself, the same verb also waits out a busy gate or a held
 * lease itself (`waitTurn`, in `commands/repo.js`) instead of handing `busy`
 * and `lease` to the lane, and stops at a plan-trespass before either. Every
 * wait test below gives its own `sleep`/`now`/`runningRound`/`readLease` —
 * without them the loop polls the real filesystem against a frozen clock and
 * never reaches its own bound. `planBoundary`'s own comparison rules are
 * `tests/mc/merge-boundary.test.js`'s; what is asserted here is only that
 * `gate()` reacts to what it returns.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { gate } from '../../src/mc/commands/repo.js';
import { mergesPath, parseQueue } from '../../src/mc/merge-queue.js';
import { stepForMerge } from '../../src/mc/merge-step.js';
import { registerPath } from '../../src/mc/register.js';

let root = null;
let home = null;
let priorHome = null;

/** A round that stopped, in the shape `runMergeRound` returns one. */
function stopped(stoppedAt, reason) {
  return {
    repo: '/repos/memoro-cli',
    pr: { number: 671, base: 'main' },
    batch: null,
    ok: false,
    merged: false,
    merge_commit: null,
    merged_into: null,
    stopped_at: stoppedAt,
    reason,
    gate: {
      ok: false,
      stopped_at: stoppedAt,
      reason,
      pr: { number: 671, head: 'merge-queue', base: 'main' },
      candidate: { red: [], totals: { tests: 10 } },
      extra_gates: [],
    },
    deploy: null,
  };
}

function landed() {
  return {
    ...stopped(null, null),
    ok: true,
    merged: true,
    merge_commit: 'abc1234def',
    merged_into: 'main',
    default_branch: 'main',
    off_default: false,
    gate: { ...stopped(null, null).gate, ok: true, stopped_at: null, reason: null },
  };
}

/**
 * Everything `gate` would otherwise reach the machine through. A test that
 * never has to wait needs none of `overrides`; one that does supplies its own
 * `runningRound`/`readLease`/`sleep`/`now`/`alive`/`gh` — real ones would poll
 * this process's own, empty `MC_HOME` forever or hit the network.
 */
function deps(report, { runner = 'alive', overrides = {} } = {}) {
  const out = { out: '', err: '' };
  if (runner !== 'none') {
    // A live pid is this process's own; a dead one is a runner that was killed
    // and left its file behind, which `readRunner` answers as not alive.
    const pid = runner === 'alive' ? process.pid : 2 ** 22 - 1;
    mkdirSync(join(root, 'runner'), { recursive: true });
    writeFileSync(join(root, 'runner', 'runner.json'), JSON.stringify({ pid, started: '2026-09-06T12:00:00Z' }));
  }
  return {
    out,
    io: {
      stdout: { write: (text) => { out.out += text; } },
      stderr: { write: (text) => { out.err += text; } },
      root,
      resolveRepo: async () => '/repos/memoro-cli',
      mergeRound: async () => report,
      now: () => new Date('2026-09-06T18:00:00Z'),
      ...overrides,
    },
  };
}

const queue = () => parseQueue(existsSync(mergesPath(root)) ? readFileSync(mergesPath(root), 'utf8') : null);

/** No lock, no lease, `gh` unreachable — `planBoundary` fails open at once. */
const FREE = { runningRound: () => null, readLease: () => ({ held: false, holder: null }), gh: () => ({ status: 1, stdout: '' }) };

describe('a red mc merge is the caller\'s — nothing is queued for a lane (ruling 21)', () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mc-merge-red-'));
    home = mkdtempSync(join(tmpdir(), 'mc-merge-home-'));
    priorHome = process.env.MC_HOME;
    process.env.MC_HOME = home;
  });

  afterEach(() => {
    if (priorHome === undefined) delete process.env.MC_HOME; else process.env.MC_HOME = priorHome;
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it('exits 1 with the gate\'s own lines, writes no queue file and says nothing about a runner', async () => {
    const { out, io } = deps(stopped('red', '1 test red: new thing › broke'), { overrides: FREE });
    const code = await gate({ repo: 'memoro-cli', pr: 671 }, io);
    assert.equal(code, 1);
    assert.equal(existsSync(mergesPath(root)), false, 'no queue file is even made');
    assert.match(out.out, /^mc: nothing was merged$/mu);
    assert.doesNotMatch(out.out, /queued/u);
    assert.doesNotMatch(out.err, /no runner/u);
  });

  it('a stop the round could not name is the same: exit 1, nothing queued', async () => {
    const { out, io } = deps(stopped('pr', 'gh could not read the pull request'), { overrides: FREE });
    const code = await gate({ repo: 'memoro-cli', pr: 671 }, io);
    assert.equal(code, 1);
    assert.equal(existsSync(mergesPath(root)), false);
    assert.doesNotMatch(out.out, /queued/u);
  });

  it('a landed round touches no queue, says nothing new, and never waited', async () => {
    const { out, io } = deps(landed(), { overrides: FREE });
    const code = await gate({ repo: 'memoro-cli', pr: 671 }, io);
    assert.equal(code, 0);
    assert.equal(existsSync(mergesPath(root)), false, 'the file is not even made');
    assert.doesNotMatch(out.out, /queued/u);
    assert.doesNotMatch(out.err, /waiting|waited/u, 'a free machine leaves no trace of a wait it never took');
  });

  it('--json is the round\'s own report, with no queue fields', async () => {
    const { out, io } = deps(stopped('red', '1 test red: new thing › broke'), { overrides: FREE });
    const code = await gate({ repo: 'memoro-cli', pr: 671, json: true }, io);
    assert.equal(code, 1);
    const report = JSON.parse(out.out);
    assert.equal(report.queued, undefined);
    assert.equal(report.stopped_at, 'red');
  });
});

describe('mc merge waits out a busy gate or a held lease instead of refusing', () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mc-merge-wait-'));
    home = mkdtempSync(join(tmpdir(), 'mc-merge-wait-home-'));
    priorHome = process.env.MC_HOME;
    process.env.MC_HOME = home;
  });

  afterEach(() => {
    if (priorHome === undefined) delete process.env.MC_HOME; else process.env.MC_HOME = priorHome;
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it('a free machine runs the round at once, with no waiter entry written', async () => {
    const { out, io } = deps(landed(), { overrides: FREE });
    const code = await gate({ repo: 'memoro-cli', pr: 671 }, io);
    assert.equal(code, 0);
    assert.deepEqual(queue(), [], 'nothing was ever held, so nothing was ever queued');
    assert.equal(out.err, '', 'no line for a wait that never happened');
  });

  it('a held gate lock waits, then runs once released — one announce line, one waited line', async () => {
    let clock = Date.parse('2026-09-06T18:00:00Z');
    let polls = 0;
    const { out, io } = deps(landed(), {
      overrides: {
        runningRound: () => (polls < 1 ? { pid: 999, repo: 'other', since: '2026-09-06T17:00:00Z' } : null),
        readLease: () => ({ held: false, holder: null }),
        alive: () => true,
        sleep: async (ms) => { polls += 1; clock += ms; },
        now: () => new Date(clock),
        gh: () => ({ status: 1, stdout: '' }),
      },
    });
    const code = await gate({ repo: 'memoro-cli', pr: 671 }, io);
    assert.equal(code, 0);
    assert.match(out.err, /^mc: waiting behind another gate round is running.* — 0 ahead of this one$/mu);
    assert.match(out.err, /^mc: waited \d+s$/mu);
    assert.deepEqual(queue(), [], 'its own entry is gone once its turn ran');
  });

  it('a dead waiter\'s entry is dropped, and never counted as ahead', async () => {
    mkdirSync(join(root, 'runner'), { recursive: true });
    writeFileSync(mergesPath(root), JSON.stringify([{
      repo: 'memoro-cli', pr: 900, branch: 'other', reason: 'memoro-cli is held by mc-run',
      stopped_at: 'lease', since: '2026-09-06T17:00:00Z', holder: 'martin@host', pid: 424242,
    }]));
    let clock = Date.parse('2026-09-06T18:00:00Z');
    let polls = 0;
    const { out, io } = deps(landed(), {
      overrides: {
        runningRound: () => null,
        readLease: () => (polls < 1 ? { held: true, holder: 'someone' } : { held: false, holder: null }),
        alive: (pid) => pid !== 424242,
        sleep: async (ms) => { polls += 1; clock += ms; },
        now: () => new Date(clock),
        gh: () => ({ status: 1, stdout: '' }),
      },
    });
    const code = await gate({ repo: 'memoro-cli', pr: 671 }, io);
    assert.equal(code, 0);
    assert.match(out.err, /— 0 ahead of this one$/mu, 'the dead entry was never live to be ahead');
    assert.deepEqual(queue(), [], 'the dead entry and this call\'s own are both gone');
  });

  it('a later mc merge counts the earlier live waiter ahead of it, then takes its turn once that one is gone', async () => {
    mkdirSync(join(root, 'runner'), { recursive: true });
    writeFileSync(mergesPath(root), JSON.stringify([{
      repo: 'memoro-cli', pr: 900, branch: 'other', reason: 'another gate round is running',
      stopped_at: 'busy', since: '2026-09-06T17:00:00Z', holder: 'martin@host', pid: 424242,
    }]));
    let clock = Date.parse('2026-09-06T18:00:00Z');
    let polls = 0;
    const { out, io } = deps(landed(), {
      overrides: {
        runningRound: () => (polls < 1 ? { pid: 999, since: '2026-09-06T17:00:00Z' } : null),
        readLease: () => ({ held: false, holder: null }),
        alive: () => true,
        sleep: async (ms) => {
          polls += 1;
          clock += ms;
          // The earlier waiter takes its own turn and leaves — the one thing
          // this single-process test cannot let a second `mc merge` do for
          // itself.
          writeFileSync(mergesPath(root), JSON.stringify(queue().filter((entry) => entry.pr !== 900)));
        },
        now: () => new Date(clock),
        gh: () => ({ status: 1, stdout: '' }),
      },
    });
    const code = await gate({ repo: 'memoro-cli', pr: 671 }, io);
    assert.equal(code, 0);
    assert.match(out.err, /^mc: waiting behind another gate round is running.* — 1 ahead of this one$/mu, 'the earlier waiter was counted');
    assert.deepEqual(queue(), [], 'both are gone once both have their answers');
  });

  it('past MERGE_WAIT_MS, mc merge stops, prints once, exits 3, and keeps its place', async () => {
    let clock = Date.parse('2026-09-06T18:00:00Z');
    const { out, io } = deps(stopped('busy', 'never reached — the wait times out first'), {
      overrides: {
        runningRound: () => ({ pid: 999, since: '2026-09-06T17:00:00Z' }),
        readLease: () => ({ held: false, holder: null }),
        alive: () => true,
        sleep: async (ms) => { clock += ms; },
        now: () => new Date(clock),
        gh: () => ({ status: 1, stdout: '' }),
      },
    });
    const code = await gate({ repo: 'memoro-cli', pr: 671 }, io);
    assert.equal(code, 3);
    assert.match(
      out.err,
      /^mc: still waiting behind another gate round is running.* after 8 min — run this again; the place in the queue is kept$/mu,
    );
    assert.equal(out.err.split('\n').filter((line) => line.startsWith('mc: still waiting')).length, 1, 'one line, not one per poll');
    const entries = queue();
    assert.equal(entries.length, 1, 'the place in the queue is kept, not dropped');
    assert.equal(entries[0].pr, 671);
  });
});

describe('a plan-trespass stops mc merge before the gate', () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mc-merge-door-'));
    home = mkdtempSync(join(tmpdir(), 'mc-merge-door-home-'));
    priorHome = process.env.MC_HOME;
    process.env.MC_HOME = home;
  });

  afterEach(() => {
    if (priorHome === undefined) delete process.env.MC_HOME; else process.env.MC_HOME = priorHome;
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it('every problem the door found is printed, nothing is queued, and the gate never ran', async () => {
    let ranRound = false;
    const { out, io } = deps(stopped('busy', 'unused — the door stops this first'), {
      overrides: {
        ...FREE,
        planBoundary: async () => ({
          checked: true, ok: false,
          problems: ['steps[1].instruction: a step session does not change it', 'goal: a step session does not change it'],
        }),
        mergeRound: async () => { ranRound = true; return landed(); },
      },
    });
    const code = await gate({ repo: 'memoro-cli', pr: 671 }, io);
    assert.equal(code, 1);
    assert.equal(ranRound, false, 'a trespass is a fact about the pull request, not something the gate gets to measure');
    assert.match(out.err, /^mc: plan-trespass — steps\[1\]\.instruction: a step session does not change it$/mu);
    assert.match(out.err, /^mc: plan-trespass — goal: a step session does not change it$/mu);
    assert.deepEqual(queue(), [], 'plan-trespass is never the lane\'s to retry');
  });

  it('a plan the door never checked (no project branch, or something unreadable) reaches the gate as before', async () => {
    const { io } = deps(landed(), { overrides: FREE });
    const code = await gate({ repo: 'memoro-cli', pr: 671 }, io);
    assert.equal(code, 0, 'FREE\'s planBoundary is unstubbed, so the real one runs against an unreachable gh and fails open');
  });
});

/* ------------------------------------------------------------ the step */

const PLAN_PATH = 'docs/project/mc/merge-queue/PLAN.json';

/** A register entry for the project the fixture pull request belongs to. */
function register(stepOver = {}) {
  mkdirSync(join(root, 'runner', 'projects'), { recursive: true });
  const entry = {
    project: 'merge-queue', repo: 'memoro-cli', programme: 'mc', plan: PLAN_PATH,
    steps: [
      { status: 'done', pr: 600, branch: 'merge-queue', comments: [], attempts: 0 },
      { status: 'running', pr: null, branch: 'merge-queue-2', comments: [], attempts: 0, session: { pid: 4242, started: '2026-09-12T10:00:00Z' }, ...stepOver },
    ],
  };
  writeFileSync(registerPath(root, 'merge-queue'), JSON.stringify(entry));
  return entry;
}

const entryNow = () => JSON.parse(readFileSync(registerPath(root, 'merge-queue'), 'utf8'));

/** FREE, plus what a step needs: a session's environment, a kill that records, a lock that is nobody's. */
function stepDeps(report, { env = {}, head = null, alive = () => true } = {}) {
  const kills = [];
  const d = deps(report, {
    overrides: {
      ...FREE,
      env: { MC_WORK_ROOT: root, ...env },
      gh: (args) => (args[1] === 'view' && head ? { status: 0, stdout: JSON.stringify({ headRefName: head }) } : { status: 1, stdout: '' }),
      kill: (pid, signal) => { kills.push([pid, signal]); },
      alive,
      lock: (_root, fn) => fn(),
    },
  });
  return { ...d, kills };
}

describe('mc merge writes the register for a step, and ends the session on green', () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mc-merge-step-'));
    home = mkdtempSync(join(tmpdir(), 'mc-merge-step-home-'));
    priorHome = process.env.MC_HOME;
    process.env.MC_HOME = home;
  });

  afterEach(() => {
    if (priorHome === undefined) delete process.env.MC_HOME; else process.env.MC_HOME = priorHome;
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it('green (MC_STEP): done with the pull request and the commit, the session ended, the other step untouched', async () => {
    register();
    const { out, kills, io } = stepDeps(landed(), { env: { MC_STEP: 'merge-queue:1' } });
    const code = await gate({ repo: 'memoro-cli', pr: 671 }, io);
    assert.equal(code, 0);
    const after = entryNow();
    assert.equal(after.steps[1].status, 'done');
    assert.equal(after.steps[1].pr, 671);
    assert.deepEqual(after.steps[1].landed, { sha: 'abc1234def', into: 'main', at: '2026-09-06T18:00:00Z' });
    assert.equal(after.steps[1].session, null);
    assert.deepEqual(kills, [[4242, 'SIGTERM']], 'the session that called is ended — no further turn');
    assert.match(out.out, /^mc: merge-queue step 2 is done — the register says so$/mu);
    assert.match(out.out, /^mc: the step's session \(pid 4242\) is ended — nothing more for it to do$/mu);
    assert.equal(after.steps[0].status, 'done');
  });

  it('red: the attempt is counted and the reason kept, and the session is left to fix it', async () => {
    register();
    const { out, kills, io } = stepDeps(stopped('red', '2 tests red: a › b'), { env: { MC_STEP: 'merge-queue:1' } });
    const code = await gate({ repo: 'memoro-cli', pr: 671 }, io);
    assert.equal(code, 1);
    const after = entryNow();
    assert.equal(after.steps[1].status, 'running', 'still the session\'s');
    assert.equal(after.steps[1].attempts, 1);
    assert.equal(after.steps[1].reason, '2 tests red: a › b');
    assert.deepEqual(kills, []);
    assert.match(out.out, /^mc: merge-queue step 2 — attempt 1 did not land; fix it here and run this again$/mu);
  });

  it('the step is found from the branch when MC_STEP is not set — a person typing mc merge on a project branch', async () => {
    register();
    const { io } = stepDeps(landed(), { head: 'merge-queue-2' });
    await gate({ repo: 'memoro-cli', pr: 671 }, io);
    assert.equal(entryNow().steps[1].status, 'done');
  });

  it('a session whose pid is already gone is not signalled', async () => {
    register();
    const { kills, io } = stepDeps(landed(), { env: { MC_STEP: 'merge-queue:1' }, alive: () => false });
    await gate({ repo: 'memoro-cli', pr: 671 }, io);
    assert.deepEqual(kills, []);
    assert.equal(entryNow().steps[1].status, 'done');
  });

  it('a pull request that is nobody\'s step gets the round and nothing else', async () => {
    register();
    const { out, kills, io } = stepDeps(landed(), { head: 'plan/mc' });
    assert.equal(await gate({ repo: 'memoro-cli', pr: 671 }, io), 0);
    assert.deepEqual(kills, []);
    assert.doesNotMatch(out.out, /register/u);
    assert.equal(entryNow().steps[1].status, 'running');
  });
});

describe('stepForMerge', () => {
  const entries = [
    { project: 'mc-cut', steps: [{ status: 'done', branch: 'mc-cut' }, { status: 'running', branch: 'mc-cut-2' }] },
    { project: 'mc', steps: [{ status: 'ready', branch: null }] },
  ];
  it('MC_STEP wins, then the branch a step stands on, then the project the branch is named after', () => {
    assert.equal(stepForMerge({ env: { MC_STEP: 'mc:0' }, head: 'mc-cut-2', entries }).project, 'mc');
    assert.equal(stepForMerge({ env: {}, head: 'mc-cut-2', entries }).index, 1);
    assert.equal(stepForMerge({ env: {}, head: 'mc-cut-2', entries }).from, 'branch');
    const named = stepForMerge({ env: {}, head: 'mc-cut-9', entries });
    assert.equal(named.project, 'mc-cut');
    assert.equal(named.from, 'project');
    assert.equal(named.index, 1, 'the running step, not the done one');
    assert.equal(stepForMerge({ env: {}, head: 'plan/mc', entries }), null);
    assert.equal(stepForMerge({ env: { MC_STEP: 'ghost:0' }, head: 'x', entries }), null, 'a project the register does not have');
  });
});
