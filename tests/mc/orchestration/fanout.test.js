/**
 * In-process tests for `mc fanout` (§10a).
 *
 * Exercises the impure core (`runWithDeps`) through injected portals
 * so no real git / filesystem / registry is touched in the unit path.
 * The CLI subprocess test below covers wiring + error surface.
 *
 * Covers:
 *   - happy path: spawns one entry per phase, with the documented
 *     branch + worktree shape + brief artefact
 *   - dry-run: prints what would spawn, touches no portal mutators
 *   - missing plan file → error on stderr + exit 1 (non-JSON path too)
 *   - bad plan slug (uppercase / underscore) → error
 *   - plan with no phase headings → error
 *   - branch / session collision → exit-before-side-effect
 *   - rollback: addWorktree fails → branch is best-effort deleted
 */
import test, { describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runWithDeps } from '../../../src/mc/commands/fanout.js';
import { writeRegistry as fixtureWriteRegistry } from '../_helpers/registry-fixture.js';

// ─── helpers ───────────────────────────────────────────────────────────────

function withTempHome() {
  const dir = mkdtempSync(join(tmpdir(), 'fanout-test-'));
  process.env.MC_HOME = dir;
  return { dir, cleanup() { try { rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

function makeFakeGit({
  inside = true,
  primary = '/repo/primary',
  existingBranches = new Set(),
  addWorktreeFails = false,
} = {}) {
  const calls = { createBranch: [], addWorktree: [], deleteBranch: [] };
  return {
    calls,
    isInsideRepo: () => inside,
    primaryWorktree: () => primary,
    branchExists: (_repo, b) => existingBranches.has(b),
    createBranch(repo, branch, fromRef) {
      calls.createBranch.push({ repo, branch, fromRef });
      existingBranches.add(branch);
    },
    addWorktree(repo, wt, branch) {
      calls.addWorktree.push({ repo, wt, branch });
      if (addWorktreeFails) throw new Error('mock-worktree-fail');
      mkdirSync(wt, { recursive: true });
    },
    deleteBranch(repo, branch) {
      calls.deleteBranch.push({ repo, branch });
      existingBranches.delete(branch);
    },
  };
}

function makeFakeFs(planText) {
  const calls = { writeBrief: [] };
  return {
    calls,
    readPlanFile: (path) => {
      if (typeof planText === 'function') return planText(path);
      return planText;
    },
    writeBrief: (worktreeDir, brief) => {
      calls.writeBrief.push({ worktreeDir, brief });
      mkdirSync(join(worktreeDir, '.mc'), { recursive: true });
      writeFileSync(join(worktreeDir, '.mc', 'brief.md'), brief);
    },
  };
}

// Capture console output without leaking to test runner.
function captureConsole(fn) {
  const stdout = [], stderr = [];
  const origLog = console.log, origErr = console.error;
  const origWrite = process.stdout.write.bind(process.stdout);
  const origErrWrite = process.stderr.write.bind(process.stderr);
  console.log = (...a) => stdout.push(a.join(' '));
  console.error = (...a) => stderr.push(a.join(' '));
  process.stdout.write = (s) => { stdout.push(typeof s === 'string' ? s : s.toString()); return true; };
  process.stderr.write = (s) => { stderr.push(typeof s === 'string' ? s : s.toString()); return true; };
  return fn().finally(() => {
    console.log = origLog;
    console.error = origErr;
    process.stdout.write = origWrite;
    process.stderr.write = origErrWrite;
  }).then((status) => ({ status, stdout: stdout.join('\n'), stderr: stderr.join('\n') }));
}

// ─── tests ─────────────────────────────────────────────────────────────────

describe('mc fanout — happy path', () => {
  let home;
  beforeEach(() => { home = withTempHome(); fixtureWriteRegistry(home.dir, []); });
  afterEach(() => { home.cleanup(); delete process.env.MC_HOME; });

  test('spawns one entry per phase with documented branch + brief shape', async () => {
    const plan = [
      '# Plan',
      'Intro paragraph.',
      '',
      '## Phase 1: Parse',
      'Parse stuff.',
      '',
      '## Phase 2: Render',
      'Render stuff.',
    ].join('\n');
    const planPath = join(home.dir, 'cool-plan.md');
    writeFileSync(planPath, plan);

    const git = makeFakeGit({ primary: home.dir });
    const fs = makeFakeFs(plan);
    const { status, stdout } = await captureConsole(() =>
      runWithDeps(
        { planPath, from: 'main', dryRun: false, json: true },
        { git, fs, cwd: home.dir },
      ),
    );
    assert.equal(status, 0, stdout);

    const payload = JSON.parse(stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.plan_slug, 'cool-plan');
    assert.equal(payload.from, 'main');
    assert.equal(payload.phase_count, 2);
    assert.deepEqual(payload.phases.map((p) => p.phaseN), [1, 2]);
    assert.deepEqual(payload.phases.map((p) => p.branch), [
      'fan/cool-plan/phase-1',
      'fan/cool-plan/phase-2',
    ]);
    assert.deepEqual(payload.phases.map((p) => p.session_name), [
      'fanout-cool-plan-phase-1',
      'fanout-cool-plan-phase-2',
    ]);

    // Brief artefacts were written.
    assert.equal(fs.calls.writeBrief.length, 2);
    for (const c of fs.calls.writeBrief) {
      const briefPath = join(c.worktreeDir, '.mc', 'brief.md');
      assert.ok(existsSync(briefPath), `brief missing at ${briefPath}`);
      const content = readFileSync(briefPath, 'utf8');
      assert.match(content, /cool-plan/);
    }

    // Branch + worktree calls happened in phase order.
    assert.equal(git.calls.createBranch.length, 2);
    assert.equal(git.calls.addWorktree.length, 2);
    assert.equal(git.calls.createBranch[0].branch, 'fan/cool-plan/phase-1');
    assert.equal(git.calls.createBranch[0].fromRef, 'main');

    // Registry entries landed.
    const reg = JSON.parse(readFileSync(join(home.dir, 'registry.json'), 'utf8'));
    assert.equal(reg.entries.length, 2);
    assert.equal(reg.entries[0].kind, 'fanout-phase');
    assert.equal(reg.entries[0].parent_plan, 'cool-plan');
    assert.equal(reg.entries[0].phase_n, 1);
    assert.equal(reg.entries[0].from_ref, 'main');
  });

  test('--dry-run touches no portal mutators', async () => {
    const plan = '## Phase 1: x\nbody\n## Phase 2: y\nbody2\n';
    const planPath = join(home.dir, 'dry.md');
    writeFileSync(planPath, plan);

    const git = makeFakeGit({ primary: home.dir });
    const fs = makeFakeFs(plan);
    const { status, stdout } = await captureConsole(() =>
      runWithDeps(
        { planPath, from: 'main', dryRun: true, json: true },
        { git, fs, cwd: home.dir },
      ),
    );
    assert.equal(status, 0, stdout);
    const payload = JSON.parse(stdout);
    assert.equal(payload.dry_run, true);
    assert.equal(payload.phase_count, 2);
    assert.equal(git.calls.createBranch.length, 0);
    assert.equal(git.calls.addWorktree.length, 0);
    assert.equal(fs.calls.writeBrief.length, 0);
  });

  test('non-JSON dry-run lists phase + branch + worktree on stdout', async () => {
    const plan = '## Phase 1: x\nbody\n';
    const planPath = join(home.dir, 'plain.md');
    writeFileSync(planPath, plan);
    const git = makeFakeGit({ primary: home.dir });
    const fs = makeFakeFs(plan);
    const { status, stdout } = await captureConsole(() =>
      runWithDeps(
        { planPath, from: 'main', dryRun: true, json: false },
        { git, fs, cwd: home.dir },
      ),
    );
    assert.equal(status, 0);
    assert.match(stdout, /dry run/);
    assert.match(stdout, /fan\/plain\/phase-1/);
  });
});

describe('mc fanout — error surface (non-JSON path also tested)', () => {
  let home;
  beforeEach(() => { home = withTempHome(); fixtureWriteRegistry(home.dir, []); });
  afterEach(() => { home.cleanup(); delete process.env.MC_HOME; });

  test('missing plan file → exit 1 + stderr (human-readable path)', async () => {
    const planPath = join(home.dir, 'missing.md');
    const git = makeFakeGit({ primary: home.dir });
    const fs = makeFakeFs(() => { throw new Error('ENOENT'); });
    const { status, stderr } = await captureConsole(() =>
      runWithDeps(
        { planPath, from: 'main', dryRun: false, json: false },
        { git, fs, cwd: home.dir },
      ),
    );
    assert.equal(status, 1);
    assert.match(stderr, /cannot read plan file/);
  });

  test('missing plan file → also surfaces in --json with ok:false', async () => {
    const planPath = join(home.dir, 'missing.md');
    const git = makeFakeGit({ primary: home.dir });
    const fs = makeFakeFs(() => { throw new Error('ENOENT'); });
    const { status, stdout } = await captureConsole(() =>
      runWithDeps(
        { planPath, from: 'main', dryRun: false, json: true },
        { git, fs, cwd: home.dir },
      ),
    );
    assert.equal(status, 1);
    const payload = JSON.parse(stdout);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /cannot read plan file/);
  });

  test('bad filename slug → error before any portal call', async () => {
    const planPath = join(home.dir, 'Bad_Plan.md');
    writeFileSync(planPath, '## Phase 1: x\nbody\n');
    const git = makeFakeGit({ primary: home.dir });
    const fs = makeFakeFs('## Phase 1: x\nbody\n');
    const { status, stderr } = await captureConsole(() =>
      runWithDeps(
        { planPath, from: 'main', dryRun: false, json: false },
        { git, fs, cwd: home.dir },
      ),
    );
    assert.equal(status, 1);
    assert.match(stderr, /plan slug/);
    assert.equal(git.calls.createBranch.length, 0);
  });

  test('plan with no phases → error', async () => {
    const planPath = join(home.dir, 'empty-plan.md');
    writeFileSync(planPath, '# Just intro\nno phase headings.\n');
    const git = makeFakeGit({ primary: home.dir });
    const fs = makeFakeFs('# Just intro\nno phase headings.\n');
    const { status, stderr } = await captureConsole(() =>
      runWithDeps(
        { planPath, from: 'main', dryRun: false, json: false },
        { git, fs, cwd: home.dir },
      ),
    );
    assert.equal(status, 1);
    assert.match(stderr, /no `## Phase N:` headings/);
  });

  test('not inside a git repo → error before phase parse', async () => {
    const planPath = join(home.dir, 'plan.md');
    writeFileSync(planPath, '## Phase 1: x\nbody\n');
    const git = makeFakeGit({ inside: false, primary: home.dir });
    const fs = makeFakeFs('## Phase 1: x\nbody\n');
    const { status, stderr } = await captureConsole(() =>
      runWithDeps(
        { planPath, from: 'main', dryRun: false, json: false },
        { git, fs, cwd: home.dir },
      ),
    );
    assert.equal(status, 1);
    assert.match(stderr, /not inside a git repository/);
  });

  test('branch collision → exit-before-side-effect (no branch created)', async () => {
    const planPath = join(home.dir, 'plan.md');
    writeFileSync(planPath, '## Phase 1: x\nbody\n');
    const git = makeFakeGit({
      primary: home.dir,
      existingBranches: new Set(['fan/plan/phase-1']),
    });
    const fs = makeFakeFs('## Phase 1: x\nbody\n');
    const { status, stderr } = await captureConsole(() =>
      runWithDeps(
        { planPath, from: 'main', dryRun: false, json: false },
        { git, fs, cwd: home.dir },
      ),
    );
    assert.equal(status, 1);
    assert.match(stderr, /branch "fan\/plan\/phase-1" already exists/);
    assert.equal(git.calls.createBranch.length, 0);
    assert.equal(fs.calls.writeBrief.length, 0);
  });

  test('session-name collision → rejected before any branch created', async () => {
    const planPath = join(home.dir, 'plan.md');
    writeFileSync(planPath, '## Phase 1: x\nbody\n');
    // Pre-seed registry with the colliding session name.
    fixtureWriteRegistry(home.dir, [{ name: 'fanout-plan-phase-1', branch: 'sess/old' }]);
    const git = makeFakeGit({ primary: home.dir });
    const fs = makeFakeFs('## Phase 1: x\nbody\n');
    const { status, stderr } = await captureConsole(() =>
      runWithDeps(
        { planPath, from: 'main', dryRun: false, json: false },
        { git, fs, cwd: home.dir },
      ),
    );
    assert.equal(status, 1);
    assert.match(stderr, /registry already has a session/);
    assert.equal(git.calls.createBranch.length, 0);
  });

  test('addWorktree failure rolls back the branch (best-effort)', async () => {
    const planPath = join(home.dir, 'plan.md');
    writeFileSync(planPath, '## Phase 1: x\nbody\n');
    const git = makeFakeGit({ primary: home.dir, addWorktreeFails: true });
    const fs = makeFakeFs('## Phase 1: x\nbody\n');
    const { status, stderr } = await captureConsole(() =>
      runWithDeps(
        { planPath, from: 'main', dryRun: false, json: false },
        { git, fs, cwd: home.dir },
      ),
    );
    assert.equal(status, 1);
    assert.match(stderr, /failed to add worktree/);
    // Branch was created, then deleted as rollback.
    assert.equal(git.calls.createBranch.length, 1);
    assert.equal(git.calls.deleteBranch.length, 1);
    assert.equal(git.calls.deleteBranch[0].branch, 'fan/plan/phase-1');
  });
});
