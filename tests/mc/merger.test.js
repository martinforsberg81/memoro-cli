/**
 * The merger (ruling 30): one process that lands the queued pull requests one
 * at a time, and writes what came of each into the goal it belongs to.
 *
 * Everything that reaches the machine — the round, the gate lock, the lease,
 * the clock — is handed in, so these run with no suite, no lock and no
 * process behind them. The pid file is real, in a temporary work root,
 * because `O_EXCL` on a file is the whole of what it does.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { mergesPath, parseQueue } from '../../src/mc/merge-queue.js';
import {
  landerFor, landJob, MAX_REQUEUES, mayOffline, mergerPath, OFFLINE_BLOCK_AFTER, offlineBackoffMs, queueMerge, readMerger, releaseMerger,
  serve, startMerger, SUBJECT_POLL_MS, succeed,
  sweepMergedReds, takeMerger, watchSubject,
} from '../../src/mc/merger.js';

let root = null;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'mc-merger-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const lock = (_root, fn) => fn();
// One loop for every repository: the tests of order and batching across
// repositories predate the lanes (ruling 34), which land memoro and
// memoro-cli side by side; `lanes (merge-throughput step 2)` tests those.
const ONE_LANE = { lanes: ['memoro'], laneOf: () => 'memoro' };
const LANE_OF = (job) => job.repo;
const queue = () => parseQueue(existsSync(mergesPath(root)) ? readFileSync(mergesPath(root), 'utf8') : null);

const JOB = { repo: 'memoro-cli', repo_path: '/repos/memoro-cli', pr: 671, branch: 'mq', holder: { name: 'mq', kind: 'work-area' } };

const green = { ok: true, merged: true, merge_commit: 'abc1234def', merged_into: 'main', off_default: false, stopped_at: null };
const red = { ok: false, merged: false, stopped_at: 'red', reason: '2 tests red: a › b' };

/** landJob's machine, faked: no lock, no lease, a clock that moves with sleep. */
function machine(reports, over = {}) {
  const said = [];
  const rounds = [];
  const rows = [];
  let clock = Date.parse('2026-10-09T12:00:00Z');
  const queueOf = [...reports];
  return {
    said, rounds, rows,
    deps: {
      root, lock, say: (line) => said.push(line),
      sleep: async (ms) => { clock += ms; },
      now: () => new Date(clock),
      mergeRound: async (options) => { rounds.push(options); return queueOf.shift(); },
      readRunningRound: () => null,
      readRunningDeploy: () => null,
      readLeaseFn: () => ({ held: false }),
      recordStart: () => {}, record: () => {},
      gh: () => ({ stdout: JSON.stringify({ body: '## What\n\nit' }) }),
      appendRun: (row) => rows.push(row),
      ...over,
    },
  };
}

describe('landJob — one job, landed or answered', () => {
  it('green: the job is answered landed with the commit, the round ran as the job\'s holder, one runs.tsv row', async () => {
    const m = machine([green]);
    const [answer] = await landJob(JOB, m.deps);
    assert.equal(answer.landed, true);
    assert.equal(answer.report.merge_commit, 'abc1234def');
    assert.equal(m.rounds.length, 1);
    assert.equal(m.rounds[0].pr, 671);
    assert.equal('prs' in m.rounds[0], false, 'one job is the single round it always was');
    assert.deepEqual(m.rounds[0].holder, JOB.holder);
    assert.equal(m.rounds[0].repoPath, '/repos/memoro-cli');
    assert.equal(m.rows[0].note, 'merged');
    assert.equal(m.rows[0].kind, 'merge');
    assert.equal(m.rows[0].name, 'memoro-cli');
  });

  it('a landed pull request leaves the page\'s PR cache at once; a red one stays', async () => {
    const dropped = [];
    await landJob(JOB, machine([green], { dropFromPage: (pr) => dropped.push(pr) }).deps);
    assert.deepEqual(dropped, [{ root, repo: 'memoro-cli', number: 671 }]);
    const kept = [];
    await landJob(JOB, machine([red], { dropFromPage: (pr) => kept.push(pr) }).deps);
    assert.deepEqual(kept, []);
  });

  it('red: the job is answered not landed with the round\'s reason, and one runs.tsv row says so', async () => {
    const m = machine([red]);
    const [answer] = await landJob(JOB, m.deps);
    assert.equal(answer.landed, false);
    assert.equal(answer.report.reason, '2 tests red: a › b');
    assert.equal(m.rows[0].note, 'red,red');
    assert.ok(m.said.includes('memoro-cli #671: not merged — red: 2 tests red: a › b'), m.said.join('\n'));
  });

  it('a manual job with no goal pointer is refused when its only owner was dropped', async () => {
    const calls = [];
    const sets = [];
    const dropped = { programme: 'prog', goal: 'gone', dir: '/goals/.archive/gone', stage: 'dropped', prs: [{ repo: JOB.repo, pr: JOB.pr }] };
    const m = machine([green], { goalsOf: () => [dropped], setGoal: (change) => sets.push(change), gh: (...args) => { calls.push(args); return { stdout: '{}' }; } });
    const [answer] = await landJob({ ...JOB, goal: null }, m.deps);
    assert.equal(answer.report.stopped_at, 'dropped');
    assert.equal(m.rounds.length, 0, 'the gate round never starts');
    assert.equal(calls.some(([args]) => args[1] === 'merge'), false, 'no direct GitHub merge');
    assert.deepEqual(sets, [], 'a late callback cannot reactivate an archived dropped goal');
  });

  it('a shared PR stays eligible when a different unfinished goal carries it', async () => {
    const dropped = { programme: 'prog', goal: 'gone', dir: '/goals/gone', stage: 'dropped', prs: [{ repo: JOB.repo, pr: JOB.pr }] };
    const live = { programme: 'prog', goal: 'live', dir: '/goals/live', stage: 'build', prs: [{ repo: JOB.repo, pr: JOB.pr }] };
    const m = machine([green], { goalsOf: () => [dropped, live] });
    const [answer] = await landJob({ ...JOB, goal: null }, m.deps);
    assert.equal(answer.landed, true);
    assert.equal(m.rounds.length, 1, 'shared ownership does not cancel merge work');
  });

  it('a drop during the gate is rechecked by the round immediately before merge', async () => {
    const owner = { programme: 'prog', goal: 'gone', dir: '/goals/gone', stage: 'build', prs: [{ repo: JOB.repo, pr: JOB.pr }] };
    const m = machine([green], {
      goalsOf: () => [owner],
      mergeRound: async (options) => {
        owner.stage = 'dropped'; // The drop occurs while the gate is in flight.
        assert.equal(await options.beforeMerge(), false, 'the live ownership read observes the persisted drop');
        return { ok: false, merged: false, stopped_at: 'dropped', reason: 'abandoned' };
      },
    });
    const [answer] = await landJob({ ...JOB, goal: null }, m.deps);
    assert.equal(answer.landed, false);
    assert.equal(answer.report.stopped_at, 'dropped');
  });

  // A merge round red on two tests in one file, the way `runMergeRound`
  // answers: the gate's verdict under `gate`, its red files lifted beside it.
  const twoRed = () => ({
    ok: false, merged: false, stopped_at: 'red', reason: '2 tests red: s › a, s › b', red_files: ['tests/x.test.js'], main_red: null,
    pr: { number: 671 },
    gate: {
      ok: false, stopped_at: 'red',
      candidate: {
        red: ['s › a', 's › b', 's'], red_files: ['tests/x.test.js'],
        red_tests: [
          { file: 'tests/x.test.js', name: 's › a', own: 'a', at: 'tests/x.test.js:12:5', error: ['Expected values to be strictly equal:', '1 !== 2'] },
          { file: 'tests/x.test.js', name: 's › b', own: 'b', at: 'tests/x.test.js:20:7', error: ['boom'] },
        ],
      },
    },
  });

  it('a red round keeps its failures in merge-red/, on the report and in the round record (ruling 44)', async () => {
    const recorded = [];
    const m = machine([twoRed()], { record: (report, options) => recorded.push({ report, options }) });
    const [answer] = await landJob(JOB, m.deps);
    const path = join(root, 'runner', 'merge-red', 'memoro-cli-671.txt');
    assert.equal(answer.report.red_detail, path);
    assert.equal(recorded[0].report.red_detail, path, 'on the report the round record is written from');
    const text = readFileSync(path, 'utf8');
    assert.match(text, /^tests\/x\.test\.js$/mu);
    assert.match(text, /✗ s › a\n {4}at tests\/x\.test\.js:12:5\n {4}Expected values to be strictly equal:\n {4}1 !== 2/u);
    assert.match(text, /✗ s › b\n {4}at tests\/x\.test\.js:20:7\n {4}boom/u);
  });

  it('the next red overwrites the file and a green landing removes it', async () => {
    const path = join(root, 'runner', 'merge-red', 'memoro-cli-671.txt');
    await landJob(JOB, machine([twoRed()]).deps);
    const again = twoRed();
    again.gate.candidate.red_tests = [again.gate.candidate.red_tests[1]];
    await landJob(JOB, machine([again]).deps);
    assert.doesNotMatch(readFileSync(path, 'utf8'), /✗ s › a/u,'one file per pull request, the last red\'s');
    await landJob(JOB, machine([green]).deps);
    assert.equal(existsSync(path), false);
  });

  it('a batch keeps one file per pull request, from each one\'s own round', async () => {
    const own = { ...twoRed(), pr: { number: 672 } };
    const batch = {
      ok: false, merged: false, stopped_at: 'batch', reason: '1 of 2 did not land',
      batch: { prs: [671, 672], merges: [{ number: 671, merged: true, merge_commit: 'abc' }, { number: 672, merged: false, error: 'red' }], rounds: [{ ...green, pr: { number: 671 } }, own] },
    };
    await landJob([JOB, { ...JOB, pr: 672, branch: 'mq2' }], machine([batch]).deps);
    assert.equal(own.red_detail, join(root, 'runner', 'merge-red', 'memoro-cli-672.txt'));
    assert.equal(existsSync(own.red_detail), true);
    assert.equal(existsSync(join(root, 'runner', 'merge-red', 'memoro-cli-671.txt')), false);
  });

  it('waits behind another gate round before running its own, saying so once', async () => {
    let polls = 0;
    const m = machine([green], { readRunningRound: () => (polls++ < 3 ? { pid: 9, repo: 'memoro', pr: 1 } : null) });
    await landJob(JOB, m.deps);
    assert.equal(m.rounds.length, 1, 'no round while the lock is held');
    assert.equal(m.said.filter((line) => /waiting behind another gate round/u.test(line)).length, 1);
    assert.equal(m.rows.at(-1).note, 'merged');
  });

  it('waits while a deploy runs, and lands after it', async () => {
    let polls = 0;
    const m = machine([green], { readRunningDeploy: () => (polls++ < 2 ? { pid: 7, sha: 'c6b53f26a6f7' } : null) });
    await landJob(JOB, { ...m.deps, lane: 'memoro' });
    assert.equal(m.rounds.length, 1, 'no round while the deploy runs');
    assert.equal(m.said.filter((line) => /waiting behind the deploy of c6b53f2 \(pid 7\)/u.test(line)).length, 1);
    assert.equal(m.rows.at(-1).note, 'merged');
  });

  it('a deploy holds only memoro\'s lane: another repository lands past it', async () => {
    const m = machine([green], { lane: 'memoro-cli', readRunningDeploy: () => ({ pid: 7, sha: 'c6b53f26a6f7' }) });
    await landJob({ ...JOB, repo: 'memoro-cli' }, { ...m.deps, lane: 'memoro-cli' });
    assert.equal(m.rounds.length, 1);
    assert.equal(m.said.some((line) => /waiting behind the deploy/u.test(line)), false);
  });

  it('a round that lost the race for the lock is run again, not answered', async () => {
    const m = machine([{ ok: false, stopped_at: 'busy', reason: 'another round' }, green]);
    await landJob(JOB, m.deps);
    assert.equal(m.rounds.length, 2);
    assert.equal(m.rows.at(-1).note, 'merged');
  });

  const killed = {
    ok: false, merged: false, stopped_at: 'file-killed', verdict: 'stopped',
    reason: 'tests/b.test.js ended by SIGTERM from outside the round — not a verdict on this change',
    killed_files: [{ file: 'tests/b.test.js', signal: 'SIGTERM' }],
  };

  it('a test file killed from outside the round is measured once more, and then lands', async () => {
    const m = machine([killed, green]);
    await landJob(JOB, m.deps);
    assert.equal(m.rounds.length, 2);
    assert.ok(m.said.includes('memoro-cli #671: tests/b.test.js was killed from outside the round — measuring again'));
    assert.equal(m.rows.at(-1).note, 'merged');
  });

  it('killed twice is put back in line, with no session and no attempt counted', async () => {
    const m = machine([killed, killed, green]);
    const answers = await landJob(JOB, m.deps);
    assert.equal(m.rounds.length, 2, 'once more, not on and on');
    assert.equal(answers[0].requeued, true);
    assert.ok(m.said.some((line) => /back in line in 15 min \(requeue 1 of 2\), no session started/u.test(line)));
  });

  it('killed twice once the requeues are spent is answered red with that reason, and nothing is mended', async () => {
    const m = machine([killed, killed, green]);
    const answers = await landJob({ ...JOB, requeues: MAX_REQUEUES }, m.deps);
    assert.equal(m.rounds.length, 2, 'once more, not on and on');
    assert.equal(answers[0].landed, false);
    assert.equal(answers[0].report.stopped_at, 'file-killed');
    assert.equal(answers[0].report.reason, killed.reason);
    assert.equal(m.rows[0].note, 'red,file-killed');
    assert.equal(m.said.filter((line) => /mend/u.test(line)).length, 0);
  });

  const underLoad = {
    ok: false, merged: false, stopped_at: 'red-under-load', verdict: 'stopped',
    reason: 'tests/b.test.js red in the round, green alone on the base and on the candidate — measured again',
    under_load_files: ['tests/b.test.js'],
  };

  it('a red that passes alone on the base and the candidate is measured once more, and then lands', async () => {
    const m = machine([underLoad, green]);
    await landJob(JOB, m.deps);
    assert.equal(m.rounds.length, 2);
    assert.ok(m.said.includes('memoro-cli #671: tests/b.test.js red only under load — measuring again'));
    assert.equal(m.rows.at(-1).note, 'merged');
  });

  it('red under load twice is put back in line, not handed to a session', async () => {
    const m = machine([underLoad, underLoad, green]);
    const answers = await landJob(JOB, m.deps);
    assert.equal(answers[0].requeued, true);
    assert.equal(answers[0].report.stopped_at, 'red-under-load');
  });

  it('red under load twice once the requeues are spent is answered red, saying the files passed alone on base and head', async () => {
    const m = machine([underLoad, underLoad, green]);
    const answers = await landJob({ ...JOB, requeues: MAX_REQUEUES }, m.deps);
    assert.equal(m.rounds.length, 2, 'once more, not on and on');
    assert.equal(answers[0].landed, false);
    assert.equal(answers[0].report.stopped_at, 'red-under-load');
    assert.match(answers[0].report.reason, /green alone on the base and on the candidate/u);
    assert.match(answers[0].report.reason, /red under load in two rounds running/u);
    assert.equal(m.said.filter((line) => /mend/u.test(line)).length, 0);
  });

  it('a job that is nobody\'s goal gets the round and nothing else', async () => {
    const m = machine([green]);
    await landJob(JOB, m.deps);
    assert.equal(m.rounds.length, 1);
    assert.equal(m.rows[0].name, 'memoro-cli');
  });
});

/** A round the network stopped, as `runMergeRound` answers it: nothing was read, so nothing is wrong with the pull request. */
const OFFLINE = {
  ok: false, merged: false, stopped_at: 'offline',
  reason: 'git fetch origin --prune failed, so origin/main could not be re-checked before merging (exit 128)',
};
const AT = '2026-11-06T12:00:00Z';

describe('an offline round is put back in line, not answered red', () => {
  it('the backoff is a minute, doubling, at most 15 minutes', () => {
    assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map(offlineBackoffMs), [60_000, 120_000, 240_000, 480_000, 900_000, 900_000, 900_000]);
    assert.equal(OFFLINE_BLOCK_AFTER, 6);
  });

  it('one offline answer: no requeue used, no goal said, one merger.log line, and the row says offline', async () => {
    const m = machine([OFFLINE]);
    const answers = await landJob(JOB, m.deps);
    assert.equal(answers[0].offline, true);
    assert.equal(answers[0].landed, false);
    assert.equal(answers[0].requeued, undefined);
    assert.equal(m.rows[0].note, 'offline');
    assert.equal(m.said.filter((line) => /: offline: /u.test(line)).length, 1, 'one line per answer');
    assert.ok(m.said.some((line) => /^memoro-cli #671: offline: git fetch origin --prune failed.* — back in line in 1 min \(offline 1 of 6\), no session started$/u.test(line)), m.said.join('\n'));
  });

  it('serve: the job is queued again a minute on, its place and its requeue budget kept', async () => {
    mkdirSync(join(root, 'runner'), { recursive: true });
    writeFileSync(mergesPath(root), JSON.stringify([{ ...JOB, since: '2026-11-06T11:00:00Z' }]));
    const m = machine([OFFLINE]);
    const now = () => new Date(AT);
    await serve({
      root, lock, take: () => true, release: () => {}, ...ONE_LANE, now,
      land: (batch, lane, extra) => landJob(batch, { ...m.deps, ...extra, now }),
    });
    const [entry] = queue();
    assert.equal(entry.state, 'queued');
    assert.equal(entry.offline, 1);
    assert.equal(entry.requeues, 0);
    assert.equal(entry.since, '2026-11-06T11:00:00Z');
    assert.equal(entry.not_before, '2026-11-06T12:01:00.000Z');
    assert.equal(m.rounds.length, 1, 'no second round before the backoff has passed');
  });

  it('serve: a later reachable round lands once the backoff has passed', async () => {
    mkdirSync(join(root, 'runner'), { recursive: true });
    writeFileSync(mergesPath(root), JSON.stringify([{ ...JOB, since: '2026-11-06T11:00:00Z', offline: 1, not_before: '2026-11-06T12:01:00.000Z' }]));
    const m = machine([green]);
    const now = () => new Date('2026-11-06T12:01:00Z');
    await serve({
      root, lock, take: () => true, release: () => {}, ...ONE_LANE, now,
      land: (batch, lane, extra) => landJob(batch, { ...m.deps, ...extra, now }),
    });
    assert.equal(m.rounds.length, 1);
    assert.deepEqual(queue(), []);
  });

  it('an offline answer leaves its goal as it is: no status, no note, no session', async () => {
    const GOAL = { programme: 'mc', goal: 'g', dir: '/programs/mc/goals/g' };
    const goal = { ...GOAL, stage: 'review', status: 'ready', prs: [{ repo: 'memoro-cli', pr: 671 }], log: [] };
    const writes = [];
    const notes = [];
    const m = machine([OFFLINE], {
      goalsOf: () => [goal], setGoal: (change) => { writes.push(change); return { goal }; }, noteGoal: (change) => { notes.push(change); },
    });
    // A goal's review-queued pull request: no `job.goal`, its goal found by its `prs`, so the round runs.
    const answers = await landJob(JOB, m.deps);
    assert.equal(answers[0].offline, true);
    assert.equal(m.rounds.length, 1);
    assert.deepEqual(writes, []);
    assert.deepEqual(notes, []);
  });

  it('the fifth offline answer in a row is put back in line, the next backoff on', async () => {
    const m = machine([OFFLINE]);
    const answers = await landJob({ ...JOB, offline: 4 }, m.deps);
    assert.equal(answers[0].offline, true);
    assert.ok(m.said.some((line) => /back in line in 15 min \(offline 5 of 6\), no session started/u.test(line)), m.said.join('\n'));
    assert.equal(mayOffline({ offline: 4 }, OFFLINE), true);
    assert.equal(mayOffline({ offline: 5 }, OFFLINE), false);
    assert.equal(mayOffline({ offline: 0 }, { ...OFFLINE, stopped_at: 'pr' }), false, 'only the network answer waits');
  });

  it('the sixth offline answer in a row is answered as it stands, and the goal is blocked saying the network was down for that long', async () => {
    const GOAL = { programme: 'mc', goal: 'g', dir: '/programs/mc/goals/g' };
    const goal = { ...GOAL, stage: 'review', status: 'ready', prs: [{ repo: 'memoro-cli', pr: 671 }], log: [] };
    const writes = [];
    const m = machine([OFFLINE], {
      goalsOf: () => [goal], setGoal: (change) => { writes.push(change); return { goal }; }, noteGoal: () => {},
    });
    const answers = await landJob({ ...JOB, offline: 5 }, m.deps);
    assert.equal(answers[0].offline, undefined);
    assert.equal(answers[0].landed, false);
    assert.equal(answers[0].report.stopped_at, 'offline');
    assert.match(answers[0].report.reason, /the network has been unreachable for at least 30 min \(6 rounds in a row\)/u);
    assert.equal(m.rows[0].note, 'red,offline');
    assert.equal(writes.length, 1);
    assert.deepEqual([writes[0].stage, writes[0].status], ['review', 'blocked'], 'blocked where it stands: a review goal has no verdict to move it on');
    assert.match(writes[0].entry.comment, /unreachable for at least 30 min \(6 rounds in a row\)/u);
  });
});

describe('serve — the loop', () => {
  const take = () => true;
  const release = () => {};

  it('lands every job oldest first, one repository at a time, empties the queue and leaves', async () => {
    mkdirSync(join(root, 'runner'), { recursive: true });
    writeFileSync(mergesPath(root), JSON.stringify([
      { ...JOB, repo: 'memoro', pr: 2, since: '2026-10-09T12:02:00Z' },
      { ...JOB, pr: 1, since: '2026-10-09T12:01:00Z' },
    ]));
    const landed = [];
    const states = [];
    const code = await serve({
      root, lock, take, release, ...ONE_LANE,
      land: async ([job]) => { landed.push(job.pr); states.push(queue().find((e) => e.pr === job.pr).state); return green; },
    });
    assert.equal(code, 0);
    assert.deepEqual(landed, [1, 2]);
    assert.deepEqual(states, ['landing', 'landing'], 'the job is marked while the round runs');
    assert.deepEqual(queue(), []);
  });

  it('a job queued while the merger is landing another is landed by the same merger', async () => {
    mkdirSync(join(root, 'runner'), { recursive: true });
    writeFileSync(mergesPath(root), JSON.stringify([{ ...JOB, pr: 1 }]));
    const landed = [];
    await serve({
      root, lock, take, release,
      land: async ([job]) => {
        landed.push(job.pr);
        if (job.pr === 1) queueMerge({ root, repo: 'memoro-cli', repoPath: '/r', pr: 2, lock, start: () => ({ pid: process.pid, started: false }) });
      },
    });
    assert.deepEqual(landed, [1, 2]);
  });

  it('a red answer stays in the file as a red row with its reason, and the queue goes on', async () => {
    mkdirSync(join(root, 'runner'), { recursive: true });
    writeFileSync(mergesPath(root), JSON.stringify([{ ...JOB, pr: 1, since: 'a' }, { ...JOB, repo: 'memoro', pr: 2, since: 'b' }]));
    const landed = [];
    await serve({
      root, lock, take, release, ...ONE_LANE, now: () => new Date('2026-10-10T07:00:00Z'),
      land: async ([job]) => { landed.push(job.pr); return job.pr === 1 ? red : green; },
    });
    assert.deepEqual(landed, [1, 2], 'the red one did not hold the next back');
    const [left] = queue();
    assert.equal(queue().length, 1);
    assert.equal(left.pr, 1);
    assert.equal(left.state, 'red');
    assert.equal(left.reason, 'red: 2 tests red: a › b');
    assert.equal(left.answered, '2026-10-10T07:00:00.000Z');
  });

  it('queued again, a red row is back in line and landed', async () => {
    mkdirSync(join(root, 'runner'), { recursive: true });
    writeFileSync(mergesPath(root), JSON.stringify([{ ...JOB, pr: 1, since: 'a', state: 'red', reason: 'red: x', answered: 'z' }]));
    queueMerge({ root, repo: 'memoro-cli', repoPath: '/r', pr: 1, lock, start: () => ({ pid: null, started: false }) });
    assert.equal(queue()[0].state, 'queued');
    assert.equal(queue()[0].reason, null);
    const landed = [];
    await serve({ root, lock, take, release, land: async ([job]) => { landed.push(job.pr); return green; } });
    assert.deepEqual(landed, [1]);
    assert.deepEqual(queue(), []);
  });

  it('a round that throws is said, its job kept red, and the next one landed', async () => {
    mkdirSync(join(root, 'runner'), { recursive: true });
    writeFileSync(mergesPath(root), JSON.stringify([{ ...JOB, pr: 1, since: 'a' }, { ...JOB, repo: 'memoro', pr: 2, since: 'b' }]));
    const said = [];
    const landed = [];
    await serve({
      root, lock, take, release, say: (line) => said.push(line),
      land: async ([job]) => { if (job.pr === 1) throw new Error('boom'); landed.push(job.pr); return green; },
    });
    assert.deepEqual(landed, [2]);
    assert.equal(queue()[0].state, 'red');
    assert.match(queue()[0].reason, /^threw: the round threw \(boom\)/u);
    assert.ok(said.some((line) => /#1: the round threw — Error: boom/u.test(line)));
  });

  it('asked to stop, it leaves between jobs and the rest wait', async () => {
    mkdirSync(join(root, 'runner'), { recursive: true });
    writeFileSync(mergesPath(root), JSON.stringify([{ ...JOB, pr: 1, since: 'a' }, { ...JOB, repo: 'memoro', pr: 2, since: 'b' }]));
    let stop = false;
    await serve({ root, lock, take, release, ...ONE_LANE, stopping: () => stop, land: async () => { stop = true; return green; } });
    assert.deepEqual(queue().map((e) => e.pr), [2]);
  });

  it('another merger running: this one leaves at once', async () => {
    let landed = 0;
    assert.equal(await serve({ root, lock, take: () => false, release, land: async () => { landed += 1; } }), 0);
    assert.equal(landed, 0);
  });

  it('a merger whose checkout moved releases merger.json and hands over at once, finishes the round in flight and leaves', async () => {
    mkdirSync(join(root, 'runner'), { recursive: true });
    writeFileSync(mergesPath(root), JSON.stringify([{ ...JOB, pr: 1, since: 'a' }, { ...JOB, repo: 'memoro', pr: 2, since: 'b' }]));
    const heads = ['aaa1111', 'bbb2222'];
    const said = [];
    const moved = [];
    const landed = [];
    const order = [];
    let handovers = 0;
    const code = await serve({
      root, lock, take, release: () => order.push('release'), ...ONE_LANE, say: (l) => said.push(l),
      version: { checkout: '~/memoro-cli', commit: 'aaa1111' },
      head: async () => heads.shift() ?? 'bbb2222',
      onMoved: (a, b) => moved.push([a, b]),
      handover: () => { handovers += 1; order.push('handover'); },
      land: async ([job]) => { landed.push(job.pr); return green; },
    });
    assert.equal(code, 0);
    assert.equal(handovers, 1);
    assert.deepEqual(order.slice(0, 2), ['release', 'handover'], 'merger.json is let go before the successor is started');
    assert.deepEqual(landed, [1]);
    assert.deepEqual(queue().map((e) => [e.pr, e.state]), [[2, 'queued']]);
    assert.ok(said.includes('code moved aaa1111 → bbb2222 — successor started; this merger finishes the rounds in flight and leaves'), said.join('\n'));
    assert.ok(said.includes('left for bbb2222'), said.join('\n'));
    assert.deepEqual(moved, [['aaa1111', 'bbb2222']]);
  });

  it('a landing entry another live merger holds is not landed here; the next queued one is', async () => {
    mkdirSync(join(root, 'runner'), { recursive: true });
    writeFileSync(mergesPath(root), JSON.stringify([
      { ...JOB, pr: 1, since: 'a', state: 'landing', merger: 777 },
      { ...JOB, repo: 'memoro', pr: 2, since: 'b' },
    ]));
    const landed = [];
    await serve({ root, lock, take, release, ...ONE_LANE, alive: (p) => p === 777, land: async ([job]) => { landed.push(job.pr); return green; } });
    assert.deepEqual(landed, [2]);
    assert.deepEqual(queue().map((e) => [e.pr, e.state]), [[1, 'landing']]);
  });

  it('a landing entry whose merger is dead is landed first, as before', async () => {
    mkdirSync(join(root, 'runner'), { recursive: true });
    writeFileSync(mergesPath(root), JSON.stringify([
      { ...JOB, pr: 1, since: 'a', state: 'landing', merger: 777 },
      { ...JOB, repo: 'memoro', pr: 2, since: 'b' },
    ]));
    const landed = [];
    await serve({ root, lock, take, release, ...ONE_LANE, alive: () => false, land: async ([job]) => { landed.push(job.pr); return green; } });
    assert.deepEqual(landed, [1, 2]);
  });

  it('a `mending` entry an older merger left reads as queued and is landed: no mend session exists any more', async () => {
    mkdirSync(join(root, 'runner'), { recursive: true });
    writeFileSync(mergesPath(root), JSON.stringify([
      { ...JOB, pr: 1, since: 'a' },
      { ...JOB, repo: 'memoro', pr: 2, since: 'b', state: 'mending', merger: 777, mend: { pid: 4321, started: 's', reason: 'x', stopped_at: 'merge' } },
    ]));
    assert.equal(queue().find((e) => e.pr === 2).state, 'queued');
    const landed = [];
    await serve({ root, lock, take, release, ...ONE_LANE, alive: (p) => p === 777, land: async ([job]) => { landed.push(job.pr); return green; } });
    assert.deepEqual(landed, [1, 2]);
    assert.deepEqual(queue(), []);
  });

  it('serve writes its pid on the entry it marks landing', async () => {
    mkdirSync(join(root, 'runner'), { recursive: true });
    writeFileSync(mergesPath(root), JSON.stringify([{ ...JOB, pr: 1, since: 'a' }]));
    let during = null;
    await serve({ root, lock, take, release, pid: 4242, land: async () => { during = queue()[0]; return green; } });
    assert.equal(during.state, 'landing');
    assert.equal(during.merger, 4242);
  });

  it('a head that reads the same commit, a longer sha of it, or nothing changes nothing', async () => {
    mkdirSync(join(root, 'runner'), { recursive: true });
    for (const now of ['aaa1111', 'aaa1111ff', null]) {
      writeFileSync(mergesPath(root), JSON.stringify([{ ...JOB, pr: 1, since: 'a' }, { ...JOB, repo: 'memoro', pr: 2, since: 'b' }]));
      const said = [];
      const landed = [];
      await serve({
        root, lock, take, release, ...ONE_LANE, say: (l) => said.push(l),
        version: { checkout: '~/memoro-cli', commit: 'aaa1111' },
        head: async () => now,
        land: async ([job]) => { landed.push(job.pr); return green; },
      });
      assert.deepEqual(landed, [1, 2], `head ${now}`);
      assert.equal(said.some((l) => l.startsWith('code moved')), false, said.join('\n'));
    }
  });

  it('without a version or a head the loop is as before', async () => {
    // Every other serve test passes neither; this one passes a head alone.
    mkdirSync(join(root, 'runner'), { recursive: true });
    writeFileSync(mergesPath(root), JSON.stringify([{ ...JOB, pr: 1, since: 'a' }, { ...JOB, repo: 'memoro', pr: 2, since: 'b' }]));
    const landed = [];
    await serve({
      root, lock, take, release, ...ONE_LANE, head: async () => 'bbb2222',
      land: async ([job]) => { landed.push(job.pr); return green; },
    });
    assert.deepEqual(landed, [1, 2]);
  });

});

describe('succeed — a successor after new code', () => {
  it('succeed starts a merger only while jobs remain', () => {
    mkdirSync(join(root, 'runner'), { recursive: true });
    writeFileSync(mergesPath(root), JSON.stringify([{ ...JOB, pr: 1, since: 'a' }]));
    const said = [];
    assert.equal(
      succeed({ root, movedTo: 'bbb2222', start: () => ({ pid: 4321, started: true }), say: (l) => said.push(l) }),
      'successor pid 4321 started on bbb2222 for 1 job in line',
    );
    assert.deepEqual(said, ['successor pid 4321 started on bbb2222 for 1 job in line']);
    assert.equal(
      succeed({ root, movedTo: 'bbb2222', start: () => ({ pid: null, error: 'spawn failed' }) }),
      'no successor started (spawn failed) — the runner\'s next pass starts one',
    );

    let started = 0;
    const start = () => { started += 1; return { pid: 4321, started: true }; };
    writeFileSync(mergesPath(root), JSON.stringify([]));
    assert.equal(succeed({ root, movedTo: 'bbb2222', start }), 'nothing in line — no successor started; the next mc merge starts one');
    writeFileSync(mergesPath(root), JSON.stringify([{ ...JOB, pr: 1, since: 'a', state: 'red', reason: 'red: x', answered: 'z' }]));
    assert.equal(succeed({ root, movedTo: 'bbb2222', start }), 'nothing in line — no successor started; the next mc merge starts one');
    assert.equal(started, 0);
  });
});

describe('batches (merge-throughput step 1)', () => {
  const take = () => true;
  const release = () => {};
  const MEMORO = { repo: 'memoro', repo_path: '/repos/memoro', branch: null, holder: { name: 'mb', kind: 'work-area' } };
  const jobFor = (pr, _index, since) => ({ ...MEMORO, pr, since });

  function queueFour(extra = {}) {
    mkdirSync(join(root, 'runner'), { recursive: true });
    writeFileSync(mergesPath(root), JSON.stringify([
      { ...jobFor(11, 0, '2026-10-10T12:01:00Z'), ...extra[11] },
      { ...JOB, since: '2026-10-10T12:02:00Z' },
      { ...jobFor(12, 1, '2026-10-10T12:03:00Z'), ...extra[12] },
      { ...jobFor(13, 2, '2026-10-10T12:04:00Z'), ...extra[13] },
    ]));
  }

  const batchGreen = {
    ok: true, merged: true, merge_commit: 'ccc', merged_into: 'main', off_default: false, stopped_at: null, pr: { number: 11, base: 'main' },
    batch: {
      prs: [11, 12, 13], gate_ok: true, fallback: false, rounds: [],
      merges: [{ number: 11, merged: true, merge_commit: 'aaa', error: null }, { number: 12, merged: true, merge_commit: 'bbb', error: null }, { number: 13, merged: true, merge_commit: 'ccc', error: null }],
    },
  };

  it('three memoro jobs and one memoro-cli job: one round with prs [11, 12, 13], every one landed, the queue empty', async () => {
    queueFour();
    const m = machine([batchGreen, green]);
    await serve({ root, lock, take, release, ...ONE_LANE, batchMax: 4, say: m.deps.say, now: m.deps.now, land: (batch) => landJob(batch, m.deps) });
    assert.equal(m.rounds.length, 2);
    assert.equal(m.rounds[0].pr, 11);
    assert.deepEqual(m.rounds[0].prs, [11, 12, 13]);
    assert.deepEqual(m.rounds[0].holder, MEMORO.holder);
    assert.equal('prs' in m.rounds[1], false, 'memoro-cli alone is a single round');
    assert.ok(m.said.includes('memoro: landing a batch of 3 — #11 #12 #13'));
    assert.deepEqual(queue(), []);
    assert.deepEqual(m.rows.map((r) => [r.pr, r.note]), [[11, 'merged'], [12, 'merged'], [13, 'merged'], [671, 'merged']]);
  });

  it('a fallback with #12 red in its own round: #12 is red with its reason, #11 and #13 land', async () => {
    queueFour();
    const own = (number, over) => ({ ...green, pr: { number }, merge_commit: `m${number}`, ...over });
    const fallback = {
      ok: false, merged: false, stopped_at: 'batch', reason: '1 of 3 did not land in its own round: #12 (3 tests red)', pr: { number: 11, base: 'main' },
      batch: {
        prs: [11, 12, 13], gate_ok: false, fallback: true,
        rounds: [own(11), own(12, { ok: false, merged: false, merge_commit: null, stopped_at: 'red', reason: '3 tests red' }), own(13)],
        merges: [{ number: 11, merged: true, merge_commit: 'm11', error: null }, { number: 12, merged: false, merge_commit: null, error: '3 tests red' }, { number: 13, merged: true, merge_commit: 'm13', error: null }],
      },
    };
    const m = machine([fallback, green]);
    await serve({ root, lock, take, release, ...ONE_LANE, batchMax: 4, say: m.deps.say, now: m.deps.now, land: (batch) => landJob(batch, m.deps) });
    assert.deepEqual(m.rows.filter((r) => r.pr !== 671).map((r) => [r.pr, r.note]), [[11, 'merged'], [12, 'red,red'], [13, 'merged']]);
    assert.deepEqual(queue().map((e) => [e.pr, e.state, e.reason]), [[12, 'red', 'red: 3 tests red']]);
  });

  it('a stop before a job is reached gives that job the batch\'s stop; one that merged before it lands', async () => {
    const drift = {
      ok: false, merged: false, stopped_at: 'drift', reason: 'origin/main moved between merges', pr: { number: 11, base: 'main' },
      batch: { prs: [11, 12], gate_ok: true, fallback: false, rounds: [], merges: [{ number: 11, merged: true, merge_commit: 'aaa', error: null }] },
    };
    const m = machine([drift]);
    const answers = await landJob([jobFor(11, 0), jobFor(12, 1)], m.deps);
    assert.deepEqual(answers.map((a) => a.landed), [true, false]);
    assert.equal(answers[0].report.merged_into, 'main');
    assert.equal(answers[1].report.stopped_at, 'drift');
    assert.equal(answers[1].report.reason, 'origin/main moved between merges');
  });

  it('a merger that died under a batch takes the whole batch again, before anything queued', async () => {
    queueFour({ 11: { state: 'landing', started: 'x' }, 13: { state: 'landing', started: 'x' } });
    const resumed = { ...batchGreen, batch: { ...batchGreen.batch, prs: [11, 13], merges: [batchGreen.batch.merges[0], batchGreen.batch.merges[2]] } };
    const m = machine([resumed, green, green]);
    const rounds = [];
    await serve({
      root, lock, take, release, ...ONE_LANE, batchMax: 4, say: m.deps.say, now: m.deps.now,
      land: (batch) => { rounds.push(batch.map((j) => j.pr)); return landJob(batch, m.deps); },
    });
    assert.deepEqual(rounds[0], [11, 13]);
    assert.deepEqual(m.rounds[0].prs, [11, 13]);
    assert.deepEqual(rounds.slice(1), [[671], [12]]);
  });

  it('two queued jobs of one repository and no batchMax: land is called with a batch of one, each', async () => {
    mkdirSync(join(root, 'runner'), { recursive: true });
    writeFileSync(mergesPath(root), JSON.stringify([jobFor(11, 0, '2026-10-10T12:01:00Z'), jobFor(12, 1, '2026-10-10T12:02:00Z')]));
    const m = machine([green, green]);
    const sizes = [];
    await serve({
      root, lock, take, release, ...ONE_LANE, say: m.deps.say, now: m.deps.now,
      land: (batch) => { sizes.push(batch.length); return landJob(batch, m.deps); },
    });
    assert.deepEqual(sizes, [1, 1]);
    assert.deepEqual(m.rounds.map((r) => r.pr), [11, 12]);
    assert.deepEqual(queue(), []);
  });
});

describe('already merged or closed on GitHub (merger-hardening step 2)', () => {
  const MEMORO = { repo: 'memoro', repo_path: '/repos/memoro', branch: null, holder: { name: 'mb', kind: 'work-area' } };
  const jobFor = (pr, index) => ({ ...MEMORO, pr, since: `2026-10-10T17:0${index}:00Z` });

  /** A stub `gh`: `pr view <n> --json state,…` answers from `states`, anything else a body. */
  function stubGh(states) {
    const asked = [];
    const gh = (args, options) => {
      asked.push({ args, cwd: options?.cwd });
      if (!args.includes('state,mergeCommit,baseRefName')) return { status: 0, stdout: JSON.stringify({ body: 'b' }) };
      const said = states[Number(args[2])];
      if (said === undefined) return { status: 1, stdout: '', stderr: 'gh: not found' };
      return { status: 0, stdout: JSON.stringify(said) };
    };
    return { gh, asked };
  }
  const OPEN = { state: 'OPEN', mergeCommit: null, baseRefName: 'main' };
  const MERGED = { state: 'MERGED', mergeCommit: { oid: 'feed1234beef' }, baseRefName: 'main' };
  const CLOSED = { state: 'CLOSED', mergeCommit: null, baseRefName: 'main' };
  const two = {
    ok: true, merged: true, merge_commit: 'ccc', merged_into: 'main', off_default: false, stopped_at: null, pr: { number: 11, base: 'main' },
    batch: {
      prs: [11, 13], gate_ok: true, fallback: false, rounds: [],
      merges: [{ number: 11, merged: true, merge_commit: 'aaa', error: null }, { number: 13, merged: true, merge_commit: 'ccc', error: null }],
    },
  };

  it('a batch of three with the second MERGED: it is landed with GitHub\'s commit and dequeued, and the round gets the other two', async () => {
    mkdirSync(join(root, 'runner'), { recursive: true });
    writeFileSync(mergesPath(root), JSON.stringify([jobFor(11, 0), jobFor(12, 1), jobFor(13, 2)]));
    const { gh, asked } = stubGh({ 11: OPEN, 12: MERGED, 13: OPEN });
    const m = machine([two], { gh });
    await serve({ root, lock, take: () => true, release: () => {}, ...ONE_LANE, batchMax: 4, gh, say: m.deps.say, now: m.deps.now, land: (batch) => landJob(batch, m.deps) });
    assert.equal(m.rounds.length, 1);
    assert.deepEqual(m.rounds[0].prs, [11, 13]);
    assert.equal(m.rounds[0].pr, 11);
    assert.deepEqual(m.rows.map((r) => [r.pr, r.note]).sort((a, b) => a[0] - b[0]), [[11, 'merged'], [12, 'merged'], [13, 'merged']]);
    assert.deepEqual(queue(), []);
    assert.ok(m.said.includes('memoro #12: already merged on GitHub as feed123 — answered landed'));
    assert.ok(asked.some((a) => a.args[2] === '12' && a.cwd === '/repos/memoro'), 'asked in the job\'s repository');
  });

  it('CLOSED: that job is red with stopped_at closed, and the other two are measured and landed without it', async () => {
    const { gh } = stubGh({ 11: OPEN, 12: CLOSED, 13: OPEN });
    const m = machine([two], { gh });
    const answers = await landJob([jobFor(11, 0), jobFor(12, 1), jobFor(13, 2)], m.deps);
    assert.deepEqual(m.rounds[0].prs, [11, 13]);
    const closed = answers.find((a) => a.job.pr === 12);
    assert.equal(closed.landed, false);
    assert.equal(closed.report.stopped_at, 'closed');
    assert.equal(closed.report.reason, '#12 was closed on GitHub without merging');
  });

  it('every job MERGED: no round at all', async () => {
    const { gh } = stubGh({ 11: MERGED, 12: MERGED, 13: MERGED });
    const m = machine([], { gh });
    const answers = await landJob([jobFor(11, 0), jobFor(12, 1), jobFor(13, 2)], m.deps);
    assert.equal(m.rounds.length, 0);
    assert.deepEqual(answers.map((a) => a.landed), [true, true, true]);
  });

  it('gh failing or saying nothing keeps the job: the round decides as before', async () => {
    const { gh } = stubGh({ 11: OPEN, 12: { body: 'x' } });
    const m = machine([{ ...two, batch: { ...two.batch, prs: [11, 12, 13] } }], { gh });
    await landJob([jobFor(11, 0), jobFor(12, 1), jobFor(13, 2)], m.deps);
    assert.deepEqual(m.rounds[0].prs, [11, 12, 13]);
  });

  it('sweepMergedReds: a merged red entry is dequeued and answered landed, a closed one dequeued, an open one left', async () => {
    mkdirSync(join(root, 'runner'), { recursive: true });
    const redOf = (job) => ({ ...job, state: 'red', reason: 'red: x', answered: 'z' });
    writeFileSync(mergesPath(root), JSON.stringify([redOf(jobFor(11, 0)), redOf(jobFor(12, 1)), redOf(jobFor(13, 2)), jobFor(14, 3)]));
    const { gh, asked } = stubGh({ 11: MERGED, 12: CLOSED, 13: OPEN, 14: MERGED });
    const said = [];
    const dropped = await sweepMergedReds({ root, gh, lock, say: (line) => said.push(line) });
    assert.equal(dropped, 2);
    assert.deepEqual(queue().map((e) => [e.pr, e.state]), [[13, 'red'], [14, 'queued']]);
    assert.equal(asked.filter((a) => a.args.includes('state,mergeCommit,baseRefName')).length, 3, 'only red entries are asked about');
    assert.ok(said.includes('memoro #11: already merged on GitHub as feed123 — answered landed'));
  });

  it('serve sweeps once at start, before anything else, and not again within five minutes', async () => {
    mkdirSync(join(root, 'runner'), { recursive: true });
    writeFileSync(mergesPath(root), JSON.stringify([{ ...JOB, pr: 1 }]));
    let sweeps = 0;
    const order = [];
    await serve({
      root, lock, take: () => true, release: () => {},
      sweep: async () => { sweeps += 1; order.push('sweep'); },
      land: async ([job]) => { order.push(job.pr); return green; },
    });
    assert.equal(sweeps, 1);
    assert.deepEqual(order, ['sweep', 1]);
  });

  /** `serve` over 11, 12 and 13 with `landJob` as its `land`; `seen` is the queue as the round starts. */
  async function serveSeeing(m, gh, { landOver = {}, serveOver = {}, jobs = [jobFor(11, 0), jobFor(12, 1), jobFor(13, 2)], after = () => {} } = {}) {
    mkdirSync(join(root, 'runner'), { recursive: true });
    writeFileSync(mergesPath(root), JSON.stringify(jobs));
    const at = { seen: null, entries: null };
    await serve({
      root, lock, take: () => true, release: () => {}, ...ONE_LANE, batchMax: 4, gh, say: m.deps.say, now: m.deps.now,
      land: (batch, lane, extra) => landJob(batch, {
        ...m.deps, ...landOver, ...extra,
        mergeRound: async (options) => {
          at.entries = queue();
          at.seen = at.entries.map((e) => [e.pr, e.state]);
          const report = await m.deps.mergeRound(options);
          after();
          return report;
        },
      }),
      ...serveOver,
    });
    return at;
  }

  it('a member closed on GitHub is red in merges.json while the others\' round runs', async () => {
    const { gh } = stubGh({ 11: OPEN, 12: CLOSED, 13: OPEN });
    const m = machine([two], { gh });
    const { seen, entries } = await serveSeeing(m, gh);
    assert.deepEqual(seen, [[11, 'landing'], [12, 'red'], [13, 'landing']]);
    assert.equal(entries.find((e) => e.pr === 12).reason, 'closed: #12 was closed on GitHub without merging');
    assert.deepEqual(queue().map((e) => [e.pr, e.state]), [[12, 'red']]);
  });

  it('a member already merged is gone from merges.json while the round runs', async () => {
    const { gh } = stubGh({ 11: OPEN, 12: MERGED, 13: OPEN });
    const m = machine([two], { gh });
    const { seen } = await serveSeeing(m, gh);
    assert.deepEqual(seen, [[11, 'landing'], [13, 'landing']]);
    assert.deepEqual(queue(), []);
  });

});

describe('lanes (merge-throughput step 2)', () => {
  const take = () => true;
  const release = () => {};
  const MEMORO = { ...JOB, repo: 'memoro', repo_path: '/repos/memoro' };

  it('a memoro-cli job is answered while a memoro round runs, and the next memoro job waits for that round', async () => {
    mkdirSync(join(root, 'runner'), { recursive: true });
    writeFileSync(mergesPath(root), JSON.stringify([
      { ...MEMORO, pr: 1, since: '2026-10-10T12:01:00Z' },
      { ...JOB, pr: 2, since: '2026-10-10T12:02:00Z' },
    ]));
    const events = [];
    let finish = null;
    const memoroRound = new Promise((resolve) => { finish = resolve; });
    const lanesOf = [];
    await serve({
      root, lock, take, release, laneOf: LANE_OF,
      land: async ([job], lane) => {
        events.push(`start ${job.repo} #${job.pr}`);
        lanesOf.push([job.pr, lane]);
        if (job.pr === 1) {
          // Queued while the first memoro round runs: not in its batch, so a
          // second memoro round.
          queueMerge({ root, repo: 'memoro', repoPath: '/repos/memoro', pr: 3, lock, start: () => ({ pid: process.pid, started: false }) });
          await memoroRound;
          events.push('end memoro #1');
        }
        return green;
      },
      // The light loop, with nothing left in its lane, waits on the heavy one:
      // the memoro round is let go only from here, once memoro-cli's answer is
      // in the file.
      sleep: () => {
        const left = queue();
        if (!left.some((e) => e.pr === 2) && !events.includes('answered memoro-cli #2')) {
          events.push('answered memoro-cli #2');
          assert.equal(left.find((e) => e.pr === 1).state, 'landing', 'the memoro round is still running');
          assert.equal(events.includes('start memoro #3'), false, 'no second memoro round beside the first');
          finish();
        }
        return new Promise((resolve) => { setImmediate(resolve); });
      },
    });
    assert.deepEqual(events, ['start memoro #1', 'start memoro-cli #2', 'answered memoro-cli #2', 'end memoro #1', 'start memoro #3']);
    assert.deepEqual(lanesOf, [[1, 'memoro'], [2, 'memoro-cli'], [3, 'memoro']]);
    assert.deepEqual(queue(), []);
  });

  it('a job waits only on a round in its own lane', async () => {
    const lanesAsked = [];
    const memoroBusy = ({ lane }) => { lanesAsked.push(lane); return lane === 'memoro' ? { pid: 9, repo: 'memoro', pr: 1, lane } : null; };
    const m = machine([green], { readRunningRound: memoroBusy, lane: 'memoro-cli' });
    await landJob(JOB, m.deps);
    assert.equal(m.rounds.length, 1);
    assert.deepEqual([...new Set(lanesAsked)], ['memoro-cli']);
    assert.equal(m.said.some((line) => /waiting behind/u.test(line)), false, 'a heavy round does not hold a light job');
  });

  it('a round in its own lane is waited for, and the wait names the lane', async () => {
    let polls = 0;
    const m = machine([green], {
      lane: 'memoro-cli',
      readRunningRound: ({ lane }) => (lane === 'memoro-cli' && polls++ < 2 ? { pid: 9, repo: 'memoro-cli', pr: 5, lane } : null),
    });
    await landJob(JOB, m.deps);
    assert.ok(m.said.some((line) => /waiting behind another gate round in the memoro-cli lane \(memoro-cli #5, pid 9\)/u.test(line)), m.said.join('\n'));
  });

  it('asked to stop, each lane leaves between its jobs and the merger leaves once both have', async () => {
    mkdirSync(join(root, 'runner'), { recursive: true });
    writeFileSync(mergesPath(root), JSON.stringify([
      { ...MEMORO, pr: 1, since: 'a' }, { ...JOB, pr: 2, since: 'b' },
    ]));
    let stop = false;
    const landed = [];
    const code = await serve({
      root, lock, take, release, laneOf: LANE_OF, stopping: () => stop,
      // Asked once both lanes have a round in flight, and one more job
      // queued behind memoro-cli's.
      land: async ([job]) => {
        landed.push(job.pr);
        if (job.pr === 2) queueMerge({ root, repo: 'memoro-cli', repoPath: '/r', pr: 4, lock, start: () => ({ pid: process.pid, started: false }) });
        stop = landed.length === 2;
        return green;
      },
    });
    assert.equal(code, 0);
    assert.deepEqual(landed, [1, 2], 'the round in flight in each lane finished; nothing new started');
    assert.deepEqual(queue().map((e) => e.pr), [4]);
  });
});

describe('a round watches its pull request (round-abort)', () => {
  const PR = { repo: 'memoro', repo_path: '/repos/memoro', pr: 14169 };
  const MERGED = { state: 'MERGED', mergeCommit: { oid: 'feed1234beef' }, baseRefName: 'main', headRefOid: 'aaa' };
  const CLOSED = { state: 'CLOSED', mergeCommit: null, baseRefName: 'main', headRefOid: 'aaa' };
  const OPEN = { state: 'OPEN', mergeCommit: null, baseRefName: 'main', headRefOid: 'aaa' };
  const REQUEST = { args: ['pr', 'view', '14169', '--json', 'state,headRefOid,mergeCommit,baseRefName'], cwd: '/repos/memoro' };

  /** A fake `gh` answering `pr view` with `facts`, or failing when `facts` is undefined; every call is recorded. */
  function viewing(facts) {
    const asked = [];
    const gh = (args, options) => {
      asked.push({ args, cwd: options?.cwd });
      return facts === undefined ? { status: 1, stdout: '', stderr: 'gh: not found' } : { status: 0, stdout: JSON.stringify(facts) };
    };
    return { gh, asked };
  }

  // Drive the real watch callback explicitly. Wall-clock sleeps can expire
  // before a second interval fires when the merge gate's event loop is busy.
  function watching(options) {
    let check;
    let active = false;
    const stop = watchSubject({
      ...options,
      setTimer: (callback) => { check = callback; active = true; return 1; },
      clearTimer: () => { active = false; },
    });
    return {
      stop,
      // Also permit a dispatched callback after cancellation, to exercise
      // the watcher's own stop guard rather than hiding it in this fixture.
      tick: () => check(),
      get active() { return active; },
    };
  }

  it('SUBJECT_POLL_MS is a minute', () => {
    assert.equal(SUBJECT_POLL_MS, 60_000);
  });

  it('MERGED: one onGone of kind merged with the commit and the base, and no check after it', async () => {
    const { gh, asked } = viewing(MERGED);
    const gone = [];
    const watch = watching({ job: PR, gh, startHead: 'aaa', every: 5, onGone: (facts) => gone.push(facts) });
    await watch.tick();
    await watch.tick();
    assert.equal(watch.active, false);
    assert.equal(gone.length, 1);
    assert.equal(gone[0].kind, 'merged');
    assert.equal(gone[0].sha, 'feed1234beef');
    assert.equal(gone[0].base, 'main');
    assert.equal(gone[0].reason, '#14169 was merged on GitHub as feed123 while its round ran — the round is stopped');
    assert.equal(asked.length, 1);
    assert.deepEqual(asked[0], { args: ['pr', 'view', '14169', '--json', 'state,headRefOid,mergeCommit,baseRefName'], cwd: '/repos/memoro' });
  });

  it('CLOSED: one onGone of kind closed', async () => {
    const { gh } = viewing(CLOSED);
    const gone = [];
    const watch = watching({ job: PR, gh, startHead: 'aaa', every: 5, onGone: (facts) => gone.push(facts) });
    await watch.tick();
    await watch.tick();
    assert.equal(watch.active, false);
    assert.equal(gone.length, 1);
    assert.equal(gone[0].kind, 'closed');
    assert.equal(gone[0].reason, '#14169 was closed on GitHub while its round ran — the round is stopped');
  });

  it('OPEN with a head other than the start one: one onGone of kind pushed, with the new head', async () => {
    const { gh } = viewing({ ...OPEN, headRefOid: 'bbb1111222' });
    const gone = [];
    const watch = watching({ job: PR, gh, startHead: 'aaa', every: 5, onGone: (facts) => gone.push(facts) });
    await watch.tick();
    await watch.tick();
    assert.equal(watch.active, false);
    assert.equal(gone.length, 1);
    assert.equal(gone[0].kind, 'pushed');
    assert.equal(gone[0].sha, 'bbb1111222');
    assert.equal(gone[0].reason, '#14169 got a new push (bbb1111) while its round ran — stopped; back in line at its place');
  });

  it('OPEN with the start head, or no start head to compare: checked on, nothing called', async () => {
    const same = viewing(OPEN);
    const none = viewing({ ...OPEN, headRefOid: 'bbb' });
    const gone = [];
    const watches = [
      watching({ job: PR, gh: same.gh, startHead: 'aaa', every: 5, onGone: (facts) => gone.push(facts) }),
      watching({ job: PR, gh: none.gh, startHead: null, every: 5, onGone: (facts) => gone.push(facts) }),
    ];
    for (const watch of watches) {
      await watch.tick();
      assert.equal(watch.active, true);
      await watch.tick();
      assert.equal(watch.active, true);
      watch.stop();
      assert.equal(watch.active, false);
    }
    assert.deepEqual(gone, []);
    assert.deepEqual(same.asked, [REQUEST, REQUEST]);
    assert.deepEqual(none.asked, [REQUEST, REQUEST]);
  });

  it('a gh that fails or says nothing sensible: no call, and the checks go on', async () => {
    const failing = viewing(undefined);
    const gone = [];
    const watch = watching({ job: PR, gh: failing.gh, startHead: 'aaa', every: 5, onGone: (facts) => gone.push(facts) });
    await watch.tick();
    assert.equal(watch.active, true);
    await watch.tick();
    assert.equal(watch.active, true);
    watch.stop();
    assert.equal(watch.active, false);
    assert.deepEqual(gone, []);
    assert.deepEqual(failing.asked, [REQUEST, REQUEST]);
  });

  it('onGone is not called twice, though the checks would say so again', async () => {
    const { gh, asked } = viewing(MERGED);
    const gone = [];
    const watch = watching({ job: PR, gh, startHead: 'aaa', every: 5, onGone: (facts) => gone.push(facts) });
    await watch.tick();
    await watch.tick();
    watch.stop();
    assert.equal(watch.active, false);
    assert.equal(gone.length, 1);
    assert.equal(asked.length, 1);
  });

  it('after stop() no further gh call is made', async () => {
    const { gh, asked } = viewing(OPEN);
    const watch = watching({ job: PR, gh, startHead: 'aaa', every: 5, onGone: () => assert.fail('not gone') });
    await watch.tick();
    watch.stop();
    assert.equal(watch.active, false);
    const count = asked.length;
    await watch.tick();
    assert.equal(asked.length, count);
  });

  it('landJob: MERGED while the round runs stops it and answers the job landed, already merged', async () => {
    const rounds = [];
    const gh = (args) => {
      if (args.includes('state,headRefOid,mergeCommit,baseRefName')) return { status: 0, stdout: JSON.stringify(MERGED) };
      if (args.includes('headRefOid')) return { status: 0, stdout: JSON.stringify({ headRefOid: 'aaa' }) };
      return { status: 0, stdout: JSON.stringify(OPEN) };
    };
    const m = machine([], {
      gh, watchMs: 5,
      mergeRound: (options) => {
        rounds.push(options);
        return new Promise((resolve) => {
          options.signal.addEventListener('abort', () => resolve({ ok: false, merged: false, stopped_at: 'gone', reason: options.signal.reason.message }));
        });
      },
    });
    const answers = await landJob({ ...JOB, pr: 671 }, m.deps);
    assert.equal(rounds[0].signal.aborted, true);
    assert.equal(answers[0].landed, true);
    assert.equal(answers[0].report.already_merged, true);
    assert.equal(answers[0].report.merge_commit, 'feed1234beef');
    assert.equal(m.rows.at(-1).note, 'merged');
    assert.deepEqual(queue(), [], 'nothing queued by the round');
  });

  it('landJob: CLOSED while the round runs answers the job closed, not landed', async () => {
    const gh = (args) => {
      if (args.includes('state,headRefOid,mergeCommit,baseRefName')) return { status: 0, stdout: JSON.stringify(CLOSED) };
      if (args.includes('headRefOid')) return { status: 0, stdout: JSON.stringify({ headRefOid: 'aaa' }) };
      return { status: 0, stdout: JSON.stringify(OPEN) };
    };
    const m = machine([], {
      gh, watchMs: 5,
      mergeRound: (options) => new Promise((resolve) => {
        options.signal.addEventListener('abort', () => resolve({ ok: false, merged: false, stopped_at: 'gone', reason: options.signal.reason.message }));
      }),
    });
    const answers = await landJob({ ...JOB, pr: 671 }, m.deps);
    assert.equal(answers[0].landed, false);
    assert.equal(answers[0].report.stopped_at, 'closed');
    assert.equal(answers[0].back, undefined);
  });

  it('landJob: a new push while the round runs answers the job back in line — no red', async () => {
    const gh = (args) => {
      if (args.includes('state,headRefOid,mergeCommit,baseRefName')) return { status: 0, stdout: JSON.stringify({ ...OPEN, headRefOid: 'bbb' }) };
      if (args.includes('headRefOid')) return { status: 0, stdout: JSON.stringify({ headRefOid: 'aaa' }) };
      return { status: 0, stdout: JSON.stringify(OPEN) };
    };
    const m = machine([], {
      gh, watchMs: 5,
      mergeRound: (options) => new Promise((resolve) => {
        options.signal.addEventListener('abort', () => resolve({ ok: false, merged: false, stopped_at: 'gone', reason: options.signal.reason.message }));
      }),
    });
    const answers = await landJob({ ...JOB, pr: 671 }, m.deps);
    assert.equal(answers[0].landed, false);
    assert.equal(answers[0].back, true);
    assert.equal(answers[0].report.stopped_at, 'pushed');
    assert.equal(answers[0].requeued, undefined);
    assert.ok(m.said.includes('memoro-cli #671: #671 got a new push (bbb) while its round ran — stopped; back in line at its place'));
  });

  it('serve: a pushed job is put back in line at its place — queued, since and requeues unchanged', async () => {
    mkdirSync(join(root, 'runner'), { recursive: true });
    const since = '2026-10-09T12:01:00Z';
    writeFileSync(mergesPath(root), JSON.stringify([{ ...JOB, since, requeues: 1 }]));
    const seen = [];
    let rounds = 0;
    await serve({
      root, lock, take: () => true, release: () => {}, ...ONE_LANE,
      land: async ([job], lane, { onAnswer }) => {
        rounds += 1;
        if (rounds > 1) return [{ job, landed: true, report: green }];
        const answer = { job, landed: false, report: { ok: false, merged: false, stopped_at: 'pushed', reason: '#671 got a new push' }, back: true };
        await onAnswer(answer);
        const entry = queue().find((item) => item.pr === job.pr);
        seen.push({ state: entry.state, since: entry.since, requeues: entry.requeues });
        return [answer];
      },
    });
    assert.equal(rounds, 2, 'the job is taken again, at its place');
    assert.deepEqual(seen, [{ state: 'queued', since, requeues: 1 }]);
  });
});

describe('the pid file', () => {
  it('one merger at a time; a dead one\'s file is taken over; release is only the owner\'s', () => {
    const dead = 2 ** 22 - 1;
    assert.equal(takeMerger({ root, pid: 111, alive: (pid) => pid === 111 }), true);
    assert.equal(takeMerger({ root, pid: 222, alive: (pid) => pid === 111 }), false, '111 is alive');
    assert.equal(readMerger({ root, alive: () => true }).pid, 111);
    assert.equal(releaseMerger({ root, pid: 222 }), false);
    writeFileSync(mergerPath(root), JSON.stringify({ pid: dead, since: 'x' }));
    assert.equal(readMerger({ root, alive: (pid) => pid !== dead }), null);
    assert.equal(takeMerger({ root, pid: 333, alive: (pid) => pid !== dead }), true);
    assert.equal(releaseMerger({ root, pid: 333 }), true);
    assert.equal(existsSync(mergerPath(root)), false);
  });

  it('startMerger starts none while one runs, and keeps a session\'s step out of the one it starts', () => {
    const spawned = [];
    const spawn = (bin, args, options) => { spawned.push({ bin, args, options }); return { pid: 4321, unref() {} }; };
    writeFileSync(join(root, 'x'), '');
    mkdirSync(join(root, 'runner'), { recursive: true });
    writeFileSync(mergerPath(root), JSON.stringify({ pid: 111 }));
    assert.deepEqual(startMerger({ root, spawn, alive: () => true }), { pid: 111, started: false });
    assert.equal(spawned.length, 0);
    const started = startMerger({ root, spawn, alive: () => false, env: { PATH: '/bin', MC_STEP: 'mq:0', MC_WORKAREA: '/w' } });
    assert.deepEqual(started, { pid: 4321, started: true });
    assert.equal(spawned[0].options.detached, true);
    assert.equal(spawned[0].options.env.MC_STEP, undefined);
    assert.equal(spawned[0].options.env.MC_WORKAREA, undefined);
    assert.equal(spawned[0].options.env.PATH, '/bin');
    assert.equal(spawned[0].options.env.MC_WORK_ROOT, root);
  });

  // merger-hardening step 1: on 2026-10-10 a step session's `node src/mc-cli.js
  // merge` started merger 14366 on its own branch's code.
  it('startMerger runs the merger-run.js of the checkout the mc on PATH links into, not its own', () => {
    const checkout = join(root, 'installed');
    mkdirSync(join(checkout, 'src', 'mc'), { recursive: true });
    writeFileSync(join(checkout, 'src', 'mc-cli.js'), '#!/usr/bin/env node\n', { mode: 0o755 });
    writeFileSync(join(checkout, 'src', 'mc', 'merger-run.js'), '');
    execFileSync('git', ['init', '-q', checkout]);
    const bin = join(root, 'bin');
    mkdirSync(bin);
    symlinkSync(join(checkout, 'src', 'mc-cli.js'), join(bin, 'mc'));
    const spawned = [];
    const spawn = (_bin, args) => { spawned.push(args); return { pid: 4321, unref() {} }; };

    startMerger({ root, spawn, alive: () => false, env: { PATH: `${join(root, 'nothing')}:${bin}` } });
    assert.equal(spawned[0][0], join(realpathSync(checkout), 'src', 'mc', 'merger-run.js'));
    assert.notEqual(spawned[0][0], fileURLToPath(new URL('../../src/mc/merger-run.js', import.meta.url)));
    assert.equal(existsSync(join(root, 'runner', 'log', 'merger.log')) && readFileSync(join(root, 'runner', 'log', 'merger.log'), 'utf8'), '');
  });

  it('with no mc on PATH it falls back to its own merger-run.js and says so in the log', () => {
    const spawned = [];
    const spawn = (_bin, args) => { spawned.push(args); return { pid: 4321, unref() {} }; };
    const own = fileURLToPath(new URL('../../src/mc/merger-run.js', import.meta.url));
    startMerger({ root, spawn, alive: () => false, env: { PATH: join(root, 'nothing') }, now: () => new Date('2026-10-10T18:00:00Z') });
    assert.equal(spawned[0][0], own);
    assert.equal(readFileSync(join(root, 'runner', 'log', 'merger.log'), 'utf8'),
      `2026-10-10T18:00:00.000Z  merger started from ${own} — no installed mc found\n`);
  });

  it('serve\'s first line names the checkout and its commit, and merger.json keeps the commit', async () => {
    const said = [];
    let held = null;
    await serve({
      root, lock, ...ONE_LANE, say: (line) => said.push(line),
      version: { checkout: '~/memoro-cli', commit: '7238d3e' },
      release: () => { held ??= JSON.parse(readFileSync(mergerPath(root), 'utf8')); return releaseMerger({ root }); },
      land: async () => green,
    });
    assert.equal(said[0], `merger ${process.pid} started — ~/memoro-cli at 7238d3e`);
    assert.equal(held.pid, process.pid);
    assert.equal(held.commit, '7238d3e');
  });
});

describe('queueMerge', () => {
  it('the job first, then a merger', () => {
    const order = [];
    const result = queueMerge({
      root, repo: 'memoro-cli', repoPath: '/repos/memoro-cli', pr: 671, branch: 'mq',
      lock, now: new Date('2026-10-09T12:00:00Z'),
      start: () => { order.push(['start', queue().length]); return { pid: 9, started: true }; },
    });
    assert.deepEqual(order, [['start', 1]]);
    assert.equal(result.place, 0);
    assert.equal('step' in queue()[0], false, 'a job carries no step');
  });
});

describe('no round holds the other lane, and a SIGTERM finishes what is in flight (merger-hardening step 5)', () => {
  const take = () => true;
  const release = () => {};
  const MEMORO = { ...JOB, repo: 'memoro', repo_path: '/repos/memoro' };
  const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

  it('a light job queued while the heavy round is held open starts and is answered before it resolves', async () => {
    mkdirSync(join(root, 'runner'), { recursive: true });
    writeFileSync(mergesPath(root), JSON.stringify([{ ...MEMORO, pr: 1, since: 'a' }]));
    const events = [];
    const lanesAsked = [];
    const signals = [];
    let lightGoneAtHeavyEnd = null;
    // The heavy round is held open until the light job is answered and
    // dequeued, not for a fixed time: the light lane runs this suite beside a
    // memoro round, and on that loaded machine a fixed 300 ms ran out first
    // (#872, 2026-10-11). The deadline only keeps a light lane that never
    // comes from hanging the test.
    let lightAnswered = false;
    const lightGone = async (deadline) => {
      while (Date.now() < deadline) {
        if (lightAnswered && !queue().some((e) => e.pr === 2)) return true;
        await pause(5);
      }
      return false;
    };
    let lightInTime = false;
    const m = machine([], {
      readRunningRound: ({ lane }) => { lanesAsked.push(lane); return null; },
      mergeRound: async (options) => {
        signals.push(options.signals);
        if (options.repoPath === '/repos/memoro') {
          events.push('heavy start');
          queueMerge({ root, repo: 'memoro-cli', repoPath: '/repos/memoro-cli', pr: 2, lock, start: () => ({ pid: process.pid, started: false }) });
          lightInTime = await lightGone(Date.now() + 5000);
          lightGoneAtHeavyEnd = !queue().some((e) => e.pr === 2);
          events.push('heavy end');
        } else {
          events.push('memoro-cli');
        }
        return green;
      },
    });
    const say = (line) => {
      m.said.push(line);
      if (/^memoro-cli #2: merged/u.test(line)) lightAnswered = true;
    };
    const code = await serve({
      root, lock, take, release, laneOf: LANE_OF, say, now: m.deps.now,
      sleep: () => pause(5),
      land: landerFor({ ...m.deps, say }),
    });
    assert.equal(code, 0);
    assert.deepEqual(events, ['heavy start', 'memoro-cli', 'heavy end']);
    assert.equal(lightGoneAtHeavyEnd, true, 'the light job was answered and dequeued before the heavy round resolved');
    assert.equal(lightInTime, true, 'the light job was answered while the heavy round was held open');
    assert.deepEqual(lanesAsked, ['memoro', 'memoro-cli'], 'each job reads the round in its own lane');
    assert.deepEqual(signals, [false, false], 'the gate installs no signal handler in the merger');
    assert.deepEqual(queue(), []);
  });

  it('stopping() turned true mid-round: the round is answered as usual, no killed, and serve returns 0 within a second', async () => {
    // Another repository in the same lane, so not in the first job's batch.
    mkdirSync(join(root, 'runner'), { recursive: true });
    writeFileSync(mergesPath(root), JSON.stringify([{ ...JOB, since: 'a' }, { ...JOB, repo: 'other', pr: 672, since: 'b' }]));
    let stop = false;
    let answeredAt = null;
    const m = machine([], {
      mergeRound: async () => { stop = true; await pause(50); return green; },
    });
    const say = (line) => {
      m.said.push(line);
      if (/^memoro-cli #671: merged/u.test(line)) answeredAt = Date.now();
    };
    const code = await serve({
      root, lock, take, release, laneOf: () => 'memoro-cli', stopping: () => stop, say, now: m.deps.now,
      sleep: () => pause(5),
      land: landerFor({ ...m.deps, say }),
    });
    const leftAt = Date.now();
    assert.equal(code, 0);
    assert.equal(m.rows[0]?.note, 'merged', 'the round in flight was answered');
    assert.deepEqual(queue().map((e) => [e.pr, e.state]), [[672, 'queued']], 'the next job waits for the next start');
    assert.equal(m.said.some((line) => /killed/u.test(line)), false, m.said.join('\n'));
    assert.equal(m.said.filter((line) => line === 'asked to stop — waiting for 1 job(s) in flight').length, 1, m.said.join('\n'));
    assert.equal(m.said.at(-1), 'left');
    assert.ok(answeredAt !== null && leftAt - answeredAt < 1000);
  });

  it('a conflict on a pull request is red at once (ruling 30): no mend', async () => {
    const conflict = { ok: false, merged: false, stopped_at: 'merge', reason: 'CONFLICT (content): Merge conflict in a.js' };
    const m = machine([conflict]);
    const [answer] = await landJob({ ...JOB, pr: 671 }, m.deps);
    assert.equal(answer.landed, false);
    assert.deepEqual(Object.keys(answer).sort(), ['job', 'landed', 'report']);
    assert.equal(m.rows[0].note, 'red,merge');
    assert.equal(m.said.filter((line) => /mend/u.test(line)).length, 0, m.said.join('\n'));
  });

});


describe('a session decision to merge a goal', () => {
  const GOAL = { programme: 'mc', goal: 'g', dir: '/programs/mc/goals/g' };
  const jobs = [
    { ...JOB, repo: 'memoro-cli', pr: 90, goal: GOAL, sha: 'old-reviewed-head' },
    { ...JOB, repo: 'memoro', repo_path: '/repos/memoro', pr: 14804, goal: GOAL },
  ];

  function decision({ conflict = false } = {}) {
    let goal = { ...GOAL, stage: 'merge', status: 'ready', prs: jobs.map(({ repo, pr }) => ({ repo, pr })),
      success_criteria: [{ criterion: 'not checked again', check: 'none', met: false }], log: [], problems: [] };
    const calls = [];
    const landed = new Set();
    const writes = [];
    const pulled = [];
    const gh = (args, { cwd }) => {
      calls.push({ args, cwd });
      const pr = Number(args[2]);
      if (args[1] === 'merge') {
        if (landed.has(pr)) return { status: 1, stderr: 'already merged' };
        if (conflict && pr === 14804) return { status: 1, stderr: 'CONFLICT (content): a.js' };
        landed.add(pr);
        return { status: 0, stdout: '' };
      }
      return { status: 0, stdout: JSON.stringify(landed.has(pr)
        ? { state: 'MERGED', mergeCommit: { oid: `commit-${pr}` }, baseRefName: 'main' }
        : { state: 'OPEN' }) };
    };
    const m = machine([], {
      gh, goalsOf: () => [goal], afterLanding: (job) => { pulled.push(job.pr); },
      noteGoal: ({ entry }) => { goal.log.push(entry); },
      setGoal: (change) => {
        writes.push(change);
        goal = { ...goal, ...(change.stage ? { stage: change.stage } : {}), ...(change.status ? { status: change.status } : {}), log: [...goal.log, { ...change.entry, stage: change.stage ?? goal.stage, status: change.status ?? goal.status }] };
        return { goal };
      },
    });
    return { m, calls, writes, landed, pulled, goal: () => goal };
  }

  it('merges both repositories directly and sets done only after the last landing', async () => {
    const d = decision();
    assert.equal((await landJob(jobs[0], d.m.deps))[0].landed, true);
    assert.equal(d.goal().stage, 'merge');
    assert.equal((await landJob(jobs[1], d.m.deps))[0].landed, true);
    assert.deepEqual([d.goal().stage, d.goal().status], ['done', 'ready']);
    assert.deepEqual(d.m.rounds, [], 'no gate round');
    assert.deepEqual(d.pulled, [90, 14804], 'successful landings still update installations');
    assert.deepEqual(d.calls.filter(({ args }) => args[1] === 'merge'), [
      { args: ['pr', 'merge', '90', '--squash'], cwd: '/repos/memoro-cli' },
      { args: ['pr', 'merge', '14804', '--squash'], cwd: '/repos/memoro' },
    ]);
    assert.equal(d.calls.some(({ args }) => args.includes('headRefOid')), false);
  });

  it('blocks a content conflict on the first attempt and keeps repeated failures blocked', async () => {
    const d = decision({ conflict: true });
    await landJob(jobs[0], d.m.deps);
    const [answer] = await landJob(jobs[1], d.m.deps);
    assert.equal(answer.landed, false);
    assert.equal(answer.report.reason, 'CONFLICT (content): a.js');
    assert.deepEqual(d.pulled, [90], 'a failed merge does not update the installation');
    assert.deepEqual([d.goal().stage, d.goal().status], ['merge', 'blocked']);
    assert.equal(d.goal().log.at(-1).done, 'merger answered red on #14804');
    await landJob(jobs[1], d.m.deps);
    assert.deepEqual([d.goal().stage, d.goal().status], ['merge', 'blocked']);
    assert.deepEqual(d.m.rounds, []);
  });

  it('recovers a landing made before the previous process recorded its answer', async () => {
    const d = decision();
    d.landed.add(90);
    await landJob(jobs[0], d.m.deps);
    await landJob(jobs[1], d.m.deps);
    assert.equal(d.goal().stage, 'done');
  });

  // GitHub unreachable for the direct merge: the call failed, or it ran and the confirmation could not be read.
  function unreachable({ mergeRuns = false } = {}) {
    const d = decision();
    const gh = (args) => {
      d.calls.push({ args });
      if (args[1] === 'merge' && !mergeRuns) return { status: 1, stderr: 'error connecting to api.github.com' };
      if (args[1] === 'merge') return { status: 0, stdout: '' };
      return { status: 1, stderr: 'dial tcp: lookup api.github.com: no such host — Could not resolve host: api.github.com' };
    };
    return { d, deps: { ...d.m.deps, gh } };
  }

  it('a merge decision GitHub cannot be reached for is put back in line, and the goal stays merge · ready', async () => {
    for (const mergeRuns of [false, true]) {
      const { d, deps } = unreachable({ mergeRuns });
      const [answer] = await landJob(jobs[0], deps);
      assert.deepEqual([d.goal().stage, d.goal().status], ['merge', 'ready'], 'no recovery session for the network');
      assert.equal(answer.landed, false);
      assert.equal(answer.offline, true, answer.report.reason);
      assert.equal(answer.report.stopped_at, 'offline');
      assert.match(answer.report.reason, mergeRuns ? /^gh pr view 90 could not reach GitHub/u : /^gh pr merge 90 --squash could not reach GitHub \(error connecting to api\.github\.com\)/u);
      assert.deepEqual(d.writes, []);
      assert.deepEqual(d.goal().log, []);
      assert.ok(d.m.said.some((line) => /: offline: .* — back in line in 1 min \(offline 1 of 6\), no session started$/u.test(line)), d.m.said.join('\n'));
    }
  });

  it('a merge decision still unreachable on the sixth answer blocks the goal in merge, saying the network was down', async () => {
    const { d, deps } = unreachable();
    const [answer] = await landJob({ ...jobs[0], offline: 5 }, deps);
    assert.equal(answer.offline, undefined);
    assert.deepEqual([d.goal().stage, d.goal().status], ['merge', 'blocked']);
    assert.match(d.goal().log.at(-1).comment, /unreachable for at least 30 min \(6 rounds in a row\)/u);
  });

  it('a merge decision GitHub refuses is still red at once, not offline', async () => {
    const d = decision({ conflict: true });
    const [answer] = await landJob(jobs[1], d.m.deps);
    assert.equal(answer.offline, undefined);
    assert.equal(answer.report.stopped_at, 'merge');
  });

  it('a PR linked to a goal uses its merge decision even without job.goal', async () => {
    const d = decision();
    await landJob({ ...jobs[0], goal: null }, d.m.deps);
    assert.deepEqual(d.m.rounds, []);
    assert.match(d.goal().log.at(-1).done, /^memoro-cli#90 landed/u);
  });
});

// Ordinary PR jobs still use their existing round and goal association.
it('ordinary PR failure leaves a linked build goal in build, and another repository PR tells no goal', async () => {
  const goal = { programme: 'mc', goal: 'g', dir: '/programs/mc/goals/g', stage: 'build', status: 'ready', prs: [{ repo: JOB.repo, pr: JOB.pr }], log: [], problems: [] };
  const sets = [];
  const notes = [];
  const m = machine([red], { goalsOf: () => [goal], setGoal: (call) => sets.push(call), noteGoal: (call) => notes.push(call) });
  await landJob(JOB, m.deps);
  assert.equal(m.rounds.length, 1);
  assert.deepEqual(sets, []);
  assert.deepEqual(notes.map(({ entry }) => [entry.stage, entry.status]), [['build', 'ready']]);
  const other = machine([green], { goalsOf: () => [{ ...goal, prs: [{ repo: 'memoro', pr: JOB.pr }] }], setGoal: (call) => sets.push(call), noteGoal: (call) => notes.push(call) });
  await landJob(JOB, other.deps);
  assert.equal(other.rounds.length, 1);
  assert.deepEqual(sets, []);
  assert.equal(notes.length, 1);
});
