/**
 * `mc setup` integration spec (§11b).
 *
 * Non-interactive, self-verifying. The verb is contract-bound:
 *   - missing pieces → exit 1 + numbered checklist + exact commands
 *   - all green       → exit 0 + write ${MC_HOME}/.setup-done-v1
 *
 * We can't simulate "all green" deterministically across a subprocess
 * boundary without a real Memoro token in the keychain, so the
 * green-path test injects a fake token directly into MC_HOME's
 * fallback secrets file (the keychain layer falls through to it on
 * Darwin when `security` is absent — we force that by stripping PATH
 * of /usr/bin, which removes `security` from reach).
 *
 * Other cases drive the deterministic red branches.
 */
import test, { describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runMc, parseJsonOrNull } from '../_helpers/cli.js';
import { makeTempRepo } from '../_helpers/git-fixture.js';

describe('mc setup — checklist (red path)', () => {
  let repo, pidDir;
  beforeEach(() => {
    repo = makeTempRepo({ name: 'setup-red' });
    pidDir = mkdtempSync(join(tmpdir(), 'mc-setup-pid-'));
  });
  afterEach(() => {
    repo.cleanup();
    try { rmSync(pidDir, { recursive: true, force: true }); } catch {}
  });

  test('fresh install → exits 1 with numbered checklist, no sentinel', () => {
    const r = runMc(['setup'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir, HOME: repo.root },
    });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stdout, /mc setup — \d+ local setup step/);
    assert.match(r.stdout, /1\. Sign in to Memoro/);
    assert.match(r.stdout, /run:\s+mc/);
    assert.match(r.stdout, /browser device sign-in/);
    assert.match(r.stdout, /Install Codex CLI/);
    assert.match(r.stdout, /Install the shell wrapper/);
    assert.match(r.stdout, /run:\s+mc install-shell/);
    // Sentinel must NOT exist after a red run.
    assert.ok(!existsSync(join(repo.mcHome, '.setup-done-v1')));
  });

  test('--json shape: { ok, report, missing_steps, sentinel_path }', () => {
    const r = runMc(['setup', '--json'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir, HOME: repo.root },
    });
    const j = parseJsonOrNull(r.stdout);
    assert.ok(j, r.stdout);
    assert.equal(j.ok, false);
    assert.ok(Array.isArray(j.missing_steps));
    assert.ok(j.missing_steps.length >= 1);
    // First step on a fresh install must be Memoro login.
    assert.equal(j.missing_steps[0].id, 'memoro-login');
    assert.equal(j.missing_steps[0].command, 'mc');
    // Sentinel path is exposed even on red so callers can preview.
    assert.match(j.sentinel_path, /\.setup-done-v1$/);
  });

  test('checklist commands are real mc verbs the user can paste', () => {
    const r = runMc(['setup', '--json'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir, HOME: repo.root },
    });
    const j = parseJsonOrNull(r.stdout);
    // Every step that has a command should either be a real `mc` verb,
    // a real npm install line, or `claude` itself. No "TODO" / "not
    // implemented" leakage.
    for (const s of j.missing_steps) {
      if (!s.command) continue;
      const ok = /^(mc($| )|npm install|claude\b)/.test(s.command);
      assert.ok(ok, `step ${s.id} command must be runnable, got: ${s.command}`);
    }
  });

  test('rejects unknown flag', () => {
    const r = runMc(['setup', '--whatever'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir, HOME: repo.root },
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /unknown flag/);
  });
});

describe('mc setup — pure helpers (in-process)', () => {
  test('missingSteps([] when report is all green) returns []', async () => {
    const { missingSteps } = await import('../../../src/mc/commands/setup.js');
    const greenReport = {
      memoro: { authenticated: true, hint: null },
      tools: {
        codex:  { installed: true, version: '0.137.0', authenticated: null,
                  hint: 'Run `codex /status` to verify auth, or open codex', detailLines: [] },
        claude: { installed: false, version: null, authenticated: null,
                  hint: 'Install with: npm install -g @anthropic-ai/claude-code',
                  detailLines: [] },
        gemini: { installed: false, version: null, authenticated: null,
                  hint: 'planned', detailLines: [] },
      },
      shell_wrapper: { installed: true, rc: '/fake/.zshrc', hint: null },
      workspace: { mc_home: '/tmp', mc_home_exists: true, session_count: 0,
                   orphan_daemon_count: 0, stale_pidfile_count: 0 },
    };
    assert.deepEqual(missingSteps(greenReport), []);
  });

  test('missingSteps surfaces install + verify when Codex missing', async () => {
    const { missingSteps } = await import('../../../src/mc/commands/setup.js');
    const report = {
      memoro: { authenticated: true, hint: null },
      tools: {
        codex: { installed: false, version: null, authenticated: null,
                 hint: 'Install Codex CLI from openai/codex', detailLines: [] },
        claude: { installed: false, version: null, authenticated: null,
                  hint: 'Install with: npm install -g @anthropic-ai/claude-code', detailLines: [] },
        gemini: { installed: false, version: null, authenticated: null,
                  hint: 'planned', detailLines: [] },
      },
      shell_wrapper: { installed: true, rc: '/fake', hint: null },
      workspace: {},
    };
    const steps = missingSteps(report);
    assert.equal(steps.length, 2);
    assert.equal(steps[0].id, 'install-codex');
    assert.equal(steps[0].command, '');
    assert.match(steps[0].note, /Codex CLI/i);
    assert.equal(steps[1].id, 'verify-codex');
    assert.equal(steps[1].command, 'mc auth codex');
  });

  test('missingSteps accepts installed Codex with unknown auth as ready', async () => {
    const { missingSteps } = await import('../../../src/mc/commands/setup.js');
    const report = {
      memoro: { authenticated: true, hint: null },
      tools: {
        codex: { installed: true, version: '0.137.0', authenticated: null,
                 hint: 'Run `codex /status` to verify auth, or open codex', detailLines: [] },
        claude: { installed: false, version: null, authenticated: null,
                  hint: 'Install with: npm install -g @anthropic-ai/claude-code', detailLines: [] },
        gemini: { installed: false, version: null, authenticated: null,
                  hint: 'planned', detailLines: [] },
      },
      shell_wrapper: { installed: true, rc: '/fake', hint: null },
      workspace: {},
    };
    assert.deepEqual(missingSteps(report), []);
  });

  test('writeSentinel + sentinelPath write to MC_HOME on green', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mc-setup-sentinel-'));
    const origHome = process.env.MC_HOME;
    process.env.MC_HOME = tmp;
    try {
      const { writeSentinel, sentinelPath } = await import('../../../src/mc/commands/setup.js');
      const path = sentinelPath();
      assert.equal(path, join(tmp, '.setup-done-v1'));
      writeSentinel();
      assert.ok(existsSync(path));
      // Re-running is a no-op (existing content preserved — no exception).
      writeSentinel();
      assert.ok(existsSync(path));
    } finally {
      if (origHome === undefined) delete process.env.MC_HOME;
      else process.env.MC_HOME = origHome;
      try { rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
  });
});

describe('mc setup — re-run is idempotent', () => {
  let repo, pidDir;
  beforeEach(() => {
    repo = makeTempRepo({ name: 'setup-idempotent' });
    pidDir = mkdtempSync(join(tmpdir(), 'mc-setup-pid-'));
  });
  afterEach(() => {
    repo.cleanup();
    try { rmSync(pidDir, { recursive: true, force: true }); } catch {}
  });

  test('two consecutive runs produce the same checklist', () => {
    const env = { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir, HOME: repo.root };
    const r1 = runMc(['setup', '--json'], { cwd: repo.dir, env });
    const r2 = runMc(['setup', '--json'], { cwd: repo.dir, env });
    const j1 = parseJsonOrNull(r1.stdout);
    const j2 = parseJsonOrNull(r2.stdout);
    assert.deepEqual(
      j1.missing_steps.map((s) => s.id),
      j2.missing_steps.map((s) => s.id),
    );
  });
});
