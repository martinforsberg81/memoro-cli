/**
 * The full run nobody asks for.
 *
 * The guarantees under test: a tick measures every repository mc knows and
 * writes down what it found — when it started, what it cost, which commit of
 * the branch it measured, and how it came out; a tick that finds `gate-lock`
 * held by a live round records a skip naming that round and does not wait for
 * it; a round that could not measure is never mistaken for one that found
 * nothing; and a STOP that appears between two repositories means the second
 * one's suite is never started.
 *
 * And where it is reached from: `mc test nightly status`, the verb whose round
 * it runs — the only word it has, since the tick is a chore of the runner
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
import { runMcCli } from './_helpers/mc-cli.js';
import { gateLockPath } from '../../src/mc/gate-lock.js';
import { nightlyLogPath } from '../../src/mc/nightly.js';
import { nightlyReading, readNightlyHistory, recordNightlyRun } from '../../src/mc/nightly-history.js';
import { loggedTick, nightlyTick } from '../../src/mc/nightly-loop.js';

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

describe('a tick, when the branch has not moved', () => {
  const SHA = 'a'.repeat(40);
  const OTHER = 'b'.repeat(40);
  const seed = (root, commit = SHA) => recordNightlyRun({
    repo: 'memoro', path: '/repos/memoro', started_at: '2026-09-02T02:00:00.000Z', duration_ms: 300_000,
    commit, verdict: 'red', stopped_at: 'red', reason: null, red: ['data-bus event names'], tests: 17_982,
  }, { root });
  const tick = (root, head, extra = {}) => {
    const asked = [];
    const said = [];
    return nightlyTick({
      root, repos: [REPOS[0]], head, say: (message) => said.push(message),
      round: ({ repoPath }) => { asked.push(repoPath); return report({ red: ['data-bus event names'], verdict: 'red', commit: OTHER }); },
      ...extra,
    }).then((outcome) => ({ outcome, asked, said }));
  };

  it('the head the last measurement covered is not measured, and is written down as measuring nothing', async () => {
    const root = home();
    try {
      seed(root);
      const { outcome, asked, said } = await tick(root, () => SHA);
      assert.deepEqual(asked, []);
      assert.equal(outcome.runs.length, 1);
      assert.equal(outcome.runs[0].red, null);
      const { runs } = readNightlyHistory('/repos/memoro', { root });
      assert.equal(runs.length, 2);
      assert.equal(runs[1].red, null);
      assert.equal(runs[1].outcome, 'incomplete');
      assert.equal(runs[1].stopped_at, 'unchanged');
      assert.equal(runs[1].commit, SHA);
      assert.match(said.join('\n'), /memoro {2}unchanged .*main aaaaaaa — .*last measured 2026-09-02T02:00:00\.000Z/u);
      // The measurement it did not replace is still the reading.
      assert.equal(nightlyReading('/repos/memoro', { root }).measured.at, '2026-09-02T02:00:00.000Z');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('an unchanged repository does not end the tick: the next one is still visited', async () => {
    const root = home();
    try {
      seed(root);
      const asked = [];
      const outcome = await nightlyTick({
        root, repos: REPOS, head: () => SHA,
        round: ({ repoPath }) => { asked.push(repoPath); return report(); },
      });
      assert.deepEqual(asked, ['/repos/memoro-cli']);
      assert.equal(outcome.runs.length, 2);
      assert.equal(outcome.skipped, null);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('a head that moved is measured exactly as before', async () => {
    const root = home();
    try {
      seed(root);
      const { outcome, asked } = await tick(root, () => OTHER);
      assert.deepEqual(asked, ['/repos/memoro']);
      const { runs } = readNightlyHistory('/repos/memoro', { root });
      assert.equal(runs.length, 2);
      assert.equal(runs[1].commit, OTHER);
      assert.deepEqual(runs[1].red, ['data-bus event names']);
      assert.equal(outcome.runs[0].verdict, 'red');
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
        const { asked } = await tick(root, probe);
        assert.deepEqual(asked, ['/repos/memoro']);
        const { runs } = readNightlyHistory('/repos/memoro', { root });
        assert.equal(runs.length, 2);
        assert.notEqual(runs[1].stopped_at, 'unchanged');
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }

  it('a repository never measured is measured, whatever the head', async () => {
    const root = home();
    try {
      const { asked } = await tick(root, () => SHA);
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
      const { asked } = await tick(root, () => SHA);
      assert.deepEqual(asked, ['/repos/memoro']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('a live gate round still ends the tick before the probe is asked', async () => {
    const root = home();
    try {
      seed(root);
      writeFileSync(gateLockPath(root), JSON.stringify({ pid: process.pid, repo: 'memoro', pr: 1, since: '2026-09-03T02:00:00.000Z' }));
      let probed = 0;
      const { outcome, asked } = await tick(root, () => { probed += 1; return SHA; });
      assert.equal(probed, 0);
      assert.deepEqual(asked, []);
      assert.ok(outcome.skipped);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('a tick, and a STOP', () => {
  it('a STOP that appears after the first repository leaves the second unstarted', async () => {
    const root = home();
    try {
      let stop = false;
      const asked = [];
      const outcome = await nightlyTick({
        root,
        repos: REPOS,
        head: () => null,
        shouldStop: () => stop,
        round: ({ repoPath }) => { asked.push(repoPath); stop = true; return report(); },
      });
      assert.deepEqual(asked, ['/repos/memoro'], 'the second repository\'s suite was started after the STOP');
      // What was measured stays measured, and the tick says it was stopped.
      assert.equal(outcome.runs.length, 1);
      assert.equal(outcome.stopped, true);
      assert.equal(outcome.skipped, null);
      assert.equal(readNightlyHistory('/repos/memoro', { root }).runs.length, 1);
      assert.equal(readNightlyHistory('/repos/memoro-cli', { root }).runs.length, 0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('a STOP that is already there starts nothing', async () => {
    const root = home();
    try {
      let ran = 0;
      const outcome = await nightlyTick({
        root, repos: REPOS, shouldStop: () => true, round: () => { ran += 1; return report(); },
      });
      assert.equal(ran, 0);
      assert.equal(outcome.stopped, true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('without a shouldStop the tick is what it was', async () => {
    const root = home();
    try {
      const outcome = await nightlyTick({ root, repos: REPOS, head: () => null, round: () => report() });
      assert.equal(outcome.runs.length, 2);
      assert.equal(outcome.stopped, false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('the log', () => {
  it('holds the round\'s whole narration, while the caller is handed the summaries alone', async () => {
    const root = home();
    try {
      const said = [];
      await loggedTick({
        root,
        repos: [REPOS[0]],
        head: () => null,
        say: (message) => said.push(message),
        round: ({ say }) => { say('fetch took 1.1s'); say('# tests 17982'); return report(); },
      });
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

describe('the verbs', () => {
  it('start and stop are gone: they exit 2 with the usage, and start nothing', () => {
    const fx = fixture({ name: 'nightly' });
    try {
      for (const argv of [['start'], ['stop'], ['start', '--interval', '1']]) {
        const out = runMcCli(['test', 'nightly', ...argv], fx.env);
        assert.equal(out.status, 2, `${argv.join(' ')}: ${out.stdout}`);
        assert.match(out.stderr, /usage — mc test dev/u);
        assert.doesNotMatch(out.stderr, /mc test nightly (start|stop) \[/u);
      }
      assert.equal(existsSync(join(fx.mcHome, 'nightly', 'nightly.json')), false, 'a pid file was written');
    } finally { fx.cleanup(); }
  });

  it('the old spelling says where it went, and starts nothing', () => {
    const fx = fixture({ name: 'nightly' });
    try {
      const moved = runMcCli(['repo', 'nightly', 'start', '--interval', '3600'], fx.env);
      assert.equal(moved.status, 2, moved.stdout);
      assert.match(moved.stderr, /mc repo nightly is now mc test nightly/u);
      assert.equal(existsSync(join(fx.mcHome, 'nightly', 'nightly.json')), false);
      assert.equal(runMcCli(['repo', 'nightly', 'status'], fx.env).status, 2);
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
      assert.match(page.stdout, /runner stopped {2}— no tick will happen until mc run start/u);
      assert.match(page.stdout, /full run\s+.*1 red of 2,445\s+bbbbbbb/u);
      // The streak reaches the oldest run kept, so the date is a floor — said
      // as one, with the name it is about.
      assert.match(page.stdout, /since at least 3d ago\s+data-bus event names/u);

      const state = json(runMcCli(['test', 'nightly', 'status', '--json'], fx.env));
      assert.equal(state.runner.running, false);
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
      assert.match(page.stdout, /full run\s+never — the runner's chore takes it when it is due/u);
      assert.deepEqual(json(runMcCli(['test', 'nightly', 'status', '--json'], fx.env)).repos.repo, {
        runs: 0, last: null, measured: null, red: [],
      });
    } finally { fx.cleanup(); }
  });

  it('says a repository was skipped because nothing changed, and still shows the last measurement', () => {
    const fx = fixture({ name: 'nightly' });
    addArea(fx, 'alpha', 'alpha');
    try {
      record(fx, ago(2), ['data-bus event names'], 'a'.repeat(40));
      recordNightlyRun({
        repo: 'repo', path: fx.dir, started_at: ago(1), duration_ms: 400,
        commit: 'a'.repeat(40), verdict: 'stopped', stopped_at: 'unchanged',
        reason: 'main is still aaaaaaa, last measured x', red: null, tests: null,
      }, { root: fx.mcHome });

      const page = runMcCli(['test', 'nightly', 'status'], fx.env);
      assert.equal(page.status, 0, page.stderr);
      assert.match(page.stdout, /full run\s+.*1 red of 2,445\s+aaaaaaa/u);
      assert.match(page.stdout, /skipped, nothing changed/u);
      assert.doesNotMatch(page.stdout, /last tried/u);
    } finally { fx.cleanup(); }
  });

  it('says the tick is the runner\'s chore, and when it is next due, while the runner runs', () => {
    const fx = fixture({ name: 'nightly' });
    addArea(fx, 'alpha', 'alpha');
    try {
      const runner = join(fx.workRoot, 'runner');
      mkdirSync(join(runner, 'log'), { recursive: true });
      writeFileSync(join(runner, 'runner.json'), JSON.stringify({ pid: process.pid, started: '2026-09-19T08:00:00Z' }));
      const tsv = 'ts\tname\tkind\texit\tseconds\tpr\tturns\tinput\toutput\tcache_read\tcache_write\tsession\tnote\n'
        + `${new Date(Date.now() - 2 * 3_600_000).toISOString()}\tnightly\tnightly\t0\t900\t-\t-\t-\t-\t-\t-\t-\tsuccess,2-measured,0-unchanged\n`;
      writeFileSync(join(runner, 'log', 'runs.tsv'), tsv);

      const page = runMcCli(['test', 'nightly', 'status'], fx.env);
      assert.equal(page.status, 0, page.stderr);
      assert.match(page.stdout, /runner running {2}pid \d+/u);
      assert.match(page.stdout, /the tick is its chore/u);
      assert.match(page.stdout, /the next is due in 22 h/u);
      assert.match(page.stdout, /\n {4}full run\s+never/u, 'the per-repository block is still there');
      const state = json(runMcCli(['test', 'nightly', 'status', '--json'], fx.env));
      assert.equal(state.runner.running, true);
      assert.equal(state.tick.due, false);

      // Due: the last tick is more than a day old.
      writeFileSync(join(runner, 'log', 'runs.tsv'), tsv.replace(/^\d{4}-[^\t]*/mu, (m, offset) => (offset ? '2026-09-01T00:00:00.000Z' : m)));
      const due = runMcCli(['test', 'nightly', 'status'], fx.env);
      assert.match(due.stdout, /a tick is due now/u);

      // A STOP beside a live runner: on its way out, no further tick.
      writeFileSync(join(runner, 'STOP'), '');
      assert.match(runMcCli(['test', 'nightly', 'status'], fx.env).stdout, /runner stopping.*no further tick will start/u);
    } finally { fx.cleanup(); }
  });

  it('says the runner is stopped, and that no tick will happen, when no runner is alive', () => {
    const fx = fixture({ name: 'nightly' });
    addArea(fx, 'alpha', 'alpha');
    try {
      const runner = join(fx.workRoot, 'runner');
      mkdirSync(runner, { recursive: true });
      // A pid file a dead runner left behind: nobody has that pid.
      writeFileSync(join(runner, 'runner.json'), JSON.stringify({ pid: 2_147_483_000, started: '2026-09-19T08:00:00Z' }));
      const page = runMcCli(['test', 'nightly', 'status'], fx.env);
      assert.equal(page.status, 0, page.stderr);
      assert.match(page.stdout, /runner stopped {2}— no tick will happen until mc run start/u);
      assert.match(page.stdout, /full run\s+never/u, 'the readings are printed whatever the runner is doing');
    } finally { fx.cleanup(); }
  });
});
