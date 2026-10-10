/**
 * `mc merge watch <repo> <pr>` — following one job through the merger's queue
 * (ruling 36). Every input is injected: the queue, the merger, GitHub's
 * answer, the clock and a sleep that moves the clock, so a thirty-minute
 * timeout takes no time at all.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { run } from '../../src/mc/commands/merge.js';
import { WATCH_POLL_MS, watch, watchLine, watchState } from '../../src/mc/merge-watch.js';

const REPO = 'memoro-cli';
const job = (pr, over = {}) => ({
  repo: REPO, repo_path: `/repos/${REPO}`, pr, branch: `b-${pr}`, since: `2026-10-10T10:00:0${pr % 10}Z`,
  state: 'queued', ...over,
});
const MERGER = { pid: 41210, since: '2026-10-10T10:00:00Z' };

/**
 * A scripted world: `polls[i]` is the queue at the i-th read (the last one
 * repeats), `mergers[i]` the merger likewise.
 */
function world({ polls, mergers = [MERGER], view = null }) {
  let t = 0;
  let read = 0;
  let merged = 0;
  const views = [];
  const lines = [];
  return {
    lines,
    views,
    deps: {
      repo: REPO,
      pr: 835,
      readQueue: () => polls[Math.min(read++, polls.length - 1)],
      readMerger: () => mergers[Math.min(merged++, mergers.length - 1)],
      prView: (repo, pr) => { views.push({ repo, pr, read }); return view; },
      now: () => t,
      sleep: async (ms) => { t += ms; },
      print: (line) => lines.push(line),
    },
  };
}

describe('watch', () => {
  it('queued at place 3, then landing, then gone and merged: three lines and 0', async () => {
    const w = world({
      polls: [
        [job(833), job(834), job(835)],
        [job(833), job(834), job(835)],
        [job(835, { state: 'landing', started: 's1' })],
        [],
      ],
      view: { state: 'MERGED', mergeCommit: '4f2a1c9deadbeef' },
    });
    const { code, result } = await watch(w.deps);
    assert.equal(code, 0);
    assert.deepEqual(w.lines, [
      'mc: #835 queued — place 3, behind #833 #834',
      'mc: #835 landing — the merger has it (pid 41210)',
      'mc: #835 merged into main as 4f2a1c9 (30s)',
    ]);
    assert.equal(result.outcome, 'merged');
    assert.equal(result.merge_commit, '4f2a1c9deadbeef');
    assert.equal(result.place, 3);
    assert.equal(result.seconds, 30);
    assert.deepEqual(w.views, [{ repo: REPO, pr: 835, read: 4 }], 'GitHub is asked once, after the job left the queue');
  });

  it('landing then red: 1 with the reason markRed kept', async () => {
    const w = world({
      polls: [
        [job(835, { state: 'landing', started: 's1' })],
        [job(835, { state: 'red', reason: 'suite red: 2 failing', answered: '2026-10-10T10:05:00Z' })],
      ],
    });
    const { code, result } = await watch(w.deps);
    assert.equal(code, 1);
    assert.equal(w.lines.at(-1), 'mc: #835 red — suite red: 2 failing; fix it on its branch and mc merge again');
    assert.equal(result.outcome, 'red');
    assert.equal(result.reason, 'suite red: 2 failing');
    assert.equal(w.views.length, 0);
  });

  it('a job never queued and closed: 2', async () => {
    const w = world({ polls: [[job(900)]], view: { state: 'CLOSED', mergeCommit: null } });
    const { code, result } = await watch(w.deps);
    assert.equal(code, 2);
    assert.equal(result.outcome, 'closed');
    assert.equal(w.views.length, 1);
  });

  it('a job never queued and still open: 2, and says how to queue it', async () => {
    const w = world({ polls: [[]], view: { state: 'OPEN', mergeCommit: null } });
    const { code, result } = await watch(w.deps);
    assert.equal(code, 2);
    assert.equal(result.outcome, 'open');
    assert.deepEqual(w.lines, ['mc: #835 is open and not in the merge queue — mc merge memoro-cli 835 queues it']);
  });

  it('an unchanged queued state past --timeout: 3, one line before the end, the job left alone', async () => {
    const w = world({ polls: [[job(834), job(835)]] });
    const { code, result } = await watch({ ...w.deps, timeoutMs: 30 * 60_000 });
    assert.equal(code, 3);
    assert.equal(result.outcome, 'timeout');
    assert.deepEqual(w.lines, [
      'mc: #835 queued — place 2, behind #834',
      'mc: #835 queued — place 2, behind #834 — still queued after 30m; the job stays in the queue',
    ]);
    assert.equal(result.seconds, 30 * 60);
    assert.equal(w.views.length, 0);
  });

  it('a queued job with no merger for two polls: 4', async () => {
    const w = world({ polls: [[job(835)]], mergers: [null] });
    const { code, result } = await watch(w.deps);
    assert.equal(code, 4);
    assert.equal(result.outcome, 'no-merger');
    assert.deepEqual(w.lines, [
      'mc: #835 queued — place 1, next in line — no merger is running',
      'mc: no merger is running and the job waits — the next mc merge or runner pass starts one',
    ]);
  });

  it('one poll without a merger is not yet the answer', async () => {
    const w = world({
      polls: [[job(835)], [job(835)], []],
      mergers: [null, MERGER],
      view: { state: 'MERGED', mergeCommit: 'abcdef0123' },
    });
    const { code } = await watch(w.deps);
    assert.equal(code, 0);
    assert.deepEqual(w.lines.slice(0, 2), [
      'mc: #835 queued — place 1, next in line — no merger is running',
      'mc: #835 queued — place 1, next in line',
    ]);
  });

  it('a job stacked on one still queued waits for it', async () => {
    const parent = { project: 'merge-watch', index: 0, pr: 834, sha: 'abc' };
    const w = world({ polls: [[job(834), job(835, { parent })]], view: null });
    await watch({ ...w.deps, timeoutMs: 0 });
    assert.equal(w.lines[0], 'mc: #835 waits for #834 (stacked on it) to land');
  });

  it('polls every WATCH_POLL_MS', () => {
    assert.equal(WATCH_POLL_MS, 10_000);
  });
});

describe('watchState and watchLine', () => {
  it('a batch is the other entries landing with the same started', () => {
    const entries = [
      job(833, { state: 'landing', started: 's1' }),
      job(834, { state: 'landing', started: 's1' }),
      job(835, { state: 'landing', started: 's1' }),
      job(836),
    ];
    const state = watchState(entries, { repo: REPO, pr: 835, merger: MERGER });
    assert.deepEqual(state, { kind: 'landing', batch: [833, 834], pid: 41210 });
    assert.equal(watchLine(null, state, { pr: 835 }), 'mc: #835 landing in a batch with #833 #834 (pid 41210)');
  });

  it('nothing a reader cares about changed: null', () => {
    const entries = [job(834), job(835)];
    const a = watchState(entries, { repo: REPO, pr: 835, merger: MERGER });
    const b = watchState(entries, { repo: REPO, pr: 835, merger: { pid: 1 } });
    assert.equal(watchLine(a, b, { pr: 835 }), null);
    const moved = watchState([job(835)], { repo: REPO, pr: 835, merger: MERGER });
    assert.equal(watchLine(a, moved, { pr: 835 }), 'mc: #835 queued — place 1, next in line');
  });

  it('another repository\'s number is not this job, and gone is gone', () => {
    const entries = [job(835, { repo: 'memoro' })];
    assert.deepEqual(watchState(entries, { repo: REPO, pr: 835, merger: MERGER }), { kind: 'gone' });
  });
});

describe('mc merge watch', () => {
  const sink = () => { const out = []; return { out, write: (s) => { out.push(s); } }; };

  it('runs the loop for the resolved repository and prints one object with --json', async () => {
    const stdout = sink();
    const stderr = sink();
    let asked = null;
    const code = await run(['watch', REPO, '#835', '--timeout', '5', '--json'], {
      stdout, stderr,
      resolveRepoPath: async () => `/repos/${REPO}`,
      watch: async (opts) => {
        asked = opts;
        opts.print('a line --json must not show');
        return { code: 0, result: { repo: REPO, pr: 835, outcome: 'merged', merge_commit: 'x', reason: null, place: 1, seconds: 3 } };
      },
    });
    assert.equal(code, 0);
    assert.equal(asked.repo, REPO);
    assert.equal(asked.pr, 835);
    assert.equal(asked.timeoutMs, 5 * 60_000);
    assert.deepEqual(JSON.parse(stdout.out.join('')), { repo: REPO, pr: 835, outcome: 'merged', merge_commit: 'x', reason: null, place: 1, seconds: 3 });
  });

  it('an unknown repository or a missing number: 2', async () => {
    const stderr = sink();
    assert.equal(await run(['watch', 'nope', '1'], { stdout: sink(), stderr, resolveRepoPath: async () => null }), 2);
    assert.equal(await run(['watch', REPO], { stdout: sink(), stderr }), 2);
    assert.equal(await run(['watch', REPO, '1', '--timeout', 'x'], { stdout: sink(), stderr }), 2);
  });
});
