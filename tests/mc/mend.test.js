/**
 * The mend (ruling 37, merger-hardening step 6): a red the change caused gets
 * one session of its own before it is red.
 *
 * The session, git and `ls-remote` are stubs; the queue file and the register
 * are real, in a temporary work root, because what the mend writes there is
 * the whole of what it does.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { markMended, markMending, mergesPath, nextBatch, parseQueue } from '../../src/mc/merge-queue.js';
import { conflictPaths, MEND_AT_ONCE, MEND_STOPS, mayMend, mendLine, runMend } from '../../src/mc/mend.js';
import { landerFor, serve } from '../../src/mc/merger.js';
import { registerPath } from '../../src/mc/register.js';
import { readCanonRole } from '../../src/mc/roles.js';

let root = null;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'mc-mend-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const lock = (_root, fn) => fn();
const ONE_LANE = { lanes: ['heavy'], laneOf: () => 'heavy' };
const queue = () => parseQueue(existsSync(mergesPath(root)) ? readFileSync(mergesPath(root), 'utf8') : null);
const SINCE = '2026-10-10T12:00:00Z';
const JOB = {
  repo: 'memoro-cli', repo_path: '/repos/memoro-cli', pr: 671, branch: 'mq', holder: { name: 'mq', kind: 'work-area' },
  step: { project: 'mq', index: 0 }, since: SINCE,
};
const MEASURED = 'aaaa111';
const green = { ok: true, merged: true, merge_commit: 'abc1234def', merged_into: 'main', off_default: false, stopped_at: null };
const conflict = {
  ok: false, merged: false, stopped_at: 'merge', pr: { number: 671, head_sha: MEASURED, title: 'mq: the thing' },
  reason: '#671 conflicts with main — Auto-merging src/card-views.js\nCONFLICT (content): Merge conflict in src/card-views.js',
};

function register(stepOver = {}) {
  mkdirSync(join(root, 'runner', 'projects'), { recursive: true });
  writeFileSync(registerPath(root, 'mq'), JSON.stringify({
    project: 'mq', repo: 'memoro-cli', programme: 'mc', plan: 'docs/project/mc/mq/PLAN.json',
    steps: [{ status: 'landing', pr: 671, branch: 'mq', comments: [], attempts: 0, ...stepOver }],
  }));
}
const stepNow = () => JSON.parse(readFileSync(registerPath(root, 'mq'), 'utf8')).steps[0];
const writeQueue = (entries) => {
  mkdirSync(join(root, 'runner'), { recursive: true });
  writeFileSync(mergesPath(root), JSON.stringify(entries));
};

/** The mend's machine: git, ls-remote and the session, all stubs. */
function mendMachine({ pushed = true, result = 'merged origin/main in, kept both intents', timedOut = false, status = 0 } = {}) {
  const git = [];
  const sessions = [];
  let head = MEASURED;
  const deps = {
    role: () => ({ overlay: 'You are the mend.', model: 'opus', tools: ['claude'] }),
    launch: () => ({ ok: true, id: 'claude', adapter: null, spec: { bin: 'claude' } }),
    git: async (cwd, args) => {
      git.push({ cwd, args });
      if (args[0] === 'show') {
        return { ok: true, stdout: JSON.stringify({ steps: [{ title: '1. The thing', done_when: 'DONE-WHEN-THE-THING', instruction: 'Build the thing.' }] }) };
      }
      if (args[0] === 'ls-remote') return { ok: true, stdout: `${head}\trefs/heads/mq` };
      return { ok: true, stdout: '' };
    },
    session: async (call) => {
      sessions.push(call);
      call.onPid(4242);
      await new Promise((resolve) => { setImmediate(resolve); });
      if (pushed) head = 'bbbb222';
      return {
        status: timedOut ? 142 : status,
        timedOut,
        stdout: timedOut ? '' : JSON.stringify({ type: 'result', result, num_turns: 7, session_id: 's-1', usage: { input_tokens: 10, output_tokens: 20 } }),
        stderr: '',
      };
    },
  };
  return { git, sessions, deps };
}

/** serve with a stub round and a stub mend, the way merger-run.js wires them. */
async function serveWith({ reports, mm, over = {} }) {
  const said = [];
  const rounds = [];
  const rows = [];
  const queued = [...reports];
  let clock = Date.parse('2026-10-10T13:00:00Z');
  const now = () => new Date(clock);
  const say = (line) => said.push(line);
  const land = landerFor({
    root, lock, say, now,
    sleep: async (ms) => { clock += ms; },
    mergeRound: async (options) => { rounds.push({ options, entries: queue(), step: stepNow() }); return queued.shift(); },
    readRunningRound: () => null, readRunningDeploy: () => null, readLeaseFn: () => ({ held: false }),
    recordStart: () => {}, record: () => {},
    gh: () => ({ status: 0, stdout: JSON.stringify({ state: 'OPEN', body: '' }) }),
    mayMend,
  });
  const code = await serve({
    root, lock, now, say, take: () => true, release: () => {}, ...ONE_LANE,
    sweep: async () => 0,
    sleep: () => new Promise((resolve) => { setImmediate(resolve); }),
    land,
    mend: mm ? (job, report, { onPid }) => runMend({ root, job, report, deps: { ...mm.deps, onPid, now } }) : null,
    appendRun: (row) => rows.push(row),
    ...over,
  });
  return { code, said, rounds, rows };
}

describe('which reds are mended', () => {
  it('the stops where the fault is in the change, and only those', () => {
    assert.deepEqual([...MEND_STOPS], ['merge', 'restack', 'red', 'selected-gate', 'pr-tests', 'extra-gate', 'derived-outside', 'project-log']);
    assert.equal(MEND_AT_ONCE, 1);
    assert.equal(mayMend(JOB, conflict), true);
    for (const stopped_at of ['fetch', 'pr', 'killed', 'threw', 'busy', 'drift', 'closed']) {
      assert.equal(mayMend(JOB, { ok: false, stopped_at, reason: 'x' }), false, stopped_at);
    }
  });

  it('a red that is all main\'s is not the branch\'s; one the change caused part of is', () => {
    const red = (onMain) => ({ ok: false, stopped_at: 'red', reason: '2 tests red', candidate: { red_files: ['a.test.js', 'b.test.js'] }, main_red: { red_on_main: onMain } });
    assert.equal(mayMend(JOB, red(['a.test.js', 'b.test.js'])), false);
    assert.equal(mayMend(JOB, red(['a.test.js'])), true);
    assert.equal(mayMend(JOB, red([])), true);
  });

  it('a mended job, or one without a branch, is not mended', () => {
    assert.equal(mayMend({ ...JOB, mended: { at: 'x', outcome: 'pushed' } }, conflict), false);
    assert.equal(mayMend({ ...JOB, branch: null }, conflict), false);
  });

  it('conflict paths are read from git\'s words and from the restack\'s', () => {
    assert.deepEqual(conflictPaths(conflict.reason), ['src/card-views.js']);
    assert.deepEqual(conflictPaths('moving #10 onto main after #9 landed conflicts in a.js b.js — merge origin/main'), ['a.js', 'b.js']);
  });

  it('canon/roles/mend.md is the mend role', () => {
    const role = readCanonRole('mend');
    assert.equal(role?.name, 'mend');
    assert.equal(role.model, 'opus');
    assert.deepEqual(role.tools, ['claude']);
    assert.match(role.overlay, /gh pr merge/u);
    assert.match(role.overlay, /PLAN\.json/u);
  });
});

describe('the queue: mending and mended', () => {
  it('a mending entry is in line but not taken; mended, it is queued at its old place with its mend spent', () => {
    const entries = parseQueue(JSON.stringify([{ ...JOB, state: 'queued' }]));
    const mending = markMending(entries, JOB, { reason: 'merge: x', stopped_at: 'merge', started: 't' });
    const back = parseQueue(JSON.stringify(mending));
    assert.equal(back[0].state, 'mending');
    assert.deepEqual(back[0].mend, { pid: null, started: 't', reason: 'merge: x', stopped_at: 'merge' });
    assert.deepEqual(nextBatch(back), []);
    const mended = parseQueue(JSON.stringify(markMended(back, JOB, { outcome: 'pushed', at: 'u' })));
    assert.equal(mended[0].state, 'queued');
    assert.equal(mended[0].since, SINCE);
    assert.deepEqual(mended[0].mended, { at: 'u', outcome: 'pushed' });
    assert.equal(mended[0].mend, null);
    assert.equal(nextBatch(mended).length, 1);
  });
});

describe('a mend (merger-hardening step 6)', () => {
  it('a merge stop starts one session in its own worktree on origin/<branch>, with the conflict and the step\'s done_when', async () => {
    register();
    writeQueue([JOB]);
    const mm = mendMachine({ pushed: true });
    const run = await serveWith({ reports: [conflict, green], mm });
    assert.equal(run.code, 0);
    assert.equal(mm.sessions.length, 1);
    const dir = join(root, 'runner', 'mend', 'memoro-cli-671');
    assert.equal(mm.sessions[0].cwd, dir);
    const add = mm.git.find((call) => call.args[0] === 'worktree' && call.args[1] === 'add');
    assert.deepEqual(add.args, ['worktree', 'add', '-q', '--detach', dir, 'origin/mq']);
    assert.equal(add.cwd, '/repos/memoro-cli');
    assert.ok(mm.git.findIndex((call) => call.args[0] === 'fetch') < mm.git.indexOf(add));
    assert.ok(mm.git.some((call) => call.args[0] === 'worktree' && call.args[1] === 'remove' && call.args.includes(dir)), 'the worktree is removed');
    const prompt = mm.sessions[0].args.join('\n');
    assert.match(prompt, /src\/card-views\.js/u);
    assert.match(prompt, /DONE-WHEN-THE-THING/u);
    assert.match(prompt, /git push origin HEAD:mq/u);
    assert.ok(mm.sessions[0].args.includes('--tools'));
    assert.ok(run.said.some((line) => /^memoro-cli #671: #671 conflicts with main[\s\S]* — mending \(one try\)$/u.test(line)), run.said.join('\n'));
  });

  it('a moved head puts the job back in line at its old place, mended, the step still landing — and a full round lands it', async () => {
    register();
    writeQueue([JOB]);
    const mm = mendMachine({ pushed: true });
    const run = await serveWith({ reports: [conflict, green], mm });
    assert.equal(run.rounds.length, 2, 'measured again by a full round');
    const [again] = run.rounds[1].entries;
    assert.equal(again.since, SINCE);
    assert.equal(again.mended.outcome, 'pushed');
    assert.equal(run.rounds[1].step.status, 'landing');
    assert.equal(run.rounds[1].step.attempts, 0, 'no redPatch while mending');
    assert.ok(run.said.some((line) => line === 'memoro-cli #671: mended — merged origin/main in, kept both intents — back in line'), run.said.join('\n'));
    assert.equal(stepNow().status, 'done');
    assert.deepEqual(queue(), []);
    const mend = run.rows.find((row) => row.kind === 'mend');
    assert.equal(mend.name, 'mq');
    assert.equal(mend.exit, 0);
    assert.equal(mend.turns, '7');
    assert.equal(mend.input, '10');
  });

  it('an unmoved head is red with "the mend pushed nothing", mended, and the step goes through redPatch', async () => {
    register();
    writeQueue([JOB]);
    const mm = mendMachine({ pushed: false, result: 'looked\nthe conflict needs a decision about the card layout' });
    const run = await serveWith({ reports: [conflict], mm });
    const [left] = queue();
    assert.equal(left.state, 'red');
    assert.match(left.reason, /^merge: #671 conflicts with main[\s\S]* — the mend pushed nothing: the conflict needs a decision about the card layout$/u);
    assert.equal(left.mended.outcome, 'nothing');
    const step = stepNow();
    assert.equal(step.status, 'ready');
    assert.equal(step.attempts, 1);
    assert.match(step.reason, /the mend pushed nothing/u);
    assert.equal(run.rounds.length, 1);
    assert.equal(run.rows.find((row) => row.kind === 'mend').exit, 1);
  });

  it('a timeout is red with "the mend timed out"', async () => {
    register();
    writeQueue([JOB]);
    await serveWith({ reports: [conflict], mm: mendMachine({ pushed: false, timedOut: true }) });
    assert.match(queue()[0].reason, / — the mend timed out$/u);
    assert.match(stepNow().reason, / — the mend timed out$/u);
  });

  it('a second red on a mended job starts nothing and is red at once', async () => {
    register();
    writeQueue([{ ...JOB, mended: { at: 'x', outcome: 'pushed' } }]);
    const mm = mendMachine();
    await serveWith({ reports: [conflict], mm });
    assert.equal(mm.sessions.length, 0);
    assert.equal(queue()[0].state, 'red');
    assert.equal(stepNow().attempts, 1);
  });

  it('fetch, pr, killed and a red that is all main\'s start nothing', async () => {
    const mainRed = { ok: false, merged: false, stopped_at: 'red', reason: '1 test red', candidate: { red_files: ['a.test.js'] }, main_red: { red_on_main: ['a.test.js'] } };
    for (const report of [
      { ok: false, merged: false, stopped_at: 'fetch', reason: 'x' },
      { ok: false, merged: false, stopped_at: 'pr', reason: 'x' },
      { ok: false, merged: false, stopped_at: 'killed', reason: 'x' },
      mainRed,
    ]) {
      register();
      writeQueue([JOB]);
      const mm = mendMachine();
      await serveWith({ reports: [report], mm });
      assert.equal(mm.sessions.length, 0, report.stopped_at);
      assert.equal(queue()[0].state, 'red', report.stopped_at);
    }
  });

  it('a mending entry left by a dead merger is queued again, unmended', async () => {
    register();
    writeQueue([{ ...JOB, state: 'mending', mended: null, mend: { pid: 999999, started: 't', reason: 'merge: x', stopped_at: 'merge' } }]);
    const run = await serveWith({ reports: [green], mm: mendMachine() });
    assert.equal(run.rounds.length, 1);
    assert.equal(run.rounds[0].entries[0].mended, null);
    assert.ok(run.said.some((line) => /its mend \(pid 999999\) never finished — back in line/u.test(line)), run.said.join('\n'));
    assert.deepEqual(queue(), []);
  });

  it(`two reds at once with MEND_AT_ONCE ${MEND_AT_ONCE} run one after the other`, async () => {
    const order = [];
    let running = 0;
    let most = 0;
    const line = mendLine({
      atOnce: 1,
      run: async (job) => {
        running += 1; most = Math.max(most, running); order.push(`start ${job.pr}`);
        await new Promise((resolve) => { setTimeout(resolve, 10); });
        order.push(`end ${job.pr}`); running -= 1;
        return { outcome: 'nothing' };
      },
      settle: async () => {},
    });
    const both = Promise.all([line.start({ pr: 1 }, {}), line.start({ pr: 2 }, {})]);
    assert.equal(line.busy(), true);
    await both;
    await line.idle();
    assert.equal(most, 1);
    assert.deepEqual(order, ['start 1', 'end 1', 'start 2', 'end 2']);
    assert.equal(line.busy(), false);
  });
});
