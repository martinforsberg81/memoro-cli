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
import { carriedGate, lockfileHashAt, saveBaseline } from '../../src/mc/repo-baseline-cache.js';
import { claimLease, readLease } from '../../src/mc/repo-lease.js';
import { claimSuiteLease, readSuiteLease } from '../../src/mc/suite-lease.js';
import { renderRatchet } from '../../src/mc/red-ratchet.js';

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
  // What `.mc/red-ratchet.json` says in the candidate worktree, if anything.
  // An array is a recorded set; a string is written verbatim, which is how a
  // malformed one is tested. `undefined` is a repository with no ratchet.
  ratchet = undefined,
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
  const told = [];
  const git = (args, opts = {}) => {
    calls.push({ tool: 'git', args, cwd: opts.cwd });
    if (args[0] === 'worktree' && args[1] === 'add') {
      const dir = args[args.length - 2];
      mkdirSync(dir, { recursive: true });
      // The gate reads the ratchet out of the candidate worktree, so this is
      // where a checkout that has one gets it — the same place a real
      // `worktree add` would have put it.
      if (ratchet !== undefined && dir.endsWith('candidate')) {
        mkdirSync(join(dir, '.mc'), { recursive: true });
        writeFileSync(
          join(dir, '.mc', 'red-ratchet.json'),
          typeof ratchet === 'string' ? ratchet : renderRatchet(ratchet),
        );
      }
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
    // What the round told a holder it was refused by. Stubbed, always: the
    // real one writes to a real area's inbox with a wake, and one run of this
    // file with it live put two "CLAIM REFUSED" files in PM's inbox about a
    // temp repository that never existed (2026-08-23).
    told,
    run: (extra = {}) => runGate({
      repoPath,
      pr: 400,
      holder: AREA,
      root: mcHome,
      git,
      gh,
      suite,
      tests,
      tell: (message) => { told.push(message); return { told: true, woke: true, reason: null, file: null }; },
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
      assert.match(report.reason, /held by pm .*their own round” — pm has been told/u);
      // The holder was told, once, which lease and by whom (lease-refusal.js).
      assert.equal(fx.told.length, 1);
      assert.equal(fx.told[0].lease.holder, 'pm');
      assert.equal(fx.told[0].asker.name, 'klient-guard');
      assert.equal(fx.told[0].what, fx.repoPath);
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

/**
 * The verdict now carries a number and a floor.
 *
 * The differential rule above is untouched — every test in it still passes
 * unchanged, which is the point. What is added is a second, independent check
 * that the differential one structurally cannot make: it compares against a
 * baseline measured in the same round, so it can never notice that the
 * baseline itself has got worse since last time.
 */
describe('the standing red set, recorded and ratcheted', () => {
  it('reports how many red names the base itself is carrying', async () => {
    const red = ['old world › one', 'old world'];
    const fx = fixture({ baselineRed: red, candidateRed: red });
    try {
      const report = await fx.run();
      assert.equal(report.ok, true, report.reason || '');
      assert.equal(report.standing_red, 2, 'the count is read off the baseline, which is the base branch');
      assert.equal(report.verdict, 'no-new-red', 'a pass over standing red is not the same claim as green');
    } finally { fx.cleanup(); }
  });

  it('a clean base is still the strict verdict', async () => {
    const fx = fixture({ baselineRed: [], candidateRed: [] });
    try {
      const report = await fx.run();
      assert.equal(report.standing_red, 0);
      assert.equal(report.verdict, 'green');
    } finally { fx.cleanup(); }
  });

  it('a repository with no ratchet runs exactly as it did before', async () => {
    const red = ['old world › one', 'old world'];
    const fx = fixture({ baselineRed: red, candidateRed: red });
    try {
      const report = await fx.run();
      assert.equal(report.ok, true, report.reason || '');
      assert.equal(report.ratchet.present, false, 'absent is not a floor of zero');
      assert.deepEqual(report.ratchet.risen, []);
    } finally { fx.cleanup(); }
  });

  it('a red name nobody recorded fails the round', async () => {
    // Red on both sides, so `broke` is empty and the differential rule passes
    // it. The only thing that can see this is the recorded floor.
    const red = ['old world › one', 'old world'];
    const fx = fixture({ baselineRed: red, candidateRed: red, ratchet: ['old world'] });
    try {
      const report = await fx.run();
      assert.equal(report.ok, false);
      assert.equal(report.stopped_at, 'ratchet');
      assert.deepEqual(report.broke, [], 'the differential rule had no objection — that is the whole point');
      assert.deepEqual(report.ratchet.risen, ['old world › one']);
      assert.equal(report.verdict, 'ratchet-risen');
      assert.equal(report.merged, false);
    } finally { fx.cleanup(); }
  });

  it('the recorded set breathing on a name it already knows does not fail', async () => {
    // The measurement from the brief: the same repository, 55 red names one
    // round and 56 the next, the extra one green again after that. The floor
    // holds the name, so neither round moves it.
    const floor = ['old world › one', 'old world', 'flaky under load'];
    const busy = fixture({ baselineRed: floor, candidateRed: floor, ratchet: floor });
    try {
      const report = await busy.run();
      assert.equal(report.ok, true, report.reason || '');
      assert.deepEqual(report.ratchet.risen, []);
    } finally { busy.cleanup(); }

    const quiet = fixture({
      baselineRed: ['old world › one', 'old world'],
      candidateRed: ['old world › one', 'old world'],
      ratchet: floor,
    });
    try {
      const report = await quiet.run();
      assert.equal(report.ok, true, report.reason || '');
      assert.deepEqual(report.ratchet.fallen, ['flaky under load'], 'offered up, not taken');
    } finally { quiet.cleanup(); }
  });

  it('a ratchet that will not parse stops the round rather than reading as empty', async () => {
    const red = ['old world › one', 'old world'];
    const fx = fixture({ baselineRed: red, candidateRed: red, ratchet: '{ not json' });
    try {
      const report = await fx.run();
      assert.equal(report.ok, false);
      assert.equal(report.stopped_at, 'ratchet');
      assert.equal(report.ratchet.ok, false);
      // An empty floor would have made both standing names look like a rise.
      assert.deepEqual(report.ratchet.risen, []);
    } finally { fx.cleanup(); }
  });

  it('the ratchet cannot be used to get a new red name past the differential rule', async () => {
    // The candidate breaks something *and* writes it into the floor. `broke`
    // runs first and there is no way round it, which is why the two checks are
    // independent rather than one that consults a file.
    const fx = fixture({
      baselineRed: ['old world'],
      candidateRed: ['old world', 'newly broken'],
      ratchet: ['old world', 'newly broken'],
    });
    try {
      const report = await fx.run();
      assert.equal(report.ok, false);
      assert.equal(report.stopped_at, 'red', 'stopped by broke, not by the ratchet');
      assert.deepEqual(report.broke, ['newly broken']);
    } finally { fx.cleanup(); }
  });
});

/**
 * The pull request's own tests (D-0157). The suite says whether anything else
 * broke; this says whether the change is proved — and a suite that globs some
 * directories and not others had said neither about a PR whose tests lived in
 * `tests/ui/`: the same count as the day before, 114 new test lines.
 */
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
      assert.match(result.reason, /2 of the pull request's own tests are red: thing › proves the fix, thing/u);
      assert.deepEqual(result.broke, [], 'the suite had nothing to say');
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
      assert.deepEqual(order, ['suite', 'suite', 'diff', 'tests']);
    } finally { fx.cleanup(); }
  });
});

/**
 * A suite in a worktree with no dependency tree does not fail, it shrinks
 * (D-0152): 2162 tests and a tidy number where 206 never ran. The gate checks
 * the tree after preparation and before either run.
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
      assert.match(result.reason, /baseline declares 1 dependencies and has no node_modules after preparation/u);
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
      assert.equal(fx.ran('suite').length, 2);
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
 * The suite right (D-0141): the gate is the one thing that runs suites by
 * machine, so it takes the machine-wide lease before either run and gives it
 * back after — and stops, in the other holder's favour, when it is held.
 */
describe('the gate holds the suite right while it runs', () => {
  it('stops before any work when somebody else holds the suite right, and keeps nothing', async () => {
    const fx = fixture();
    try {
      claimSuiteLease({ errand: 'msr contract, by hand', holder: { name: 'msr-cleanup', kind: 'work-area' }, root: fx.mcHome });
      const running = [{ pid: 9, command: 'npm test', area: 'msr-cleanup', elapsed: '05:00' }];
      const result = await fx.run({ suiteRunsNow: async () => running });
      assert.equal(result.stopped_at, 'suite-lease');
      assert.match(result.reason, /held by msr-cleanup for “msr contract, by hand” — one full suite at a time/u);
      // The holder is told what runs under the right as measured, never as
      // a default: "nothing running" by default told PM a suite was idle
      // while it was five minutes in (2026-08-23).
      assert.equal(fx.told.length, 1);
      assert.equal(fx.told[0].what, 'the suite right');
      assert.deepEqual(fx.told[0].running, running);
      assert.deepEqual(fx.ran('suite'), [], 'no suite ran over somebody\'s right');
      assert.equal(fx.lease().held, false, 'the repository lease was given back');
      assert.equal(readSuiteLease({ root: fx.mcHome }).holder, 'msr-cleanup', 'and theirs was not touched');
    } finally { fx.cleanup(); }
  });

  it('takes it for the round and releases it after, whatever happened', async () => {
    const fx = fixture({ candidateRed: ['new › red'] });
    try {
      const progress = [];
      const result = await fx.run({ onProgress: (line) => progress.push(line) });
      assert.equal(result.stopped_at, 'red');
      assert.ok(progress.includes('suite right taken by klient-guard'), progress.join('\n'));
      assert.ok(progress.includes('suite right released'));
      assert.equal(readSuiteLease({ root: fx.mcHome }).held, false);
    } finally { fx.cleanup(); }
  });

  it('a holder who claimed it by hand before the round keeps it after', async () => {
    const fx = fixture();
    try {
      claimSuiteLease({ errand: 'mine', holder: AREA, root: fx.mcHome });
      await fx.run();
      assert.equal(readSuiteLease({ root: fx.mcHome }).holder, AREA.name, 'their claim, their release');
    } finally { fx.cleanup(); }
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
});

/**
 * Several pull requests as one candidate (A3, 2026-08-23). With eleven in
 * the queue and each round holding the suite right for 5–13 minutes, the
 * round itself was the bottleneck. The batch is one tree with all of them
 * merged in, measured once each side — and each pull request's own tests
 * still run by themselves, so the batch can never hide which one carried
 * which test.
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

  it('builds the candidate from the base with every head merged in, in order, and runs the suite once each side', async () => {
    const fx = batchFixture();
    try {
      const report = await fx.run();
      assert.equal(report.ok, true, report.reason);
      const adds = fx.ran('git').filter((call) => call.args[0] === 'worktree' && call.args[1] === 'add').map((call) => call.args[call.args.length - 1]);
      assert.deepEqual(adds, ['origin/main', 'origin/main'], 'both worktrees start from the base');
      const merges = fx.ran('git').filter((call) => call.args[0] === 'merge').map((call) => call.args[2]);
      assert.deepEqual(merges, ['sha401', 'sha402', 'sha403'], 'heads merged in the order given');
      assert.equal(fx.ran('suite').length, 2, 'one suite per side, not per pull request');
      // Each pull request's own tests: its files, by its head, never the others'.
      const own = fx.ran('tests').map((call) => call.files);
      assert.deepEqual(own, [['tests/sha401.test.js'], ['tests/sha402.test.js'], ['tests/sha403.test.js']]);
      assert.deepEqual(report.prs.map((item) => [item.number, item.pr_tests.files]), [
        [401, ['tests/sha401.test.js']], [402, ['tests/sha402.test.js']], [403, ['tests/sha403.test.js']],
      ]);
      assert.ok(Object.keys(report.timings).includes('suite baseline'), 'wall clock per step (A5)');
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
 * Extra gates, run on both sides and judged by the delta (2026-08-24).
 *
 * Measured that night on #10909's round: the extra gate ran only on the
 * candidate, main's own contract suite was red the whole time (5 fail, the
 * same 5 on untouched origin/main), and the round said "FAILED on the
 * candidate". A track spent six minutes proving its innocence. The rules
 * asserted here: both sides run, the verdict is the delta, a red baseline
 * is said as main's fault, and a carried result spares the baseline run.
 */
describe('extra gates are differential: both sides, and the delta decides', () => {
  const declare = (fx, command, { name = 'contract' } = {}) => writeJson(join(fx.mcHome, 'repo-gates.json'), {
    repo: { prepare: null, prepare_why: 'a test', extra_gates: [{ name, command }], merge_log: null },
  });
  // A gate whose result depends on which worktree it runs in: red in the
  // baseline, green in the candidate, or any mix — one shell line, branching
  // on the directory name the round gave it as cwd.
  const gate = (baselineExit, candidateExit) => `case "$(basename "$PWD")" in baseline) exit ${baselineExit};; *) exit ${candidateExit};; esac`;

  it('runs the gate on both sides, and both green passes', async () => {
    const fx = fixture();
    try {
      declare(fx, gate(0, 0));
      const report = await fx.run({ root: fx.mcHome });
      assert.equal(report.ok, true, report.reason);
      assert.equal(report.extra_gates.length, 1);
      assert.equal(report.extra_gates[0].baseline.ok, true);
      assert.equal(report.extra_gates[0].candidate.ok, true);
      assert.ok('extra gates baseline' in report.timings, 'the baseline run was not timed');
    } finally { fx.cleanup(); }
  });

  it('candidate red and baseline green is the PR\'s fault, said as loudly as ever', async () => {
    const fx = fixture();
    try {
      declare(fx, gate(0, 1));
      const report = await fx.run({ root: fx.mcHome });
      assert.equal(report.stopped_at, 'extra-gate');
      assert.match(report.reason, /failed on the candidate and passed on the baseline/u);
    } finally { fx.cleanup(); }
  });

  it('red on both sides is main\'s fault, and the round stops for THAT reason', async () => {
    const fx = fixture();
    try {
      declare(fx, gate(1, 1));
      const report = await fx.run({ root: fx.mcHome });
      assert.equal(report.stopped_at, 'extra-gate-baseline');
      assert.match(report.reason, /already red before this PR/u);
      assert.match(report.reason, /the base itself is broken; not this change's doing/u);
      assert.equal(report.extra_gates[0].already_red, true);
    } finally { fx.cleanup(); }
  });

  it('a candidate that repairs a red baseline passes, with a sentence', async () => {
    const fx = fixture();
    try {
      declare(fx, gate(1, 0));
      const progress = [];
      const report = await fx.run({ root: fx.mcHome, onProgress: (line) => progress.push(line) });
      assert.equal(report.ok, true, report.reason);
      assert.ok(progress.some((line) => /red on the baseline, green on the candidate — this change repairs it/u.test(line)), progress.join('\n'));
    } finally { fx.cleanup(); }
  });

  it('a gate that prints TAP is judged by red names: a new name is the PR\'s even over a red baseline', async () => {
    const fx = fixture();
    try {
      // Baseline: one standing red. Candidate: the same, plus a new one.
      const emit = (names) => `printf '%s\\n' 'TAP version 13' ${names.map((n, i) => `'# Subtest: ${n}' 'not ok ${i + 1} - ${n}'`).join(' ')} '1..${names.length}' '# tests ${names.length}' '# pass 0' '# fail ${names.length}'; exit 1`;
      declare(fx, `case "$(basename "$PWD")" in baseline) ${emit(['standing'])};; *) ${emit(['standing', 'fresh'])};; esac`);
      const report = await fx.run({ root: fx.mcHome });
      assert.equal(report.stopped_at, 'extra-gate', report.reason);
      assert.match(report.reason, /already red on the baseline \(1 red\) and the candidate adds 1 more: fresh/u);
      assert.deepEqual(report.extra_gates[0].broke, ['fresh']);
    } finally { fx.cleanup(); }
  });

  it('a carried gate result spares the baseline run — once per main SHA, not once per PR', async () => {
    const fx = fixture();
    try {
      const marker = join(fx.root, 'gate-ran.txt');
      declare(fx, `echo "$(basename "$PWD")" >> "${marker}"; exit 0`);
      saveBaseline({
        repoPath: fx.repoPath,
        commit: 'cand2222',
        lockfileHash: lockfileHashAt({ git: fx.git, repoPath: fx.repoPath, commit: 'cand2222' }),
        command: 'npm test  (node --test tests/)',
        red: [],
        totals: { tests: 100, fail: 0 },
        extraGates: [{ name: 'contract', command: `echo "$(basename "$PWD")" >> "${marker}"; exit 0`, ok: true, exit_code: 0, red: [] }],
        root: fx.mcHome,
      });
      const report = await fx.run({ root: fx.mcHome });
      assert.equal(report.ok, true, report.reason);
      assert.equal(report.baseline.carried, true);
      assert.equal(report.extra_gates[0].baseline.carried, true);
      assert.deepEqual(readFileSync(marker, 'utf8').trim().split('\n'), ['candidate'], 'the gate ran somewhere besides the candidate');
      assert.equal(fx.ran('suite').length, 1, 'the suite baseline was carried too');
    } finally { fx.cleanup(); }
  });

  it('a carried suite entry WITHOUT this gate still gets a baseline worktree, and the gate runs there', async () => {
    const fx = fixture();
    try {
      const marker = join(fx.root, 'gate-ran.txt');
      declare(fx, `echo "$(basename "$PWD")" >> "${marker}"; exit 0`);
      // An A1 entry from before extra gates were carried: suite result only.
      saveBaseline({
        repoPath: fx.repoPath,
        commit: 'cand2222',
        lockfileHash: lockfileHashAt({ git: fx.git, repoPath: fx.repoPath, commit: 'cand2222' }),
        command: 'npm test  (node --test tests/)',
        red: [],
        totals: { tests: 100, fail: 0 },
        root: fx.mcHome,
      });
      const report = await fx.run({ root: fx.mcHome });
      assert.equal(report.ok, true, report.reason);
      assert.equal(report.baseline.carried, true, 'the suite result was still carried');
      assert.equal(fx.ran('suite').length, 1, 'no suite reran for the gate\'s sake');
      assert.deepEqual(readFileSync(marker, 'utf8').trim().split('\n').sort(), ['baseline', 'candidate']);
    } finally { fx.cleanup(); }
  });

  it('carriedGate matches by command, never by name', () => {
    const entry = { extra_gates: [{ name: 'old name', command: 'run-it', ok: true, exit_code: 0, red: [] }] };
    assert.ok(carriedGate(entry, { name: 'new name', command: 'run-it' }));
    assert.equal(carriedGate(entry, { name: 'old name', command: 'run-it --different' }), null);
    assert.equal(carriedGate(null, { name: 'x', command: 'run-it' }), null);
  });
});

/**
 * The baseline, carried forward instead of rerun (A1). Ordered by Martin on
 * the independent review's finding: 52 of 61 memoro baselines were exactly
 * the previous round's already-measured candidate, and 0 of 92 rounds ever
 * had a red delta on the baseline. The rules asserted here: reuse only on
 * an exact three-key match, break the chain on the smallest deviation, and
 * keep the red comparison's form — fed from the carried result.
 */
describe('the baseline is carried forward, and the chain breaks on any deviation', () => {

  it('an exact key match skips the baseline run and says where the number came from', async () => {
    const fx = fixture({ baselineRed: [], candidateRed: ['old-red'] });
    try {
      // The key as the gate will compute it: the base commit the stubbed
      // rev-parse answers in the repo, the lockfile hash the stubbed git
      // shows, and the repository's own suite command.
      saveBaseline({
        repoPath: fx.repoPath,
        commit: 'cand2222',
        lockfileHash: lockfileHashAt({ git: fx.git, repoPath: fx.repoPath, commit: 'cand2222' }),
        command: 'npm test  (node --test tests/)',
        red: ['old-red'],
        totals: { tests: 100, fail: 1 },
        root: fx.mcHome,
      });
      const progress = [];
      const report = await fx.run({ root: fx.mcHome, onProgress: (line) => progress.push(line) });
      assert.equal(report.ok, true, report.reason);
      assert.equal(report.baseline.carried, true);
      assert.equal(report.baseline.commit, 'cand2222');
      assert.equal(fx.ran('suite').length, 1, 'one suite run: the candidate\'s');
      assert.ok(fx.ran('suite')[0].cwd.endsWith('candidate'));
      // The red comparison kept its form, fed from the carried result: the
      // candidate's red name was already red, so nothing broke.
      assert.deepEqual(report.broke, []);
      assert.equal(report.standing_red, 1);
      assert.ok(progress.some((line) => /^baseline carried from the last green round: 1 red at cand222/u.test(line)), progress.join('\n'));
    } finally { fx.cleanup(); }
  });

  it('a baseline above its own floor is flagged loudly, and is not a stop (the 57 that passed through)', async () => {
    // Measured 2026-08-23: #385's candidate measured a tree at 55 red;
    // #386's baseline measured the same content at 57 minutes later, and
    // the 57 was compared against nothing. The floor already knew 55.
    const names = Array.from({ length: 3 }, (_, index) => `stable-${index}`);
    const fx = fixture({
      baselineRed: [...names, 'flaky-one', 'flaky-two'],
      candidateRed: names,
      ratchet: names,
    });
    try {
      const progress = [];
      const report = await fx.run({ onProgress: (line) => progress.push(line) });
      assert.equal(report.ok, true, `${report.reason} — the base's instability is never the change's fault`);
      assert.deepEqual(report.ratchet.baseline_risen, ['flaky-one', 'flaky-two']);
      assert.ok(progress.some((line) => /^BASELINE UNSTABLE — 2 red names on the baseline are not in/u.test(line)), progress.join('|'));
    } finally { fx.cleanup(); }
  });

  it('any key off — commit, lockfile, command, or nothing saved — runs the baseline as before', async () => {
    const fx = fixture();
    try {
      saveBaseline({
        repoPath: fx.repoPath,
        commit: 'somebody-elses-commit',
        lockfileHash: lockfileHashAt({ git: fx.git, repoPath: fx.repoPath, commit: 'x' }),
        command: 'npm test  (node --test tests/)',
        red: [],
        totals: null,
        root: fx.mcHome,
      });
      const report = await fx.run({ root: fx.mcHome });
      assert.equal(report.ok, true, report.reason);
      assert.ok(!report.baseline.carried);
      assert.equal(fx.ran('suite').length, 2, 'both sides measured, as always');
    } finally { fx.cleanup(); }
  });
});
