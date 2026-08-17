/**
 * The gate round as a machine — what it must do, and what it must not be able
 * to do.
 *
 * The verdict half: a fresh baseline every round, the candidate measured with
 * the current base merged into it, red sets compared by name at every level,
 * and a run that never finished treated as no evidence rather than as a clean
 * sweep. That last one is the quiet failure worth guarding: two runs that both
 * died on the same missing dependency produce two empty red sets, and a gate
 * that compares them reports a confident green from a suite that never ran.
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
import { runMcCli } from './_helpers/mc-cli.js';
import { gateRoot, runGate } from '../../src/mc/repo-gate.js';
import { claimLease, readLease } from '../../src/mc/repo-lease.js';

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
  baselineRed = [],
  candidateRed = [],
  candidateFinished = true,
  baselineFinished = true,
  conflict = false,
  pr = { number: 400, headRefName: 'feature', baseRefName: 'main', headRefOid: 'abc1234', state: 'OPEN', title: 'a change' },
  prStatus = 0,
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
      mkdirSync(args[args.length - 2], { recursive: true });
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
    if (args[0] === 'rev-parse') {
      return { status: 0, stdout: `${opts.cwd.endsWith('baseline') ? 'base1111' : 'cand2222'}\n`, stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };

  const gh = (args, opts = {}) => {
    calls.push({ tool: 'gh', args, cwd: opts.cwd });
    if (prStatus !== 0) return { status: prStatus, stdout: '', stderr: 'gh: could not resolve to a PullRequest' };
    return { status: 0, stdout: JSON.stringify(pr), stderr: '' };
  };

  const suite = ({ cwd }) => {
    calls.push({ tool: 'suite', cwd });
    const baseline = cwd.endsWith('baseline');
    return Promise.resolve({
      code: 1,
      tap: baseline
        ? tapWith(baselineRed, { finished: baselineFinished })
        : tapWith(candidateRed, { finished: candidateFinished }),
    });
  };

  return {
    root,
    repoPath,
    mcHome,
    calls,
    git,
    gh,
    suite,
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
      ...extra,
    }),
    cleanup() { try { rmSync(root, { recursive: true, force: true }); } catch { /* gone */ } },
  };
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

describe('the gate round decides on names, at every level', () => {
  it('is green when the candidate is red nowhere the baseline was green', async () => {
    const red = ['old world › one', 'old world'];
    const fx = fixture({ baselineRed: red, candidateRed: red });
    try {
      const report = await fx.run();
      assert.equal(report.ok, true, report.reason || '');
      assert.equal(report.stopped_at, null);
      assert.deepEqual(report.broke, []);
      assert.equal(report.merged, false, 'the gate must never report a merge');
      assert.equal(report.baseline.commit, 'base1111');
      assert.equal(report.candidate.commit, 'cand2222');
    } finally { fx.cleanup(); }
  });

  it('the same number of failures with different names is red', async () => {
    // The regression a counting gate waves through: one repaired, one broken.
    const fx = fixture({
      baselineRed: ['old world › one', 'old world'],
      candidateRed: ['old world › two', 'old world'],
    });
    try {
      const report = await fx.run();
      assert.equal(report.ok, false);
      assert.equal(report.stopped_at, 'red');
      assert.deepEqual(report.broke, ['old world › two']);
      assert.deepEqual(report.fixed, ['old world › one']);
      assert.equal(report.baseline.totals.fail, report.candidate.totals.fail, 'the point is that the totals agree');
    } finally { fx.cleanup(); }
  });

  it('a subtest swapped under an identical top level is red', async () => {
    // Both runs have `old world` failing at the top. Only the level below
    // says which test it was, which is why the comparison goes all the way down.
    const fx = fixture({
      baselineRed: ['old world › reads the manifest', 'old world'],
      candidateRed: ['old world › writes the manifest', 'old world'],
    });
    try {
      const report = await fx.run();
      assert.equal(report.ok, false);
      assert.deepEqual(report.broke, ['old world › writes the manifest']);
    } finally { fx.cleanup(); }
  });

  it('repairing a long-red test does not fail the round', async () => {
    const fx = fixture({ baselineRed: ['old world › one', 'old world'], candidateRed: [] });
    try {
      const report = await fx.run();
      assert.equal(report.ok, true);
      assert.deepEqual(report.fixed, ['old world › one', 'old world']);
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

  it('fetches before it builds the baseline — no remembered main', async () => {
    const fx = fixture();
    try {
      await fx.run();
      const git = fx.ran('git').map((call) => call.args.join(' '));
      const fetched = git.findIndex((line) => line.startsWith('fetch origin'));
      const built = git.findIndex((line) => line.startsWith('worktree add'));
      assert.ok(fetched !== -1, 'it never fetched');
      assert.ok(fetched < built, 'the baseline was checked out from a remembered ref');
    } finally { fx.cleanup(); }
  });

  it('both worktrees are detached, so no branch is moved', async () => {
    const fx = fixture();
    try {
      await fx.run();
      const added = fx.ran('git').filter((call) => call.args[0] === 'worktree' && call.args[1] === 'add');
      assert.equal(added.length, 2);
      for (const call of added) assert.ok(call.args.includes('--detach'), call.args.join(' '));
    } finally { fx.cleanup(); }
  });

  it('runs the two suites one after the other, baseline first', async () => {
    const fx = fixture();
    try {
      await fx.run();
      const sides = fx.ran('suite').map((call) => call.cwd.split('/').pop());
      assert.deepEqual(sides, ['baseline', 'candidate']);
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
    // Both sides die the same way — a missing dependency, a syntax error — and
    // both produce no failures at all. Compared, that is a confident green from
    // a suite that never ran, which is the worst thing this could report.
    const fx = fixture({ baselineFinished: false });
    try {
      const report = await fx.run();
      assert.equal(report.ok, false);
      assert.equal(report.stopped_at, 'suite');
      assert.match(report.reason, /baseline run never reached its own summary/u);
      assert.deepEqual(fx.ran('suite').length, 1, 'it paid for the candidate run anyway');
    } finally { fx.cleanup(); }
  });

  it('catches it on the candidate side too', async () => {
    const fx = fixture({ candidateFinished: false });
    try {
      const report = await fx.run();
      assert.equal(report.ok, false);
      assert.equal(report.stopped_at, 'suite');
      assert.match(report.reason, /candidate run never reached its own summary/u);
    } finally { fx.cleanup(); }
  });

  it('a repository with no suite of its own is a stop, not a pass', async () => {
    const fx = fixture();
    try {
      rmSync(join(fx.repoPath, 'package.json'), { force: true });
      const report = await fx.run();
      assert.equal(report.ok, false);
      assert.equal(report.stopped_at, 'suite');
      assert.match(report.reason, /no npm test script/u);
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
      assert.match(report.reason, /held by pm .*their own round/u);
      assert.deepEqual(fx.ran('suite'), []);
      assert.deepEqual(fx.ran('gh'), [], 'it did not even ask about the pull request');
      // And it did not release somebody else's lease on its way out.
      assert.equal(fx.lease().holder, 'pm');
    } finally { fx.cleanup(); }
  });

  it('clears the worktrees it made, whatever the verdict', async () => {
    const fx = fixture({ candidateRed: ['new thing › broke', 'new thing'] });
    try {
      await fx.run();
      const workspace = gateRoot(fx.mcHome);
      assert.equal(existsSync(join(workspace, 'baseline')), false);
      assert.equal(existsSync(join(workspace, 'candidate')), false);
    } finally { fx.cleanup(); }
  });
});

describe('there is no merge in here', () => {
  it('never reports a merge, on any path', async () => {
    for (const options of [{}, { candidateRed: ['x › y', 'x'] }, { conflict: true }, { prStatus: 1 }]) {
      const fx = fixture(options);
      try {
        const report = await fx.run();
        assert.equal(report.merged, false, JSON.stringify(options));
      } finally { fx.cleanup(); }
    }
  });

  it('runs no command that could land anything', async () => {
    const fx = fixture();
    try {
      await fx.run();
      const forbidden = fx.calls.filter(({ tool, args = [] }) => {
        const line = args.join(' ');
        if (tool === 'gh') return /\bpr (merge|edit|close|review|ready)\b/u.test(line);
        if (tool !== 'git') return false;
        // `worktree remove --force` is the round tidying up after itself: it
        // deletes a directory the round made, under mc's home, and cannot land
        // anything anywhere. Every other forceful git verb is the thing this
        // test is about.
        if (/^worktree remove --force /u.test(line)) return !line.includes('/gate/');
        return /^(push|commit|tag|branch|reset|rebase|cherry-pick)\b/u.test(line) || line.includes('--force');
      });
      assert.deepEqual(forbidden.map((call) => call.args.join(' ')), []);
      // The one merge it does run is into a throwaway worktree, never a branch.
      const merges = fx.ran('git').filter((call) => call.args[0] === 'merge');
      assert.equal(merges.length, 1);
      assert.match(merges[0].cwd, /candidate$/u);
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
  it('carries the red sets, the difference, the commits and the stop reason', async () => {
    const fx = fixture({
      baselineRed: ['old world › one', 'old world'],
      candidateRed: ['old world › one', 'old world', 'new thing › broke', 'new thing'],
    });
    try {
      const report = await fx.run();
      // Everything a surface with no judgement needs in order to report onward
      // without reading prose.
      assert.equal(report.ok, false);
      assert.equal(report.stopped_at, 'red');
      assert.equal(typeof report.reason, 'string');
      assert.deepEqual(report.baseline.red, ['old world › one', 'old world']);
      assert.deepEqual(report.broke, ['new thing › broke', 'new thing']);
      assert.equal(report.baseline.commit, 'base1111');
      assert.equal(report.candidate.commit, 'cand2222');
      assert.equal(report.pr.head, 'feature');
      assert.equal(report.pr.base, 'main');
      assert.match(report.command, /npm test/u);
      assert.equal(report.holder, 'klient-guard');
      assert.equal(typeof report.duration_ms, 'number');
      // It survives the trip through a pipe intact.
      assert.deepEqual(JSON.parse(JSON.stringify(report)).broke, report.broke);
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
describe('mc repo merge — the grammar', () => {
  it('offers two modes and no way to overrule a red gate', () => {
    const fx = repoFixture({ name: 'repo-gate-cli' });
    try {
      // `--check` gates and stops; without it the same round also merges.
      // What must not exist is a third mode — anything that lands a change the
      // gate called red. Overruling one is the human's call and should cost a
      // human action rather than a flag on a routine command.
      const usage = runMcCli(['repo', 'merge'], fx.env).stderr;
      assert.match(usage, /mc repo merge <repo> <pr> \[--check\]/u);
      for (const flag of ['--force', '--anyway', '--no-verify', '--skip-gate', '--apply']) {
        const tried = runMcCli(['repo', 'merge', 'repo', '400', flag], fx.env);
        assert.notEqual(tried.status, 0, `${flag} was accepted`);
      }
    } finally { fx.cleanup(); }
  });

  it('asks for the pull request rather than guessing one', () => {
    const fx = repoFixture({ name: 'repo-gate-cli' });
    try {
      assert.match(runMcCli(['repo', 'merge', 'repo'], fx.env).stderr, /which pull request\?/u);
      assert.match(runMcCli(['repo', 'merge'], fx.env).stderr, /which repository\?/u);
      assert.match(runMcCli(['repo', 'merge', 'repo', 'later', '--check'], fx.env).stderr, /not a pull request number/u);
    } finally { fx.cleanup(); }
  });

  it('a repository nobody has heard of is an error, not a round', () => {
    const fx = repoFixture({ name: 'repo-gate-cli' });
    try {
      const asked = runMcCli(['repo', 'merge', 'nowhere-at-all', '400', '--check'], fx.env);
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
      assert.match(runMcCli(['repo', 'claim', 'repo', 'x', '--check'], fx.env).stderr, /--check belongs to mc repo merge/u);
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
