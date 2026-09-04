/**
 * The full run nobody asks for.
 *
 * The guarantees under test: a tick measures every repository mc knows and
 * writes down what it found — when it started, what it cost, which commit of
 * the branch it measured, and how it came out; a tick that finds `gate-lock`
 * held by a live round records a skip naming that round and does not wait for
 * it; a round that could not measure is never mistaken for one that found
 * nothing; and stopping the scheduler stops it, leaving no orphan process and
 * no pid file.
 *
 * And where it is reached from: `mc test nightly`, the verb whose round it
 * runs. `mc repo nightly` is the old spelling, and it answers with the new one
 * rather than working — a legacy verb that still works is a verb nobody
 * retires.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { git } from './_helpers/git-fixture.js';
import { addArea, fixture, json, snapshot } from './_helpers/repo-fixture.js';
import { runMcCli } from './_helpers/mc-cli.js';
import { gateLockPath } from '../../src/mc/gate-lock.js';
import { nightlyLogPath, nightlyStatePath } from '../../src/mc/nightly.js';
import { recordNightlyRun } from '../../src/mc/nightly-history.js';
import { nightlyLoop, nightlyTick } from '../../src/mc/nightly-loop.js';

const home = () => mkdtempSync(join(tmpdir(), 'mc-nightly-'));

const REPOS = [
  { name: 'memoro', path: '/repos/memoro' },
  { name: 'memoro-cli', path: '/repos/memoro-cli' },
];

/** A gate report of the shape `runGate` returns for a `--full` round. */
function report({
  verdict = 'green', stopped_at = null, reason = null, red = [], commit = 'a'.repeat(40),
  started_at = '2026-09-03T02:00:00.000Z', duration_ms = 302_300,
} = {}) {
  return {
    full: true,
    verdict,
    stopped_at,
    reason,
    started_at,
    duration_ms,
    base: { ref: 'origin/main', commit },
    candidate: stopped_at ? null : { commit, red, totals: { tests: 17_982, finished: true } },
  };
}

/** Wait for something a detached process does in its own time. */
async function until(predicate, { timeoutMs = 30_000, everyMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => { setTimeout(resolve, everyMs); });
  }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

describe('a tick', () => {
  it('measures every repository mc knows and writes down what it found', async () => {
    const root = home();
    try {
      const said = [];
      const asked = [];
      const outcome = await nightlyTick({
        root,
        repos: REPOS,
        say: (message) => said.push(message),
        round: ({ repoPath }) => {
          asked.push(repoPath);
          return report({ red: repoPath.endsWith('memoro') ? ['data-bus event names'] : [], verdict: repoPath.endsWith('memoro') ? 'red' : 'green' });
        },
      });

      assert.deepEqual(asked, ['/repos/memoro', '/repos/memoro-cli']);
      assert.equal(outcome.runs.length, 2);
      assert.equal(outcome.skipped, null);

      // The four facts the log has to carry, on one line each.
      const line = said.find((message) => message.startsWith('memoro  red'));
      assert.ok(line, said.join('\n'));
      assert.match(line, /started 2026-09-03T02:00:00\.000Z/u);
      assert.match(line, /took 302\.3s/u);
      assert.match(line, /main aaaaaaa/u);
      assert.match(line, /1 red: data-bus event names/u);

      // And the round's own facts, for whoever asks "since when" next.
      assert.equal(outcome.runs[0].commit, 'a'.repeat(40));
      assert.deepEqual(outcome.runs[0].red, ['data-bus event names']);
      assert.equal(outcome.runs[1].verdict, 'green');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('a gate round already running ends the tick, named, and nothing waits for it', async () => {
    const root = home();
    try {
      // A live pid, because a dead one is litter rather than a holder — the
      // whole of `gate-lock`'s reaping.
      writeFileSync(gateLockPath(root), JSON.stringify({
        pid: process.pid, repo: 'memoro', pr: 11082, since: '2026-09-03T02:00:00.000Z',
      }));
      const said = [];
      let ran = 0;
      const started = Date.now();
      const outcome = await nightlyTick({
        root,
        repos: REPOS,
        say: (message) => said.push(message),
        round: () => { ran += 1; return report(); },
      });

      assert.equal(ran, 0, 'the tick ran a round while another round held the lock');
      assert.deepEqual(outcome.runs, []);
      assert.equal(outcome.skipped.pid, process.pid);
      assert.match(outcome.skipped.reason, /pid \d+/u);
      assert.match(outcome.skipped.reason, /memoro #11082/u);
      assert.match(said.join('\n'), /memoro {2}skipped {2}another gate round is running/u);
      // Not waited for: no retry, no backoff, no queue. The tick is over.
      assert.ok(Date.now() - started < 2000, 'the tick waited for the lock');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('a round that finds the lock taken between the look and the ask is a skip too', async () => {
    const root = home();
    try {
      const said = [];
      const outcome = await nightlyTick({
        root,
        repos: REPOS,
        say: (message) => said.push(message),
        // What `runGate` returns when `takeGateLock` refuses it.
        round: () => report({ verdict: 'stopped', stopped_at: 'busy', reason: 'another gate round is running on this machine (pid 4242, memoro #11082) — one at a time' }),
      });
      assert.deepEqual(outcome.runs, [], 'a busy round was counted as a measurement');
      assert.ok(outcome.skipped);
      assert.match(outcome.skipped.reason, /one at a time/u);
      assert.match(said.join('\n'), /skipped/u);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('a round that could not measure is never a round that found nothing', async () => {
    const root = home();
    try {
      const said = [];
      const outcome = await nightlyTick({
        root,
        repos: REPOS,
        say: (message) => said.push(message),
        round: ({ repoPath }) => {
          if (repoPath.endsWith('/memoro')) throw new Error('git fetch failed');
          return report({ verdict: 'stopped', stopped_at: 'declaration', reason: 'memoro-cli declares select and no suite' });
        },
      });

      // Both are runs, and neither is green. A day of these reported as a
      // green streak is the false green this project exists to remove.
      assert.equal(outcome.runs.length, 2);
      assert.deepEqual(outcome.runs.map((run) => run.verdict), ['stopped', 'stopped']);
      assert.equal(outcome.runs[0].stopped_at, 'threw');
      assert.equal(outcome.runs[0].red, null, 'a run that never ran must not carry an empty red set');
      assert.equal(outcome.runs[1].stopped_at, 'declaration');
      assert.match(said.join('\n'), /stopped at declaration/u);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('the loop', () => {
  it('ticks again after the interval, and a tick that throws does not end it', async () => {
    const root = home();
    try {
      const lines = [];
      let ticks = 0;
      await nightlyLoop({
        root,
        intervalMs: 10,
        rounds: 3,
        log: (message) => lines.push(message),
        tick: () => {
          ticks += 1;
          if (ticks === 2) throw new Error('the board could not be read');
          return { at: new Date().toISOString(), runs: [{ repo: 'memoro' }], skipped: null };
        },
      });
      assert.equal(ticks, 3);
      assert.equal(lines.filter((line) => line === 'tick: 1 measured').length, 2);
      assert.equal(lines.filter((line) => line.startsWith('tick failed')).length, 1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('the process', () => {
  it('starts, ticks on its own, and stops leaving no orphan and no pid file', async () => {
    const fx = fixture({ name: 'nightly' });
    const worktree = addArea(fx, 'alpha', 'alpha');
    try {
      const before = {
        head: git(fx.dir, 'rev-parse HEAD'),
        branches: git(fx.dir, 'show-ref --heads'),
        dirty: git(fx.dir, 'status --porcelain'),
        files: snapshot(fx.dir, { skipGit: true }),
        worktreeFiles: snapshot(worktree, { skipGit: true }),
        work: snapshot(fx.workRoot),
      };

      // Two ticks a second apart, so the interval boundary is crossed inside
      // this test rather than asserted about. The fixture repository has no
      // gate declaration, so each round stops at `declaration` in a moment —
      // which is a run that did not produce a suite result, and it must be
      // logged as one.
      const started = runMcCli(['test', 'nightly', 'start', '--interval', '1'], fx.env);
      assert.equal(started.status, 0, started.stderr);
      assert.match(started.stdout, /a full run of every repository every 1s \(pid \d+\)/u);

      const state = json(runMcCli(['test', 'nightly', 'status', '--json'], fx.env));
      assert.equal(state.running, true);
      assert.ok(state.pid > 0);

      const log = nightlyLogPath(fx.mcHome);
      const twice = await until(() => {
        if (!existsSync(log)) return null;
        const text = readFileSync(log, 'utf8');
        return text.match(/stopped at declaration/gu)?.length >= 2 ? text : null;
      });
      assert.ok(twice, `two runs never appeared in ${log}:\n${existsSync(log) ? readFileSync(log, 'utf8') : '(no log)'}`);
      // Every run says when it began, what it cost, and how it came out.
      assert.match(twice, /started \d{4}-\d\d-\d\dT[\d:.]+Z {2}took [\d.]+s/u);

      const stopped = runMcCli(['test', 'nightly', 'stop'], fx.env);
      assert.equal(stopped.status, 0, stopped.stderr);
      assert.match(stopped.stdout, /stopped the nightly \(pid \d+\)/u);
      assert.equal(existsSync(nightlyStatePath(fx.mcHome)), false, 'the pid file outlived the process');
      const gone = await until(() => !alive(state.pid));
      assert.ok(gone !== null, 'the nightly was still running after stop');
      assert.equal(json(runMcCli(['test', 'nightly', 'status', '--json'], fx.env)).running, false);

      // A meter: it wrote its own files and touched no repository.
      assert.equal(git(fx.dir, 'rev-parse HEAD'), before.head);
      assert.equal(git(fx.dir, 'show-ref --heads'), before.branches);
      assert.equal(git(fx.dir, 'status --porcelain'), before.dirty);
      assert.deepEqual(snapshot(fx.dir, { skipGit: true }), before.files);
      assert.deepEqual(snapshot(worktree, { skipGit: true }), before.worktreeFiles);
      assert.deepEqual(snapshot(fx.workRoot), before.work);
    } finally {
      runMcCli(['test', 'nightly', 'stop'], fx.env);
      fx.cleanup();
    }
  });

  it('stopping nothing is not an error, and neither is asking twice', async () => {
    const fx = fixture({ name: 'nightly' });
    try {
      const stopped = runMcCli(['test', 'nightly', 'stop'], fx.env);
      assert.equal(stopped.status, 0);
      assert.match(stopped.stdout, /no nightly is running/u);

      const started = runMcCli(['test', 'nightly', 'start', '--interval', '3600'], fx.env);
      assert.equal(started.status, 0, started.stderr);
      const again = runMcCli(['test', 'nightly', 'start'], fx.env);
      assert.equal(again.status, 0);
      assert.match(again.stdout, /already running \(pid \d+, every 1h\)/u);
    } finally {
      runMcCli(['test', 'nightly', 'stop'], fx.env);
      fx.cleanup();
    }
  });

  it('a pid file whose process is gone is said out loud, and clearing it is the stop', () => {
    const fx = fixture({ name: 'nightly' });
    try {
      runMcCli(['test', 'nightly', 'start', '--interval', '3600'], fx.env);
      const state = json(runMcCli(['test', 'nightly', 'status', '--json'], fx.env));
      process.kill(state.pid, 'SIGKILL');
      const abandoned = json(runMcCli(['test', 'nightly', 'status', '--json'], fx.env));
      assert.equal(abandoned.running, false);
      assert.equal(abandoned.abandoned, true);
      const cleared = runMcCli(['test', 'nightly', 'stop'], fx.env);
      assert.match(cleared.stdout, /cleared the pid file it left behind/u);
      assert.equal(existsSync(nightlyStatePath(fx.mcHome)), false);
    } finally {
      runMcCli(['test', 'nightly', 'stop'], fx.env);
      fx.cleanup();
    }
  });

  it('a live pid that is not the nightly is not the nightly', () => {
    // Pids are reused, and a pid file outlives a reboot. Asking only whether
    // the pid is alive would report a scheduler that is running whenever the
    // number happened to land on somebody else's process — so the command
    // line has to be the runner's too. This test's own pid is alive and is
    // not it.
    const fx = fixture({ name: 'nightly' });
    try {
      runMcCli(['test', 'nightly', 'start', '--interval', '3600'], fx.env);
      runMcCli(['test', 'nightly', 'stop'], fx.env);
      writeFileSync(nightlyStatePath(fx.mcHome), JSON.stringify({
        pid: process.pid, started_at: new Date().toISOString(), interval_ms: 3_600_000,
      }));
      const state = json(runMcCli(['test', 'nightly', 'status', '--json'], fx.env));
      assert.equal(state.running, false);
      assert.equal(state.abandoned, true);
    } finally {
      runMcCli(['test', 'nightly', 'stop'], fx.env);
      fx.cleanup();
    }
  });

  it('runs on a cadence of a day unless told otherwise', () => {
    const fx = fixture({ name: 'nightly' });
    try {
      assert.equal(json(runMcCli(['test', 'nightly', 'status', '--json'], fx.env)).interval_ms, 86_400_000);
    } finally { fx.cleanup(); }
  });

  it('the old spelling says where it went, and starts nothing', () => {
    const fx = fixture({ name: 'nightly' });
    try {
      const moved = runMcCli(['repo', 'nightly', 'start', '--interval', '3600'], fx.env);
      assert.equal(moved.status, 2, moved.stdout);
      assert.match(moved.stderr, /mc repo nightly is now mc test nightly/u);
      // Not an alias: nothing was started, and nothing is running.
      assert.equal(existsSync(nightlyStatePath(fx.mcHome)), false, 'the old spelling started a nightly');
      assert.equal(json(runMcCli(['test', 'nightly', 'status', '--json'], fx.env)).running, false);
      assert.equal(runMcCli(['repo', 'nightly', 'status'], fx.env).status, 2);
    } finally {
      runMcCli(['test', 'nightly', 'stop'], fx.env);
      fx.cleanup();
    }
  });
});

/**
 * The question the meter exists for, asked where the meter is started.
 *
 * Until 2026-09-04 "red, and since when" was printed only by `mc repo status`.
 * A person who typed `nightly start` should be able to type `nightly status`
 * and read what it found.
 */
describe('mc test nightly status — red, and since when', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const ago = (days) => new Date(Date.now() - days * DAY).toISOString();

  const record = (fx, at, red, commit) => recordNightlyRun({
    repo: 'repo', path: fx.dir, started_at: at, duration_ms: 302_300,
    commit, verdict: red.length ? 'red' : 'green', stopped_at: red.length ? 'red' : null,
    reason: null, red, tests: 2445,
  }, { root: fx.mcHome });

  it('prints each repository\'s last measured run, and the oldest red with its date', () => {
    const fx = fixture({ name: 'nightly' });
    addArea(fx, 'alpha', 'alpha');
    try {
      // Two runs, the second red on a name the first was also red on: the
      // streak began at the first, not at the most recent.
      const first = ago(3);
      record(fx, first, ['data-bus event names'], 'a'.repeat(40));
      record(fx, ago(1), ['data-bus event names'], 'b'.repeat(40));

      const page = runMcCli(['test', 'nightly', 'status'], fx.env);
      assert.equal(page.status, 0, page.stderr);
      assert.match(page.stdout, /not running/u);
      assert.match(page.stdout, /full run\s+.*1 red of 2,445\s+bbbbbbb/u);
      // The streak reaches the oldest run kept, so the date is a floor — said
      // as one, with the name it is about.
      assert.match(page.stdout, /since at least 3d ago\s+data-bus event names/u);

      const state = json(runMcCli(['test', 'nightly', 'status', '--json'], fx.env));
      assert.equal(state.running, false);
      assert.equal(state.interval_ms, 86_400_000);
      const reading = state.repos.repo;
      assert.equal(reading.runs, 2);
      assert.equal(reading.measured.commit, 'b'.repeat(40));
      assert.equal(reading.measured.red, 1);
      assert.equal(reading.red[0].name, 'data-bus event names');
      // The whole point: the first run that saw it, not the most recent.
      assert.equal(reading.red[0].since, first);
      assert.equal(reading.red[0].since_commit, 'a'.repeat(40));
    } finally { fx.cleanup(); }
  });

  it('a repository nobody has measured is named anyway, rather than left out', () => {
    const fx = fixture({ name: 'nightly' });
    addArea(fx, 'alpha', 'alpha');
    try {
      const page = runMcCli(['test', 'nightly', 'status'], fx.env);
      assert.equal(page.status, 0, page.stderr);
      assert.match(page.stdout, /full run\s+never — mc test nightly start/u);
      assert.deepEqual(json(runMcCli(['test', 'nightly', 'status', '--json'], fx.env)).repos.repo, {
        runs: 0, last: null, measured: null, red: [],
      });
    } finally { fx.cleanup(); }
  });
});
