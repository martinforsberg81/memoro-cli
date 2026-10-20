/**
 * `mc merge <repo> <pr>` — the door, then the merger's queue (ruling 30).
 *
 * The round itself is `tests/mc/repo-merge.test.js` and the merger that runs
 * it is `tests/mc/merger.test.js`; this drives the verb, whose whole job for
 * one pull request is now three things: refuse an unmet criterion at the door,
 * make the step `landing` and queue the job, and see that a merger is
 * running. It returns at once — nothing here waits, so nothing here needs a
 * clock. `criteriaDoor`'s own rules are `tests/mc/merge-boundary.test.js`'s.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { gate, parseMergeArgs } from '../../src/mc/commands/repo.js';
import { mergesPath, parseQueue } from '../../src/mc/merge-queue.js';
import { remainderOf, stepForMerge } from '../../src/mc/merge-step.js';
import { roundLogPath } from '../../src/mc/repo-round-log.js';
import { registerPath } from '../../src/mc/register.js';

let root = null;
let home = null;
let priorHome = null;

const queue = () => parseQueue(existsSync(mergesPath(root)) ? readFileSync(mergesPath(root), 'utf8') : null);

const PLAN_PATH = 'docs/project/mc/merge-queue/PLAN.json';

/** A register entry for the project the fixture pull request belongs to. */
function register(stepOver = {}, belowOver = {}) {
  mkdirSync(join(root, 'runner', 'projects'), { recursive: true });
  const entry = {
    project: 'merge-queue', repo: 'memoro-cli', programme: 'mc', plan: PLAN_PATH,
    steps: [
      { status: 'done', pr: 600, branch: 'merge-queue', comments: [], attempts: 0, ...belowOver },
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
function deps({ env = {}, head = null, door = null, merger = { pid: 777, started: true }, mergeable = undefined, git = undefined, cwd = undefined } = {}) {
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
      gh: (args) => (args[1] === 'view' && head ? { status: 0, stdout: JSON.stringify({ headRefName: head, mergeable }) } : { status: 1, stdout: '' }),
      criteriaDoor: async () => door || { checked: false },
      lock: (_root, fn) => fn(),
      git,
      cwd,
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

  it('several at once are queued one by one, in the order given, each with its own place', async () => {
    const d = deps({ env: { MC_STEP: 'merge-queue:1' } });
    assert.equal(await gate({ repo: 'memoro-cli', pr: 673, prs: [673, 671, 672] }, d.io), 0);
    assert.equal(d.ranRound(), false, 'no batch round: each is the merger\'s');
    assert.deepEqual(queue().map((job) => job.pr), [673, 671, 672]);
    assert.ok(queue().every((job) => job.step === null), 'MC_STEP names one step, not three');
    assert.match(d.out.out, /^mc: #673 is queued for the merger — it is next$/mu);
    assert.match(d.out.out, /^mc: #672 is queued for the merger — 2 ahead of it$/mu);
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

describe('an unmet criterion stops mc merge at the door', () => {
  fresh('mc-merge-door');

  it('the last step with an unmet criterion is refused at the door and nothing is queued', async () => {
    register();
    const d = deps({
      env: { MC_STEP: 'merge-queue:1' },
      door: { checked: true, ok: false, unmet: [1], problems: ['step 2 is the plan\'s last, and success criterion 1 is not met — run its check and record it with mc project criterion met <project> 1, or add a step that does'] },
    });
    const code = await gate({ repo: 'memoro-cli', pr: 671 }, d.io);
    assert.equal(code, 1);
    assert.match(d.out.err, /^mc: unmet-criteria — step 2 is the plan's last/mu);
    assert.deepEqual(queue(), []);
    assert.equal(d.starts.length, 0);
    assert.equal(entryNow().steps[1].status, 'running', 'the session that called measures, still on the step');
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

  it('a branch named after a project but no step\'s is queued, books no step, and says so', async () => {
    register();
    const d = deps({ head: 'merge-queue-direct-fix' });
    assert.equal(await gate({ repo: 'memoro-cli', pr: 671 }, d.io), 0);
    assert.equal(entryNow().steps[1].status, 'running');
    assert.equal(queue()[0].step, null);
    assert.match(d.out.out, /merge-queue-direct-fix is named after a project but is none of its steps' branches — landing it marks no step done/u);
  });

  it('a step stacked on one still landing: the job names that one', async () => {
    register({ stacked_on: { index: 0, pr: 600, sha: 'deadbeef' } }, { status: 'landing' });
    const d = deps({ env: { MC_STEP: 'merge-queue:1' }, head: 'merge-queue-2' });
    assert.equal(await gate({ repo: 'memoro-cli', pr: 671 }, d.io), 0);
    assert.deepEqual(queue()[0].parent, { project: 'merge-queue', index: 0, pr: 600, sha: 'deadbeef' });
    assert.match(d.out.out, /^mc: it lands after #600 \(step 1\), which it is built on$/mu);
  });

  it('a step stacked on one that has since landed: no parent is named', async () => {
    register({ stacked_on: { index: 0, pr: 600, sha: 'deadbeef' } });
    const d = deps({ env: { MC_STEP: 'merge-queue:1' }, head: 'merge-queue-2' });
    assert.equal(await gate({ repo: 'memoro-cli', pr: 671 }, d.io), 0);
    assert.equal(queue()[0].parent, null);
  });

  it('remainderOf reads a `## Remainder` and nothing else', () => {
    assert.equal(remainderOf('## Remainder\n\n`smart-search.js` — 16 sites.\n\n## Verified\n\nnpm test'), '`smart-search.js` — 16 sites.');
    assert.equal(remainderOf('## Remainder\n\nNone.\n'), null);
    assert.equal(remainderOf('no such heading'), null);
    assert.equal(remainderOf('## Remainder\nOne thing.\n\n<!-- mc:described abc1234 -->'), 'One thing.');
  });
});

describe('the door refuses what cannot land as asked (ruling 43)', () => {
  fresh('mc-merge-refuse');

  const WORKTREE = '/work/some-branch';
  const LOCAL = 'a'.repeat(40);
  const REMOTE = 'b'.repeat(40);

  /** A worktree on `branch` at `local`, whose origin has `remote` of the pull request's branch (or nothing). */
  const here = ({ branch, local = LOCAL, remote = REMOTE }) => (args, { cwd }) => {
    if (cwd !== WORKTREE) return { status: 1, stdout: '' };
    if (args.join(' ') === 'rev-parse --abbrev-ref HEAD') return { status: 0, stdout: `${branch}\n` };
    if (args.join(' ') === 'rev-parse HEAD') return { status: 0, stdout: `${local}\n` };
    if (args[0] === 'ls-remote') return { status: 0, stdout: remote ? `${remote}\trefs/heads/some-branch\n` : '' };
    return { status: 1, stdout: '' };
  };

  it('a pull request GitHub reports CONFLICTING is refused at the door and nothing is queued', async () => {
    const d = deps({ head: 'some-branch', mergeable: 'CONFLICTING' });
    assert.equal(await gate({ repo: 'memoro-cli', pr: 671 }, d.io), 1);
    assert.match(d.out.err, /^mc: #671 conflicts with its base on GitHub — merge origin\/main into the branch here \(git fetch -q origin && git merge origin\/main\), resolve, mc publish, then mc merge again$/mu);
    assert.deepEqual(queue(), []);
    assert.equal(d.starts.length, 0);
    assert.equal(d.ranRound(), false);
    assert.equal(existsSync(roundLogPath(root)), false, 'a refusal at the door records no round');
  });

  it('the branch checked out here at a head origin does not have is refused: mc publish first', async () => {
    const d = deps({ head: 'some-branch', cwd: WORKTREE, git: here({ branch: 'some-branch' }) });
    assert.equal(await gate({ repo: 'memoro-cli', pr: 671 }, d.io), 1);
    assert.equal(d.out.err, `mc: this worktree holds some-branch at aaaaaaa, origin at bbbbbbb — mc publish first, then mc merge\n`);
    assert.deepEqual(queue(), []);
    assert.equal(d.starts.length, 0);
    assert.equal(existsSync(roundLogPath(root)), false, 'a refusal at the door records no round');

    const gone = deps({ head: 'some-branch', cwd: WORKTREE, git: here({ branch: 'some-branch', remote: '' }) });
    assert.equal(await gate({ repo: 'memoro-cli', pr: 671 }, gone.io), 1);
    assert.match(gone.out.err, /^mc: this worktree holds some-branch at aaaaaaa, origin at nothing — mc publish first, then mc merge$/mu);
    assert.deepEqual(queue(), []);
  });

  it('a worktree on another branch, and UNKNOWN mergeability, are queued as before', async () => {
    const d = deps({ head: 'some-branch', mergeable: 'UNKNOWN', cwd: WORKTREE, git: here({ branch: 'elsewhere' }) });
    assert.equal(await gate({ repo: 'memoro-cli', pr: 671 }, d.io), 0);
    assert.equal(d.out.err, '');
    assert.equal(queue().length, 1);
    assert.match(d.out.out, /^mc: #671 is queued for the merger — it is next$/mu);
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

  it('a branch merely named after a project is no step of it, and a blocked step is never taken by name (#13549)', () => {
    const blocked = [{ project: 'photo-analysis', steps: [{ status: 'done', branch: 'photo-analysis' }, { status: 'blocked', branch: 'photo-analysis-6' }] }];
    assert.equal(stepForMerge({ env: {}, head: 'photo-analysis-direct-envelope', entries: blocked }), null);
    assert.equal(stepForMerge({ env: {}, head: 'photo-analysis-7', entries: blocked }), null, 'numbered, but the step it would be is blocked');
    assert.equal(stepForMerge({ env: {}, head: 'photo-analysis-6', entries: blocked }).index, 1, 'the step\'s own branch still finds it');
    assert.equal(stepForMerge({ env: {}, head: 'mc-cut-fix', entries }), null);
  });
});

describe('mc merge --watch queues, then follows the job (ruling 36)', () => {
  fresh('mc-merge-watch');

  const sink = () => { const out = []; return { out, write: (s) => { out.push(s); } }; };

  it('queues first, then watches, and returns the watch\'s code', async () => {
    const calls = [];
    const stdout = sink();
    const code = await gate({ repo: 'memoro-cli', pr: 835, watch: true }, {
      stdout, stderr: sink(), root,
      resolveRepo: async () => '/repos/memoro-cli',
      queueForMerger: async ({ opts }) => { calls.push(['queue', opts.pr]); return 0; },
      watch: async (options) => { calls.push(['watch', options.repo, options.pr]); options.print('mc: #835 red — x'); return { code: 1, result: {} }; },
    });
    assert.equal(code, 1);
    assert.deepEqual(calls, [['queue', 835], ['watch', 'memoro-cli', 835]]);
    assert.deepEqual(stdout.out, ['mc: #835 red — x\n']);
  });

  it('a queueing that failed is returned as it is, with no watch', async () => {
    let watched = false;
    const code = await gate({ repo: 'memoro-cli', pr: 835, watch: true }, {
      stdout: sink(), stderr: sink(), root,
      resolveRepo: async () => '/repos/memoro-cli',
      queueForMerger: async () => 1,
      watch: async () => { watched = true; return { code: 0, result: {} }; },
    });
    assert.equal(code, 1);
    assert.equal(watched, false);
  });

  it('--json prints the final state as one object, and the queueing says nothing', async () => {
    const stdout = sink();
    const code = await gate({ repo: 'memoro-cli', pr: 835, watch: true, json: true }, {
      stdout, stderr: sink(), root,
      resolveRepo: async () => '/repos/memoro-cli',
      queueForMerger: async ({ stdout: out }) => { out.write('mc: #835 is queued for the merger — it is next\n'); return 0; },
      readQueue: () => [],
      readMerger: () => null,
      prView: () => ({ state: 'MERGED', mergeCommit: 'abc1234def' }),
      now: () => 0,
      sleep: async () => {},
    });
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(stdout.out.join('')), {
      repo: 'memoro-cli', pr: 835, outcome: 'merged', merge_commit: 'abc1234def', reason: null, place: null, seconds: 0,
    });
  });

  it('--watch is refused with --docs, --check and several numbers, and by mc test', () => {
    assert.equal(parseMergeArgs(['memoro-cli', '835', '--watch', '--docs'], { docs: true, watch: true }).error, '--docs lands in the call — there is nothing to watch');
    assert.match(parseMergeArgs(['memoro-cli', '835', '--watch', '--check'], { docs: true, watch: true }).error, /nothing to watch/u);
    assert.match(parseMergeArgs(['memoro-cli', '835', '836', '--watch'], { docs: true, watch: true }).error, /^--watch follows one pull request/u);
    assert.equal(parseMergeArgs(['memoro-cli', '835', '--watch'], { full: true }).error, 'unknown flag: --watch');
    assert.equal(parseMergeArgs(['memoro-cli', '835', '--watch'], { docs: true, watch: true }).watch, true);
  });
});
