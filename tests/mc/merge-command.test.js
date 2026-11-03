/**
 * `mc merge <repo> <pr>` — the door, then the merger's queue (ruling 30).
 *
 * The round itself is `tests/mc/repo-merge.test.js` and the merger that runs
 * it is `tests/mc/merger.test.js`; this drives the verb, whose whole job for
 * one pull request is now two things: queue the job, and see that a merger is
 * running. It returns at once — nothing here waits, so nothing here needs a
 * clock.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { run } from '../../src/mc/commands/merge.js';
import { gate, parseMergeArgs } from '../../src/mc/commands/repo.js';
import { mergesPath, parseQueue } from '../../src/mc/merge-queue.js';
import { remainderOf } from '../../src/mc/merge-step.js';
import { roundLogPath } from '../../src/mc/repo-round-log.js';

let root = null;
let home = null;
let priorHome = null;

const queue = () => parseQueue(existsSync(mergesPath(root)) ? readFileSync(mergesPath(root), 'utf8') : null);

/**
 * Everything `gate` would otherwise reach the machine through: `gh` answers
 * the pull request's branch, the door is open unless told otherwise, and the
 * merger is started by a fake that counts.
 */
function deps({ env = {}, head = null, merger = { pid: 777, started: true }, mergeable = undefined, git = undefined, cwd = undefined } = {}) {
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

  it('a bare repository is queued under its name, without .git', async () => {
    const d = deps({ head: 'some-branch' });
    d.io.resolveRepo = async () => '/mc/repos/memoro-cli.git';
    assert.equal(await gate({ repo: 'memoro-cli', pr: 671 }, d.io), 0);
    const [job] = queue();
    assert.equal(job.repo, 'memoro-cli', 'memoro-cli.git queued #1101 a second time beside its memoro-cli entry (2026-10-25)');
    assert.equal(job.repo_path, '/mc/repos/memoro-cli.git');
  });

  it('several at once are queued one by one, in the order given, each with its own place', async () => {
    const d = deps();
    assert.equal(await gate({ repo: 'memoro-cli', pr: 673, prs: [673, 671, 672] }, d.io), 0);
    assert.equal(d.ranRound(), false, 'no batch round: each is the merger\'s');
    assert.deepEqual(queue().map((job) => job.pr), [673, 671, 672]);
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
    assert.deepEqual(said, { queued: true, repo: 'memoro-cli', pr: 671, place: 0, merger_pid: 777 });
  });
});

describe('remainderOf', () => {
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

describe('mc merge <repo> <pr> --admin lands past the gate and books it (Martin\'s verb)', () => {
  fresh('mc-merge-admin');

  const HEAD = 'c'.repeat(40);
  const MERGE_SHA = 'abcdef1234567890abcdef1234567890abcdef12';
  const OPEN = { number: 671, title: 'Fix the thing', state: 'OPEN', headRefOid: HEAD, headRefName: 'merge-queue-2', baseRefName: 'main', body: '## Remainder\n\nNone.', mergeCommit: null };
  const MERGED = { state: 'MERGED', mergeCommit: { oid: MERGE_SHA } };
  const ok = (value) => ({ status: 0, stdout: JSON.stringify(value), stderr: '' });
  const queued = (over = {}) => ({ repo: 'memoro-cli', repo_path: '/repos/memoro-cli', pr: 671, state: 'queued', step: { project: 'merge-queue', index: 1 }, since: '2026-10-24T11:00:00Z', ...over });
  const writeQueue = (entries) => {
    mkdirSync(join(root, 'runner'), { recursive: true });
    writeFileSync(mergesPath(root), JSON.stringify(entries));
  };

  /**
   * `gh` answers `pr view` from `views`, in order, the last one again after
   * that, and `pr merge` with `merge`. The verb's own output is captured.
   */
  function adminRun({ views = [ok(OPEN), ok(MERGED)], merge = { status: 0, stdout: '', stderr: '' } } = {}) {
    const calls = [];
    const out = { out: '', err: '' };
    let reads = 0;
    const gh = async (args) => {
      calls.push(args);
      if (args[1] === 'merge') return merge;
      const answer = views[Math.min(reads, views.length - 1)];
      reads += 1;
      return answer;
    };
    return {
      out,
      merges: () => calls.filter((args) => args[1] === 'merge'),
      run: (argv = ['memoro-cli', '671', '--admin']) => run(argv, {
        stdout: { write: (text) => { out.out += text; } },
        stderr: { write: (text) => { out.err += text; } },
        root,
        env: { MC_WORK_ROOT: root },
        resolveRepoPath: async () => '/repos/memoro-cli',
        gh,
        lock: (_root, fn) => fn(),
        now: () => new Date('2026-10-24T12:00:00Z'),
      }),
    };
  }

  it('an open pull request: squashed, pinned to its head, the entry gone', async () => {
    writeQueue([queued(), queued({ pr: 672, since: '2026-10-24T11:05:00Z' })]);
    const d = adminRun();
    assert.equal(await d.run(), 0);
    assert.deepEqual(d.merges(), [['pr', 'merge', '671', '--squash', '--admin', '--subject', 'Fix the thing (#671)', '--match-head-commit', HEAD]]);
    assert.deepEqual(queue().map((entry) => entry.pr), [672], 'only this pull request leaves the queue');
    assert.equal(d.out.out, 'mc: merged #671 into main as abcdef1 (squash, --admin: no gate round)\n');
    assert.equal(d.out.err, '');
  });

  it('a landing entry is left as the merger has it: the merger\'s watch books it', async () => {
    writeQueue([queued({ state: 'landing' })]);
    const d = adminRun();
    assert.equal(await d.run(), 0);
    assert.equal(d.merges().length, 1);
    assert.equal(queue()[0].state, 'landing');
    assert.match(d.out.out, /^mc: #671 is landing in the merger's queue — the merger's round for it stops within a minute and books it$/mu);
  });

  it('a pull request already merged is booked without a merge call', async () => {
    const d = adminRun({ views: [ok({ ...OPEN, ...MERGED })] });
    assert.equal(await d.run(), 0);
    assert.equal(d.merges().length, 0);
    assert.equal(d.out.err, 'mc: #671 was already merged as abcdef1 — booking it\n');
  });

  it('--json says what landed, where, and what became of its queue entry', async () => {
    const d = adminRun();
    assert.equal(await d.run(['memoro-cli', '671', '--admin', '--json']), 0);
    assert.deepEqual(JSON.parse(d.out.out), {
      ok: true, merged: true, merge_commit: MERGE_SHA, merged_into: 'main', queue: 'none',
    });
  });

  it('a closed pull request exits 1 and changes nothing', async () => {
    writeQueue([queued()]);
    const before = readFileSync(mergesPath(root), 'utf8');
    const d = adminRun({ views: [ok({ ...OPEN, state: 'CLOSED' })] });
    assert.equal(await d.run(), 1);
    assert.equal(d.merges().length, 0);
    assert.equal(readFileSync(mergesPath(root), 'utf8'), before);
    assert.equal(d.out.err, 'mc: #671 is closed, not merged — nothing to land\n');
  });

  it('a gh pr merge that fails leaves the queue unchanged, and says the last line of its error', async () => {
    writeQueue([queued()]);
    const before = readFileSync(mergesPath(root), 'utf8');
    const d = adminRun({
      views: [ok(OPEN)],
      merge: { status: 1, stdout: '', stderr: 'X Pull request is not mergeable\nGraphQL: Head branch was modified\n' },
    });
    assert.equal(await d.run(), 1);
    assert.equal(d.merges().length, 1);
    assert.equal(readFileSync(mergesPath(root), 'utf8'), before);
    assert.equal(d.out.err, 'mc: NOT merged — GraphQL: Head branch was modified\n');
  });

  it('a pull request gh cannot read exits 1 and nothing is merged', async () => {
    const d = adminRun({ views: [{ status: 1, stdout: '', stderr: 'no such pull request' }] });
    assert.equal(await d.run(), 1);
    assert.equal(d.merges().length, 0);
    assert.equal(d.out.err, 'mc: gh could not read #671\n');
  });

  it('parseMergeArgs takes --admin for one pull request and refuses it with the four it cannot be with', () => {
    const forms = { docs: true, watch: true, admin: true };
    const parsed = parseMergeArgs(['memoro-cli', '671', '--admin'], forms);
    assert.equal(parsed.error, undefined);
    assert.equal(parsed.admin, true);
    assert.equal(parsed.pr, 671);
    assert.equal(parseMergeArgs(['memoro-cli', '671', '672', '--admin'], forms).error, '--admin lands one pull request at a time');
    assert.equal(parseMergeArgs(['memoro-cli', '671', '--admin', '--check'], forms).error, '--admin lands; --check only measures');
    assert.equal(parseMergeArgs(['memoro-cli', '671', '--admin', '--docs'], forms).error, '--admin or --docs, not both');
    assert.equal(parseMergeArgs(['memoro-cli', '671', '--admin', '--watch'], forms).error, '--admin lands in the call — there is nothing to watch');
    assert.equal(parseMergeArgs(['memoro-cli', '671', '--admin'], { docs: true, watch: true }).error, 'unknown flag: --admin', 'the other forms do not take it');
  });
});

