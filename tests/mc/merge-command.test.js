/**
 * `mc merge <repo> <pr>` — the door, then the merger's queue (ruling 30).
 *
 * The round itself is `tests/mc/repo-merge.test.js` and the merger that runs
 * it is `tests/mc/merger.test.js`; this drives the verb, whose whole job for
 * one pull request is now three things: refuse a plan trespass at the door,
 * make the step `landing` and queue the job, and see that a merger is
 * running. It returns at once — nothing here waits, so nothing here needs a
 * clock. `planBoundary`'s own rules are `tests/mc/merge-boundary.test.js`'s.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { gate } from '../../src/mc/commands/repo.js';
import { mergesPath, parseQueue } from '../../src/mc/merge-queue.js';
import { remainderOf, stepForMerge } from '../../src/mc/merge-step.js';
import { registerPath } from '../../src/mc/register.js';

let root = null;
let home = null;
let priorHome = null;

const queue = () => parseQueue(existsSync(mergesPath(root)) ? readFileSync(mergesPath(root), 'utf8') : null);

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

/**
 * Everything `gate` would otherwise reach the machine through: `gh` answers
 * the pull request's branch, the door is open unless told otherwise, and the
 * merger is started by a fake that counts.
 */
function deps({ env = {}, head = null, boundary = null, merger = { pid: 777, started: true } } = {}) {
  const out = { out: '', err: '' };
  const starts = [];
  let ranRound = false;
  return {
    out,
    starts,
    ranRound: () => ranRound,
    io: {
      stdout: { write: (text) => { out.out += text; } },
      stderr: { write: (text) => { out.err += text; } },
      root,
      resolveRepo: async () => '/repos/memoro-cli',
      mergeRound: async () => { ranRound = true; throw new Error('mc merge runs no round of its own'); },
      now: () => new Date('2026-09-06T18:00:00Z'),
      env: { MC_WORK_ROOT: root, ...env },
      gh: (args) => (args[1] === 'view' && head ? { status: 0, stdout: JSON.stringify({ headRefName: head }) } : { status: 1, stdout: '' }),
      planBoundary: async () => boundary || { checked: false },
      lock: (_root, fn) => fn(),
      startMerger: (options) => { starts.push(options); return merger; },
    },
  };
}

function fresh(prefix) {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), `${prefix}-`));
    home = mkdtempSync(join(tmpdir(), `${prefix}-home-`));
    priorHome = process.env.MC_HOME;
    process.env.MC_HOME = home;
  });
  afterEach(() => {
    if (priorHome === undefined) delete process.env.MC_HOME; else process.env.MC_HOME = priorHome;
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });
}

describe('mc merge queues the pull request for the merger and returns (ruling 30)', () => {
  fresh('mc-merge-queue');

  it('exit 0, one job in the queue, a merger started, and no round run here', async () => {
    const d = deps({ head: 'some-branch' });
    const code = await gate({ repo: 'memoro-cli', pr: 671 }, d.io);
    assert.equal(code, 0);
    assert.equal(d.ranRound(), false, 'the round is the merger\'s');
    const [job, ...rest] = queue();
    assert.deepEqual(rest, []);
    assert.equal(job.repo, 'memoro-cli');
    assert.equal(job.repo_path, '/repos/memoro-cli');
    assert.equal(job.pr, 671);
    assert.equal(job.branch, 'some-branch');
    assert.equal(job.state, 'queued');
    assert.equal(job.step, null, 'a branch that is nobody\'s step');
    assert.equal(job.since, '2026-09-06T18:00:00Z');
    assert.ok(job.holder?.name, 'who asked is kept for the round\'s lease');
    assert.equal(d.starts.length, 1);
    assert.match(d.out.out, /^mc: #671 is queued for the merger — it is next$/mu);
    assert.match(d.out.out, /^mc: the merger \(pid 777, just started\) lands it; follow it in .*merger\.log$/mu);
  });

  it('a second pull request stands behind the first, and the place is said', async () => {
    await gate({ repo: 'memoro-cli', pr: 671 }, deps().io);
    const d = deps({ merger: { pid: 777, started: false } });
    assert.equal(await gate({ repo: 'memoro-cli', pr: 672 }, d.io), 0);
    assert.deepEqual(queue().map((job) => job.pr), [671, 672]);
    assert.match(d.out.out, /^mc: #672 is queued for the merger — 1 ahead of it$/mu);
    assert.match(d.out.out, /^mc: the merger \(pid 777\) lands it/mu);
  });

  it('the same pull request asked twice is one job, keeping its place', async () => {
    await gate({ repo: 'memoro-cli', pr: 671 }, deps().io);
    await gate({ repo: 'memoro-cli', pr: 672 }, deps().io);
    await gate({ repo: 'memoro-cli', pr: 671 }, deps().io);
    assert.deepEqual(queue().map((job) => job.pr), [671, 672]);
  });

  it('a job the merger is landing now is left alone, and the caller is told so', async () => {
    mkdirSync(join(root, 'runner'), { recursive: true });
    writeFileSync(mergesPath(root), JSON.stringify([{ repo: 'memoro-cli', repo_path: '/repos/memoro-cli', pr: 671, state: 'landing', since: '2026-09-06T17:00:00Z' }]));
    const d = deps();
    assert.equal(await gate({ repo: 'memoro-cli', pr: 671 }, d.io), 0);
    assert.equal(queue()[0].state, 'landing');
    assert.match(d.out.out, /^mc: #671 is queued for the merger — the merger is landing it now$/mu);
  });

  it('no merger could be started: still queued, and the next start is named', async () => {
    const d = deps({ merger: { pid: null, started: false, error: 'spawn EACCES' } });
    assert.equal(await gate({ repo: 'memoro-cli', pr: 671 }, d.io), 0);
    assert.equal(queue().length, 1);
    assert.match(d.out.out, /^mc: no merger could be started \(spawn EACCES\) — the job waits/mu);
  });

  it('--json is the job as queued', async () => {
    const d = deps();
    assert.equal(await gate({ repo: 'memoro-cli', pr: 671, json: true }, d.io), 0);
    const said = JSON.parse(d.out.out);
    assert.deepEqual(said, { queued: true, repo: 'memoro-cli', pr: 671, place: 0, merger_pid: 777, step: null });
  });
});

describe('a plan-trespass stops mc merge at the door', () => {
  fresh('mc-merge-door');

  it('every problem the door found is printed, exit 1, nothing queued, no merger started', async () => {
    register();
    const d = deps({
      env: { MC_STEP: 'merge-queue:1' },
      boundary: { checked: true, ok: false, problems: ['steps[1].instruction: a step session does not change it', 'goal: a step session does not change it'] },
    });
    const code = await gate({ repo: 'memoro-cli', pr: 671 }, d.io);
    assert.equal(code, 1);
    assert.match(d.out.err, /^mc: plan-trespass — steps\[1\]\.instruction: a step session does not change it$/mu);
    assert.match(d.out.err, /^mc: plan-trespass — goal: a step session does not change it$/mu);
    assert.deepEqual(queue(), []);
    assert.equal(d.starts.length, 0);
    assert.equal(entryNow().steps[1].status, 'running', 'the session that called fixes it, still on the step');
  });
});

describe('mc merge makes the step landing', () => {
  fresh('mc-merge-step');

  it('MC_STEP: the step is landing with its pull request, the job names it, the other step is untouched', async () => {
    register();
    const d = deps({ env: { MC_STEP: 'merge-queue:1' }, head: 'merge-queue-2' });
    assert.equal(await gate({ repo: 'memoro-cli', pr: 671 }, d.io), 0);
    const after = entryNow();
    assert.equal(after.steps[1].status, 'landing');
    assert.equal(after.steps[1].pr, 671);
    assert.equal(after.steps[1].session, null, 'the session\'s part is over');
    assert.equal(after.steps[0].status, 'done');
    assert.deepEqual(queue()[0].step, { project: 'merge-queue', index: 1 });
    assert.match(d.out.out, /^mc: merge-queue step 2 is landing — green makes it done; red sends it back to the step's next session$/mu);
  });

  it('the step is found from the branch when MC_STEP is not set — a person typing mc merge on a project branch', async () => {
    register();
    assert.equal(await gate({ repo: 'memoro-cli', pr: 671 }, deps({ head: 'merge-queue-2' }).io), 0);
    assert.equal(entryNow().steps[1].status, 'landing');
    assert.deepEqual(queue()[0].step, { project: 'merge-queue', index: 1 });
  });

  it('a pull request that is nobody\'s step is queued and the register is left alone', async () => {
    register();
    const d = deps({ head: 'plan/mc' });
    assert.equal(await gate({ repo: 'memoro-cli', pr: 671 }, d.io), 0);
    assert.equal(entryNow().steps[1].status, 'running');
    assert.equal(queue()[0].step, null);
    assert.doesNotMatch(d.out.out, /landing —/u);
  });

  it('a step stacked on one still landing: the job names that one, and the door reads the plan from its tip', async () => {
    register({ stacked_on: { index: 0, pr: 600, sha: 'deadbeef' } });
    const d = deps({ env: { MC_STEP: 'merge-queue:1' }, head: 'merge-queue-2' });
    let asked = null;
    d.io.planBoundary = async (options) => { asked = options; return { checked: false }; };
    assert.equal(await gate({ repo: 'memoro-cli', pr: 671 }, d.io), 0);
    assert.equal(asked.from, 'deadbeef');
    assert.deepEqual(queue()[0].parent, { project: 'merge-queue', index: 0, pr: 600, sha: 'deadbeef' });
    assert.match(d.out.out, /^mc: it lands after #600 \(step 1\), which it is built on$/mu);
  });

  it('remainderOf reads a `## Remainder` and nothing else', () => {
    assert.equal(remainderOf('## Remainder\n\n`smart-search.js` — 16 sites.\n\n## Verified\n\nnpm test'), '`smart-search.js` — 16 sites.');
    assert.equal(remainderOf('## Remainder\n\nNone.\n'), null);
    assert.equal(remainderOf('no such heading'), null);
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
