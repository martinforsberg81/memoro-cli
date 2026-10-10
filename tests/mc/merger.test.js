/**
 * The merger (ruling 30): one process that lands the queued pull requests one
 * at a time, and writes what came of each into the register.
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
import { MAX_MERGE_ATTEMPTS } from '../../src/mc/merge-step.js';
import {
  landerFor, landJob, mergerPath, queueMerge, readMerger, releaseMerger, restack, serve, startMerger, sweepMergedReds, takeMerger,
} from '../../src/mc/merger.js';
import { registerPath } from '../../src/mc/register.js';

let root = null;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'mc-merger-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const lock = (_root, fn) => fn();
// One loop for every repository: the tests of order and batching across
// repositories predate the lanes (ruling 34), which land memoro and
// memoro-cli side by side; `lanes (merge-throughput step 2)` tests those.
const ONE_LANE = { lanes: ['heavy'], laneOf: () => 'heavy' };
const LANE_OF = (job) => (job.repo === 'memoro-cli' ? 'light' : 'heavy');
const queue = () => parseQueue(existsSync(mergesPath(root)) ? readFileSync(mergesPath(root), 'utf8') : null);

function register(stepOver = {}) {
  mkdirSync(join(root, 'runner', 'projects'), { recursive: true });
  writeFileSync(registerPath(root, 'mq'), JSON.stringify({
    project: 'mq', repo: 'memoro-cli', programme: 'mc', plan: 'docs/project/mc/mq/PLAN.json',
    steps: [{ status: 'landing', pr: 671, branch: 'mq', comments: [], attempts: 0, ...stepOver }],
  }));
}
const stepNow = () => JSON.parse(readFileSync(registerPath(root, 'mq'), 'utf8')).steps[0];

const JOB = { repo: 'memoro-cli', repo_path: '/repos/memoro-cli', pr: 671, branch: 'mq', holder: { name: 'mq', kind: 'work-area' }, step: { project: 'mq', index: 0 } };

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
  it('green: the step is done with the commit, the round ran as the job\'s holder, one runs.tsv row', async () => {
    register();
    const m = machine([green]);
    await landJob(JOB, m.deps);
    const step = stepNow();
    assert.equal(step.status, 'done');
    assert.equal(step.landed.sha, 'abc1234def');
    assert.equal(m.rounds.length, 1);
    assert.equal(m.rounds[0].pr, 671);
    assert.equal('prs' in m.rounds[0], false, 'one job is the single round it always was');
    assert.deepEqual(m.rounds[0].holder, JOB.holder);
    assert.equal(m.rounds[0].repoPath, '/repos/memoro-cli');
    assert.equal(m.rows[0].note, 'merged');
    assert.equal(m.rows[0].kind, 'merge');
    assert.equal(m.rows[0].name, 'mq');
  });

  it('a landed pull request leaves the page\'s PR cache at once; a red one stays', async () => {
    register();
    const dropped = [];
    await landJob(JOB, machine([green], { dropFromPage: (pr) => dropped.push(pr) }).deps);
    assert.deepEqual(dropped, [{ root, repo: 'memoro-cli', number: 671 }]);
    register();
    const kept = [];
    await landJob(JOB, machine([red], { dropFromPage: (pr) => kept.push(pr) }).deps);
    assert.deepEqual(kept, []);
  });

  it('red: the step is ready again with the reason, the attempt and the pull request — the next session\'s', async () => {
    register();
    const m = machine([red]);
    await landJob(JOB, m.deps);
    const step = stepNow();
    assert.equal(step.status, 'ready');
    assert.equal(step.attempts, 1);
    assert.equal(step.reason, '2 tests red: a › b');
    assert.equal(step.pr, 671);
    assert.equal(m.rows[0].note, 'red,red');
    assert.ok(m.said.some((line) => /ready again \(attempt 1\)/u.test(line)));
  });

  it(`red on the ${MAX_MERGE_ATTEMPTS}th attempt is failed — a person's`, async () => {
    register({ attempts: MAX_MERGE_ATTEMPTS - 1 });
    await landJob(JOB, machine([red]).deps);
    const step = stepNow();
    assert.equal(step.status, 'failed');
    assert.match(step.reason, new RegExp(`attempt ${MAX_MERGE_ATTEMPTS} of ${MAX_MERGE_ATTEMPTS}`, 'u'));
  });

  it('a round that cannot say whether it merged is failed at once', async () => {
    register();
    await landJob(JOB, machine([{ ok: false, stopped_at: 'merge-unknown', reason: 'timed out on the reply' }]).deps);
    assert.equal(stepNow().status, 'failed');
  });

  it('waits behind another gate round before running its own, saying so once', async () => {
    register();
    let polls = 0;
    const m = machine([green], { readRunningRound: () => (polls++ < 3 ? { pid: 9, repo: 'memoro', pr: 1 } : null) });
    await landJob(JOB, m.deps);
    assert.equal(m.rounds.length, 1, 'no round while the lock is held');
    assert.equal(m.said.filter((line) => /waiting behind another gate round/u.test(line)).length, 1);
    assert.equal(stepNow().status, 'done');
  });

  it('waits while a deploy runs, and lands after it', async () => {
    register();
    let polls = 0;
    const m = machine([green], { readRunningDeploy: () => (polls++ < 2 ? { pid: 7, sha: 'c6b53f26a6f7' } : null) });
    await landJob(JOB, m.deps);
    assert.equal(m.rounds.length, 1, 'no round while the deploy runs');
    assert.equal(m.said.filter((line) => /waiting behind the deploy of c6b53f2 \(pid 7\)/u.test(line)).length, 1);
    assert.equal(stepNow().status, 'done');
  });

  it('a round that lost the race for the lock is run again, not answered', async () => {
    register();
    const m = machine([{ ok: false, stopped_at: 'busy', reason: 'another round' }, green]);
    await landJob(JOB, m.deps);
    assert.equal(m.rounds.length, 2);
    assert.equal(stepNow().status, 'done');
  });

  const killed = {
    ok: false, merged: false, stopped_at: 'file-killed', verdict: 'stopped',
    reason: 'tests/b.test.js ended by SIGTERM from outside the round — not a verdict on this change',
    killed_files: [{ file: 'tests/b.test.js', signal: 'SIGTERM' }],
  };

  it('a test file killed from outside the round is measured once more, and then lands', async () => {
    register();
    const m = machine([killed, green]);
    await landJob(JOB, m.deps);
    assert.equal(m.rounds.length, 2);
    assert.ok(m.said.includes('memoro-cli #671: tests/b.test.js was killed from outside the round — measuring again'));
    assert.equal(stepNow().status, 'done');
  });

  it('killed twice is answered red with that reason, and nothing is mended', async () => {
    register();
    const m = machine([killed, killed, green]);
    const answers = await landJob(JOB, m.deps);
    assert.equal(m.rounds.length, 2, 'once more, not on and on');
    assert.equal(answers[0].landed, false);
    assert.equal(answers[0].report.stopped_at, 'file-killed');
    const step = stepNow();
    assert.equal(step.status, 'ready', 'the next session\'s, as any red is — no mend');
    assert.equal(step.reason, killed.reason);
    assert.equal(m.rows[0].note, 'red,file-killed');
    assert.equal(m.said.filter((line) => /mend/u.test(line)).length, 0);
  });

  it('a step somebody marked done or blocked meanwhile is left as it is', async () => {
    register({ status: 'blocked', blocked_by: { kind: 'decision', name: 'x' } });
    await landJob(JOB, machine([red]).deps);
    assert.equal(stepNow().status, 'blocked');
  });

  it('a job that is nobody\'s step gets the round and nothing else', async () => {
    const m = machine([green]);
    await landJob({ ...JOB, step: null }, m.deps);
    assert.equal(m.rounds.length, 1);
    assert.equal(m.rows[0].name, 'memoro-cli');
  });
});

describe('serve — the loop', () => {
  const take = () => true;
  const release = () => {};

  it('lands every job oldest first, one repository at a time, empties the queue and leaves', async () => {
    mkdirSync(join(root, 'runner'), { recursive: true });
    writeFileSync(mergesPath(root), JSON.stringify([
      { ...JOB, repo: 'memoro', pr: 2, since: '2026-10-09T12:02:00Z', step: null },
      { ...JOB, pr: 1, since: '2026-10-09T12:01:00Z', step: null },
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
    writeFileSync(mergesPath(root), JSON.stringify([{ ...JOB, pr: 1, step: null }]));
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
    writeFileSync(mergesPath(root), JSON.stringify([{ ...JOB, pr: 1, since: 'a', step: null }, { ...JOB, repo: 'memoro', pr: 2, since: 'b', step: null }]));
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
    writeFileSync(mergesPath(root), JSON.stringify([{ ...JOB, pr: 1, since: 'a', step: null, state: 'red', reason: 'red: x', answered: 'z' }]));
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
    writeFileSync(mergesPath(root), JSON.stringify([{ ...JOB, pr: 1, since: 'a', step: null }, { ...JOB, repo: 'memoro', pr: 2, since: 'b', step: null }]));
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

  it('a step whose earlier step is not done is not landed, even resumed from landing; once it is done, it goes', async () => {
    register();
    const steps = (first) => writeFileSync(registerPath(root, 'mq'), JSON.stringify({
      project: 'mq', repo: 'memoro-cli', programme: 'mc', plan: 'docs/project/mc/mq/PLAN.json',
      steps: [{ status: first, comments: [], attempts: 0 }, { status: 'landing', pr: 672, branch: 'mq-2', comments: [], attempts: 0 }],
    }));
    steps('failed');
    writeFileSync(mergesPath(root), JSON.stringify([{ ...JOB, pr: 672, since: 'a', step: { project: 'mq', index: 1 }, state: 'landing', started: 's' }]));
    const said = [];
    const landed = [];
    const land = async ([job]) => { landed.push(job.pr); return green; };
    await serve({ root, lock, take, release, say: (line) => said.push(line), land });
    assert.deepEqual(landed, []);
    assert.equal(queue()[0].state, 'queued', 'put back in line, not landed');
    assert.equal(queue()[0].since, 'a');
    assert.ok(said.some((line) => /#672: back in line — mq step 1 is not done/u.test(line)), said.join('\n'));
    assert.ok(said.includes('nothing the merger may take — leaving'));
    steps('done');
    await serve({ root, lock, take, release, land });
    assert.deepEqual(landed, [672]);
  });

  it('asked to stop, it leaves between jobs and the rest wait', async () => {
    mkdirSync(join(root, 'runner'), { recursive: true });
    writeFileSync(mergesPath(root), JSON.stringify([{ ...JOB, pr: 1, since: 'a', step: null }, { ...JOB, repo: 'memoro', pr: 2, since: 'b', step: null }]));
    let stop = false;
    await serve({ root, lock, take, release, ...ONE_LANE, stopping: () => stop, land: async () => { stop = true; return green; } });
    assert.deepEqual(queue().map((e) => e.pr), [2]);
  });

  it('another merger running: this one leaves at once', async () => {
    let landed = 0;
    assert.equal(await serve({ root, lock, take: () => false, release, land: async () => { landed += 1; } }), 0);
    assert.equal(landed, 0);
  });
});

describe('batches (merge-throughput step 1)', () => {
  const take = () => true;
  const release = () => {};
  const MEMORO = { repo: 'memoro', repo_path: '/repos/memoro', branch: null, holder: { name: 'mb', kind: 'work-area' } };
  // One plan per pull request: a plan's own steps never share a batch, because
  // step n+1 waits until step n is done (merger-hardening step 3).
  const jobFor = (pr, _index, since) => ({ ...MEMORO, pr, since, step: { project: `mb-${pr}`, index: 0 } });

  function registerBatch() {
    mkdirSync(join(root, 'runner', 'projects'), { recursive: true });
    for (const pr of [11, 12, 13]) {
      writeFileSync(registerPath(root, `mb-${pr}`), JSON.stringify({
        project: `mb-${pr}`, repo: 'memoro', programme: 'mc', plan: `docs/project/mc/mb-${pr}/PLAN.json`,
        steps: [{ status: 'landing', pr, branch: `mb-${pr}`, comments: [], attempts: 0 }],
      }));
    }
  }
  const steps = () => [11, 12, 13].map((pr) => JSON.parse(readFileSync(registerPath(root, `mb-${pr}`), 'utf8')).steps[0]);

  function queueFour(extra = {}) {
    mkdirSync(join(root, 'runner'), { recursive: true });
    writeFileSync(mergesPath(root), JSON.stringify([
      { ...jobFor(11, 0, '2026-10-10T12:01:00Z'), ...extra[11] },
      { ...JOB, step: null, since: '2026-10-10T12:02:00Z' },
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

  it('three memoro jobs and one memoro-cli job: one round with prs [11, 12, 13], every step done, the queue empty', async () => {
    registerBatch();
    queueFour();
    const m = machine([batchGreen, green]);
    await serve({ root, lock, take, release, ...ONE_LANE, say: m.deps.say, now: m.deps.now, land: (batch) => landJob(batch, m.deps) });
    assert.equal(m.rounds.length, 2);
    assert.equal(m.rounds[0].pr, 11);
    assert.deepEqual(m.rounds[0].prs, [11, 12, 13]);
    assert.deepEqual(m.rounds[0].holder, MEMORO.holder);
    assert.equal('prs' in m.rounds[1], false, 'memoro-cli alone is a single round');
    assert.ok(m.said.includes('memoro: landing a batch of 3 — #11 #12 #13'));
    assert.deepEqual(steps().map((s) => [s.status, s.landed.sha]), [['done', 'aaa'], ['done', 'bbb'], ['done', 'ccc']]);
    assert.deepEqual(queue(), []);
    assert.deepEqual(m.rows.map((r) => [r.pr, r.note]), [[11, 'merged'], [12, 'merged'], [13, 'merged'], [671, 'merged']]);
  });

  it('a fallback with #12 red in its own round: #12 is red with its reason and ready again, #11 and #13 land', async () => {
    registerBatch();
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
    await serve({ root, lock, take, release, ...ONE_LANE, say: m.deps.say, now: m.deps.now, land: (batch) => landJob(batch, m.deps) });
    const [a, b, c] = steps();
    assert.equal(a.status, 'done');
    assert.equal(a.landed.sha, 'm11');
    assert.equal(c.landed.sha, 'm13');
    assert.equal(b.status, 'ready');
    assert.equal(b.attempts, 1);
    assert.equal(b.reason, '3 tests red');
    assert.deepEqual(queue().map((e) => [e.pr, e.state, e.reason]), [[12, 'red', 'red: 3 tests red']]);
  });

  it('a stop before a job is reached gives that job the batch\'s stop; one that merged before it lands', async () => {
    registerBatch();
    const drift = {
      ok: false, merged: false, stopped_at: 'drift', reason: 'origin/main moved between merges', pr: { number: 11, base: 'main' },
      batch: { prs: [11, 12], gate_ok: true, fallback: false, rounds: [], merges: [{ number: 11, merged: true, merge_commit: 'aaa', error: null }] },
    };
    const m = machine([drift]);
    const answers = await landJob([jobFor(11, 0), jobFor(12, 1)], m.deps);
    assert.deepEqual(answers.map((a) => a.landed), [true, false]);
    assert.equal(answers[0].report.merged_into, 'main');
    assert.equal(answers[1].report.stopped_at, 'drift');
    assert.deepEqual(steps().slice(0, 2).map((s) => s.status), ['done', 'ready']);
    assert.equal(steps()[1].reason, 'origin/main moved between merges');
  });

  it('a restack refusal of one member answers it at once, and the other two still go as a batch of two', async () => {
    registerBatch();
    const parent = { project: null, index: null, pr: 5, sha: 'abc' };
    const two = { ...batchGreen, batch: { ...batchGreen.batch, prs: [11, 13], merges: [batchGreen.batch.merges[0], batchGreen.batch.merges[2]] } };
    const m = machine([two], { moveOntoMain: (job) => (job.pr === 12 ? { ok: false, reason: 'moving #12 onto main after #5 landed conflicts in a.js' } : { ok: true, moved: true }) });
    const answers = await landJob([jobFor(11, 0), { ...jobFor(12, 1), parent }, jobFor(13, 2)], m.deps);
    assert.equal(m.rounds.length, 1);
    assert.deepEqual(m.rounds[0].prs, [11, 13]);
    assert.deepEqual(answers.map((a) => [a.job.pr, a.landed, a.report.stopped_at]), [[12, false, 'restack'], [11, true, null], [13, true, null]]);
    assert.deepEqual(steps().map((s) => s.status), ['done', 'ready', 'done']);
    assert.match(steps()[1].reason, /conflicts in a\.js/u);
  });

  it('a merger that died under a batch takes the whole batch again, before anything queued', async () => {
    registerBatch();
    queueFour({ 11: { state: 'landing', started: 'x' }, 13: { state: 'landing', started: 'x' } });
    const resumed = { ...batchGreen, batch: { ...batchGreen.batch, prs: [11, 13], merges: [batchGreen.batch.merges[0], batchGreen.batch.merges[2]] } };
    const m = machine([resumed, green, green]);
    const rounds = [];
    await serve({
      root, lock, take, release, ...ONE_LANE, say: m.deps.say, now: m.deps.now,
      land: (batch) => { rounds.push(batch.map((j) => j.pr)); return landJob(batch, m.deps); },
    });
    assert.deepEqual(rounds[0], [11, 13]);
    assert.deepEqual(m.rounds[0].prs, [11, 13]);
    assert.deepEqual(rounds.slice(1), [[671], [12]]);
  });
});

describe('already merged or closed on GitHub (merger-hardening step 2)', () => {
  const MEMORO = { repo: 'memoro', repo_path: '/repos/memoro', branch: null, holder: { name: 'mb', kind: 'work-area' } };
  // One plan per pull request, so the batch is not held apart by step order.
  const jobFor = (pr, index) => ({ ...MEMORO, pr, since: `2026-10-10T17:0${index}:00Z`, step: { project: `mb-${pr}`, index: 0 } });

  function registerBatch(status = 'landing') {
    mkdirSync(join(root, 'runner', 'projects'), { recursive: true });
    for (const pr of [11, 12, 13]) {
      writeFileSync(registerPath(root, `mb-${pr}`), JSON.stringify({
        project: `mb-${pr}`, repo: 'memoro', programme: 'mc', plan: `docs/project/mc/mb-${pr}/PLAN.json`,
        steps: [{ status, pr, branch: `mb-${pr}`, comments: [], attempts: 0 }],
      }));
    }
  }
  const steps = () => [11, 12, 13].map((pr) => JSON.parse(readFileSync(registerPath(root, `mb-${pr}`), 'utf8')).steps[0]);

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
    registerBatch();
    mkdirSync(join(root, 'runner'), { recursive: true });
    writeFileSync(mergesPath(root), JSON.stringify([jobFor(11, 0), jobFor(12, 1), jobFor(13, 2)]));
    const { gh, asked } = stubGh({ 11: OPEN, 12: MERGED, 13: OPEN });
    const m = machine([two], { gh });
    await serve({ root, lock, take: () => true, release: () => {}, ...ONE_LANE, gh, say: m.deps.say, now: m.deps.now, land: (batch) => landJob(batch, m.deps) });
    assert.equal(m.rounds.length, 1);
    assert.deepEqual(m.rounds[0].prs, [11, 13]);
    assert.equal(m.rounds[0].pr, 11);
    assert.deepEqual(steps().map((s) => [s.status, s.landed?.sha]), [['done', 'aaa'], ['done', 'feed1234beef'], ['done', 'ccc']]);
    assert.equal(steps()[1].landed.into, 'main');
    assert.deepEqual(queue(), []);
    assert.ok(m.said.includes('memoro #12: already merged on GitHub as feed123 — answered landed'));
    assert.ok(asked.some((a) => a.args[2] === '12' && a.cwd === '/repos/memoro'), 'asked in the job\'s repository');
  });

  it('CLOSED: that job is red with stopped_at closed, and the other two are measured and landed without it', async () => {
    registerBatch();
    const { gh } = stubGh({ 11: OPEN, 12: CLOSED, 13: OPEN });
    const m = machine([two], { gh });
    const answers = await landJob([jobFor(11, 0), jobFor(12, 1), jobFor(13, 2)], m.deps);
    assert.deepEqual(m.rounds[0].prs, [11, 13]);
    const closed = answers.find((a) => a.job.pr === 12);
    assert.equal(closed.landed, false);
    assert.equal(closed.report.stopped_at, 'closed');
    assert.equal(closed.report.reason, '#12 was closed on GitHub without merging');
    assert.deepEqual(steps().map((s) => s.status), ['done', 'ready', 'done']);
  });

  it('every job MERGED: no round at all', async () => {
    registerBatch();
    const { gh } = stubGh({ 11: MERGED, 12: MERGED, 13: MERGED });
    const m = machine([], { gh });
    const answers = await landJob([jobFor(11, 0), jobFor(12, 1), jobFor(13, 2)], m.deps);
    assert.equal(m.rounds.length, 0);
    assert.deepEqual(answers.map((a) => a.landed), [true, true, true]);
    assert.deepEqual(steps().map((s) => s.status), ['done', 'done', 'done']);
  });

  it('gh failing or saying nothing keeps the job: the round decides as before', async () => {
    registerBatch();
    const { gh } = stubGh({ 11: OPEN, 12: { body: 'x' } });
    const m = machine([{ ...two, batch: { ...two.batch, prs: [11, 12, 13] } }], { gh });
    await landJob([jobFor(11, 0), jobFor(12, 1), jobFor(13, 2)], m.deps);
    assert.deepEqual(m.rounds[0].prs, [11, 12, 13]);
  });

  it('sweepMergedReds: a merged red entry is dequeued and its step done, a closed one dequeued, an open one left', async () => {
    registerBatch('ready');
    mkdirSync(join(root, 'runner'), { recursive: true });
    const redOf = (job) => ({ ...job, state: 'red', reason: 'red: x', answered: 'z' });
    writeFileSync(mergesPath(root), JSON.stringify([redOf(jobFor(11, 0)), redOf(jobFor(12, 1)), redOf(jobFor(13, 2)), jobFor(14, 3)]));
    const { gh, asked } = stubGh({ 11: MERGED, 12: CLOSED, 13: OPEN, 14: MERGED });
    const said = [];
    const dropped = await sweepMergedReds({ root, gh, lock, say: (line) => said.push(line) });
    assert.equal(dropped, 2);
    assert.deepEqual(queue().map((e) => [e.pr, e.state]), [[13, 'red'], [14, 'queued']]);
    assert.deepEqual(steps().map((s) => s.status), ['done', 'ready', 'ready']);
    assert.equal(steps()[0].landed.sha, 'feed1234beef');
    assert.equal(asked.filter((a) => a.args.includes('state,mergeCommit,baseRefName')).length, 3, 'only red entries are asked about');
    assert.ok(said.includes('memoro #11: already merged on GitHub as feed123 — answered landed'));
  });

  it('sweepMergedReds leaves a step that is done already as it is', async () => {
    registerBatch('done');
    mkdirSync(join(root, 'runner'), { recursive: true });
    writeFileSync(mergesPath(root), JSON.stringify([{ ...jobFor(11, 0), state: 'red', reason: 'r', answered: 'z' }]));
    await sweepMergedReds({ root, gh: stubGh({ 11: MERGED }).gh, lock });
    assert.deepEqual(queue(), []);
    assert.equal(steps()[0].landed, undefined);
  });

  it('serve sweeps once at start, before anything else, and not again within five minutes', async () => {
    mkdirSync(join(root, 'runner'), { recursive: true });
    writeFileSync(mergesPath(root), JSON.stringify([{ ...JOB, pr: 1, step: null }]));
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
});

describe('lanes (merge-throughput step 2)', () => {
  const take = () => true;
  const release = () => {};
  const MEMORO = { ...JOB, repo: 'memoro', repo_path: '/repos/memoro', step: null };

  it('a memoro-cli job is answered while a memoro round runs, and the next memoro job waits for that round', async () => {
    mkdirSync(join(root, 'runner'), { recursive: true });
    writeFileSync(mergesPath(root), JSON.stringify([
      { ...MEMORO, pr: 1, since: '2026-10-10T12:01:00Z' },
      { ...JOB, pr: 2, since: '2026-10-10T12:02:00Z', step: null },
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
    assert.deepEqual(lanesOf, [[1, 'heavy'], [2, 'light'], [3, 'heavy']]);
    assert.deepEqual(queue(), []);
  });

  it('a job waits only on a round in its own lane', async () => {
    register();
    const lanesAsked = [];
    const heavyBusy = ({ lane }) => { lanesAsked.push(lane); return lane === 'heavy' ? { pid: 9, repo: 'memoro', pr: 1, lane } : null; };
    const m = machine([green], { readRunningRound: heavyBusy, lane: 'light' });
    await landJob(JOB, m.deps);
    assert.equal(m.rounds.length, 1);
    assert.deepEqual([...new Set(lanesAsked)], ['light']);
    assert.equal(m.said.some((line) => /waiting behind/u.test(line)), false, 'a heavy round does not hold a light job');
  });

  it('a round in its own lane is waited for, and the wait names the lane', async () => {
    register();
    let polls = 0;
    const m = machine([green], {
      lane: 'light',
      readRunningRound: ({ lane }) => (lane === 'light' && polls++ < 2 ? { pid: 9, repo: 'memoro-cli', pr: 5, lane } : null),
    });
    await landJob(JOB, m.deps);
    assert.ok(m.said.some((line) => /waiting behind another gate round in the light lane \(memoro-cli #5, pid 9\)/u.test(line)), m.said.join('\n'));
  });

  it('asked to stop, each lane leaves between its jobs and the merger leaves once both have', async () => {
    mkdirSync(join(root, 'runner'), { recursive: true });
    writeFileSync(mergesPath(root), JSON.stringify([
      { ...MEMORO, pr: 1, since: 'a' }, { ...JOB, pr: 2, since: 'b', step: null },
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
  it('the register first, then the job, then a merger', () => {
    register({ status: 'running', pr: null, session: { pid: 5 } });
    const order = [];
    const result = queueMerge({
      root, repo: 'memoro-cli', repoPath: '/repos/memoro-cli', pr: 671, branch: 'mq',
      step: { project: 'mq', index: 0 }, lock, now: new Date('2026-10-09T12:00:00Z'),
      start: () => { order.push(['start', stepNow().status, queue().length]); return { pid: 9, started: true }; },
    });
    assert.deepEqual(order, [['start', 'landing', 1]]);
    assert.equal(result.place, 0);
    assert.equal(stepNow().pr, 671);
    assert.equal(stepNow().session, null);
  });
});

describe('stacked jobs (ruling 30, A)', () => {
  const PARENT = { project: 'mq', index: 0, pr: 9, sha: 'abc' };
  const STACKED = { ...JOB, pr: 10, branch: 'mq-2', step: { project: 'mq', index: 1 }, parent: PARENT };

  function registerTwo(first, second) {
    mkdirSync(join(root, 'runner', 'projects'), { recursive: true });
    writeFileSync(registerPath(root, 'mq'), JSON.stringify({
      project: 'mq', repo: 'memoro-cli', programme: 'mc', plan: 'docs/project/mc/mq/PLAN.json',
      steps: [
        { status: 'done', pr: 9, branch: 'mq', comments: [], attempts: 0, ...first },
        { status: 'landing', pr: 10, branch: 'mq-2', comments: [], attempts: 0, stacked_on: { index: 0, pr: 9, sha: 'abc' }, ...second },
      ],
    }));
  }
  const second = () => JSON.parse(readFileSync(registerPath(root, 'mq'), 'utf8')).steps[1];

  it('is moved onto main before its round, and lands', async () => {
    registerTwo({}, {});
    const moved = [];
    const m = machine([green], { moveOntoMain: (job) => { moved.push(job.pr); return { ok: true, moved: true }; } });
    await landJob(STACKED, m.deps);
    assert.deepEqual(moved, [10]);
    assert.equal(m.rounds.length, 1);
    assert.equal(second().status, 'done');
  });

  it('a move that conflicts is a red with the files, no round runs, and nothing is moved again', async () => {
    registerTwo({}, {});
    const m = machine([green], { moveOntoMain: () => ({ ok: false, reason: 'moving #10 onto main after #9 landed conflicts in a.js — merge origin/main into mq-2 and keep both intents' }) });
    await landJob(STACKED, m.deps);
    assert.equal(m.rounds.length, 0);
    const step = second();
    assert.equal(step.status, 'ready');
    assert.match(step.reason, /conflicts in a\.js/u);
    assert.equal(step.stacked_on, null, 'the one below has landed: the next session merges main in instead');
    assert.equal(m.rows[0].note, 'red,restack');
  });

  it('the merger leaves when the only job waits on one that came back red', async () => {
    registerTwo({ status: 'ready', reason: 'red', attempts: 1 }, {});
    mkdirSync(join(root, 'runner'), { recursive: true });
    writeFileSync(mergesPath(root), JSON.stringify([STACKED]));
    let landed = 0;
    let takes = 0;
    const code = await serve({ root, lock, take: () => { takes += 1; return true; }, release: () => {}, land: async () => { landed += 1; } });
    assert.equal(code, 0);
    assert.equal(landed, 0);
    assert.equal(takes, 1, 'no spinning on a job that may not go');
    assert.equal(queue().length, 1, 'it keeps its place for when #9 is queued again');
  });

  it('restack: a real squash below, and only the stacked step\'s own commit is replayed onto main', async () => {
    const base = mkdtempSync(join(tmpdir(), 'mc-restack-'));
    const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
    try {
      const origin = join(base, 'origin.git');
      const work = join(base, 'work');
      sh(base, 'init', '-q', '--bare', '-b', 'main', origin);
      sh(base, 'clone', '-q', origin, work);
      writeFileSync(join(work, 'a.txt'), 'a\n');
      sh(work, 'add', '.'); sh(work, 'commit', '-qm', 'base'); sh(work, 'push', '-q', 'origin', 'HEAD:main');
      // Step 1 on mq, step 2 on mq-2 on top of it.
      sh(work, 'checkout', '-qb', 'mq');
      writeFileSync(join(work, 'one.txt'), '1\n'); sh(work, 'add', '.'); sh(work, 'commit', '-qm', 'step 1');
      const parentSha = sh(work, 'rev-parse', 'HEAD');
      sh(work, 'push', '-q', 'origin', 'mq');
      sh(work, 'checkout', '-qb', 'mq-2');
      writeFileSync(join(work, 'two.txt'), '2\n'); sh(work, 'add', '.'); sh(work, 'commit', '-qm', 'step 2');
      sh(work, 'push', '-q', 'origin', 'mq-2');
      // Step 1 squash-merged onto main, as GitHub does it.
      sh(work, 'checkout', '-q', 'main');
      sh(work, 'merge', '-q', '--squash', 'mq'); sh(work, 'commit', '-qm', 'step 1 (#9)');
      sh(work, 'push', '-q', 'origin', 'main');
      const said = [];
      const result = await restack({ repo: 'r', repo_path: work, pr: 10, branch: 'mq-2', parent: { pr: 9, sha: parentSha } }, { say: (l) => said.push(l) });
      assert.deepEqual(result, { ok: true, moved: true });
      sh(work, 'fetch', '-q', 'origin');
      assert.equal(sh(work, 'rev-list', '--count', 'origin/main..origin/mq-2'), '1', 'one commit: step 2\'s own');
      assert.equal(sh(work, 'log', '-1', '--format=%s', 'origin/mq-2'), 'step 2');
      assert.equal(sh(work, 'merge-base', 'origin/main', 'origin/mq-2'), sh(work, 'rev-parse', 'origin/main'));
      assert.match(said[0], /moved onto main past #9/u);
      // Asked again — a merger that died after the push — it is already moved.
      assert.deepEqual(await restack({ repo: 'r', repo_path: work, pr: 10, branch: 'mq-2', parent: { pr: 9, sha: parentSha } }), { ok: true, moved: false });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  // Ruling 38: the child has main merged into it, and main moved on past the
  // squash of its parent — the shape of #857 on 2026-10-10.
  const stackedFixture = (base, { childEdits }) => {
    const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
    const origin = join(base, 'origin.git');
    const work = join(base, 'work');
    sh(base, 'init', '-q', '--bare', '-b', 'main', origin);
    sh(base, 'clone', '-q', origin, work);
    writeFileSync(join(work, 'a.txt'), 'a\n');
    sh(work, 'add', '.'); sh(work, 'commit', '-qm', 'base'); sh(work, 'push', '-q', 'origin', 'HEAD:main');
    // Parent P on mq.
    sh(work, 'checkout', '-qb', 'mq');
    writeFileSync(join(work, 'one.txt'), '1\n'); sh(work, 'add', '.'); sh(work, 'commit', '-qm', 'P');
    const parentSha = sh(work, 'rev-parse', 'HEAD');
    sh(work, 'push', '-q', 'origin', 'mq');
    // Child C on P.
    sh(work, 'checkout', '-qb', 'mq-2');
    childEdits(work); sh(work, 'add', '.'); sh(work, 'commit', '-qm', 'C');
    // P squashed onto main.
    sh(work, 'checkout', '-q', 'main');
    sh(work, 'merge', '-q', '--squash', 'mq'); sh(work, 'commit', '-qm', 'P (#9)');
    sh(work, 'push', '-q', 'origin', 'main');
    // The child merges that main in.
    sh(work, 'checkout', '-q', 'mq-2');
    sh(work, 'merge', '-q', '--no-edit', 'main');
    sh(work, 'push', '-q', 'origin', 'mq-2');
    // Main moves on, over the lines the squash wrote and over a.txt.
    sh(work, 'checkout', '-q', 'main');
    writeFileSync(join(work, 'one.txt'), '1 later\n');
    writeFileSync(join(work, 'a.txt'), 'a on main\n');
    sh(work, 'add', '.'); sh(work, 'commit', '-qm', 'later on main'); sh(work, 'push', '-q', 'origin', 'main');
    return { sh, work, job: { repo: 'r', repo_path: work, pr: 10, branch: 'mq-2', parent: { pr: 9, sha: parentSha } } };
  };

  it('restack: a child with main merged in is moved with exactly its own commit over main, where the old rebase --onto conflicts', async () => {
    const base = mkdtempSync(join(tmpdir(), 'mc-restack-'));
    try {
      const { sh, work, job } = stackedFixture(base, { childEdits: (w) => writeFileSync(join(w, 'two.txt'), '2\n') });
      // What it fixes: the old move replays the squash the merge brought in.
      const old = join(base, 'old');
      sh(work, 'worktree', 'add', '-q', '--detach', old, 'origin/mq-2');
      assert.throws(() => sh(old, 'rebase', '-q', '--onto', 'origin/main', job.parent.sha), 'the old rebase --onto conflicts on this fixture');
      sh(old, 'rebase', '--abort');
      sh(work, 'worktree', 'remove', '--force', old);

      const said = [];
      assert.deepEqual(await restack(job, { say: (l) => said.push(l) }), { ok: true, moved: true });
      sh(work, 'fetch', '-q', 'origin');
      assert.equal(sh(work, 'rev-list', '--count', 'origin/main..origin/mq-2'), '1', 'exactly C over main');
      assert.equal(sh(work, 'log', '-1', '--format=%s', 'origin/mq-2'), 'C');
      assert.equal(sh(work, 'rev-parse', 'origin/mq-2^'), sh(work, 'rev-parse', 'origin/main'));
      assert.equal(said[0], 'r #10: moved onto main past #9');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('restack: a child whose own commit edits the line main changed is ok: false and names the file', async () => {
    const base = mkdtempSync(join(tmpdir(), 'mc-restack-'));
    try {
      const { sh, work, job } = stackedFixture(base, { childEdits: (w) => writeFileSync(join(w, 'a.txt'), 'a on the child\n') });
      const tipBefore = sh(work, 'rev-parse', 'origin/mq-2');
      const result = await restack(job);
      assert.equal(result.ok, false);
      assert.match(result.reason, /moving #10 onto main after #9 landed conflicts in a\.txt — merge origin\/main into mq-2/u);
      sh(work, 'fetch', '-q', 'origin');
      assert.equal(sh(work, 'rev-parse', 'origin/mq-2'), tipBefore, 'nothing pushed');
      assert.equal(sh(work, 'worktree', 'list').split('\n').length, 1, 'the temporary worktree is gone');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('no round holds the other lane, and a SIGTERM finishes what is in flight (merger-hardening step 5)', () => {
  const take = () => true;
  const release = () => {};
  const MEMORO = { ...JOB, repo: 'memoro', repo_path: '/repos/memoro', step: null };
  const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

  it('a light job queued while the heavy round is pending for 300 ms starts and is answered inside that time', async () => {
    mkdirSync(join(root, 'runner'), { recursive: true });
    writeFileSync(mergesPath(root), JSON.stringify([{ ...MEMORO, pr: 1, since: 'a' }]));
    const events = [];
    const lanesAsked = [];
    const signals = [];
    let lightGoneAtHeavyEnd = null;
    const started = Date.now();
    let lightAnswered = null;
    const m = machine([], {
      readRunningRound: ({ lane }) => { lanesAsked.push(lane); return null; },
      mergeRound: async (options) => {
        signals.push(options.signals);
        if (options.repoPath === '/repos/memoro') {
          events.push('heavy start');
          queueMerge({ root, repo: 'memoro-cli', repoPath: '/repos/memoro-cli', pr: 2, lock, start: () => ({ pid: process.pid, started: false }) });
          await pause(300);
          lightGoneAtHeavyEnd = !queue().some((e) => e.pr === 2);
          events.push('heavy end');
        } else {
          events.push('light');
        }
        return green;
      },
    });
    const say = (line) => {
      m.said.push(line);
      if (/^memoro-cli #2: merged/u.test(line)) lightAnswered = Date.now() - started;
    };
    const code = await serve({
      root, lock, take, release, laneOf: LANE_OF, say, now: m.deps.now,
      sleep: () => pause(5),
      land: landerFor({ ...m.deps, say }),
    });
    assert.equal(code, 0);
    assert.deepEqual(events, ['heavy start', 'light', 'heavy end']);
    assert.equal(lightGoneAtHeavyEnd, true, 'the light job was answered and dequeued before the heavy round resolved');
    assert.ok(lightAnswered !== null && lightAnswered < 300, `answered at ${lightAnswered} ms`);
    assert.deepEqual(lanesAsked, ['heavy', 'light'], 'each job reads the round in its own lane');
    assert.deepEqual(signals, [false, false], 'the gate installs no signal handler in the merger');
    assert.deepEqual(queue(), []);
  });

  it('stopping() turned true mid-round: the round is answered as usual, no killed, and serve returns 0 within a second', async () => {
    register();
    // Another repository in the same lane, so not in the first job's batch.
    writeFileSync(mergesPath(root), JSON.stringify([{ ...JOB, since: 'a' }, { ...JOB, repo: 'other', pr: 672, since: 'b', step: null }]));
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
      root, lock, take, release, laneOf: (job) => (job.repo === 'memoro' ? 'heavy' : 'light'), stopping: () => stop, say, now: m.deps.now,
      sleep: () => pause(5),
      land: landerFor({ ...m.deps, say }),
    });
    const leftAt = Date.now();
    assert.equal(code, 0);
    assert.equal(stepNow().status, 'done', 'the round in flight was answered');
    assert.deepEqual(queue().map((e) => [e.pr, e.state]), [[672, 'queued']], 'the next job waits for the next start');
    assert.equal(m.said.some((line) => /killed/u.test(line)), false, m.said.join('\n'));
    assert.equal(m.said.filter((line) => line === 'asked to stop — waiting for 1 job(s) in flight').length, 1, m.said.join('\n'));
    assert.equal(m.said.at(-1), 'left');
    assert.ok(answeredAt !== null && leftAt - answeredAt < 1000);
  });

  it('while a mend is pending, the same lane takes and answers its next job (merger-hardening step 6)', async () => {
    register();
    writeFileSync(mergesPath(root), JSON.stringify([{ ...JOB, since: 'a' }, { ...JOB, repo: 'other', pr: 672, since: 'b', step: null }]));
    const conflict = { ok: false, merged: false, stopped_at: 'merge', reason: 'CONFLICT (content): Merge conflict in a.js' };
    let release672 = null;
    let otherAnsweredWhileMending = null;
    let mendDone = false;
    const m = machine([conflict, green]);
    const say = (line) => {
      m.said.push(line);
      if (/^other #672: merged/u.test(line)) otherAnsweredWhileMending = !mendDone;
    };
    const code = await serve({
      root, lock, take, release, ...ONE_LANE, say, now: m.deps.now,
      sleep: () => pause(5),
      land: landerFor({ ...m.deps, say, mayMend: (job) => job.pr === 671 }),
      mend: async () => {
        await new Promise((resolve) => { release672 = resolve; setTimeout(resolve, 300); });
        mendDone = true;
        return { outcome: 'nothing', line: 'gave up', status: 0, seconds: 0 };
      },
      appendRun: () => {},
    });
    assert.equal(code, 0);
    assert.ok(release672, 'the mend was started');
    assert.equal(otherAnsweredWhileMending, true, m.said.join('\n'));
    assert.equal(m.rounds.length, 2);
    assert.equal(queue().find((e) => e.pr === 671).state, 'red');
  });

  it('restack awaits an async git, skips an empty pick, merges main in on a conflicting pick, and a conflicting merge is said with its files', async () => {
    let calls = [];
    // pick: 'clean' | 'empty' | 'conflict'; mergeConflict: whether the fallback merge conflicts too.
    const gitWith = ({ pick = 'clean', mergeConflict = false } = {}) => {
      let inPick = false;
      let inMerge = false;
      return async (cwd, args) => {
        calls.push(args[0] === 'cherry-pick' && args[1]?.startsWith('--') ? `cherry-pick ${args[1]}` : args[0]);
        await new Promise((resolve) => { setImmediate(resolve); });
        if (args[0] === 'rev-list') return { ok: true, stdout: 'c1\nc2', stderr: '' };
        if (args[0] === 'cherry-pick' && args[1] === 'c2' && pick !== 'clean') { inPick = pick === 'conflict'; return { ok: false, stdout: '', stderr: '' }; }
        if (args[0] === 'merge' && args[1] === '--no-edit') { inMerge = mergeConflict; return { ok: !mergeConflict, stdout: '', stderr: '' }; }
        if (args[0] === 'diff') return { ok: true, stdout: inMerge ? 'a.js\nb.js' : inPick ? 'p.js' : '', stderr: '' };
        return { ok: true, stdout: args[0] === 'rev-parse' ? 'tip1234' : '', stderr: '' };
      };
    };
    const job = { repo: 'r', repo_path: '/r', pr: 10, branch: 'mq-2', parent: { pr: 9, sha: 'abc' } };
    const said = [];
    assert.deepEqual(await restack(job, { git: gitWith(), say: (l) => said.push(l) }), { ok: true, moved: true });
    assert.deepEqual(calls, ['fetch', 'rev-parse', 'merge-base', 'worktree', 'rev-list', 'checkout', 'cherry-pick', 'cherry-pick', 'push', 'worktree']);
    assert.equal(said.at(-1), 'r #10: moved onto main past #9');

    calls = [];
    assert.deepEqual(await restack(job, { git: gitWith({ pick: 'empty' }), say: (l) => said.push(l) }), { ok: true, moved: true });
    assert.deepEqual(calls.slice(6, -1), ['cherry-pick', 'cherry-pick', 'diff', 'cherry-pick --skip', 'push'], 'an empty pick is skipped, not a conflict');
    assert.equal(said.at(-1), 'r #10: moved onto main past #9');

    calls = [];
    assert.deepEqual(await restack(job, { git: gitWith({ pick: 'conflict' }), say: (l) => said.push(l) }), { ok: true, moved: true });
    assert.deepEqual(calls.slice(6, -1), ['cherry-pick', 'cherry-pick', 'diff', 'cherry-pick --abort', 'checkout', 'merge', 'push']);
    assert.equal(said.at(-1), 'r #10: moved onto main past #9 (merged main in)');

    calls = [];
    const refused = await restack(job, { git: gitWith({ pick: 'conflict', mergeConflict: true }) });
    assert.equal(refused.ok, false);
    assert.match(refused.reason, /conflicts in a\.js b\.js — merge origin\/main into mq-2/u, 'the merge\'s conflicted paths');
    assert.ok(calls.includes('merge') && !calls.includes('push'));
  });
});
