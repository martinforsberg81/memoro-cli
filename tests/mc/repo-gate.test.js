/**
 * The gate round as a machine — what it must do, and what it must not be able
 * to do.
 *
 * The verdict half: ONE tree, the candidate with the current base merged into
 * it, and what went red in it named at every level. There is no baseline and
 * no comparison — ruled by Martin on 2026-08-31, so a test the change reaches
 * that is already red on main is red here too, which several tests below exist
 * to pin rather than to soften. A run that never finished is still treated as
 * no evidence rather than as a clean sweep: it is the quiet failure worth
 * guarding, and with one side it is the whole verdict.
 *
 * The safety half: the lease is taken as the *area* that asked and given back
 * in every exit including a crash, and there is no path through this module
 * that merges anything — not behind a flag, not behind an option. That is
 * asserted against the calls it makes and against its own source, because the
 * one review this step cannot survive is "it looked like it only checked".
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { addArea, fixture as repoFixture } from './_helpers/repo-fixture.js';
import { gateLines } from '../../src/mc/commands/repo.js';
import { runMcCli } from './_helpers/mc-cli.js';
import { gateRoot, runGate, verdictFor, verdictHeadline, verdictPhrase } from '../../src/mc/repo-gate.js';
import { claimLease, readLease } from '../../src/mc/repo-lease.js';
import { gateLockPath, runningRound, takeGateLock } from '../../src/mc/gate-lock.js';

const AREA = { name: 'klient-guard', kind: 'work-area' };
const OTHER = { name: 'pm', kind: 'work-area' };

/** TAP for a run with these suites red, and a summary at the end. */
function tapWith(red, { finished = true, tests = 100 } = {}) {
  const lines = ['TAP version 13'];
  let index = 0;
  for (const name of red) {
    const [suite, test] = name.split(' › ');
    index += 1;
    lines.push(`# Subtest: ${suite}`);
    if (test) {
      lines.push(`    # Subtest: ${test}`, `    not ok 1 - ${test}`);
    }
    lines.push(`not ok ${index} - ${suite}`);
  }
  lines.push(`1..${index}`);
  if (finished) lines.push(`# tests ${tests}`, `# pass ${tests - red.length}`, `# fail ${red.length}`);
  return lines.join('\n');
}

/**
 * A repository, a lease store, and a git/gh/suite the test decides the answers
 * for. Every call is recorded, so "what did the round actually run?" is a
 * question about a list rather than about a mock's expectations.
 */
function fixture({
  candidateRed = [],
  candidateFinished = true,
  conflict = false,
  pr = { number: 400, headRefName: 'feature', baseRefName: 'main', headRefOid: 'abc1234', state: 'OPEN', title: 'a change' },
  prStatus = 0,
  changed = [],
  ownRed = [],
  ownFinished = true,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mc-repo-gate-'));
  const repoPath = join(root, 'repo');
  const mcHome = join(root, 'home');
  mkdirSync(repoPath, { recursive: true });
  mkdirSync(mcHome, { recursive: true, mode: 0o700 });
  // The gate runs whatever the repository calls its full suite.
  writeJson(join(repoPath, 'package.json'), { name: 'repo', scripts: { test: 'node --test tests/' } });

  const calls = [];
  const git = (args, opts = {}) => {
    calls.push({ tool: 'git', args, cwd: opts.cwd });
    if (args[0] === 'worktree' && args[1] === 'add') {
      const dir = args[args.length - 2];
      mkdirSync(dir, { recursive: true });
      // A worktree carries the repository's manifest, as a real one would.
      writeFileSync(join(dir, 'package.json'), readFileSync(join(repoPath, 'package.json')));
      return { status: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'worktree' && args[1] === 'remove') {
      rmSync(args[args.length - 1], { recursive: true, force: true });
      return { status: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'merge') {
      return conflict
        ? { status: 1, stdout: 'CONFLICT (content): Merge conflict in src/x.js', stderr: '' }
        : { status: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'diff') {
      return { status: 0, stdout: changed.map((file) => `${file}\n`).join(''), stderr: '' };
    }
    if (args[0] === 'rev-parse') {
      // `origin/main` is asked in the repository itself; HEAD is asked in the
      // one worktree the round builds.
      return { status: 0, stdout: `${opts.cwd === repoPath ? 'base1111' : 'cand2222'}\n`, stderr: '' };
    }
    if (args[0] === 'symbolic-ref') return { status: 0, stdout: 'origin/main\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };

  const gh = (args, opts = {}) => {
    calls.push({ tool: 'gh', args, cwd: opts.cwd });
    if (prStatus !== 0) return { status: prStatus, stdout: '', stderr: 'gh: could not resolve to a PullRequest' };
    return { status: 0, stdout: JSON.stringify(pr), stderr: '' };
  };

  const suite = ({ cwd }) => {
    calls.push({ tool: 'suite', cwd });
    return Promise.resolve({ code: 1, tap: tapWith(candidateRed, { finished: candidateFinished }) });
  };

  const tests = ({ cwd, files, flags = [] }) => {
    calls.push({ tool: 'tests', cwd, files, flags });
    return Promise.resolve({ code: ownRed.length ? 1 : 0, tap: tapWith(ownRed, { finished: ownFinished, tests: files.length * 3 }) });
  };

  return {
    root,
    repoPath,
    mcHome,
    calls,
    git,
    gh,
    suite,
    tests,
    progress: [],
    lease: () => readLease(repoPath, { root: mcHome }),
    ran: (tool) => calls.filter((call) => call.tool === tool),
    run: (extra = {}) => runGate({
      repoPath,
      pr: 400,
      holder: AREA,
      root: mcHome,
      git,
      gh,
      suite,
      tests,
      ...extra,
    }),
    cleanup() { try { rmSync(root, { recursive: true, force: true }); } catch { /* gone */ } },
  };
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

describe('the round decides on the one tree it measured', () => {
  it('a candidate with nothing red is green', async () => {
    const fx = fixture({ candidateRed: [] });
    try {
      const report = await fx.run();
      assert.equal(report.ok, true, report.reason || '');
      assert.equal(report.stopped_at, null);
      assert.equal(report.verdict, 'green');
      assert.equal(report.merged, false, 'the gate must never report a merge');
      assert.equal(report.candidate.commit, 'cand2222');
    } finally { fx.cleanup(); }
  });

  it('any red on the candidate is red, and the names are in the reason', async () => {
    const fx = fixture({ candidateRed: ['old world › two', 'old world'] });
    try {
      const report = await fx.run();
      assert.equal(report.ok, false);
      assert.equal(report.stopped_at, 'red');
      assert.equal(report.verdict, 'red');
      assert.deepEqual(report.candidate.red, ['old world › two', 'old world']);
      assert.match(report.reason, /2 tests red: old world › two, old world/u);
    } finally { fx.cleanup(); }
  });

  /**
   * The consequence of the 2026-08-31 ruling, pinned rather than left to be
   * discovered: a test that is red on main and inside this change's reach
   * makes the round red. The differential form passed exactly this case, at
   * the price of a second worktree and a second suite run to find out. The
   * repair is a selector that reaches fewer unrelated tests, not a second
   * measurement here.
   */
  it('a test that was already red on main is red here — it is not subtracted', async () => {
    const fx = fixture({ candidateRed: ['old world › one', 'old world'] });
    try {
      const report = await fx.run();
      assert.equal(report.ok, false);
      assert.equal(report.stopped_at, 'red');
      assert.deepEqual(report.candidate.red, ['old world › one', 'old world']);
      assert.equal(fx.ran('suite').length, 1, 'and nothing was run to ask whether main carried it');
    } finally { fx.cleanup(); }
  });

  it('every level of the run is read, not only the top', async () => {
    // A red test reddens its suite too, and a report that named only the top
    // level would say "old world" and leave the reader to find the test.
    const fx = fixture({ candidateRed: ['old world › writes the manifest', 'old world'] });
    try {
      const report = await fx.run();
      assert.ok(report.candidate.red.includes('old world › writes the manifest'));
    } finally { fx.cleanup(); }
  });
});

describe('the round measures a state worth measuring', () => {
  it('merges the current base into the candidate before running it', async () => {
    const fx = fixture();
    try {
      await fx.run();
      const merge = fx.ran('git').find((call) => call.args[0] === 'merge');
      assert.ok(merge, 'the base was never merged into the candidate');
      assert.deepEqual(merge.args, ['merge', '--no-edit', 'origin/main']);
      assert.match(merge.cwd, /candidate$/u, 'the merge must happen in the throwaway candidate, not in the repository');

      // And it happened before the suite ran, or the round measured the wrong tree.
      const order = fx.calls.map((call) => `${call.tool}:${call.args?.[0] ?? call.cwd.split('/').pop()}`);
      assert.ok(order.indexOf('git:merge') < order.findIndex((step) => step.startsWith('suite:')));
    } finally { fx.cleanup(); }
  });

  it('fetches before it builds the candidate — no remembered main merged in', async () => {
    const fx = fixture();
    try {
      await fx.run();
      const git = fx.ran('git').map((call) => call.args.join(' '));
      const fetched = git.findIndex((line) => line.startsWith('fetch origin'));
      const built = git.findIndex((line) => line.startsWith('worktree add'));
      assert.ok(fetched !== -1, 'it never fetched');
      assert.ok(fetched < built, 'the candidate was built from a remembered ref');
    } finally { fx.cleanup(); }
  });

  /**
   * The 2× this step removed. One worktree, one prepare, one suite run — on
   * memoro the second side was a second `npm ci` for a 492 MB tree and a
   * second 233.6 s of tests for every pull request.
   */
  it('builds ONE worktree, detached, and runs the suite once', async () => {
    const fx = fixture();
    try {
      await fx.run();
      const added = fx.ran('git').filter((call) => call.args[0] === 'worktree' && call.args[1] === 'add');
      assert.equal(added.length, 1, 'a second worktree was built');
      assert.ok(added[0].args.includes('--detach'), added[0].args.join(' '));
      assert.ok(added[0].args[added[0].args.length - 2].endsWith('candidate'));
      const sides = fx.ran('suite').map((call) => call.cwd.split('/').pop());
      assert.deepEqual(sides, ['candidate']);
    } finally { fx.cleanup(); }
  });

  it('a conflict with the base stops the round before any suite runs', async () => {
    const fx = fixture({ conflict: true });
    try {
      const report = await fx.run();
      assert.equal(report.ok, false);
      assert.equal(report.stopped_at, 'merge');
      assert.match(report.reason, /conflicts with origin\/main/u);
      assert.deepEqual(fx.ran('suite'), [], 'it spent a suite run on a tree it could not build');
    } finally { fx.cleanup(); }
  });
});

describe('a run that did not run is not evidence', () => {
  it('stops rather than reading an empty red set as a clean sweep', async () => {
    // A run that dies on a missing dependency or a syntax error produces no
    // failures at all, and with one side that empty set IS the verdict — a
    // confident green from a suite that never ran, which is the worst thing
    // this could report.
    const fx = fixture({ candidateFinished: false });
    try {
      const report = await fx.run();
      assert.equal(report.ok, false);
      assert.equal(report.stopped_at, 'suite');
      assert.match(report.reason, /never reached its own summary/u);
    } finally { fx.cleanup(); }
  });

  it('a repository with no suite of its own is a stop, not a pass', async () => {
    const fx = fixture();
    try {
      // A manifest with nothing to install, so the declaration check passes and
      // the round gets as far as looking for a suite — and finds none.
      writeJson(join(fx.repoPath, 'package.json'), { name: 'repo' });
      const report = await fx.run();
      assert.equal(report.ok, false);
      assert.equal(report.stopped_at, 'suite');
      assert.match(report.reason, /no npm test script/u);
    } finally { fx.cleanup(); }
  });

  it('a repository mc cannot reason about at all is a stop before any work', async () => {
    const fx = fixture();
    try {
      rmSync(join(fx.repoPath, 'package.json'), { force: true });
      const report = await fx.run();
      assert.equal(report.ok, false);
      assert.equal(report.stopped_at, 'declaration');
      assert.match(report.reason, /no package.json for mc to reason about/u);
      // And it cost nothing: no worktrees, no suite, not even a question to gh.
      assert.deepEqual(fx.ran('suite'), []);
      assert.deepEqual(fx.ran('gh'), []);
    } finally { fx.cleanup(); }
  });
});

describe('the lease is held as the area, and always given back', () => {
  it('is taken in the name it was handed, not the process\'s directory', async () => {
    // The known trap: the round lives in temporary worktrees outside the work
    // root, where `currentHolder()` answers `user@host`. The holder is read once
    // by the caller and carried, so the lease names the area doing the work.
    const fx = fixture();
    let heldBy = null;
    try {
      await fx.run({ onProgress: () => { heldBy = heldBy ?? fx.lease().holder; } });
      assert.equal(heldBy, 'klient-guard');
      assert.doesNotMatch(String(heldBy), /@/u, 'it fell back to user@host');
    } finally { fx.cleanup(); }
  });

  it('gives it back after a green round', async () => {
    const fx = fixture();
    try {
      const report = await fx.run();
      assert.equal(report.ok, true);
      assert.equal(fx.lease().held, false);
    } finally { fx.cleanup(); }
  });

  it('gives it back after a red round', async () => {
    const fx = fixture({ candidateRed: ['new thing › broke', 'new thing'] });
    try {
      await fx.run();
      assert.equal(fx.lease().held, false);
    } finally { fx.cleanup(); }
  });

  it('gives it back when the round throws half way through', async () => {
    // An interrupted round that keeps the lease is a repository nobody else
    // can gate until a human works out who is holding it and why.
    const fx = fixture();
    try {
      const boom = () => { throw new Error('the machine went away'); };
      await assert.rejects(() => fx.run({ suite: boom }), /the machine went away/u);
      assert.equal(fx.lease().held, false, 'the lease outlived the round');
    } finally { fx.cleanup(); }
  });

  it('refuses when somebody else is holding it, and runs nothing', async () => {
    const fx = fixture();
    try {
      claimLease({ repoPath: fx.repoPath, errand: 'their own round', holder: OTHER, root: fx.mcHome });
      const report = await fx.run();
      assert.equal(report.ok, false);
      assert.equal(report.stopped_at, 'lease');
      assert.match(report.reason, /held by pm .*their own round”/u);
    } finally { fx.cleanup(); }
  });

  it('has no merge path in its source at all — not even behind a flag', () => {
    // A gate that could also merge is one `if` away from merging on a verdict
    // it had not finished forming. Asserted against the file, because the
    // review this step cannot survive is "it looked like it only checked".
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, '..', '..', 'src', 'mc', 'repo-gate.js'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '');
    assert.doesNotMatch(code, /pr['"\s,\]]+merge/u, 'gh pr merge appears in the gate');
    assert.doesNotMatch(code, /['"]push['"]/u, 'a push appears in the gate');
  });
});

describe('what the round reports', () => {
  it('carries the red set, the commits, the base it stood on and the stop reason', async () => {
    const fx = fixture({ candidateRed: ['new thing › broke', 'new thing'] });
    try {
      const report = await fx.run();
      // Everything a surface with no judgement needs in order to report onward
      // without reading prose.
      assert.equal(report.ok, false);
      assert.equal(report.stopped_at, 'red');
      assert.equal(typeof report.reason, 'string');
      assert.deepEqual(report.candidate.red, ['new thing › broke', 'new thing']);
      assert.equal(report.candidate.commit, 'cand2222');
      assert.equal(report.candidate.is, 'pr-head-with-base-merged-in');
      // The ground, not a measurement of it: `mc merge` has to know whether
      // the base moved between the round and the landing.
      assert.deepEqual(report.base, { ref: 'origin/main', commit: 'base1111' });
      assert.equal(report.pr.head, 'feature');
      assert.equal(report.pr.base, 'main');
      assert.equal(report.full, false);
      assert.match(report.command, /npm test/u);
      assert.equal(report.holder, 'klient-guard');
      assert.equal(typeof report.duration_ms, 'number');
      // It survives the trip through a pipe intact.
      assert.deepEqual(JSON.parse(JSON.stringify(report)).candidate.red, report.candidate.red);
    } finally { fx.cleanup(); }
  });

  it('a pull request that is not open is a stop, not a green', async () => {
    const fx = fixture({ pr: { number: 400, headRefName: 'f', baseRefName: 'main', headRefOid: 'a', state: 'MERGED' } });
    try {
      const report = await fx.run();
      assert.equal(report.ok, false);
      assert.equal(report.stopped_at, 'pr');
      assert.match(report.reason, /is merged, so there is nothing to gate/u);
      assert.deepEqual(fx.ran('suite'), []);
    } finally { fx.cleanup(); }
  });

  it('a pull request gh cannot find is a stop with what gh said', async () => {
    const fx = fixture({ prStatus: 1 });
    try {
      const report = await fx.run();
      assert.equal(report.stopped_at, 'pr');
      assert.match(report.reason, /could not resolve to a PullRequest/u);
    } finally { fx.cleanup(); }
  });
});

/**
 * The verb at the command line.
 *
 * The round itself cannot be run from here — it is two full suites against a
 * real remote — so what is asserted is the grammar and the one promise the
 * grammar makes: that a verb called `merge` cannot be made to merge yet.
 */
describe('mc merge — the grammar', () => {
  it('offers two modes and no way to overrule a red gate', () => {
    const fx = repoFixture({ name: 'repo-gate-cli' });
    try {
      // `--check` gates and stops; without it the same round also merges.
      // What must not exist is a third mode — anything that lands a change the
      // gate called red. Overruling one is the human's call and should cost a
      // human action rather than a flag on a routine command.
      const usage = runMcCli(['merge'], fx.env).stderr;
      assert.match(usage, /mc merge <repo> <pr> \[<pr>\.\.\.\] \[--check\]/u);
      for (const flag of ['--force', '--anyway', '--no-verify', '--skip-gate', '--apply']) {
        const tried = runMcCli(['merge', 'repo', '400', flag], fx.env);
        assert.notEqual(tried.status, 0, `${flag} was accepted`);
      }
    } finally { fx.cleanup(); }
  });

  it('asks for the pull request rather than guessing one', () => {
    const fx = repoFixture({ name: 'repo-gate-cli' });
    try {
      assert.match(runMcCli(['merge', 'repo'], fx.env).stderr, /which pull request\?/u);
      assert.match(runMcCli(['merge'], fx.env).stderr, /which repository\?/u);
      assert.match(runMcCli(['merge', 'repo', 'later', '--check'], fx.env).stderr, /not a pull request number/u);
    } finally { fx.cleanup(); }
  });

  it('a repository nobody has heard of is an error, not a round', () => {
    const fx = repoFixture({ name: 'repo-gate-cli' });
    try {
      const asked = runMcCli(['merge', 'nowhere-at-all', '400', '--check'], fx.env);
      assert.equal(asked.status, 1);
      assert.match(asked.stderr, /no repository called "nowhere-at-all"/u);
    } finally { fx.cleanup(); }
  });

  it('leaves the other repo verbs exactly as they were', () => {
    const fx = repoFixture({ name: 'repo-gate-cli' });
    addArea(fx, 'alpha', 'alpha');
    try {
      const who = runMcCli(['repo', 'who', 'repo', '--json'], fx.env);
      assert.equal(who.status, 0, who.stderr);
      assert.equal(JSON.parse(who.stdout).held, false);
      // `--check` belongs to one verb and is refused on the others.
      assert.match(runMcCli(['repo', 'claim', 'repo', 'x', '--check'], fx.env).stderr, /--check belongs to mc merge/u);
    } finally { fx.cleanup(); }
  });
});

/**
 * The suite is started in a clean environment, not the round's own.
 *
 * Both of these were found the hard way, and the second one by this gate
 * refusing the pull request that added it.
 *
 * `NODE_TEST_CONTEXT` is set by node inside a test run, and a suite that
 * inherits it decides it is being run recursively and skips its files
 * entirely — output with no results and exit code 0.
 *
 * `--test-reporter` in an inherited `NODE_OPTIONS` becomes a second one when
 * the gate adds its own, and node rejects that outright: the suite dies before
 * running anything. Either way the gate's unfinished-run guard turns it into a
 * stop rather than a false green, which is the guard doing its job — but a
 * gate that cannot run from inside a test run cannot gate the repository whose
 * own suite is a test run.
 */
describe('what the suite inherits, and what it must not', () => {
  it('drops the test context and any reporter the caller already asked for', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, '..', '..', 'src', 'mc', 'repo-gate.js'), 'utf8');
    const runner = source.slice(source.indexOf('function realSuite'));

    assert.match(runner, /delete clean\.NODE_TEST_CONTEXT/u, 'the test context is passed through');
    assert.match(runner, /--test-reporter\(-destination\)\?/u, 'an inherited reporter is passed through');

    // The rule the two lines add up to, applied to the strings themselves.
    const strip = (options) => String(options || '')
      .replace(/--test-reporter(-destination)?[=\s]\S+/gu, '')
      .trim();
    assert.equal(strip('--test-reporter=tap'), '');
    assert.equal(strip('--test-reporter=spec --test-reporter-destination=stdout'), '');
    assert.equal(strip('--max-old-space-size=4096 --test-reporter=tap'), '--max-old-space-size=4096');
    // What is not a reporter is the caller's and stays.
    assert.equal(strip('--max-old-space-size=4096'), '--max-old-space-size=4096');
    assert.equal(strip(''), '');
  });
});

describe('the pull request\'s own tests are run, wherever they lie', () => {
  it('runs every *.test.js the PR adds or changes, and records them', async () => {
    const fx = fixture({ changed: ['src/thing.js', 'tests/ui/thing.test.js', 'tests/architecture/rule.test.mjs', 'README.md'] });
    try {
      const result = await fx.run();
      assert.equal(result.stopped_at, null, JSON.stringify(result));
      assert.deepEqual(fx.ran('tests').map((call) => call.files), [['tests/ui/thing.test.js', 'tests/architecture/rule.test.mjs']]);
      assert.ok(fx.ran('tests')[0].cwd.endsWith('candidate'), 'on the candidate, with the base merged in');
      assert.deepEqual(result.pr_tests.files, ['tests/ui/thing.test.js', 'tests/architecture/rule.test.mjs']);
      assert.equal(result.pr_tests.totals.tests, 6);
      assert.deepEqual(result.pr_tests.red, []);
    } finally { fx.cleanup(); }
  });

  it('one red among them stops the round with the whole suite green', async () => {
    const fx = fixture({ changed: ['tests/ui/thing.test.js'], ownRed: ['thing › proves the fix'] });
    try {
      const result = await fx.run();
      assert.equal(result.stopped_at, 'pr-tests');
      // One failure, two names (the parent reddens too): counted by # fail,
      // and the names said as names (2026-08-24 — "3 names but fail 2").
      assert.match(result.reason, /1 of the pull request's own tests is red — the red names, parent suites included: thing › proves the fix, thing/u);
      assert.deepEqual(result.candidate.red, [], 'the suite had nothing to say');
      assert.deepEqual(result.pr_tests.red, ['thing › proves the fix', 'thing'], 'the subtest and its parent, as node reports them');
    } finally { fx.cleanup(); }
  });

  it('a run that never summarised is a stop, not an approval', async () => {
    const fx = fixture({ changed: ['tests/ui/thing.test.js'], ownFinished: false });
    try {
      const result = await fx.run();
      assert.equal(result.stopped_at, 'pr-tests');
      assert.match(result.reason, /never reached their summary/u);
    } finally { fx.cleanup(); }
  });

  it('a PR that touches no test file is said so, and the round goes on', async () => {
    const fx = fixture({ changed: ['src/thing.js', 'tests/fixtures/data.json'] });
    try {
      const progress = [];
      const result = await fx.run({ onProgress: (line) => progress.push(line) });
      assert.equal(result.stopped_at, null);
      assert.deepEqual(result.pr_tests, { files: [], totals: null, red: [], exit_code: null });
      assert.ok(progress.some((line) => /adds or changes no test file/u.test(line)), progress.join('\n'));
      assert.deepEqual(fx.ran('tests'), []);
    } finally { fx.cleanup(); }
  });

  it('the diff is asked after the suite and before the extra gates', async () => {
    const fx = fixture({ changed: ['tests/ui/thing.test.js'] });
    try {
      await fx.run();
      const order = fx.calls.filter((call) => call.tool === 'suite' || call.tool === 'tests' || (call.tool === 'git' && call.args[0] === 'diff')).map((call) => call.tool === 'git' ? 'diff' : call.tool);
      assert.deepEqual(order, ['suite', 'diff', 'tests']);
    } finally { fx.cleanup(); }
  });
});

/**
 * A suite in a worktree with no dependency tree does not fail, it shrinks
 * (D-0152): 2162 tests and a tidy number where 206 never ran. The gate checks
 * the tree after preparation and before the run.
 */
describe('the dependency tree is checked before a suite is believed', () => {
  const declared = (fx, prepare) => writeJson(join(fx.mcHome, 'repo-gates.json'), {
    repo: { prepare, prepare_why: 'a test', extra_gates: [], merge_log: null },
  });

  it('stops when a prepared worktree still has no node_modules and the manifest declares dependencies', async () => {
    const fx = fixture();
    try {
      writeJson(join(fx.repoPath, 'package.json'), { name: 'repo', scripts: { test: 'node --test tests/' }, dependencies: { left_pad: '1.0.0' } });
      declared(fx, 'true');
      const result = await fx.run();
      assert.equal(result.stopped_at, 'dependencies', JSON.stringify(result));
      assert.match(result.reason, /candidate declares 1 dependencies and has no node_modules after preparation/u);
      assert.match(result.reason, /D-0152/u);
      assert.deepEqual(fx.ran('suite'), [], 'no suite was run on a tree that would have shrunk');
    } finally { fx.cleanup(); }
  });

  it('runs when the tree is there', async () => {
    const fx = fixture();
    try {
      writeJson(join(fx.repoPath, 'package.json'), { name: 'repo', scripts: { test: 'node --test tests/' }, dependencies: { left_pad: '1.0.0' } });
      // The prepare step is what puts the tree in place.
      declared(fx, 'mkdir -p node_modules');
      const result = await fx.run();
      assert.equal(result.stopped_at, null, JSON.stringify(result));
      assert.equal(fx.ran('suite').length, 1);
    } finally { fx.cleanup(); }
  });

  it('runs, and says so, when the declaration vouches the suite needs no tree', async () => {
    const fx = fixture();
    try {
      writeJson(join(fx.repoPath, 'package.json'), { name: 'repo', scripts: { test: 'node --test tests/' }, dependencies: { left_pad: '1.0.0' } });
      declared(fx, null);
      const progress = [];
      const result = await fx.run({ onProgress: (line) => progress.push(line) });
      assert.equal(result.stopped_at, null, JSON.stringify(result));
      assert.ok(progress.some((line) => /1 dependencies declared and no node_modules — the declaration vouches/u.test(line)), progress.join('\n'));
    } finally { fx.cleanup(); }
  });
});

/**
 * One gate round at a time on this machine.
 *
 * A full suite pins the cores for a minute and a half; two rounds at once make
 * both slower and both flakier, and the flakiness lands on whichever pull
 * request happened to be measured.
 *
 * This used to be "the suite right": a lease with an errand, a liveness
 * verdict derived from the work board, a --force release, an inbox message to
 * whoever held it, a row on the page and four verbs of its own. Four hundred
 * lines of vocabulary for "one at a time", under a name (Martin, 2026-08-30)
 * *"mycket märkligt"* — and none of it was reachable except through the gate.
 * It is a file and a pid now, and what is asserted is the behaviour, which
 * did not change.
 */
describe('one gate round at a time', () => {
  it('stops before any work when another round is running, and keeps nothing', async () => {
    const fx = fixture();
    try {
      // A live round: this test's own pid is the one thing certain to be alive.
      writeFileSync(gateLockPath(fx.mcHome), JSON.stringify({
        pid: process.pid, repo: 'other-repo', pr: 77, since: '2026-08-30T09:00:00.000Z',
      }));
      const result = await fx.run();
      assert.equal(result.stopped_at, 'busy');
      assert.match(result.reason, /another gate round is running on this machine/u);
      assert.match(result.reason, /other-repo #77/u, 'and says which round, so the refusal is actionable');
      assert.match(result.reason, /one at a time/u);
      assert.deepEqual(fx.ran('suite'), [], 'no suite ran alongside another round');
      assert.equal(fx.lease().held, false, 'the repository lease was given back');
      assert.equal(runningRound({ root: fx.mcHome }).pr, 77, 'and the other round was not touched');
    } finally { fx.cleanup(); }
  });

  it('takes it for the round and releases it after, whatever happened', async () => {
    const fx = fixture({ candidateRed: ['new › red'] });
    try {
      const progress = [];
      const result = await fx.run({ onProgress: (line) => progress.push(line) });
      assert.equal(result.stopped_at, 'red');
      assert.ok(progress.some((line) => /^gate round started \(pid \d+\) — one at a time/u.test(line)), progress.join('\n'));
      assert.equal(runningRound({ root: fx.mcHome }), null, 'released even though the round was red');
    } finally { fx.cleanup(); }
  });

  it('a round whose process is gone is litter, not a holder', async () => {
    const fx = fixture();
    try {
      // What a killed round leaves behind. There is no clock that can tell a
      // slow round from a dead one — a round is supposed to take minutes — so
      // the only honest question is whether the pid exists.
      writeFileSync(gateLockPath(fx.mcHome), JSON.stringify({ pid: 999_999, repo: 'x', pr: 1 }));
      const result = await fx.run();
      assert.notEqual(result.stopped_at, 'busy', 'a dead round does not block the next one');
      assert.equal(runningRound({ root: fx.mcHome }), null);
    } finally { fx.cleanup(); }
  });

  it('a lock it cannot write does not stop the round it was meant to protect', () => {
    // The worst case is the contention it was avoiding. Refusing to measure
    // anything at all is worse than measuring it slowly.
    const out = takeGateLock({ repo: 'x', pr: 1, root: '/proc/definitely/not/writable' });
    assert.equal(out.ok, true);
    assert.equal(out.took, false);
  });
});

/**
 * The flags the pull request's own tests run with are declared, not guessed
 * (measured 2026-08-23: memoro's runner adds `--import browser-paths`, the
 * gate ran bare; 123/123 either way for one night's files, three files in
 * the repository that need it).
 */
describe('the pull request\'s own tests run with the declared flags', () => {
  it('hands the declaration\'s pr_tests_flags to the runner, and says so', async () => {
    const fx = fixture({ changed: ['tests/ui/thing.test.js'] });
    try {
      writeJson(join(fx.mcHome, 'repo-gates.json'), {
        repo: { prepare: null, prepare_why: 'a test', extra_gates: [], merge_log: null, pr_tests_flags: ['--import', './tests/setup.mjs'] },
      });
      const progress = [];
      const result = await fx.run({ onProgress: (line) => progress.push(line) });
      assert.equal(result.stopped_at, null, JSON.stringify(result));
      assert.deepEqual(fx.ran('tests')[0].flags, ['--import', './tests/setup.mjs']);
      assert.ok(progress.includes('pr tests run with the declared flags: --import ./tests/setup.mjs'), progress.join('\n'));
    } finally { fx.cleanup(); }
  });

  it('none declared: the runner gets none, and falls back to the test script on its own', async () => {
    const fx = fixture({ changed: ['tests/ui/thing.test.js'] });
    try {
      await fx.run();
      assert.deepEqual(fx.ran('tests')[0].flags, []);
    } finally { fx.cleanup(); }
  });

  it('a wrapper test script with nothing declared is a stop, never a silent bare run (2026-08-24)', async () => {
    // memoro's scripts.test became `node scripts/testing/ci.mjs` and the
    // harvester returned [] without a word: bare `node --test`, no loader,
    // and every PR touching one of nine /js/-importing files got red
    // pr-tests that were the gate's own. Silent-empty is the worst of the
    // three outcomes — the gate says what it cannot know.
    const fx = fixture({ changed: ['tests/ui/thing.test.js'] });
    try {
      writeJson(join(fx.repoPath, 'package.json'), { name: 'repo', scripts: { test: 'node scripts/testing/ci.mjs' } });
      const result = await fx.run();
      assert.equal(result.stopped_at, 'pr-tests', JSON.stringify(result.reason));
      assert.match(result.reason, /test script is not a `node --test` line/u);
      assert.match(result.reason, /declare pr_tests_flags/u);
      assert.deepEqual(fx.ran('tests'), [], 'nothing ran bare');
    } finally { fx.cleanup(); }
  });

  it('declared flags make the wrapper script nobody\'s problem — the declaration answers', async () => {
    const fx = fixture({ changed: ['tests/ui/thing.test.js'] });
    try {
      writeJson(join(fx.repoPath, 'package.json'), { name: 'repo', scripts: { test: 'node scripts/testing/ci.mjs' } });
      writeJson(join(fx.mcHome, 'repo-gates.json'), {
        repo: { prepare: null, prepare_why: 'a test', extra_gates: [], merge_log: null, pr_tests_flags: ['--import', './x.mjs'] },
      });
      const result = await fx.run();
      assert.equal(result.stopped_at, null, JSON.stringify(result.reason));
      assert.deepEqual(fx.ran('tests')[0].flags, ['--import', './x.mjs']);
    } finally { fx.cleanup(); }
  });

  it('red own tests are counted by # fail, never by the number of red names', async () => {
    // Two failures in one suite carry three red names (the parent reddens
    // too) — and "3 of the pull request's own tests" answered a question
    // the count had not asked (2026-08-24).
    const fx = fixture({ changed: ['tests/ui/thing.test.js'], ownRed: ['one-suite › a', 'one-suite › b'] });
    try {
      const result = await fx.run();
      assert.equal(result.stopped_at, 'pr-tests');
      assert.match(result.reason, /^2 of the pull request's own tests are red — the red names, parent suites included: /u);
      assert.equal(result.pr_tests.red.length, 3, 'the names, parents included, stay in the report');
    } finally { fx.cleanup(); }
  });
});

/**
 * Several pull requests as one candidate (A3, 2026-08-23). With eleven in
 * the queue and each round holding the suite right for 5–13 minutes, the
 * round itself was the bottleneck. The batch is one tree with all of them
 * merged in, measured once — and each pull request's own tests still run by
 * themselves, so the batch can never hide which one carried which test.
 */
describe('a batch is one candidate, and each pull request keeps its own tests', () => {
  const prs = {
    401: { number: 401, headRefName: 'one', baseRefName: 'main', headRefOid: 'sha401', state: 'OPEN', title: 'first' },
    402: { number: 402, headRefName: 'two', baseRefName: 'main', headRefOid: 'sha402', state: 'OPEN', title: 'second' },
    403: { number: 403, headRefName: 'three', baseRefName: 'main', headRefOid: 'sha403', state: 'OPEN', title: 'third' },
  };
  /** A gh that answers per number, and a diff that answers per head. */
  function batchFixture({ conflictOn = null, ownRedOn = null, bases = {} } = {}) {
    const fx = fixture();
    const gh = (args, opts = {}) => {
      fx.calls.push({ tool: 'gh', args, cwd: opts.cwd });
      const pr = prs[Number(args[2])];
      return { status: 0, stdout: JSON.stringify({ ...pr, baseRefName: bases[pr.number] || pr.baseRefName }), stderr: '' };
    };
    const git = (args, opts = {}) => {
      if (args[0] === 'merge') {
        fx.calls.push({ tool: 'git', args, cwd: opts.cwd });
        return args[2] === conflictOn
          ? { status: 1, stdout: `CONFLICT (content): Merge conflict in src/${conflictOn}.js`, stderr: '' }
          : { status: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'diff') {
        fx.calls.push({ tool: 'git', args, cwd: opts.cwd });
        const head = String(args[3]).split('...')[1];
        return { status: 0, stdout: `tests/${head}.test.js\nsrc/${head}.js\n`, stderr: '' };
      }
      return fx.git(args, opts);
    };
    const tests = ({ cwd, files, flags = [] }) => {
      fx.calls.push({ tool: 'tests', cwd, files, flags });
      const red = files.some((file) => file.includes(ownRedOn)) && ownRedOn ? ['own › broke'] : [];
      return Promise.resolve({ code: red.length ? 1 : 0, tap: tapWith(red, { finished: true, tests: 3 }) });
    };
    return { ...fx, run: (extra = {}) => fx.run({ pr: 401, prs: [401, 402, 403], gh, git, tests, ...extra }) };
  }

  it('builds the candidate from the base with every head merged in, in order, and runs the suite once', async () => {
    const fx = batchFixture();
    try {
      const report = await fx.run();
      assert.equal(report.ok, true, report.reason);
      const adds = fx.ran('git').filter((call) => call.args[0] === 'worktree' && call.args[1] === 'add').map((call) => call.args[call.args.length - 1]);
      assert.deepEqual(adds, ['origin/main'], 'one worktree, starting from the base');
      const merges = fx.ran('git').filter((call) => call.args[0] === 'merge').map((call) => call.args[2]);
      assert.deepEqual(merges, ['sha401', 'sha402', 'sha403'], 'heads merged in the order given');
      assert.equal(fx.ran('suite').length, 1, 'one suite for the batch, not one per pull request');
      // Each pull request's own tests: its files, by its head, never the others'.
      const own = fx.ran('tests').map((call) => call.files);
      assert.deepEqual(own, [['tests/sha401.test.js'], ['tests/sha402.test.js'], ['tests/sha403.test.js']]);
      assert.deepEqual(report.prs.map((item) => [item.number, item.pr_tests.files]), [
        [401, ['tests/sha401.test.js']], [402, ['tests/sha402.test.js']], [403, ['tests/sha403.test.js']],
      ]);
      assert.ok(Object.keys(report.timings).includes('suite'), 'wall clock per step (A5)');
    } finally { fx.cleanup(); }
  });

  it('a conflict names the pull request that could not go in', async () => {
    const fx = batchFixture({ conflictOn: 'sha402' });
    try {
      const report = await fx.run();
      assert.equal(report.stopped_at, 'merge');
      assert.match(report.reason, /^#402 conflicts with origin\/main and the pull requests before it/u);
      assert.equal(fx.ran('suite').length, 0);
    } finally { fx.cleanup(); }
  });

  it('one pull request\'s own red names that pull request, not the batch', async () => {
    const fx = batchFixture({ ownRedOn: 'sha403' });
    try {
      const report = await fx.run();
      assert.equal(report.stopped_at, 'pr-tests');
      assert.match(report.reason, /^#403: \d+ of the pull request's own tests (?:is|are) red/u);
      assert.equal(report.prs[0].pr_tests.red.length, 0);
      assert.ok(report.prs[2].pr_tests.red.length > 0);
    } finally { fx.cleanup(); }
  });

  it('two bases is not one candidate', async () => {
    const fx = batchFixture({ bases: { 402: 'release' } });
    try {
      const report = await fx.run();
      assert.equal(report.stopped_at, 'pr');
      assert.match(report.reason, /2 different bases \(main, release\)/u);
    } finally { fx.cleanup(); }
  });
});

/**
 * Extra gates — what an operator declares beside the suite, run on the
 * candidate.
 *
 * They ran on both sides and were judged by the delta until 2026-08-31, for a
 * reason measured on #10909's round: an extra gate run only on the candidate
 * attributed a red main to the one PR in the room, and a track spent six
 * minutes proving its innocence. That protection went with the baseline,
 * deliberately — the ruling is that main's own red is not the round's
 * question, and a declared gate that is red on main is red here.
 */
describe('extra gates run on the candidate, and a failing one is red', () => {
  const declare = (fx, command, { name = 'contract' } = {}) => writeJson(join(fx.mcHome, 'repo-gates.json'), {
    repo: { prepare: null, prepare_why: 'a test', extra_gates: [{ name, command }], merge_log: null },
  });

  it('runs it once, in the candidate worktree, and green passes', async () => {
    const fx = fixture();
    try {
      const marker = join(fx.root, 'gate-ran.txt');
      declare(fx, `echo "$(basename "$PWD")" >> "${marker}"; exit 0`);
      const report = await fx.run({ root: fx.mcHome });
      assert.equal(report.ok, true, report.reason);
      assert.equal(report.extra_gates.length, 1);
      assert.equal(report.extra_gates[0].ok, true);
      assert.equal(report.extra_gates[0].source, 'declaration');
      assert.deepEqual(readFileSync(marker, 'utf8').trim().split('\n'), ['candidate'], 'it ran somewhere besides the candidate');
      assert.ok('extra gates' in report.timings, 'the run was not timed');
    } finally { fx.cleanup(); }
  });

  it('a failing gate is a stop, and the exit code is in the reason', async () => {
    const fx = fixture();
    try {
      declare(fx, 'exit 3');
      const report = await fx.run({ root: fx.mcHome });
      assert.equal(report.stopped_at, 'extra-gate');
      assert.match(report.reason, /^contract failed \(exit 3\)/u);
    } finally { fx.cleanup(); }
  });

  /**
   * The consequence, said in a test rather than left for somebody to find: a
   * declared gate that is red on main is red here. It was reported as main's
   * fault and let through until 2026-08-31, which took a second worktree and a
   * second run of the gate to be able to say.
   */
  it('a gate that is red on main is red here too — there is no side to blame it on', async () => {
    const fx = fixture();
    try {
      declare(fx, 'exit 1');
      const report = await fx.run({ root: fx.mcHome });
      assert.equal(report.stopped_at, 'extra-gate');
      assert.notEqual(report.stopped_at, 'extra-gate-baseline', 'the stop that named main is gone with the baseline');
    } finally { fx.cleanup(); }
  });

  it('a gate that prints TAP has its red names in the report and in the reason', async () => {
    const fx = fixture();
    try {
      const emit = String.raw`printf 'const { test } = require("node:test");\ntest("standing", () => { throw new Error("no"); });\n' > g.test.cjs; node --test g.test.cjs`;
      declare(fx, emit);
      const report = await fx.run({ root: fx.mcHome });
      assert.equal(report.stopped_at, 'extra-gate', report.reason);
      assert.deepEqual(report.extra_gates[0].red, ['standing']);
      assert.match(report.reason, /1 red: standing/u);
    } finally { fx.cleanup(); }
  });

  it('a gate with no readable TAP has no names, and is still a stop', async () => {
    const fx = fixture();
    try {
      declare(fx, 'exit 1');
      const report = await fx.run({ root: fx.mcHome });
      assert.equal(report.stopped_at, 'extra-gate');
      assert.equal(report.extra_gates[0].red, null, 'half a parse is not a name list');
    } finally { fx.cleanup(); }
  });
});

describe('a repository that selects by diff', () => {
  /**
   * The round for a repository whose suite is chosen by the change.
   *
   * The selection is read in the candidate worktree, because it is a function
   * of the diff, and it is run there and nowhere else. The command gates the
   * same answer names run beside it — read and thrown away until 2026-08-31,
   * so no round had ever run one.
   */
  function selecting({
    files, candidateRed = [], commands = undefined, scripts = {}, full = false,
  } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'mc-select-'));
    const repoPath = join(root, 'repo');
    const mcHome = join(root, 'home');
    mkdirSync(repoPath, { recursive: true });
    mkdirSync(mcHome, { recursive: true, mode: 0o700 });
    // The command gates run as `npm run <script>` in the candidate worktree, so
    // the scripts are real ones in a real manifest. A stub of npm would test
    // the stub; this tests the invocation the repository will actually get.
    writeJson(join(repoPath, 'package.json'), { name: 'repo', scripts: { test: 'node --test tests/', ...scripts } });
    // Where a script records that it ran, and with which arguments. Outside the
    // worktrees, which the round removes on its way out.
    const marks = join(root, 'marks');
    mkdirSync(marks, { recursive: true });
    // The operator table is where a repository says how it selects. `echo` is a
    // real command through a real shell — the same path a real declaration
    // takes — so this exercises the JSON contract rather than a stub of it.
    writeJson(join(mcHome, 'repo-gates.json'), {
      repo: {
        prepare: null,
        prepare_why: 'the fixture installs nothing',
        select: `echo '${JSON.stringify(commands === undefined ? { files } : { files, commands })}'`,
        select_why: 'the fixture says so',
        extra_gates: [],
        merge_log: null,
        pr_tests_flags: ['--import', './x.mjs'],
      },
    });

    const runs = [];
    const git = (args, opts = {}) => {
      if (args[0] === 'worktree' && args[1] === 'add') {
        const dir = args[args.length - 2];
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'package.json'), readFileSync(join(repoPath, 'package.json')));
        for (const file of files) {
          mkdirSync(join(dir, dirname(file)), { recursive: true });
          writeFileSync(join(dir, file), '');
        }
        return { status: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'worktree' && args[1] === 'remove') {
        rmSync(args[args.length - 1], { recursive: true, force: true });
        return { status: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'diff') return { status: 0, stdout: '', stderr: '' };
      if (args[0] === 'rev-parse') {
        return { status: 0, stdout: `${opts.cwd === repoPath ? 'base1111' : 'cand2222'}\n`, stderr: '' };
      }
      if (args[0] === 'symbolic-ref') return { status: 0, stdout: 'origin/main\n', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const gh = () => ({
      status: 0,
      stdout: JSON.stringify({ number: 7, headRefName: 'feature', baseRefName: 'main', headRefOid: 'abc1234', state: 'OPEN', title: 'a change' }),
      stderr: '',
    });
    const tests = ({ cwd, files: ran, flags }) => {
      runs.push({ files: [...ran], flags, cwd });
      return Promise.resolve({ code: candidateRed.length ? 1 : 0, tap: tapWith(candidateRed, { tests: Math.max(ran.length * 3, 1) }) });
    };
    const suites = [];
    return {
      runs,
      suites,
      marks,
      mark: (name) => (existsSync(join(marks, name)) ? readFileSync(join(marks, name), 'utf8') : null),
      report: (extra = {}) => runGate({
        repoPath, pr: full ? null : 7, full, holder: AREA, root: mcHome, git, gh, tests,
        env: { ...process.env, GATE_MARKS: marks },
        suite: ({ cwd }) => {
          if (!full) throw new Error('a selecting round must not run the whole suite');
          suites.push(cwd);
          return Promise.resolve({ code: candidateRed.length ? 1 : 0, tap: tapWith(candidateRed, { tests: 42 }) });
        },
        ...extra,
      }),
      cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
  }

  /** A script that records that it ran, with its arguments, and then exits. */
  function marking(name, exit = 0) {
    return `sh -c 'printf "%s" "$*" > "$GATE_MARKS/${name}"; exit ${exit}' sh`;
  }

  it('runs the selected list once, on the candidate, and never the whole suite', async () => {
    const files = ['tests/a.test.js', 'tests/b.test.js'];
    const fx = selecting({ files });
    try {
      const report = await fx.report();
      assert.equal(report.ok, true, report.reason);
      assert.equal(report.selection.files, 2);
      assert.equal(fx.runs.length, 1, 'the list was run twice');
      assert.deepEqual(fx.runs[0].files, files);
      assert.ok(fx.runs[0].cwd.endsWith('candidate'));
      // And with the repository's own declared flags, not a guess at them.
      assert.deepEqual(fx.runs[0].flags, ['--import', './x.mjs']);
    } finally { fx.cleanup(); }
  });

  /**
   * The ruling, at the level a session will meet it: a test the change reaches
   * that is already failing on main makes the round red. It is stricter than
   * the differential form and it is the point — and it is why narrowing what a
   * change reaches is the repair, in the repository's own selector.
   */
  it('a selected test that is red on main is red, and the verdict names it', async () => {
    const fx = selecting({ files: ['tests/a.test.js'], candidateRed: ['already broken'] });
    try {
      const report = await fx.report();
      assert.equal(report.ok, false);
      assert.equal(report.stopped_at, 'red');
      assert.equal(report.verdict, 'red');
      assert.match(report.reason, /already broken/u);
      assert.match(gateLines(report).join('\n'), /RED — 1 test red:\n\s+already broken/u);
    } finally { fx.cleanup(); }
  });

  it('runs the command gates the selection named, on the candidate, with the base ref they ask for', async () => {
    // The gates the selector reports beside the files. They were read and
    // dropped until 2026-08-31, so no round had ever run one: memoro's
    // selection named six on #11158 — css:lint and css:tokens among them —
    // and the verdict said nothing about any of them.
    const fx = selecting({
      files: ['tests/a.test.js'],
      commands: [
        { id: 'css-lint', packageScript: 'css:lint', passBaseRef: false, resourceClass: 'standard', selectedBy: ['css-contract'] },
        { id: 'css-tokens', packageScript: 'css:tokens', passBaseRef: true, resourceClass: 'standard', selectedBy: ['css-contract'] },
      ],
      scripts: { 'css:lint': marking('css-lint'), 'css:tokens': marking('css-tokens') },
    });
    try {
      const report = await fx.report();
      assert.equal(report.ok, true, report.reason);
      assert.equal(report.selection.commands, 2);
      const gates = report.extra_gates.filter((gate) => gate.source === 'selection');
      assert.deepEqual(gates.map((gate) => gate.name), ['css:lint', 'css:tokens'], 'in the order the selector gave');
      assert.ok(gates.every((gate) => gate.ok && gate.ran));
      assert.ok(gates.every((gate) => typeof gate.duration_ms === 'number'));
      // `--base-ref` where the selection said so, and nowhere else: a gate that
      // is differential in itself would otherwise measure the wrong two trees.
      assert.equal(fx.mark('css-lint'), '');
      assert.equal(fx.mark('css-tokens'), '--base-ref origin/main');
      assert.equal(gates[1].command, 'npm run css:tokens -- --base-ref origin/main');
      // And the verdict counts them. What each one cost is `--json`'s since
      // 2026-08-31 — a green round says what ran, not how each part of it did.
      const lines = gateLines(report).join('\n');
      assert.match(lines, /and 2 command gates/u);
      assert.doesNotMatch(lines, /passed in/u);
    } finally { fx.cleanup(); }
  });

  it('a command gate that fails is red, and the gates after it still run', async () => {
    // ci.mjs wrote the reason down where it makes the same choice about tests:
    // while anything else is red, a skipped command gate hides every contract
    // regression it would have caught.
    const fx = selecting({
      files: ['tests/a.test.js'],
      commands: [
        { id: 'i18n-contract', packageScript: 'i18n:contract', passBaseRef: false, resourceClass: 'standard', selectedBy: ['i18n'] },
        { id: 'css-lint', packageScript: 'css:lint', passBaseRef: false, resourceClass: 'standard', selectedBy: ['css-contract'] },
      ],
      scripts: { 'i18n:contract': marking('i18n', 3), 'css:lint': marking('css-lint') },
    });
    try {
      const report = await fx.report();
      assert.equal(report.ok, false);
      assert.equal(report.stopped_at, 'selected-gate');
      assert.equal(report.verdict, 'red');
      assert.match(report.reason, /i18n:contract \(exit 3\)/u);
      // The one after it ran anyway, and is reported.
      assert.equal(fx.mark('css-lint'), '');
      const gates = report.extra_gates.filter((gate) => gate.source === 'selection');
      assert.deepEqual(gates.map((gate) => gate.ok), [false, true]);
      // The verdict names the one that failed. The one that passed is in the
      // report and in `--json`, and not in a red verdict: a reader of one is
      // repairing, not auditing.
      const lines = gateLines(report).join('\n');
      assert.match(lines, /RED — 1 command gate failed:/u);
      assert.match(lines, /i18n:contract — exit 3 — npm run i18n:contract/u);
      assert.doesNotMatch(lines, /css:lint/u);
    } finally { fx.cleanup(); }
  });

  it('a selector that names no commands is not a fault, and one that cannot be read is', async () => {
    const none = selecting({ files: ['tests/a.test.js'] });
    try {
      const report = await none.report();
      assert.equal(report.ok, true, report.reason);
      assert.equal(report.selection.commands, 0);
      assert.deepEqual(report.extra_gates, []);
    } finally { none.cleanup(); }

    // A `commands` that is not a list is the same kind of unreadable as a
    // missing `files`: fewer gates than the repository asked for is the
    // silence this reading exists to end.
    const unreadable = selecting({ files: ['tests/a.test.js'], commands: 'all of them' });
    try {
      const report = await unreadable.report();
      assert.equal(report.ok, false);
      assert.equal(report.stopped_at, 'selection');
      assert.match(report.reason, /`commands` field that is not a list/u);
    } finally { unreadable.cleanup(); }

    // And a command with nothing to run under it.
    const nameless = selecting({ files: ['tests/a.test.js'], commands: [{ id: 'x', passBaseRef: false }] });
    try {
      const report = await nameless.report();
      assert.equal(report.ok, false);
      assert.equal(report.stopped_at, 'selection');
      assert.match(report.reason, /no packageScript/u);
    } finally { nameless.cleanup(); }
  });

  it('a selection that cannot be read stops the round instead of measuring nothing', async () => {
    const fx = selecting({ files: [] });
    try {
      const report = await fx.report();
      assert.equal(report.ok, false);
      assert.equal(report.stopped_at, 'selection');
      assert.match(report.reason, /no test files/u);
    } finally { fx.cleanup(); }
  });

  /**
   * `mc test <repo> --full` — the one reading here that is about the code rather
   * than about a change.
   *
   * It exists because the differential round used to answer "is main red?" as a
   * side effect of every measurement, and the 2026-08-31 ruling took that away.
   * The state of main is still a real question; it is now asked for, on one
   * tree, with the repository's own whole suite, and never scheduled.
   */
  describe('--full runs the whole suite on one tree', () => {
    it('ignores the selector, runs the repository\'s own suite, and names its red', async () => {
      const fx = selecting({ files: ['tests/a.test.js'], full: true, candidateRed: ['main is red here'] });
      try {
        const report = await fx.report();
        assert.equal(report.full, true);
        assert.equal(report.selection, null, 'a --full round selects nothing');
        assert.equal(fx.runs.length, 0, 'the selected-file runner was used');
        assert.deepEqual(fx.suites.map((cwd) => cwd.split('/').pop()), ['candidate'], 'one tree');
        assert.match(report.command, /npm test/u);
        assert.equal(report.stopped_at, 'red');
        assert.deepEqual(report.candidate.red, ['main is red here']);
        assert.equal(report.candidate.is, 'base-branch-as-fetched');
      } finally { fx.cleanup(); }
    });

    it('with no pull request it measures the branch origin calls its default', async () => {
      const fx = selecting({ files: ['tests/a.test.js'], full: true });
      try {
        const report = await fx.report();
        assert.equal(report.ok, true, report.reason);
        assert.equal(report.pr.number, null, 'there is no pull request to name');
        assert.deepEqual(report.base, { ref: 'origin/main', commit: 'base1111' });
        assert.equal(report.pr_tests, null, 'and no diff of its own to prove');
        assert.match(verdictHeadline(report), /over the whole suite, asked for by --full/u);
        assert.match(gateLines(report).join('\n'), /the whole suite/u);
      } finally { fx.cleanup(); }
    });

    it('a remote that does not say which branch is default is a stop, not a guess', async () => {
      const fx = selecting({ files: ['tests/a.test.js'], full: true });
      try {
        const report = await fx.report({
          git: (args, opts = {}) => (args[0] === 'symbolic-ref'
            ? { status: 1, stdout: '', stderr: 'not a symbolic ref' }
            : { status: 0, stdout: args[0] === 'rev-parse' ? 'x\n' : '', stderr: '' }),
        });
        assert.equal(report.ok, false);
        assert.equal(report.stopped_at, 'base');
        assert.match(report.reason, /origin does not say which branch is its default/u);
      } finally { fx.cleanup(); }
    });
  });
});

describe('mc test — the grammar', () => {
  it('is a verb of its own, and asks the same questions merge does', () => {
    const fx = repoFixture({ name: 'repo-gate-cli' });
    try {
      // The measurement was reachable as `mc merge --check`: a flag on the
      // verb for landing things, which is not where a person looks when the
      // question is "is this red?". Its own name, and its own usage line.
      const usage = runMcCli(['test'], fx.env).stderr;
      assert.match(usage, /which repository\?/u);
      assert.match(usage, /mc test <repo> <pr>/u);
      assert.match(usage, /mc test <repo> --full/u);
      assert.doesNotMatch(usage, /--check/u);
      assert.match(runMcCli(['test', 'repo'], fx.env).stderr, /which pull request\?/u);
      assert.match(runMcCli(['test', 'repo', 'later'], fx.env).stderr, /not a pull request number/u);
      const nowhere = runMcCli(['test', 'nowhere-at-all', '400'], fx.env);
      assert.equal(nowhere.status, 1);
      assert.match(nowhere.stderr, /no repository called "nowhere-at-all"/u);
    } finally { fx.cleanup(); }
  });

  it('has no flag that makes it land anything', () => {
    const fx = repoFixture({ name: 'repo-gate-cli' });
    try {
      // The one promise the name makes. `mc test` reaches `runGate`, which has
      // no merge in it — and the flags a person might reach for to change that
      // are refused at the grammar rather than somewhere deeper.
      for (const flag of ['--merge', '--land', '--force', '--apply', '--no-verify']) {
        const tried = runMcCli(['test', 'repo', '400', flag], fx.env);
        assert.notEqual(tried.status, 0, `${flag} was accepted`);
      }
      const source = readFileSync(new URL('../../src/mc/commands/test.js', import.meta.url), 'utf8');
      assert.doesNotMatch(source, /runMergeRound|pr merge|--squash/u);
    } finally { fx.cleanup(); }
  });
});

describe('a verdict says how far it reached', () => {
  it('a selected round never says GREEN without saying over what', () => {
    // "GREEN — the test gate passes" over a suite that ran 6 of 257 files is
    // the same overclaim the standing-red count had to correct once. The reach
    // is still in the verdict and it is now a count on the line under the
    // headline — `ran 6 test files (…) and 0 command gates` — rather than the
    // sentence it used to be (ruled 2026-08-31: the prose was the part a
    // reader had to weigh). Asserted where the lines are built, in
    // tests/mc/commands/gate-verdict.test.js; what is asserted here is that
    // the headline stopped carrying it twice.
    const green = verdictHeadline({ selection: { files: 6 }, pr: { base: 'main' } });
    assert.equal(green, 'GREEN — the test gate passes');
    assert.equal(verdictPhrase({ selection: { files: 1 } }), 'gate green');
  });

  it('there is no third pass any more — a round is green or it is not', () => {
    // `no-new-red` said "no dirtier than the base", and saying it cost a
    // second worktree and half the round. With one tree a pass is a pass.
    assert.equal(verdictFor({ stopped_at: null }), 'green');
    assert.equal(verdictFor({ stopped_at: 'red' }), 'red');
    assert.equal(verdictFor({ stopped_at: 'selected-gate' }), 'red');
    assert.equal(verdictFor({ stopped_at: 'lease' }), 'stopped');
    assert.doesNotMatch(verdictHeadline({ selection: null, pr: { base: 'main' } }), /NO NEW RED/u);
  });

  it('a selector that gave up says so, instead of reading as a saving', () => {
    // memoro-cli's selector returns everything whenever a changed path is not
    // source it can trace. "measured over the 258 files this change reaches"
    // is true and misleading in the same breath when 258 is the whole suite.
    const fell = verdictHeadline({ selection: { files: 258, full_suite: true }, pr: { base: 'main' } });
    assert.match(fell, /over the whole suite: the selector could not narrow this change/u);
    assert.doesNotMatch(fell, /this change reaches/u);
  });

  it('a round with no selection says nothing extra, because its reach is what a reader assumes', () => {
    assert.equal(verdictHeadline({ selection: null, pr: { base: 'main' } }), 'GREEN — the test gate passes');
    assert.equal(verdictPhrase({ selection: null }), 'gate green');
  });
});
