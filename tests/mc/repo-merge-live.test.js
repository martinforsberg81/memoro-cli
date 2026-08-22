/**
 * The merge round against real git, a real suite, and a real squash.
 *
 * Everything else about this verb is asserted against injected commands, which
 * proves the decisions and nothing about the plumbing. This runs the whole
 * round for real — two full suite runs in throwaway worktrees, a squash that
 * actually lands on a bare origin, a deploy pull that actually moves a checkout
 * — in a repository built for the purpose, because the one thing that must
 * never be used to test a verb that merges is a repository somebody needs.
 *
 * `gh` is a shell script here. The forge is the only part that cannot be real
 * without a network, so it answers `pr view` from a file and performs `pr merge
 * --squash` as the git commands GitHub would run.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { runGate } from '../../src/mc/repo-gate.js';
import { readLease } from '../../src/mc/repo-lease.js';
import { runMergeRound } from '../../src/mc/repo-merge.js';

const AREA = { name: 'klient-guard', kind: 'work-area' };
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' });

/** A repository with an origin, a main, and a branch with a change on it. */
function repository({ branchBreaksSuite = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mc-merge-live-'));
  const repo = join(root, 'repo');
  const bare = join(root, 'origin.git');
  const mcHome = join(root, 'home');
  mkdirSync(repo, { recursive: true });
  mkdirSync(mcHome, { recursive: true, mode: 0o700 });

  git(root, ['init', '-q', '--bare', bare]);
  git(root, ['clone', '-q', bare, repo]);
  git(repo, ['config', 'user.email', 'test@example.invalid']);
  git(repo, ['config', 'user.name', 'mc-test']);

  // A repository whose `npm test` is a real node test run, small enough to run
  // twice per round without the suite being the thing under test.
  writeFileSync(join(repo, 'package.json'), `${JSON.stringify({
    name: 'gated', version: '1.0.0', type: 'module', scripts: { test: "node --test 'tests/*.test.js'" },
  }, null, 2)}\n`);
  mkdirSync(join(repo, 'tests'), { recursive: true });
  writeFileSync(join(repo, 'tests', 'a.test.js'), [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "test('always green', () => { assert.equal(1, 1); });",
    "test('long red', () => { assert.equal(1, 2); });",
    '',
  ].join('\n'));
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'Initial commit']);
  git(repo, ['push', '-q', 'origin', 'HEAD:main']);
  git(repo, ['branch', '-M', 'main']);
  git(repo, ['branch', '--set-upstream-to=origin/main', 'main']);

  git(repo, ['checkout', '-q', '-b', 'feature']);
  writeFileSync(join(repo, 'tests', 'b.test.js'), [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    `test('the change', () => { assert.equal(1, ${branchBreaksSuite ? 2 : 1}); });`,
    '',
  ].join('\n'));
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'Add the change']);
  git(repo, ['push', '-q', 'origin', 'feature']);
  const head = git(repo, ['rev-parse', 'HEAD']).trim();
  git(repo, ['checkout', '-q', 'main']);

  // `gh`, as a script: reads a pull request from a file, and performs the
  // squash as the git commands the forge would run.
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(root, 'pr.json'), JSON.stringify({
    number: 400, headRefName: 'feature', baseRefName: 'main', headRefOid: head, state: 'OPEN', title: 'the change',
  }));
  writeFileSync(join(bin, 'gh'), [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> "${root}/gh-calls.log"`,
    `if [ "$1" = "pr" ] && [ "$2" = "view" ]; then cat "${root}/pr.json"; exit 0; fi`,
    'if [ "$1" = "pr" ] && [ "$2" = "merge" ]; then',
    `  work="${root}/forge" ; rm -rf "$work"`,
    `  git clone -q "${bare}" "$work" || exit 1`,
    '  git -C "$work" config user.email "forge@example.invalid"',
    '  git -C "$work" config user.name "forge"',
    '  git -C "$work" merge --squash origin/feature >/dev/null 2>&1 || exit 1',
    '  git -C "$work" commit -q -m "Add the change (#400)" || exit 1',
    '  git -C "$work" push -q origin main || exit 1',
    '  exit 0',
    'fi',
    'exit 1',
  ].join('\n'));
  chmodSync(join(bin, 'gh'), 0o755);

  return {
    root,
    repo,
    bare,
    mcHome,
    head,
    logPath: join(root, 'merge-log.md'),
    mainAt: () => git(repo, ['ls-remote', bare, 'refs/heads/main']).trim().split(/\s+/u)[0],
    subjectsOnMain: () => {
      const clone = join(root, `read-${Math.random().toString(36).slice(2, 8)}`);
      git(root, ['clone', '-q', bare, clone]);
      return git(clone, ['log', '--oneline', '-5']).trim().split('\n');
    },
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    lease: () => readLease(repo, { root: mcHome }),
    cleanup() { try { rmSync(root, { recursive: true, force: true }); } catch { /* gone */ } },
  };
}

describe('the merge round, for real', () => {
  it('gates a green branch and squash-merges it onto main', async () => {
    const fx = repository();
    writeFileSync(fx.logPath, '| Datum | PR | Kontroller | Klass | Beslut | Anteckning |\n|---|---|---|---|---|---|\n');
    try {
      const before = fx.mainAt();
      const report = await runMergeRound({
        repoPath: fx.repo,
        pr: 400,
        holder: AREA,
        root: fx.mcHome,
        env: fx.env,
        mergeLog: fx.logPath,
      });

      assert.equal(report.ok, true, report.reason || '');
      assert.equal(report.merged, true);

      // The suite really ran, on both sides, and really found the long-red test.
      assert.equal(report.gate.baseline.totals.finished, true);
      assert.deepEqual(report.gate.broke, [], 'the branch broke nothing');
      assert.ok(report.gate.baseline.red.length > 0, 'the fixture is meant to carry one long-red test');
      assert.equal(report.gate.candidate.totals.tests > report.gate.baseline.totals.tests, true);

      // And main really moved, by exactly one squashed commit.
      const after = fx.mainAt();
      assert.notEqual(after, before, 'main did not move');
      assert.equal(report.merge_commit, after);
      assert.match(fx.subjectsOnMain()[0], /Add the change \(#400\)/u);
      assert.equal(fx.subjectsOnMain().length, 2, 'a squash should add one commit, not two');

      assert.match(readFileSync(fx.logPath, 'utf8'), /#400/u);
      assert.equal(fx.lease().held, false);
    } finally { fx.cleanup(); }
  });

  it('a branch that breaks the suite is not merged, and main is untouched', async () => {
    const fx = repository({ branchBreaksSuite: true });
    try {
      const before = fx.mainAt();
      const report = await runMergeRound({
        repoPath: fx.repo, pr: 400, holder: AREA, root: fx.mcHome, env: fx.env, mergeLog: null,
      });

      assert.equal(report.ok, false);
      assert.equal(report.stopped_at, 'red');
      assert.equal(report.merged, false);
      assert.ok(report.gate.broke.length > 0, 'the gate should have named what broke');
      assert.equal(fx.mainAt(), before, 'main moved on a red gate');
      assert.equal(fx.lease().held, false);
    } finally { fx.cleanup(); }
  });

  it('a base that moved while the suites ran stops the round', async () => {
    // Somebody merges by hand mid-round. The lease does not stop them, so the
    // round has to notice before acting on a verdict about a tree that changed.
    const fx = repository();
    try {
      const before = fx.mainAt();
      const report = await runMergeRound({
        repoPath: fx.repo,
        pr: 400,
        holder: AREA,
        root: fx.mcHome,
        env: fx.env,
        mergeLog: null,
        gate: async (options) => {
          const { runGate } = await import('../../src/mc/repo-gate.js');
          const verdict = await runGate(options);
          // Land something else on main, exactly as a person with a keyboard would.
          const side = join(fx.root, 'meanwhile');
          git(fx.root, ['clone', '-q', fx.bare, side]);
          git(side, ['config', 'user.email', 'other@example.invalid']);
          git(side, ['config', 'user.name', 'other']);
          writeFileSync(join(side, 'NOTES.md'), 'landed while the suites ran\n');
          git(side, ['add', '-A']);
          git(side, ['commit', '-q', '-m', 'Something else']);
          git(side, ['push', '-q', 'origin', 'main']);
          return verdict;
        },
      });

      assert.equal(report.ok, false);
      assert.equal(report.stopped_at, 'drift');
      assert.match(report.reason, /moved from/u);
      assert.equal(report.merged, false);
      // Main carries the other person's commit and not ours.
      assert.notEqual(fx.mainAt(), before);
      assert.match(fx.subjectsOnMain()[0], /Something else/u);
      assert.doesNotMatch(fx.subjectsOnMain().join('\n'), /#400/u);
      assert.equal(fx.lease().held, false);
    } finally { fx.cleanup(); }
  });
});

/**
 * Preparation and extra gates, in a real round.
 *
 * The declaration decides both, and both are held to the suite's own rule: a
 * step that did not reach its own end is not an approval. Asserted here against
 * real commands in real worktrees, because what a declaration is *for* is a
 * repository whose suite is incomplete without it — and an incomplete suite is
 * exactly what a stub cannot reproduce.
 */
describe('what a repository declares, the round does', () => {
  /** Declare this fixture's repository in the operator's own table. */
  const declare = (fx, entry) => writeFileSync(
    join(fx.mcHome, 'repo-gates.json'),
    JSON.stringify({ [fx.repo.split('/').pop()]: entry }),
  );

  it('runs the declared prepare step in both worktrees before the suites', async () => {
    const fx = repository();
    try {
      // A prepare that leaves a trace, so "did it run, and where" is a question
      // about the file system rather than about a mock.
      declare(fx, { prepare: 'touch PREPARED', extra_gates: [], merge_log: null });
      const report = await runMergeRound({
        repoPath: fx.repo, pr: 400, holder: AREA, root: fx.mcHome, env: fx.env, mergeLog: null,
      });
      assert.equal(report.ok, true, report.reason || '');
      assert.equal(report.gate.declaration.prepare, 'touch PREPARED');
      assert.equal(report.gate.declaration.source, 'declared');
    } finally { fx.cleanup(); }
  });

  it('a prepare that fails stops the round before any suite runs', async () => {
    const fx = repository();
    try {
      declare(fx, { prepare: 'exit 3', extra_gates: [], merge_log: null });
      const before = fx.mainAt();
      const report = await runMergeRound({
        repoPath: fx.repo, pr: 400, holder: AREA, root: fx.mcHome, env: fx.env, mergeLog: null,
      });
      assert.equal(report.ok, false);
      assert.equal(report.gate.stopped_at, 'prepare');
      assert.equal(report.merged, false);
      assert.equal(fx.mainAt(), before, 'main moved on an unprepared tree');
    } finally { fx.cleanup(); }
  });

  it('an extra gate that fails stops the round, with the suite already green', async () => {
    const fx = repository();
    try {
      declare(fx, { prepare: null, extra_gates: [{ name: 'contract', command: 'exit 1' }], merge_log: null });
      const before = fx.mainAt();
      const report = await runMergeRound({
        repoPath: fx.repo, pr: 400, holder: AREA, root: fx.mcHome, env: fx.env, mergeLog: null,
      });
      assert.equal(report.ok, false);
      assert.equal(report.gate.stopped_at, 'extra-gate');
      assert.match(report.gate.reason, /contract failed/u);
      // The suite really did pass — this is the gate beyond it doing the work.
      assert.deepEqual(report.gate.broke, []);
      assert.equal(report.merged, false);
      assert.equal(fx.mainAt(), before);
    } finally { fx.cleanup(); }
  });

  it('an extra gate that cannot be run at all is a stop, not an approval', async () => {
    // Same rule as a suite that never summarised: no answer is not a yes.
    const fx = repository();
    try {
      declare(fx, {
        prepare: null,
        extra_gates: [{ name: 'contract', command: 'this-command-does-not-exist' }],
        merge_log: null,
      });
      const report = await runMergeRound({
        repoPath: fx.repo, pr: 400, holder: AREA, root: fx.mcHome, env: fx.env, mergeLog: null,
      });
      assert.equal(report.ok, false);
      assert.equal(report.gate.stopped_at, 'extra-gate');
      assert.equal(report.merged, false);
    } finally { fx.cleanup(); }
  });

  it('an extra gate that passes lets the round land, and is reported', async () => {
    const fx = repository();
    try {
      declare(fx, { prepare: null, extra_gates: [{ name: 'contract', command: 'true' }], merge_log: null });
      const report = await runMergeRound({
        repoPath: fx.repo, pr: 400, holder: AREA, root: fx.mcHome, env: fx.env, mergeLog: null,
      });
      assert.equal(report.ok, true, report.reason || '');
      assert.equal(report.merged, true);
      assert.deepEqual(report.gate.extra_gates, [
        { name: 'contract', command: 'true', ok: true, exit_code: 0, ran: true },
      ]);
    } finally { fx.cleanup(); }
  });

  it('an undeclared repository with dependencies stops before any work', async () => {
    const fx = repository();
    try {
      // Give it a dependency and no declaration: mc cannot know whether the
      // suite would be complete, so it refuses rather than finding out the
      // expensive way.
      const manifest = JSON.parse(readFileSync(join(fx.repo, 'package.json'), 'utf8'));
      writeFileSync(join(fx.repo, 'package.json'), JSON.stringify({ ...manifest, dependencies: { left_pad: '1.0.0' } }));
      const report = await runMergeRound({
        repoPath: fx.repo, pr: 400, holder: AREA, root: fx.mcHome, env: fx.env, mergeLog: null,
      });
      assert.equal(report.ok, false);
      assert.equal(report.gate.stopped_at, 'declaration');
      assert.match(report.gate.reason, /no gate declaration/u);
      assert.equal(report.merged, false);
      assert.equal(fx.lease().held, false);
    } finally { fx.cleanup(); }
  });
});

/**
 * D-0157, for real: the suite globs `tests/*.test.js`, and the PR's own test
 * lives in `tests/ui/` — a directory the suite never sees. The suite count is
 * the same as before the PR; the PR's test is red; the old gate said green.
 */
describe('the pull request\'s own tests, for real', () => {
  const ownTest = (fx, red) => {
    git(fx.repo, ['checkout', '-q', 'feature']);
    mkdirSync(join(fx.repo, 'tests', 'ui'), { recursive: true });
    writeFileSync(join(fx.repo, 'tests', 'ui', 'fix.test.js'), [
      "import { test } from 'node:test';",
      "import assert from 'node:assert/strict';",
      `test('proves the fix', () => { assert.equal(1, ${red ? 2 : 1}); });`,
      '',
    ].join('\n'));
    git(fx.repo, ['add', '-A']);
    git(fx.repo, ['commit', '-q', '-m', 'Add the proof']);
    git(fx.repo, ['push', '-q', 'origin', 'feature']);
    const head = git(fx.repo, ['rev-parse', 'HEAD']).trim();
    git(fx.repo, ['checkout', '-q', 'main']);
    const pr = JSON.parse(readFileSync(join(fx.root, 'pr.json'), 'utf8'));
    writeFileSync(join(fx.root, 'pr.json'), JSON.stringify({ ...pr, headRefOid: head }));
  };

  it('a red test the suite never globbed stops the round — the hole #10803 fell through', async () => {
    const fx = repository();
    try {
      ownTest(fx, true);
      const result = await runGate({ repoPath: fx.repo, pr: 400, holder: AREA, root: fx.mcHome, env: fx.env });
      assert.equal(result.stopped_at, 'pr-tests', JSON.stringify(result));
      assert.equal(result.candidate.totals.tests, result.baseline.totals.tests + 1, 'the suite saw b.test.js and nothing in tests/ui/');
      assert.deepEqual(result.broke, []);
      assert.deepEqual(result.pr_tests.files, ['tests/b.test.js', 'tests/ui/fix.test.js']);
      assert.deepEqual(result.pr_tests.red, ['proves the fix']);
    } finally { fx.cleanup(); }
  });

  it('a green one is recorded, with the files named', async () => {
    const fx = repository();
    try {
      ownTest(fx, false);
      const result = await runGate({ repoPath: fx.repo, pr: 400, holder: AREA, root: fx.mcHome, env: fx.env });
      assert.equal(result.stopped_at, null, JSON.stringify(result));
      assert.deepEqual(result.pr_tests.files, ['tests/b.test.js', 'tests/ui/fix.test.js']);
      assert.equal(result.pr_tests.totals.tests, 2);
      assert.deepEqual(result.pr_tests.red, []);
    } finally { fx.cleanup(); }
  });
});
