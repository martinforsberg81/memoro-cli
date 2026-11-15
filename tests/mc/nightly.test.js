/**
 * The full run nobody asks for.
 *
 * The guarantees under test: a full run measures each repository mc knows
 * and writes down what it found — when it started, what it cost, which commit
 * of the branch it measured, and how it came out; it follows main: a pass starts
 * a run where main moved since the last measurement, or where the runner cut
 * the last one short (Martin, 2026-11-15), one at a time per repository, and a
 * run starts nothing after it; a merge round's lock does not
 * hold it back; a round that could not measure is never mistaken for one that
 * found nothing; its reds, and the files of a test that never ended, go to
 * the main-red mend (`requestMainRepair`);
 * and a STOP starts no further run.
 *
 * And where it is reached from: `mc test nightly status`, the verb whose round
 * it runs — the only word it has, since the full run is a chore of the runner
 * (`tests/mc/run.test.js`) and nothing here starts a process. `mc repo nightly`
 * is the old spelling, and it answers with the new one rather than working — a
 * legacy verb that still works is a verb nobody retires.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { git } from './_helpers/git-fixture.js';
import { addArea, fixture, json, snapshot } from './_helpers/repo-fixture.js';
import { preloadVerbs, runVerb } from './_helpers/mc-verb.js';
import { gateLockPath } from '../../src/mc/gate-lock.js';
import { nightlyLogPath } from '../../src/mc/nightly.js';
import { nightlyReading, readNightlyHistory, recordNightlyRun } from '../../src/mc/nightly-history.js';
import { fullRun, fullRunTick, loggedTick, scheduledRound } from '../../src/mc/nightly-loop.js';
import { claimFullRun, liveClaims, releaseClaim } from '../../src/mc/full-run-claim.js';

await preloadVerbs('test', 'repo');

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

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

/** A pass over `repos` that waits for every run it started, with what it asked and said. */
async function pass(root, extra = {}) {
  const asked = [];
  const said = [];
  const repaired = [];
  const outcome = await fullRunTick({
    root, repos: REPOS, head: () => null, say: (message) => said.push(message),
    repair: (request) => { repaired.push(request); return { created: ['mend-1'], open: [] }; },
    round: ({ repoPath }) => { asked.push(repoPath); return report(); },
    ...extra,
  });
  const runs = await outcome.done;
  return { outcome, runs, asked, said, repaired };
}

describe('a full run', () => {
  it('a command-only full-run red stays red in history and queues main repair with retained diagnostics', async () => {
    const root = home();
    const failure = { kind: 'output', tail: ['unbound token'] };
    try {
      const { runs, repaired } = await pass(root, { repos: [REPOS[0]], round: () => ({
        ...report({ verdict: 'red' }), stopped_at: 'selected-gate', reason: 'css:tokens:all failed',
        extra_gates: [{ name: 'css:tokens:all', id: 'css-tokens-all', command: 'npm run css:tokens:all',
          ok: false, exit_code: 1, failure, output_path: '/retained/full/css.log' }],
      }) });
      assert.deepEqual(runs[0].red, ['command:css:tokens:all']);
      assert.equal(repaired.length, 1);
      assert.equal(repaired[0].base, SHA);
      assert.deepEqual(repaired[0].files, []);
      assert.deepEqual(repaired[0].commands, [{ id: 'css-tokens-all', packageScript: 'css:tokens:all',
        command: 'npm run css:tokens:all', exit_code: 1, failure, output_path: '/retained/full/css.log' }]);
      assert.deepEqual(readNightlyHistory('/repos/memoro', { root }).runs.at(-1).red, ['command:css:tokens:all']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('measures every repository mc knows and writes down what it found', async () => {
    const root = home();
    try {
      const asked = [];
      const { outcome, runs, said } = await pass(root, {
        round: ({ repoPath }) => {
          asked.push(repoPath);
          return report({ red: repoPath.endsWith('memoro') ? ['data-bus event names'] : [], verdict: repoPath.endsWith('memoro') ? 'red' : 'green' });
        },
      });
      assert.deepEqual(asked, ['/repos/memoro', '/repos/memoro-cli']);

      assert.deepEqual(outcome.started.map((one) => one.repo), ['memoro', 'memoro-cli']);
      assert.equal(runs.length, 2);

      // The four facts the log has to carry, on one line each.
      const line = said.find((message) => message.startsWith('memoro  red'));
      assert.ok(line, said.join('\n'));
      assert.match(line, /started 2026-09-03T02:00:00\.000Z/u);
      assert.match(line, /took 302\.3s/u);
      assert.match(line, /main aaaaaaa/u);
      assert.match(line, /1 red: data-bus event names/u);

      // And the round's own facts, for whoever asks "since when" next.
      const memoro = runs.find((run) => run.repo === 'memoro');
      assert.equal(memoro.commit, SHA);
      assert.deepEqual(memoro.red, ['data-bus event names']);
      assert.equal(runs.find((run) => run.repo === 'memoro-cli').verdict, 'green');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('full commands passed on their declared retry, passed alone or unavailable are not main reds', async () => {
    const root = home();
    try {
      const { runs, repaired } = await pass(root, { repos: [REPOS[0]], round: () => ({
        ...report(), extra_gates: [
          { name: 'retry', ok: false, retry: { ok: true } },
          { name: 'alone', ok: false },
          { name: 'unavailable', ok: false, unavailable: true },
        ], alone: { gates: [{ name: 'alone', outcome: 'passed' }] },
      }) });
      assert.deepEqual(runs[0].red, []);
      assert.deepEqual(repaired, []);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  // Martin, 2026-11-13: a full run does not share or wait for the merge lane.
  it('a merge round holding the repository\'s lane does not hold the full run back', async () => {
    const root = home();
    try {
      writeFileSync(gateLockPath(root, 'memoro'), JSON.stringify({
        pid: process.pid, repo: 'memoro', pr: 11082, since: '2026-09-03T02:00:00.000Z',
      }));
      const { asked } = await pass(root);
      assert.deepEqual(asked, ['/repos/memoro', '/repos/memoro-cli']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('a round that could not measure is never a round that found nothing', async () => {
    const root = home();
    try {
      const { runs, said } = await pass(root, {
        round: ({ repoPath }) => {
          if (repoPath.endsWith('/memoro')) throw new Error('git fetch failed');
          return report({ verdict: 'stopped', stopped_at: 'declaration', reason: 'memoro-cli declares select and no suite' });
        },
      });

      // Both are runs, and neither is green. A day of these reported as a
      // green streak is the false green this project exists to remove.
      const by = Object.fromEntries(runs.map((run) => [run.repo, run]));
      assert.deepEqual(runs.map((run) => run.verdict), ['stopped', 'stopped']);
      assert.equal(by.memoro.stopped_at, 'threw');
      assert.equal(by.memoro.red, null, 'a run that never ran must not carry an empty red set');
      assert.equal(by['memoro-cli'].stopped_at, 'declaration');
      assert.match(said.join('\n'), /stopped at declaration/u);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('the reds it finds on main are handed to the main-red mend', async () => {
    const root = home();
    try {
      const red = { ...report({ verdict: 'red', red: ['memoro-cli › names'] }) };
      red.candidate.red_tests = [{ file: 'tests/mc/names.test.js', name: 'names', error: ['expected 1', 'got 2'] }];
      const { repaired, said } = await pass(root, { repos: [REPOS[1]], round: () => red });
      assert.deepEqual(repaired, [{
        repo: 'memoro-cli', base: SHA, files: ['tests/mc/names.test.js'],
        tests: [{ file: 'tests/mc/names.test.js', name: 'names', error: ['expected 1', 'got 2'] }],
      }]);
      assert.match(said.join('\n'), /main is red in tests\/mc\/names\.test\.js at aaaaaaa — main-red mend queued: mend-1/u);
    } finally { rmSync(root, { recursive: true, force: true }); }
    // A test that never ends is a red test: the files a stalled run names go
    // to the same mend, with the stall as their failure. A stall naming none asks nothing.
    const hung = home();
    try {
      const stalled = report({ verdict: 'stopped', stopped_at: 'stalled', reason: 'no progress for 15 min' });
      stalled.stalled_files = ['tests/sw.test.js'];
      const { repaired, said } = await pass(hung, { repos: [REPOS[0]], round: () => stalled });
      assert.deepEqual(repaired, [{
        repo: 'memoro', base: SHA, files: ['tests/sw.test.js'],
        tests: [{ file: 'tests/sw.test.js', name: null, error: ['never ended in the full run: no progress for 15 min'] }],
      }]);
      assert.match(said.join('\n'), /a test never ended in tests\/sw\.test\.js at aaaaaaa — main-red mend queued: mend-1/u);
      const unnamed = report({ verdict: 'stopped', stopped_at: 'stalled', reason: 'no progress for 15 min' });
      const quiet = home();
      try {
        assert.deepEqual((await pass(quiet, { repos: [REPOS[0]], round: () => unnamed })).repaired, []);
      } finally { rmSync(quiet, { recursive: true, force: true }); }
    } finally { rmSync(hung, { recursive: true, force: true }); }
    // A green run asks for nothing.
    const other = home();
    try {
      assert.deepEqual((await pass(other, { repos: [REPOS[1]] })).repaired, []);
    } finally { rmSync(other, { recursive: true, force: true }); }
  });
});

describe('a full run, and whether main moved', () => {
  const seed = (root, commit = SHA, extra = {}) => recordNightlyRun({
    repo: 'memoro', path: '/repos/memoro', started_at: '2026-09-02T02:00:00.000Z', duration_ms: 300_000,
    commit, verdict: 'red', stopped_at: 'red', reason: null, red: ['data-bus event names'], tests: 17_982, ...extra,
  }, { root });

  it('the head the last measurement covered is not measured again, and nothing is written', async () => {
    const root = home();
    try {
      seed(root);
      const { outcome, asked } = await pass(root, { repos: [REPOS[0]], head: () => SHA });
      assert.deepEqual(asked, []);
      assert.deepEqual(outcome.started, []);
      assert.match(outcome.waiting[0].why, /main is still aaaaaaa, measured 2026-09-02T02:00:00\.000Z; not measured again/u);
      // A chore pass every few minutes writing "unchanged" would push the
      // measurements out of the history.
      assert.equal(readNightlyHistory('/repos/memoro', { root }).runs.length, 1);
      assert.equal(nightlyReading('/repos/memoro', { root }).measured.at, '2026-09-02T02:00:00.000Z');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('an unchanged repository does not hold up the next one', async () => {
    const root = home();
    try {
      seed(root);
      const { asked } = await pass(root, { head: () => SHA });
      assert.deepEqual(asked, ['/repos/memoro-cli']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('a head that moved is measured exactly as before', async () => {
    const root = home();
    try {
      seed(root);
      const { runs } = await pass(root, {
        repos: [REPOS[0]], head: () => OTHER,
        round: () => report({ red: ['data-bus event names'], verdict: 'red', commit: OTHER }),
      });
      const { runs: stored } = readNightlyHistory('/repos/memoro', { root });
      assert.equal(stored.length, 2);
      assert.equal(stored[1].commit, OTHER);
      assert.deepEqual(stored[1].red, ['data-bus event names']);
      assert.equal(runs[0].verdict, 'red');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  for (const [name, probe] of [
    ['null', () => null],
    ['a throw', () => { throw new Error('Could not resolve host: github.com'); }],
    ['a differently-cased sha', () => SHA.toUpperCase()],
  ]) {
    it(`a head that cannot be read (${name}) is measured, not skipped`, async () => {
      const root = home();
      try {
        seed(root);
        const { asked } = await pass(root, { repos: [REPOS[0]], head: probe });
        assert.deepEqual(asked, ['/repos/memoro']);
        assert.equal(readNightlyHistory('/repos/memoro', { root }).runs.length, 2);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }

  it('a repository never measured is measured, whatever the head', async () => {
    const root = home();
    try {
      const { asked } = await pass(root, { repos: [REPOS[0]], head: () => SHA });
      assert.deepEqual(asked, ['/repos/memoro']);
      assert.equal(readNightlyHistory('/repos/memoro', { root }).runs.length, 1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('a history of nothing but stopped rounds has no commit to compare and is measured', async () => {
    const root = home();
    try {
      recordNightlyRun({
        repo: 'memoro', path: '/repos/memoro', started_at: '2026-09-02T02:00:00.000Z', duration_ms: 1,
        commit: SHA, verdict: 'stopped', stopped_at: 'fetch', reason: 'offline', red: null, tests: null,
      }, { root });
      const { asked } = await pass(root, { repos: [REPOS[0]], head: () => SHA });
      assert.deepEqual(asked, ['/repos/memoro']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('a run that stalled on a commit is not started again on it: the next waits for main to move', async () => {
    const root = home();
    try {
      seed(root, OTHER);
      seed(root, SHA, { started_at: '2026-09-03T02:00:00.000Z', verdict: 'stopped', stopped_at: 'stalled', reason: 'no progress for 15 min', red: null, tests: null });
      const still = await pass(root, { repos: [REPOS[0]], head: () => SHA });
      assert.deepEqual(still.asked, []);
      assert.match(still.outcome.waiting[0].why, /where the last full run stopped at stalled .*the next starts when main moves/u);
      const moved = await pass(root, { repos: [REPOS[0]], head: () => 'c'.repeat(40) });
      assert.deepEqual(moved.asked, ['/repos/memoro']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('a full run follows main: a pass starts what main or the runner left undone', () => {
  const MINUTES_AGO = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
  const seedAt = (root, minutes, extra = {}) => recordNightlyRun({
    repo: 'memoro', path: '/repos/memoro', started_at: MINUTES_AGO(minutes), duration_ms: 60_000,
    commit: SHA, verdict: 'green', stopped_at: null, reason: null, red: [], tests: 17_982, ...extra,
  }, { root });

  it('main moved: started though the last run began minutes ago', async () => {
    const root = home();
    try {
      seedAt(root, 5);
      const { asked, outcome } = await pass(root, { repos: [REPOS[0]], head: () => OTHER });
      assert.deepEqual(asked, ['/repos/memoro']);
      assert.match(outcome.started[0].why, /main moved to bbbbbbb since the measurement of aaaaaaa/u);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  for (const stop of ['gone', 'killed']) {
    it(`a run the runner cut short (${stop}) is started at once, on the same commit and minutes later`, async () => {
      const root = home();
      try {
        seedAt(root, 20, { commit: OTHER });
        seedAt(root, 3, { verdict: 'stopped', stopped_at: stop, reason: 'the runner ended it', red: null, tests: null });
        const { asked } = await pass(root, { repos: [REPOS[0]], head: () => SHA });
        assert.deepEqual(asked, ['/repos/memoro']);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }

  it('a repository whose run is in flight is not started, though main moved', async () => {
    const root = home();
    try {
      seedAt(root, 5);
      const running = new Map([['/repos/memoro', new Promise(() => {})]]);
      const { asked, outcome } = await pass(root, { repos: [REPOS[0]], head: () => OTHER, running });
      assert.deepEqual(asked, []);
      assert.deepEqual(outcome.running, ['memoro']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('a main that is the measured commit is not started, minutes or days after the run', async () => {
    const root = home();
    try {
      seedAt(root, 5);
      assert.deepEqual((await pass(root, { repos: [REPOS[0]], head: () => SHA })).asked, []);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('a run that stopped on this commit by something other than the runner is not started again on it', async () => {
    const root = home();
    try {
      seedAt(root, 20, { commit: OTHER });
      seedAt(root, 3, { verdict: 'stopped', stopped_at: 'stalled', reason: 'no progress for 15 min', red: null, tests: null });
      assert.deepEqual((await pass(root, { repos: [REPOS[0]], head: () => SHA })).asked, []);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('a full run, one at a time per repository', () => {
  it('a repository whose run is in flight is not started again', async () => {
    const root = home();
    try {
      const running = new Map([['/repos/memoro', new Promise(() => {})]]);
      const { outcome, asked } = await pass(root, { running });
      assert.deepEqual(asked, ['/repos/memoro-cli']);
      assert.deepEqual(outcome.running, ['memoro']);
      // Its own run is gone from the map once it has ended; the other is untouched.
      assert.deepEqual([...running.keys()], ['/repos/memoro']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('a run that ends starts nothing after it, even though main moved meanwhile', async () => {
    const root = home();
    try {
      // main moves from a… to b… while the first run measures a…, then stays.
      let main = SHA;
      const asked = [];
      const { runs } = await pass(root, {
        repos: [REPOS[0]],
        head: () => main,
        round: () => {
          const measured = main;
          asked.push(measured);
          main = OTHER;
          return report({ commit: measured });
        },
      });
      assert.deepEqual(asked, [SHA], 'the next pass, not this run, measures the moved main');
      assert.deepEqual(runs.map((run) => run.commit), [SHA]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('a full run, one at a time per tree — whoever starts it', () => {
  // The other starter's claim, written the way `mc deploy`'s preparation or a
  // hand-typed `--full` writes it; `alive` says which pids are running.
  const OTHER_PID = 4242;
  const STARTED = new Date('2026-09-03T02:00:00.000Z');
  const held = (root, { sha = SHA, alive = () => true } = {}) => claimFullRun({
    repo: 'memoro', sha, verb: 'mc deploy', root, pid: OTHER_PID, alive, now: () => STARTED,
  }).claim;
  const REPO = REPOS[0];
  /** What the run being followed leaves behind when it ends: its answer, its claim given back. */
  const finish = (root, claim, extra = {}) => {
    recordNightlyRun({
      repo: 'memoro', path: REPO.path, started_at: '2026-09-03T02:00:01.000Z', duration_ms: 1000,
      commit: SHA, verdict: 'green', stopped_at: null, reason: null, red: [], tests: 17_982, ...extra,
    }, { root });
    releaseClaim(claim, { root, alive: () => true });
  };

  it('a second starter of a tree already being measured follows the run and calls the round once', async () => {
    const root = home();
    try {
      const claim = held(root);
      let rounds = 0;
      const said = [];
      const slept = [];
      const run = await fullRun(REPO, {
        root, sha: SHA, say: (message) => said.push(message), repair: null,
        round: () => { rounds += 1; return report(); },
        claims: { alive: () => true, pollMs: 1, sleep: async (ms) => { slept.push(ms); finish(root, claim); } },
      });
      assert.equal(rounds, 0, 'the follower measures nothing of its own');
      assert.equal(slept.length, 1, 'it waited for the run, once');
      assert.equal(run.joined, true);
      assert.equal(run.commit, SHA);
      assert.deepEqual(run.red, []);
      assert.match(said.join('\n'), /already being measured \(pid 4242, since 2026-09-03T02:00:00.000Z\); following it, not starting a second/u);
      assert.equal(readNightlyHistory(REPO.path, { root }).runs.length, 1, 'one answer in the history, not two');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('a follower of a long run says each minute that it is still following', async () => {
    const root = home();
    try {
      const claim = held(root);
      const said = [];
      let at = 0;
      let polls = 0;
      await fullRun(REPO, {
        root, sha: SHA, say: (message) => said.push(message), repair: null, round: () => report(),
        claims: {
          alive: () => true, pollMs: 1, clock: () => at,
          sleep: async () => { at += 20_000; polls += 1; if (polls === 10) finish(root, claim); },
        },
      });
      const still = said.filter((message) => /still following the full run of/u.test(message));
      assert.equal(still.length, 3, `one line per minute over 200 s: ${said.join(' | ')}`);
      assert.match(still[0], /still following the full run of aaaaaaa \(pid 4242\), 1 min so far/u);
      assert.match(still[2], /3 min so far/u);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('two starters of the same sha at once call the round once', async () => {
    const root = home();
    try {
      let rounds = 0;
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      const claims = { alive: () => true, pollMs: 1, sleep: async () => { await gate; } };
      const round = async () => { rounds += 1; await gate; return report({ started_at: new Date().toISOString() }); };
      const first = fullRun(REPO, { root, sha: SHA, say: () => {}, repair: null, round, claims });
      // The same process holds both claims in this test: a claim is told apart by its start,
      // so the second starter's own pid is another process.
      const second = fullRun(REPO, { root, sha: SHA, say: () => {}, repair: null, round, claims: { ...claims, pid: 9999 } });
      await new Promise((resolve) => { setTimeout(resolve, 20); });
      release();
      const [a, b] = await Promise.all([first, second]);
      assert.equal(rounds, 1, 'one full run for one tree');
      assert.equal([a, b].filter((run) => run.joined).length, 1);
      assert.deepEqual(liveClaims({ root, alive: () => true }), [], 'both claims are given back');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('a run of another sha waits for the one in flight: the full-run checkout is never prepared under it', async () => {
    const root = home();
    try {
      const claim = held(root, { sha: OTHER });
      const events = [];
      const said = [];
      const run = await fullRun(REPO, {
        root, sha: SHA, say: (message) => said.push(message), repair: null,
        round: () => { events.push('round'); return report(); },
        claims: { alive: () => true, pollMs: 1, sleep: async () => { events.push('wait'); releaseClaim(claim, { root, alive: () => true }); } },
      });
      assert.deepEqual(events, ['wait', 'round'], 'measured only after the other tree\'s run had ended');
      assert.notEqual(run.joined, true, 'another tree\'s answer is no answer to this one');
      assert.match(said.join('\n'), /a full run of bbbbbbb is using the full-run checkout \(pid 4242\); waiting for it before measuring aaaaaaa/u);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('a claim whose process died is no claim, and a follower whose run left no answer starts its own', async () => {
    const root = home();
    try {
      // Dead before anyone looked: nothing to join.
      held(root, { alive: () => false });
      let rounds = 0;
      await fullRun(REPO, {
        root, sha: SHA, say: () => {}, repair: null,
        round: () => { rounds += 1; return report(); },
        claims: { alive: (pid) => pid !== OTHER_PID, pollMs: 1, sleep: async () => {} },
      });
      assert.equal(rounds, 1, 'a dead claimant is ignored');

      // Alive when joined, gone without a word: the follower measures.
      const root2 = home();
      try {
        const claim = held(root2);
        let up = true;
        const said = [];
        await fullRun(REPO, {
          root: root2, sha: SHA, say: (message) => said.push(message), repair: null,
          round: () => { rounds += 1; return report(); },
          claims: { alive: (pid) => (pid === OTHER_PID ? up : true), pollMs: 1, sleep: async () => { up = false; } },
        });
        assert.equal(rounds, 2, 'the run that left no record is run again');
        assert.match(said.join('\n'), /ended without a record; starting one/u);
        assert.ok(claim);
      } finally { rmSync(root2, { recursive: true, force: true }); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('a full run, and a STOP', () => {
  it('a STOP that is already there starts nothing', async () => {
    const root = home();
    try {
      const { outcome, asked } = await pass(root, { shouldStop: () => true });
      assert.deepEqual(asked, []);
      assert.equal(outcome.stopped, true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('a STOP during a run leaves one run written', async () => {
    const root = home();
    try {
      let main = SHA;
      let stop = false;
      const asked = [];
      await pass(root, {
        repos: [REPOS[0]], head: () => main, shouldStop: () => stop,
        round: ({ repoPath }) => { asked.push(repoPath); main = OTHER; stop = true; return report(); },
      });
      assert.deepEqual(asked, ['/repos/memoro']);
      assert.equal(readNightlyHistory('/repos/memoro', { root }).runs.length, 1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('the log', () => {
  it('holds the round\'s whole narration, while the caller is handed the summaries alone', async () => {
    const root = home();
    try {
      const said = [];
      const outcome = await loggedTick({
        root,
        repos: [REPOS[0]],
        head: () => null,
        say: (message) => said.push(message),
        round: ({ say }) => { say('fetch took 1.1s'); say('# tests 17982'); return report(); },
      });
      await outcome.done;
      assert.equal(said.length, 2, said.join('\n'));
      assert.match(said[0], /^memoro — full run started$/u);
      assert.match(said[1], /^memoro {2}green {2}started .* main aaaaaaa/u);
      const log = readFileSync(nightlyLogPath(root), 'utf8');
      assert.match(log, /\d{4}-\d\d-\d\dT[\d:.]+Z {2}fetch took 1\.1s\n/u);
      assert.match(log, /# tests 17982/u);
      assert.match(log, /memoro {2}green/u);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('the scheduled round', () => {
  it('runs beside the merge lane: no lease, no lock, its own checkout, at the full run\'s lanes', async () => {
    const root = home();
    try {
      const asked = [];
      const gate = (options) => { asked.push(options); return report(); };
      await scheduledRound({ repoPath: '/repos/memoro', root, env: { MC_FULL_RUN_LANES: '3' }, gate });
      assert.equal(asked.length, 1);
      const [options] = asked;
      assert.equal(options.full, true);
      assert.equal(options.isolated, true);
      assert.equal(options.holdLease, false);
      assert.equal(options.signals, false);
      assert.equal(options.lanes, 3);
      assert.equal(options.env.MC_TEST_LANES, '3');
      await scheduledRound({ repoPath: '/repos/memoro', root, env: {}, gate });
      assert.equal(asked[1].lanes, 2, 'the declared default is two lanes');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('the verbs', () => {
  it('start and stop are gone: they exit 2 with the usage, and start nothing', async () => {
    const fx = fixture({ name: 'nightly' });
    try {
      for (const argv of [['start'], ['stop'], ['start', '--interval', '1']]) {
        const out = (await runVerb(['test', 'nightly', ...argv], fx.env));
        assert.equal(out.status, 2, `${argv.join(' ')}: ${out.stdout}`);
        assert.match(out.stderr, /usage — mc test dev/u);
        assert.doesNotMatch(out.stderr, /mc test nightly (start|stop) \[/u);
      }
      assert.equal(existsSync(join(fx.mcHome, 'nightly', 'nightly.json')), false, 'a pid file was written');
    } finally { fx.cleanup(); }
  });

  it('the old spelling says where it went, and starts nothing', async () => {
    const fx = fixture({ name: 'nightly' });
    try {
      const moved = (await runVerb(['repo', 'nightly', 'start', '--interval', '3600'], fx.env));
      assert.equal(moved.status, 2, moved.stdout);
      assert.match(moved.stderr, /mc repo nightly is now mc test nightly/u);
      assert.equal(existsSync(join(fx.mcHome, 'nightly', 'nightly.json')), false);
      assert.equal((await runVerb(['repo', 'nightly', 'status'], fx.env)).status, 2);
    } finally { fx.cleanup(); }
  });
});

/**
 * The question the meter exists for, asked where the meter is read.
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

  it('prints each repository\'s last measured run, and the oldest red with its date', async () => {
    const fx = fixture({ name: 'nightly' });
    addArea(fx, 'alpha', 'alpha');
    try {
      // Two runs, the second red on a name the first was also red on: the
      // streak began at the first, not at the most recent.
      const first = ago(3);
      record(fx, first, ['data-bus event names'], 'a'.repeat(40));
      record(fx, ago(1), ['data-bus event names'], 'b'.repeat(40));

      const page = (await runVerb(['test', 'nightly', 'status'], fx.env));
      assert.equal(page.status, 0, page.stderr);
      assert.match(page.stdout, /runner stopped {2}— no full run will start until mc run start/u);
      assert.match(page.stdout, /full run\s+.*1 red of 2,445\s+bbbbbbb/u);
      // The streak reaches the oldest run kept, so the date is a floor — said
      // as one, with the name it is about.
      assert.match(page.stdout, /since at least 3d ago\s+data-bus event names/u);

      const state = json((await runVerb(['test', 'nightly', 'status', '--json'], fx.env)));
      assert.equal(state.runner.running, false);
      assert.equal(state.cadence, 'daily');
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

  it('a repository nobody has measured is named anyway, rather than left out', async () => {
    const fx = fixture({ name: 'nightly' });
    addArea(fx, 'alpha', 'alpha');
    try {
      const page = (await runVerb(['test', 'nightly', 'status'], fx.env));
      assert.equal(page.status, 0, page.stderr);
      assert.match(page.stdout, /full run\s+never — the runner's chore takes it when it is due/u);
      assert.deepEqual(json((await runVerb(['test', 'nightly', 'status', '--json'], fx.env))).repos.repo, {
        runs: 0, last: null, measured: null, red: [],
      });
    } finally { fx.cleanup(); }
  });

  it('says a repository was skipped because nothing changed, and still shows the last measurement', async () => {
    const fx = fixture({ name: 'nightly' });
    addArea(fx, 'alpha', 'alpha');
    try {
      record(fx, ago(2), ['data-bus event names'], 'a'.repeat(40));
      recordNightlyRun({
        repo: 'repo', path: fx.dir, started_at: ago(1), duration_ms: 400,
        commit: 'a'.repeat(40), verdict: 'stopped', stopped_at: 'unchanged',
        reason: 'main is still aaaaaaa, last measured x', red: null, tests: null,
      }, { root: fx.mcHome });

      const page = (await runVerb(['test', 'nightly', 'status'], fx.env));
      assert.equal(page.status, 0, page.stderr);
      assert.match(page.stdout, /full run\s+.*1 red of 2,445\s+aaaaaaa/u);
      assert.match(page.stdout, /skipped, nothing changed/u);
      assert.doesNotMatch(page.stdout, /last tried/u);
    } finally { fx.cleanup(); }
  });

  it('says the full runs are the runner\'s chore, and follow main, while the runner runs', async () => {
    const fx = fixture({ name: 'nightly' });
    addArea(fx, 'alpha', 'alpha');
    try {
      const runner = join(fx.workRoot, 'runner');
      mkdirSync(join(runner, 'log'), { recursive: true });
      writeFileSync(join(runner, 'runner.json'), JSON.stringify({ pid: process.pid, started: '2026-09-19T08:00:00Z' }));
      const started = new Date(Date.now() - 2 * 3_600_000).toISOString();
      const tsv = 'ts\tname\tkind\texit\tseconds\tpr\tturns\tinput\toutput\tcache_read\tcache_write\tsession\tnote\n'
        + `${started}\tnightly\tnightly\t0\t1\t-\t-\t-\t-\t-\t-\t-\tstarted,memoro\n`;
      writeFileSync(join(runner, 'log', 'runs.tsv'), tsv);

      const page = (await runVerb(['test', 'nightly', 'status'], fx.env));
      assert.equal(page.status, 0, page.stderr);
      assert.match(page.stdout, /runner running {2}pid \d+/u);
      assert.match(page.stdout, /the full runs are its chore/u);
      assert.match(page.stdout, /follows main: a full run of each repository whose origin\/main moved since its last measured full run/u);
      assert.match(page.stdout, /the last was started 2 h ago/u);
      assert.doesNotMatch(page.stdout, /due in/u);
      assert.match(page.stdout, /\n {4}full run\s+never/u, 'the per-repository block is still there');
      const state = json((await runVerb(['test', 'nightly', 'status', '--json'], fx.env)));
      assert.equal(state.runner.running, true);
      assert.equal(state.tick.last_started, started);

      // A STOP beside a live runner: on its way out, no further full run.
      writeFileSync(join(runner, 'STOP'), '');
      assert.match((await runVerb(['test', 'nightly', 'status'], fx.env)).stdout, /runner stopping.*no further full run will start/u);
    } finally { fx.cleanup(); }
  });

  it('says the runner is stopped, and that no full run will start, when no runner is alive', async () => {
    const fx = fixture({ name: 'nightly' });
    addArea(fx, 'alpha', 'alpha');
    try {
      const runner = join(fx.workRoot, 'runner');
      mkdirSync(runner, { recursive: true });
      // A pid file a dead runner left behind: nobody has that pid.
      writeFileSync(join(runner, 'runner.json'), JSON.stringify({ pid: 2_147_483_000, started: '2026-09-19T08:00:00Z' }));
      const page = (await runVerb(['test', 'nightly', 'status'], fx.env));
      assert.equal(page.status, 0, page.stderr);
      assert.match(page.stdout, /runner stopped {2}— no full run will start until mc run start/u);
      assert.match(page.stdout, /full run\s+never/u, 'the readings are printed whatever the runner is doing');
    } finally { fx.cleanup(); }
  });
});
