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
  landerFor, landJob, MAX_REQUEUES, mergerPath, queueMerge, readMerger, releaseMerger, serve, startMerger, SUBJECT_POLL_MS, succeed,
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
  const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
  const MERGED = { state: 'MERGED', mergeCommit: { oid: 'feed1234beef' }, baseRefName: 'main', headRefOid: 'aaa' };
  const CLOSED = { state: 'CLOSED', mergeCommit: null, baseRefName: 'main', headRefOid: 'aaa' };
  const OPEN = { state: 'OPEN', mergeCommit: null, baseRefName: 'main', headRefOid: 'aaa' };

  /** A fake `gh` answering `pr view` with `facts`, or failing when `facts` is undefined; every call is recorded. */
  function viewing(facts) {
    const asked = [];
    const gh = (args, options) => {
      asked.push({ args, cwd: options?.cwd });
      return facts === undefined ? { status: 1, stdout: '', stderr: 'gh: not found' } : { status: 0, stdout: JSON.stringify(facts) };
    };
    return { gh, asked };
  }

  it('SUBJECT_POLL_MS is a minute', () => {
    assert.equal(SUBJECT_POLL_MS, 60_000);
  });

  it('MERGED: one onGone of kind merged with the commit and the base, and no check after it', async () => {
    const { gh, asked } = viewing(MERGED);
    const gone = [];
    watchSubject({ job: PR, gh, startHead: 'aaa', every: 5, onGone: (facts) => gone.push(facts) });
    await wait(30);
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
    watchSubject({ job: PR, gh, startHead: 'aaa', every: 5, onGone: (facts) => gone.push(facts) });
    await wait(30);
    assert.equal(gone.length, 1);
    assert.equal(gone[0].kind, 'closed');
    assert.equal(gone[0].reason, '#14169 was closed on GitHub while its round ran — the round is stopped');
  });

  it('OPEN with a head other than the start one: one onGone of kind pushed, with the new head', async () => {
    const { gh } = viewing({ ...OPEN, headRefOid: 'bbb1111222' });
    const gone = [];
    watchSubject({ job: PR, gh, startHead: 'aaa', every: 5, onGone: (facts) => gone.push(facts) });
    await wait(30);
    assert.equal(gone.length, 1);
    assert.equal(gone[0].kind, 'pushed');
    assert.equal(gone[0].sha, 'bbb1111222');
    assert.equal(gone[0].reason, '#14169 got a new push (bbb1111) while its round ran — stopped; back in line at its place');
  });

  it('OPEN with the start head, or no start head to compare: checked on, nothing called', async () => {
    const same = viewing(OPEN);
    const none = viewing({ ...OPEN, headRefOid: 'bbb' });
    const gone = [];
    const stops = [
      watchSubject({ job: PR, gh: same.gh, startHead: 'aaa', every: 5, onGone: (facts) => gone.push(facts) }),
      watchSubject({ job: PR, gh: none.gh, startHead: null, every: 5, onGone: (facts) => gone.push(facts) }),
    ];
    await wait(30);
    stops.forEach((stop) => stop());
    assert.deepEqual(gone, []);
    assert.ok(same.asked.length > 1);
    assert.ok(none.asked.length > 1);
  });

  it('a gh that fails or says nothing sensible: no call, and the checks go on', async () => {
    const failing = viewing(undefined);
    const gone = [];
    const stop = watchSubject({ job: PR, gh: failing.gh, startHead: 'aaa', every: 5, onGone: (facts) => gone.push(facts) });
    await wait(30);
    stop();
    assert.deepEqual(gone, []);
    assert.ok(failing.asked.length > 1);
  });

  it('onGone is not called twice, though the checks would say so again', async () => {
    const { gh, asked } = viewing(MERGED);
    const gone = [];
    const stop = watchSubject({ job: PR, gh, startHead: 'aaa', every: 5, onGone: (facts) => gone.push(facts) });
    await wait(30);
    stop();
    assert.equal(gone.length, 1);
    assert.equal(asked.length, 1);
  });

  it('after stop() no further gh call is made', async () => {
    const { gh, asked } = viewing(OPEN);
    const stop = watchSubject({ job: PR, gh, startHead: 'aaa', every: 5, onGone: () => assert.fail('not gone') });
    await wait(12);
    stop();
    const count = asked.length;
    await wait(30);
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


describe('a goal\'s pull request (goals.js): done at landing; a red or a moved head stays in merging, the second blocked', () => {
  const GOAL = { programme: 'mc', goal: 'g', dir: '/programs/mc/goals/g' };
  const GOAL_JOB = { repo: 'memoro-cli', repo_path: '/repos/memoro-cli', pr: 90, branch: 'goal/g', holder: { name: 'goal:mc/g' }, goal: GOAL, sha: 'aaa111' };
  /** `setGoal`, recorded: what the merger writes to GOAL.json and LOG.md. */
  const goalWrites = () => {
    const writes = [];
    return { writes, setGoal: (call) => { writes.push(call); return { goal: {} }; } };
  };
  const headAt = (sha) => (args) => (args.includes('headRefOid') && !args.includes('state,headRefOid,mergeCommit,baseRefName')
    ? { status: 0, stdout: JSON.stringify({ headRefOid: sha }) }
    : { status: 0, stdout: JSON.stringify({ state: 'OPEN' }) });

  it('queueMerge keeps the goal and the reviewed head on the job', () => {
    const { place } = queueMerge({ root, repo: 'memoro-cli', repoPath: '/repos/memoro-cli', pr: 90, branch: 'goal/g', goal: GOAL, sha: 'aaa111', lock, start: () => null });
    assert.equal(place, 0);
    const [entry] = queue();
    assert.deepEqual(entry.goal, GOAL);
    assert.equal(entry.sha, 'aaa111');
  });

  it('landed: the goal is done, with a runner entry naming the pull request and the landed sha', async () => {
    const { writes, setGoal } = goalWrites();
    const m = machine([green], { gh: headAt('aaa111'), setGoal });
    const [answer] = await landJob(GOAL_JOB, m.deps);
    assert.equal(answer.landed, true);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].dir, GOAL.dir);
    assert.equal(writes[0].stage, 'done');
    assert.equal(writes[0].entry.tool, 'runner');
    assert.equal(writes[0].entry.done, 'landed #90 as abc1234def');
    assert.equal(m.rows[0].name, 'goal:mc/g');
  });

  it('red: the goal stays in merging, ready for one plan session, with a runner entry saying why; a second red in merging blocks it', async () => {
    const { writes, setGoal } = goalWrites();
    const m = machine([red], { gh: headAt('aaa111'), setGoal });
    const [answer] = await landJob(GOAL_JOB, m.deps);
    assert.equal(answer.landed, false);
    assert.deepEqual([writes[0].stage, writes[0].status], ['merging', 'ready']);
    assert.equal(writes[0].entry.done, 'merger answered red on #90');
    assert.match(writes[0].entry.comment, /^red: 2 tests red: a › b — one plan session takes it and queues it again$/u);

    const second = goalWrites();
    const log = [{ at: '2026-10-09T12:00Z', tool: 'runner', model: null, stage: 'merging', status: 'ready', done: 'merger answered red on #90', comment: null, next: null },
      { at: '2026-10-09T12:30Z', tool: 'claude', model: 'opus', stage: 'merging', status: 'ready', done: 'fixed it', comment: null, next: null }];
    const again = machine([red], { gh: headAt('aaa111'), setGoal: second.setGoal, goalsOf: () => [{ ...GOAL, stage: 'merging', status: 'ready', prs: [], log, problems: [] }] });
    await landJob(GOAL_JOB, again.deps);
    assert.deepEqual([second.writes[0].stage, second.writes[0].status], ['merging', 'blocked']);
    assert.match(second.writes[0].entry.comment, /— the second in merging: waits on a person$/u);
  });

  it('a head other than the reviewed one is not landed: no round, and the goal stays in merging — never back to review', async () => {
    const { writes, setGoal } = goalWrites();
    const m = machine([green], { gh: headAt('bbb222'), setGoal });
    const [answer] = await landJob(GOAL_JOB, m.deps);
    assert.equal(m.rounds.length, 0, 'no round spent on it');
    assert.equal(answer.landed, false);
    assert.equal(answer.moved, true);
    assert.equal(answer.back, undefined);
    assert.deepEqual([writes[0].stage, writes[0].status], ['merging', 'ready']);
    assert.equal(writes[0].entry.done, 'merger answered moved on #90');
    assert.match(writes[0].entry.comment, /#90 is at bbb222, not aaa111, the head its review judged — one plan session takes it/u);
  });

  it('a push while the round runs is moved too, not back in line', async () => {
    const { writes, setGoal } = goalWrites();
    const gh = (args) => {
      if (args.includes('state,headRefOid,mergeCommit,baseRefName')) return { status: 0, stdout: JSON.stringify({ state: 'OPEN', headRefOid: 'ccc333' }) };
      if (args.includes('headRefOid')) return { status: 0, stdout: JSON.stringify({ headRefOid: 'aaa111' }) };
      return { status: 0, stdout: JSON.stringify({ state: 'OPEN' }) };
    };
    const m = machine([], {
      gh, watchMs: 5, setGoal,
      mergeRound: (options) => new Promise((resolve) => {
        options.signal.addEventListener('abort', () => resolve({ ok: false, merged: false, stopped_at: 'gone', reason: options.signal.reason.message }));
      }),
    });
    const [answer] = await landJob(GOAL_JOB, m.deps);
    assert.equal(answer.moved, true);
    assert.equal(answer.back, undefined);
    assert.equal(writes[0].stage, 'merging');
  });

  it('serve: a moved goal job leaves the queue', async () => {
    mkdirSync(join(root, 'runner'), { recursive: true });
    writeFileSync(mergesPath(root), JSON.stringify([{ ...GOAL_JOB, since: '2026-10-09T12:01:00Z' }]));
    let rounds = 0;
    await serve({
      root, lock, take: () => true, release: () => {}, ...ONE_LANE,
      land: async ([job], lane, { onAnswer }) => {
        rounds += 1;
        const answer = { job, landed: false, report: { ok: false, merged: false, stopped_at: 'moved', reason: 'moved' }, moved: true };
        await onAnswer(answer);
        return [answer];
      },
    });
    assert.equal(rounds, 1);
    assert.deepEqual(queue(), []);
  });
});

describe('a pull request a goal carries in its prs (goal-lifecycle): its goal is told, whoever queued it', () => {
  const DIR = '/programs/ios/goals/asc';
  const goalAt = (prs, stage = 'merging') => [{ programme: 'ios', goal: 'asc', dir: DIR, stage, status: 'ready', prs, log: [], problems: [] }];
  const PLAIN_JOB = { repo: 'memoro', repo_path: '/repos/memoro', pr: 14761, branch: 'fix-json', holder: { name: 'person' }, goal: null, sha: null };
  const record = () => {
    const sets = [];
    const notes = [];
    return { sets, notes, setGoal: (call) => { sets.push(call); return { goal: {} }; }, noteGoal: (call) => { notes.push(call); } };
  };
  const openGh = () => ({ status: 0, stdout: JSON.stringify({ state: 'OPEN', headRefOid: 'aaa111' }) });

  it('landed, and the goal carries nothing else: done', async () => {
    const r = record();
    const m = machine([green], { gh: openGh, setGoal: r.setGoal, noteGoal: r.noteGoal, goalsOf: () => goalAt([{ repo: 'memoro', pr: 14761 }]) });
    const [answer] = await landJob(PLAIN_JOB, m.deps);
    assert.equal(answer.landed, true);
    assert.equal(r.sets.length, 1);
    assert.equal(r.sets[0].dir, DIR);
    assert.equal(r.sets[0].stage, 'done');
    assert.equal(r.sets[0].entry.done, 'landed #14761 as abc1234def');
  });

  it('landed, while the goal carries another pull request: the landing is logged, the status left for the runner', async () => {
    const r = record();
    const m = machine([green], { gh: openGh, setGoal: r.setGoal, noteGoal: r.noteGoal, goalsOf: () => goalAt([{ repo: 'memoro-cli', pr: 1238 }, { repo: 'memoro', pr: 14761 }]) });
    await landJob(PLAIN_JOB, m.deps);
    assert.equal(r.sets.length, 0);
    assert.equal(r.notes.length, 1);
    assert.deepEqual([r.notes[0].entry.stage, r.notes[0].entry.status], ['merging', 'ready'], 'the heading keeps the goal\'s stage and status');
    assert.match(r.notes[0].entry.done, /^memoro#14761 landed #14761 as abc1234def$/u);
    assert.match(r.notes[0].entry.comment, /carries memoro-cli#1238 too — done when every one has landed or closed/u);
  });

  it('red: the goal in merging stays there for one plan session, as its own branch\'s red does; one in another stage is told and does not move', async () => {
    const r = record();
    const m = machine([red], { gh: openGh, setGoal: r.setGoal, noteGoal: r.noteGoal, goalsOf: () => goalAt([{ repo: 'memoro', pr: 14761 }]) });
    await landJob(PLAIN_JOB, m.deps);
    assert.deepEqual([r.sets[0].stage, r.sets[0].status], ['merging', 'ready']);
    assert.equal(r.sets[0].entry.done, 'merger answered red on #14761');

    const building = record();
    const b = machine([red], { gh: openGh, setGoal: building.setGoal, noteGoal: building.noteGoal, goalsOf: () => goalAt([{ repo: 'memoro', pr: 14761 }], 'build') });
    await landJob(PLAIN_JOB, b.deps);
    assert.equal(building.sets.length, 0, 'a goal in build is not moved by a red');
    assert.deepEqual([building.notes[0].entry.stage, building.notes[0].entry.done], ['build', 'merger answered red on #14761']);
    assert.match(building.notes[0].entry.comment, /the goal is in build, not merging; it stays there$/u);
  });

  it('a goal with a criterion not met is not landed: no round, red with the criterion named, for one plan session', async () => {
    const r = record();
    const criteria = [{ criterion: 'a', check: 'x', met: true }, { criterion: 'b', check: 'y', met: false }];
    const m = machine([green], { gh: openGh, setGoal: r.setGoal, noteGoal: r.noteGoal, goalsOf: () => [{ ...goalAt([{ repo: 'memoro', pr: 14761 }])[0], success_criteria: criteria }] });
    const [answer] = await landJob(PLAIN_JOB, m.deps);
    assert.equal(m.rounds.length, 0, 'no round spent on it');
    assert.equal(answer.landed, false);
    assert.equal(answer.report.stopped_at, 'unmet-criteria');
    assert.match(answer.report.reason, /^criterion 2 is not met — run its check and record it with mc goal criterion met ios\/asc 2$/u);
    assert.deepEqual([r.sets[0].stage, r.sets[0].status], ['merging', 'ready']);
    assert.equal(r.sets[0].entry.done, 'merger answered red on #14761');
    assert.match(r.sets[0].entry.comment, /^unmet-criteria: criterion 2 is not met/u);

    // Its own branch's job (a green review queued it) is refused the same way; met, it lands.
    const own = record();
    const job = { ...PLAIN_JOB, branch: 'goal/asc', goal: { programme: 'ios', goal: 'asc', dir: DIR }, sha: 'aaa111' };
    const refused = machine([green], { gh: openGh, setGoal: own.setGoal, noteGoal: own.noteGoal, goalsOf: () => [{ ...goalAt([])[0], success_criteria: criteria }] });
    assert.equal((await landJob(job, refused.deps))[0].report.stopped_at, 'unmet-criteria');
    const met = machine([green], { gh: openGh, setGoal: own.setGoal, noteGoal: own.noteGoal, goalsOf: () => [{ ...goalAt([])[0], success_criteria: criteria.map((item) => ({ ...item, met: true })) }] });
    assert.equal((await landJob(job, met.deps))[0].landed, true);
  });

  it('a pull request no goal carries tells no goal', async () => {
    const r = record();
    const m = machine([green], { gh: openGh, setGoal: r.setGoal, noteGoal: r.noteGoal, goalsOf: () => goalAt([{ repo: 'memoro-cli', pr: 14761 }]) });
    await landJob(PLAIN_JOB, m.deps);
    assert.deepEqual([r.sets.length, r.notes.length], [0, 0]);
  });
});
