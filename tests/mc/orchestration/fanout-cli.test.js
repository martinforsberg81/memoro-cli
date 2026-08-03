/**
 * CLI integration tests for `mc fanout` (§10a).
 *
 * Drives the binary as a subprocess to lock in:
 *   - usage / unknown-flag / missing-arg paths exit non-zero with the
 *     human-readable error on stderr (not just --json)
 *   - bad plan slug from filename is rejected before any side effect
 *   - happy path through real git/registry primitives (the unit suite
 *     covers the same path with injected portals — this one verifies
 *     wiring, not classification)
 *
 * Heavy "did the right git op happen" coverage lives in the in-process
 * suite where deps are stubbable. This file is the "is the verb on the
 * dispatcher and does it survive the same scrubbed-env harness as the
 * rest of the lifecycle" sanity belt.
 */
import test, { describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, existsSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runMc } from '../_helpers/cli.js';
import { makeTempRepo } from '../_helpers/git-fixture.js';

describe('mc fanout — CLI surface', () => {
  let repo, pidDir;
  beforeEach(() => {
    repo = makeTempRepo({ name: 'fanout-cli' });
    pidDir = mkdtempSync(join(tmpdir(), 'mc-fanout-pid-'));
  });
  afterEach(() => {
    repo.cleanup();
    try { rmSync(pidDir, { recursive: true, force: true }); } catch {}
  });

  test('missing plan arg → exit 2 + usage on stderr', () => {
    const r = runMc(['fanout'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir, HOME: repo.root },
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /usage|Usage/);
  });

  test('unknown flag → exit 2 + stderr message (non-JSON path)', () => {
    const r = runMc(['fanout', 'plan.md', '--whatever'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir, HOME: repo.root },
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown flag/);
  });

  test('missing plan file → exit 1 + stderr (no --json)', () => {
    const r = runMc(['fanout', 'no-such-plan.md'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir, HOME: repo.root },
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /cannot read plan file/);
  });

  test('bad slug (uppercase filename) → exit 1', () => {
    const planPath = join(repo.dir, 'BadPlan.md');
    writeFileSync(planPath, '## Phase 1: x\nbody\n');
    const r = runMc(['fanout', 'BadPlan.md'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir, HOME: repo.root },
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /plan slug/);
  });

  test('plan with no phases → exit 1, no worktrees created', () => {
    const planPath = join(repo.dir, 'no-phases.md');
    writeFileSync(planPath, '# Intro only\nno phase headings here.\n');
    const r = runMc(['fanout', 'no-phases.md'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir, HOME: repo.root },
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no `## Phase N:` headings/);
  });

  test('--dry-run from a real repo prints expected sessions, touches nothing', () => {
    const planPath = join(repo.dir, 'dry-plan.md');
    writeFileSync(planPath, [
      '# Plan',
      '',
      '## Phase 1: alpha',
      'body a',
      '',
      '## Phase 2: beta',
      'body b',
    ].join('\n'));
    const r = runMc(['fanout', 'dry-plan.md', '--dry-run'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir, HOME: repo.root },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /dry run/);
    assert.match(r.stdout, /fanout-dry-plan-phase-1/);
    assert.match(r.stdout, /fanout-dry-plan-phase-2/);
    assert.match(r.stdout, /fan\/dry-plan\/phase-1/);
    // No registry file written.
    assert.ok(!existsSync(join(repo.mcHome, 'registry.json')) || JSON.parse(readFileSync(join(repo.mcHome, 'registry.json'), 'utf8')).entries.length === 0);
  });

  test('live happy path creates branches + worktrees + briefs + registry entries', () => {
    const planPath = join(repo.dir, 'live-plan.md');
    writeFileSync(planPath, [
      '# Plan',
      '',
      '## Phase 1: alpha',
      'do alpha',
      '',
      '## Phase 2: beta',
      'do beta',
    ].join('\n'));
    const r = runMc(['fanout', 'live-plan.md', '--from', 'main', '--json'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir, HOME: repo.root },
    });
    assert.equal(r.status, 0, r.stderr);
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.phase_count, 2);

    // Registry has fanout-phase entries.
    const reg = JSON.parse(readFileSync(join(repo.mcHome, 'registry.json'), 'utf8'));
    assert.equal(reg.entries.length, 2);
    for (const e of reg.entries) {
      assert.equal(e.kind, 'fanout-phase');
      assert.equal(e.parent_plan, 'live-plan');
      // Brief artefact was written into the worktree.
      const briefPath = join(e.worktree_path, '.mc', 'brief.md');
      assert.ok(existsSync(briefPath), `brief missing at ${briefPath}`);
      const brief = readFileSync(briefPath, 'utf8');
      assert.match(brief, /live-plan/);
    }
  });
});

describe('mc gather — CLI surface', () => {
  let repo, pidDir;
  beforeEach(() => {
    repo = makeTempRepo({ name: 'gather-cli' });
    pidDir = mkdtempSync(join(tmpdir(), 'mc-gather-pid-'));
  });
  afterEach(() => {
    repo.cleanup();
    try { rmSync(pidDir, { recursive: true, force: true }); } catch {}
  });

  test('missing slug → exit 2 + usage', () => {
    const r = runMc(['gather'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir, HOME: repo.root },
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /usage|Usage/);
  });

  test('bad slug (uppercase) → exit 2 + stderr', () => {
    const r = runMc(['gather', 'BadPlan'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir, HOME: repo.root },
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /invalid plan-slug/);
  });

  test('unknown flag → exit 2', () => {
    const r = runMc(['gather', 'p', '--whatever'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir, HOME: repo.root },
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown flag/);
  });

  test('missing typed GitHub portal fails closed before PR discovery', () => {
    const r = runMc(['gather', 'someplan'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir, HOME: repo.root },
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Memoro GitHub App capability is required for gather/);
  });
});
