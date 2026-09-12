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

describe('a refused mc merge is queued for the runner', () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mc-merge-queue-'));
    home = mkdtempSync(join(tmpdir(), 'mc-merge-home-'));
    priorHome = process.env.MC_HOME;
    process.env.MC_HOME = home;
  });

  afterEach(() => {
    if (priorHome === undefined) delete process.env.MC_HOME; else process.env.MC_HOME = priorHome;
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it('writes one entry, says so in one line, and exits 0 — the merge is somebody\'s now', async () => {
    const { out, io } = deps(stopped('red', '1 test red: new thing › broke'), { overrides: FREE });
    const code = await gate({ repo: 'memoro-cli', pr: 671 }, io);
    assert.equal(code, 0, 'the caller asked for a merge and the merge is now the lane\'s');
    const entries = queue();
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0], {
      repo: 'memoro-cli',
      pr: 671,
      branch: 'merge-queue',
      reason: '1 test red: new thing › broke',
      stopped_at: 'red',
      since: '2026-09-06T18:00:00Z',
      holder: entries[0].holder,
      pid: null,
    });
    assert.match(out.out, /^mc: queued — the runner's merge lane lands #671, or holds it after one repair \(mc shows the queue\)$/mu);
    assert.equal(out.out.split('\n').filter((line) => line.startsWith('mc: queued')).length, 1, 'one line, not two');
    assert.equal(out.err, '', 'a queued refusal has nothing to warn about');
  });

  it('does not queue what nothing on this machine can land', async () => {
    const { out, io } = deps(stopped('pr', 'gh could not read the pull request'), { overrides: FREE });
    const code = await gate({ repo: 'memoro-cli', pr: 671 }, io);
    assert.equal(code, 1);
    assert.deepEqual(queue(), [], 'a pull request the round could not name is not the lane\'s');
    assert.doesNotMatch(out.out, /queued/u);
    assert.equal(out.err, '', 'nothing was refused that a runner could have taken');
  });

  it('a landed round touches no queue, says nothing new, and never waited', async () => {
    const { out, io } = deps(landed(), { overrides: FREE });
    const code = await gate({ repo: 'memoro-cli', pr: 671 }, io);
    assert.equal(code, 0);
    assert.equal(existsSync(mergesPath(root)), false, 'the file is not even made');
    assert.doesNotMatch(out.out, /queued/u);
    assert.doesNotMatch(out.err, /waiting|waited/u, 'a free machine leaves no trace of a wait it never took');
  });

  it('with no runner the command is what it was, plus one line on stderr', async () => {
    const { out, io } = deps(stopped('red', '1 test red: new thing › broke'), { runner: 'none', overrides: FREE });
    const code = await gate({ repo: 'memoro-cli', pr: 671 }, io);
    assert.equal(code, 1, 'nothing will pick this up, so the refusal is still the caller\'s');
    assert.equal(existsSync(mergesPath(root)), false, 'the queue file is untouched');
    assert.doesNotMatch(out.out, /queued/u, 'stdout is byte-for-byte the round\'s own lines');
    assert.match(out.out, /^mc: nothing was merged$/mu);
    assert.equal(out.err, 'mc: no runner is running to take the refusal — start one, or run this again\n');
  });

  it('a runner.json naming a dead pid is no runner at all', async () => {
    const { out, io } = deps(stopped('red', '1 test red: new thing › broke'), { runner: 'dead', overrides: FREE });
    await gate({ repo: 'memoro-cli', pr: 671 }, io);
    assert.equal(existsSync(mergesPath(root)), false);
    assert.match(out.err, /no runner is running/u);
  });

  it('--json carries queued: true and the entry', async () => {
    const { out, io } = deps(stopped('red', '1 test red: new thing › broke'), { overrides: FREE });
    const code = await gate({ repo: 'memoro-cli', pr: 671, json: true }, io);
    assert.equal(code, 0);
    const report = JSON.parse(out.out);
    assert.equal(report.queued, true);
    assert.equal(report.queue_entry.pr, 671);
    assert.equal(report.queue_entry.stopped_at, 'red');
    assert.equal(report.stopped_at, 'red', 'the round\'s own report is unchanged under it');
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
