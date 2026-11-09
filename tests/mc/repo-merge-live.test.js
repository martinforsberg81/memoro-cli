/**
 * The application merge round with modelled git and real child suites.
 *
 * The forge is a shell script: its git commands also reach the model. Refs,
 * content and lease decisions are asserted against modelled answers, never
 * presented as proof of git's squash, conflict or lease semantics. The
 * ordinary gate remains modelled (decided 2026-11-01). The commissioned
 * standing-checkout proof also runs the bounded green/prepare cases from this
 * same file without the harness, with isolated HOME, MC_HOME and MC_WORK_ROOT,
 * against local real Git; that independent evidence belongs in the goal log.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, watch, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { fakeGitModel } from '../_fake-git-default.mjs';
import { measurementCheckoutPath } from '../../src/mc/measurement-checkout.js';
import { runGate } from '../../src/mc/repo-gate.js';
import { readLease } from '../../src/mc/repo-lease.js';
import { runMergeRound } from '../../src/mc/repo-merge.js';
import { runningRound } from '../../src/mc/gate-lock.js';

// This fixture now issues reset --hard during checkout healing. The shared
// model has no reset verb yet: extend only this fixture's installed instance,
// using its existing tracked-tree checkout mechanism, without changing the
// shared harness. Without the harness (the independent real-Git run) no model
// is installed and every reset reaches Git itself.
const model = fakeGitModel();
if (model) {
  model.cmd_reset = function ({ dir, gitDir, argv }) {
    assert.deepEqual(argv, ['--hard'], 'only the commissioned reset is modelled here');
    const { repo, worktree, state } = this.worktreeOf(dir, gitDir);
    this.checkout(repo, state, worktree, this.headSha(repo, state));
    return '';
  };
}

const AREA = { name: 'klient-guard', kind: 'work-area' };
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' });

/**
 * `gh`, as a script: reads a pull request from a file, and performs the squash
 * as the git commands the forge would run, in the bare origin itself — the
 * merged tree, one commit on main's tip, and main moved to it only if it is
 * still where the squash started. One file per process, reached from every
 * fixture by a symlink: macOS checks a fresh executable on its first run, and
 * that check cost 250–400 ms per fixture. The fixture is the directory above
 * the link's own.
 */
const STUBS = mkdtempSync(join(tmpdir(), 'mc-merge-live-gh-'));
const GH = join(STUBS, 'gh');
writeFileSync(GH, [
  '#!/bin/sh',
  'root="$(cd "$(dirname "$0")/.." && pwd)"',
  'printf \'%s\\n\' "$*" >> "$root/gh-calls.log"',
  'if [ "$1" = "pr" ] && [ "$2" = "view" ]; then cat "$root/pr.json"; exit 0; fi',
  'if [ "$1" = "pr" ] && [ "$2" = "merge" ]; then',
  '  bare="$root/origin.git"',
  '  base="$(git --git-dir="$bare" rev-parse refs/heads/main)" || exit 1',
  '  tree="$(git --git-dir="$bare" merge-tree --write-tree "$base" refs/heads/feature)" || exit 1',
  '  commit="$(GIT_AUTHOR_NAME=forge GIT_AUTHOR_EMAIL=forge@example.invalid GIT_COMMITTER_NAME=forge GIT_COMMITTER_EMAIL=forge@example.invalid \\',
  '    git --git-dir="$bare" commit-tree "$tree" -p "$base" -m "Add the change (#400)")" || exit 1',
  '  git --git-dir="$bare" update-ref refs/heads/main "$commit" "$base" || exit 1',
  '  exit 0',
  'fi',
  'exit 1',
].join('\n'));
chmodSync(GH, 0o755);
// The first run pays macOS's check, here, from a fixture of its own.
mkdirSync(join(STUBS, 'warm', 'bin'), { recursive: true });
symlinkSync(GH, join(STUBS, 'warm', 'bin', 'gh'));
try { execFileSync(join(STUBS, 'warm', 'bin', 'gh'), ['warm'], { stdio: 'ignore' }); } catch { /* exits 1: an unknown verb */ }

const templates = [STUBS];
after(() => { for (const dir of templates) rmSync(dir, { recursive: true, force: true }); });

/**
 * A repository with an origin, a main, and a branch with a change on it.
 *
 * `standingRed` puts a test on main that has always failed. It used to be the
 * default here, because the round was differential and a standing red name was
 * the interesting case; since 2026-08-31 it is the case where nothing lands
 * until somebody repairs it, which is asserted below rather than assumed.
 *
 * `hangingBranch` adds a test that never settles, and that first touches the
 * file `$MC_TEST_HANG_FLAG` names, so a test can tell when the round reached it.
 *
 * Each test builds its own small model history (`repository`).
 */
function build({ branchBreaksSuite = false, standingRed = false, hangingBranch = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mc-merge-live-'));
  templates.push(root);
  const repo = join(root, 'repo');
  const bare = join(root, 'origin.git');
  mkdirSync(repo, { recursive: true });
  mkdirSync(join(root, 'home'), { recursive: true, mode: 0o700 });

  git(root, ['init', '-q', '--bare', bare]);
  git(root, ['clone', '-q', bare, repo]);
  git(repo, ['config', 'user.email', 'test@example.invalid']);
  git(repo, ['config', 'user.name', 'mc-test']);

  // A repository whose `npm test` is a real node test run, small enough to run
  // twice per round without the suite being the thing under test — in one
  // process, since a process per file is the suite's cost and not the round's.
  writeFileSync(join(repo, 'package.json'), `${JSON.stringify({
    name: 'gated', version: '1.0.0', type: 'module', scripts: { test: "node --test --test-isolation=none 'tests/*.test.js'" },
  }, null, 2)}\n`);
  mkdirSync(join(repo, 'tests'), { recursive: true });
  writeFileSync(join(repo, 'tests', 'a.test.js'), [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "test('always green', () => { assert.equal(1, 1); });",
    ...(standingRed ? ["test('long red', () => { assert.equal(1, 2); });"] : []),
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
    ...(hangingBranch ? ["import { writeFileSync } from 'node:fs';"] : []),
    ...(!hangingBranch ? [`test('the change', () => { assert.equal(1, ${branchBreaksSuite ? 2 : 1}); });`] : []),
    ...(hangingBranch ? ["test('never settles', async () => { writeFileSync(process.env.MC_TEST_HANG_FLAG, ''); await new Promise(() => { setInterval(() => {}, 1000); }); });"] : []),
    '',
  ].join('\n'));
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'Add the change']);
  git(repo, ['push', '-q', 'origin', 'feature']);
  const head = git(repo, ['rev-parse', 'HEAD']).trim();

  writeFileSync(join(root, 'pr.json'), JSON.stringify({
    number: 400, headRefName: 'feature', baseRefName: 'main', headRefOid: head, state: 'OPEN', title: 'the change',
  }));
  mkdirSync(join(root, 'bin'));
  symlinkSync(GH, join(root, 'bin', 'gh'));
  return { root, head };
}

/** This test's own origin, checkout, home and forge. */
function repository(options = {}) {
  const { root, head } = build(options);
  chmodSync(join(root, 'home'), 0o700);
  const repo = join(root, 'repo');
  const bare = join(root, 'origin.git');
  const mcHome = join(root, 'home');
  const bin = join(root, 'bin');
  return {
    root,
    repo,
    bare,
    mcHome,
    head,
    logPath: join(root, 'merge-log.md'),
    hangFlag: join(root, 'hang-flag'),
    mainAt: () => git(root, ['--git-dir', bare, 'rev-parse', 'refs/heads/main']).trim(),
    subjectsOnMain: () => git(root, ['--git-dir', bare, 'log', '--oneline', '-5', 'refs/heads/main']).trim().split('\n'),
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, MC_WORK_ROOT: join(root, 'work'), MC_TEST_HANG_FLAG: join(root, 'hang-flag', 'started') },
    lease: () => readLease(repo, { root: mcHome }),
    cleanup() { try { rmSync(root, { recursive: true, force: true }); } catch { /* gone */ } },
  };
}

/** The fixture clock reaches a no-progress stall as soon as the child starts. */
function stallAtTheStuckChild() {
  let now = Date.now();
  let poll;
  const state = { ceilingMs: null, stallMs: null, firedAt: null };
  return {
    state, clock: () => now,
    armCeiling: (_fire, ms) => { state.ceilingMs = ms; return () => {}; },
    armStall: (fire, ms) => { poll = fire; state.stallMs = ms; return () => {}; },
    reached: () => setImmediate(() => {
      state.firedAt = Date.now();
      poll();
      now += state.stallMs;
      poll();
    }),
  };
}

describe('the merge round, with modelled git', () => {
  it('a no-progress stall kills a hanging test and releases its lane without landing', async () => {
    const fx = repository({ hangingBranch: true });
    writeFileSync(fx.logPath, '| Datum | PR | Kontroller | Klass | Beslut | Anteckning |\n|---|---|---|---|---|---|\n');
    writeFileSync(join(fx.mcHome, 'repo-gates.json'), JSON.stringify({ repo: {
      prepare: null, prepare_why: 'the fixture has no dependencies',
      select: `node -e 'console.log(${JSON.stringify(JSON.stringify({ files: ['tests/b.test.js'], commands: [] }))})'`,
      select_why: 'the fixture selects the hanging branch test', extra_gates: [], merge_log: null,
      round_timeout_ms: 5_000, round_timeout_why: 'short timeout fixture', pr_tests_flags: ['--test-timeout=30000'],
    } }));
    const stall = stallAtTheStuckChild();
    mkdirSync(fx.hangFlag);
    const watcher = watch(fx.hangFlag, () => { if (existsSync(join(fx.hangFlag, 'started'))) stall.reached(); });
    try {
      const report = await runMergeRound({
        repoPath: fx.repo, pr: 400, holder: AREA, root: fx.mcHome, env: fx.env, mergeLog: fx.logPath,
        gate: (options) => runGate({ ...options, armCeiling: stall.armCeiling, armStall: stall.armStall, clock: stall.clock }),
      });
      assert.equal(stall.state.ceilingMs, 5_000, 'the ceiling armed is the one the repository declares');
      assert.ok(stall.state.firedAt, 'the round ended before its hanging test was reached');
      const took = Date.now() - stall.state.firedAt;
      assert.ok(took < 3_000, `the round took ${took} ms past its stall`);
      assert.equal(report.ok, false);
      assert.equal(report.stopped_at, 'stalled');
      assert.match(report.reason, /no progress.*tests\/b\.test\.js/u);
      assert.equal(report.merged, false, JSON.stringify(report));
      assert.deepEqual(report.gate.stalled_files, ['tests/b.test.js'], 'the gate verdict handed to the round log names the file');
      assert.equal(runningRound({ root: fx.mcHome, lane: 'repo' }), null, 'the next job can claim the released lane');
      assert.equal(fx.mainAt(), git(fx.repo, ['rev-parse', 'refs/remotes/origin/main']).trim(), 'a red round does not land');
    } finally { watcher.close(); fx.cleanup(); }
  });

  it('measures in the standing checkout without moving the session branch and squash-merges onto main', async (t) => {
    const fx = repository();
    writeFileSync(fx.logPath, '| Datum | PR | Kontroller | Klass | Beslut | Anteckning |\n|---|---|---|---|---|---|\n');
    try {
      const before = fx.mainAt();
      const branchBefore = git(fx.repo, ['branch', '--show-current']).trim();
      const headBefore = git(fx.repo, ['rev-parse', 'HEAD']).trim();
      assert.equal(branchBefore, 'feature');
      assert.equal(headBefore, fx.head);
      const measuredIn = [];
      const report = await runMergeRound({
        onProgress: (line) => measuredIn.push(line),
        repoPath: fx.repo,
        pr: 400,
        holder: AREA,
        root: fx.mcHome,
        env: fx.env,
        mergeLog: fx.logPath,
      });

      assert.equal(report.ok, true, report.reason || '');
      assert.equal(report.merged, true);

      // The suite really ran, once, in the candidate worktree.
      assert.equal(report.gate.candidate.totals.finished, true);
      assert.deepEqual(report.gate.candidate.red, [], 'nothing this change reaches is red');
      assert.equal(report.gate.candidate.totals.tests, 2, 'both test files ran');

      const candidate = measurementCheckoutPath(fx.repo, fx.env.MC_WORK_ROOT);
      assert.ok(measuredIn.some(line => line.includes(`measurement checkout ${candidate}`)), measuredIn.join('\n'));
      assert.equal(git(candidate, ['branch', '--show-current']).trim(), '', 'measurement stays detached');
      assert.equal(git(candidate, ['rev-parse', 'HEAD^{tree}']).trim(), report.gate.candidate.tree);
      assert.equal(git(fx.repo, ['rev-parse', 'HEAD']).trim(), headBefore, 'session HEAD unchanged');
      assert.equal(git(fx.repo, ['branch', '--show-current']).trim(), branchBefore, 'session branch unchanged');
      t.diagnostic(`measurement checkout ${candidate}; session ${branchBefore} at ${headBefore} unchanged; measured tree ${report.gate.candidate.tree}`);

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
      assert.ok(report.gate.candidate.red.length > 0, 'the gate should have named what broke');
      assert.equal(fx.mainAt(), before, 'main moved on a red gate');
      assert.equal(fx.lease().held, false);
    } finally { fx.cleanup(); }
  });

  /**
   * The 2026-08-31 ruling, against modelled git and a real suite: a test that has
   * always been red on main is red here, and the change cannot land until it
   * is green. The differential round merged this happily, and paid a second
   * worktree and a second suite run every time to be able to.
   */
  it('a test that was already red on main stops the round, and nothing lands', async () => {
    const fx = repository({ standingRed: true });
    try {
      const before = fx.mainAt();
      const report = await runMergeRound({
        repoPath: fx.repo, pr: 400, holder: AREA, root: fx.mcHome, env: fx.env, mergeLog: null,
      });

      assert.equal(report.ok, false);
      assert.equal(report.stopped_at, 'red');
      assert.deepEqual(report.gate.candidate.red, ['long red'], 'the round names the test, not a count');
      assert.match(report.gate.reason, /1 test red: long red/u);
      assert.equal(report.merged, false);
      assert.equal(fx.mainAt(), before);
    } finally { fx.cleanup(); }
  });

  it('a base that moved over this change’s own files stops the round', async () => {
    // Somebody merges by hand mid-round, into a file the candidate also
    // changes. The merged tree is then one neither side measured, and the
    // round has to notice before acting on a verdict about it.
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
          // The same file the candidate adds — this is the overlap.
          mkdirSync(join(side, 'tests'), { recursive: true });
          writeFileSync(join(side, 'tests', 'b.test.js'), '// somebody else got here first\n');
          git(side, ['add', '-A']);
          git(side, ['commit', '-q', '-m', 'Something else']);
          git(side, ['push', '-q', 'origin', 'main']);
          return verdict;
        },
      });

      assert.equal(report.ok, false);
      assert.equal(report.stopped_at, 'drift');
      assert.match(report.reason, /tests\/b\.test\.js/u);
      assert.equal(report.merged, false);
      // Main carries the other person's commit and not ours.
      assert.notEqual(fx.mainAt(), before);
      assert.match(fx.subjectsOnMain()[0], /Something else/u);
      assert.doesNotMatch(fx.subjectsOnMain().join('\n'), /#400/u);
      assert.equal(fx.lease().held, false);
    } finally { fx.cleanup(); }
  });

  it('a base that only moved forward, elsewhere in the tree, is merged onto', async () => {
    // The eight `drift` rounds in gate-rounds.jsonl on 2026-08-29 were all
    // this shape, and all eight threw away a measurement that still held: one
    // squash landing on main, elsewhere, while a 4-to-101-minute gate ran.
    const fx = repository();
    try {
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

      assert.equal(report.ok, true, report.reason || '');
      assert.equal(report.merged, true);
      assert.equal(report.stopped_at, null);
      // Both landed: theirs, then ours on top of it.
      const subjects = fx.subjectsOnMain().join('\n');
      assert.match(subjects, /#400/u);
      assert.match(subjects, /Something else/u);
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

  it('runs the declared prepare step in the one worktree before the suite', async () => {
    const fx = repository();
    try {
      // A prepare that leaves a trace, so "did it run, and where" is a question
      // about the file system rather than about a mock.
      fx.env.MC_TEST_PREPARED = join(fx.root, 'prepared-in');
      const prepare = 'pwd > "$MC_TEST_PREPARED"';
      declare(fx, { prepare, extra_gates: [], merge_log: null });
      const report = await runMergeRound({
        repoPath: fx.repo, pr: 400, holder: AREA, root: fx.mcHome, env: fx.env, mergeLog: null,
      });
      assert.equal(report.ok, true, report.reason || '');
      assert.equal(report.gate.declaration.prepare, prepare);
      assert.equal(readFileSync(fx.env.MC_TEST_PREPARED, 'utf8').trim(), realpathSync(measurementCheckoutPath(fx.repo, fx.env.MC_WORK_ROOT)));
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
      declare(fx, {
        prepare: null,
        extra_gates: [{ name: 'contract', command: 'exit 1' }],
        merge_log: null,
      });
      const before = fx.mainAt();
      const report = await runMergeRound({
        repoPath: fx.repo, pr: 400, holder: AREA, root: fx.mcHome, env: fx.env, mergeLog: null,
      });
      assert.equal(report.ok, false);
      assert.equal(report.gate.stopped_at, 'extra-gate');
      assert.match(report.gate.reason, /^contract failed \(exit 1\)/u);
      // The suite really did pass — this is the gate beyond it doing the work.
      assert.deepEqual(report.gate.candidate.red, []);
      assert.equal(report.merged, false);
      assert.equal(fx.mainAt(), before);
    } finally { fx.cleanup(); }
  });

  /**
   * D-0138 ran the gate on both sides so a gate red on main could be reported
   * as main's fault rather than the pull request's. The baseline is gone, so
   * that distinction is gone with it — deliberately, by the same ruling that
   * took it off the suite. A declared gate red on main is red here.
   */
  it('a gate that is red on main is red here, with no side to blame it on', async () => {
    const fx = repository();
    try {
      declare(fx, { prepare: null, extra_gates: [{ name: 'contract', command: 'exit 1' }], merge_log: null });
      const report = await runMergeRound({
        repoPath: fx.repo, pr: 400, holder: AREA, root: fx.mcHome, env: fx.env, mergeLog: null,
      });
      assert.equal(report.gate.stopped_at, 'extra-gate');
      assert.notEqual(report.gate.stopped_at, 'extra-gate-baseline');
      assert.equal(report.merged, false);
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
      assert.deepEqual(report.gate.extra_gates, [{
        // Which kind of gate this is: one an operator declared beside the
        // suite, as opposed to one the repository's selector chose for this
        // diff. Both live in this list; the field is what tells them apart.
        source: 'declaration',
        name: 'contract',
        command: 'true',
        ok: true,
        exit_code: 0,
        ran: true,
        red: null,
        output: null,
      }]);
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
    const pr = JSON.parse(readFileSync(join(fx.root, 'pr.json'), 'utf8'));
    writeFileSync(join(fx.root, 'pr.json'), JSON.stringify({ ...pr, headRefOid: head }));
  };

  it('a red test the suite never globbed stops the round — the hole #10803 fell through', async () => {
    const fx = repository();
    try {
      ownTest(fx, true);
      const result = await runGate({ repoPath: fx.repo, pr: 400, holder: AREA, root: fx.mcHome, env: fx.env });
      assert.equal(result.stopped_at, 'pr-tests', JSON.stringify(result));
      assert.equal(result.candidate.totals.tests, 2, 'the suite saw a.test.js and b.test.js, and nothing in tests/ui/');
      assert.deepEqual(result.candidate.red, []);
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
