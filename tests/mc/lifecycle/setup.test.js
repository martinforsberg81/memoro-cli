/**
 * `mc setup` integration spec (§11b).
 *
 * Self-verifying. These subprocess cases run without a TTY; the verb is
 * contract-bound:
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
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runMc, parseJsonOrNull } from '../_helpers/cli.js';
import { makeTempRepo } from '../_helpers/git-fixture.js';

const READY_GITHUB = Object.freeze({
  schema: 1,
  state: 'ready',
  repair_action: null,
  actor: { type: 'installation', login: 'memoro[bot]' },
  accounts: [{ login: 'acme', type: 'Organization' }],
  repository: null,
  repositories: [],
  operations: [],
  approval_mode: 'prompt',
});

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
    assert.match(r.stdout, /mc setup — \d+ setup step/);
    assert.match(r.stdout, /1\. Sign in to Memoro/);
    assert.match(r.stdout, /run:\s+mc/);
    assert.match(r.stdout, /browser device sign-in/);
    assert.match(r.stdout, /Install Codex CLI/);
    assert.match(r.stdout, /Install the shell wrapper/);
    assert.match(r.stdout, /run:\s+mc install-shell/);
    // Sentinel must NOT exist after a red run.
    assert.ok(!existsSync(join(repo.mcHome, '.setup-done-v1')));
  });

  test('--json shape includes readiness, resource profile, dependency mode, steps, and sentinel', () => {
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
    assert.equal(j.resource_profile.profile, 'unlimited');
    assert.equal(j.resource_profile.enabled, false);
    assert.match(j.resource_profile.recommended, /^(unlimited|balanced|conservative)$/);
    assert.equal(j.dependency_mode, 'auto');
  });

  test('--resource-profile is scriptable and persists globally', () => {
    const r = runMc(['setup', '--json', '--resource-profile', 'conservative'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir, HOME: repo.root },
    });
    const j = parseJsonOrNull(r.stdout);
    assert.ok(j, r.stdout);
    assert.equal(j.resource_profile.profile, 'conservative');
    assert.equal(j.resource_profile.maxThreads, 2);

    const stored = JSON.parse(readFileSync(join(repo.root, '.memoro', 'config.json'), 'utf8'));
    assert.deepEqual(stored.resources.localHeavyJobs, { profile: 'conservative' });

    const rerun = runMc(['setup', '--json'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir, HOME: repo.root },
    });
    assert.equal(parseJsonOrNull(rerun.stdout).resource_profile.profile, 'conservative');
  });

  test('--dependency-mode is scriptable and persists globally', () => {
    const r = runMc(['setup', '--json', '--dependency-mode', 'isolated'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir, HOME: repo.root },
    });
    const j = parseJsonOrNull(r.stdout);
    assert.ok(j, r.stdout);
    assert.equal(j.dependency_mode, 'isolated');

    const stored = JSON.parse(readFileSync(join(repo.root, '.memoro', 'config.json'), 'utf8'));
    assert.equal(stored.dev.dependencies.mode, 'isolated');

    const rerun = runMc(['setup', '--json'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir, HOME: repo.root },
    });
    assert.equal(parseJsonOrNull(rerun.stdout).dependency_mode, 'isolated');
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
  test('interactive profile prompt keeps unlimited on Enter and does not auto-select recommendation', async () => {
    const { promptLocalResourceProfile } = await import('../../../src/mc/commands/setup.js');
    let output = '';
    const selected = await promptLocalResourceProfile({
      current: { profile: 'unlimited', enabled: false },
      recommended: 'conservative',
      ask: async () => '',
      stdout: { write: (chunk) => { output += chunk; } },
    });
    assert.equal(selected.profile, 'unlimited');
    assert.equal(selected.enabled, false);
    assert.match(output, /Conservative.*recommended for this machine/);
  });

  test('interactive custom profile collects and validates every limit', async () => {
    const { promptLocalResourceProfile } = await import('../../../src/mc/commands/setup.js');
    const answers = ['custom', '2', '3', '3072', '768', '12'];
    const selected = await promptLocalResourceProfile({
      current: { profile: 'unlimited', enabled: false },
      recommended: 'conservative',
      ask: async () => answers.shift(),
      stdout: { write: () => {} },
    });
    assert.deepEqual(selected, {
      profile: 'custom',
      enabled: true,
      maxConcurrent: 2,
      maxThreads: 3,
      maxRssMb: 3072,
      maxSwapMb: 768,
      minFreeDiskGb: 12,
    });
  });

  test('interactive dependency prompt keeps the current mode on Enter', async () => {
    const { promptDependencyMode } = await import('../../../src/mc/commands/setup.js');
    let output = '';
    const selected = await promptDependencyMode({
      current: 'isolated',
      ask: async () => '',
      stdout: { write: (chunk) => { output += chunk; } },
    });
    assert.equal(selected, 'isolated');
    assert.match(output, /Auto:/);
    assert.match(output, /Isolated \(current\)/);
    assert.match(output, /Off:/);
  });

  test('custom CLI limits require the custom profile', async () => {
    const { parseArgs } = await import('../../../src/mc/commands/setup.js');
    assert.match(parseArgs(['--heavy-max-threads', '2']).error, /require --resource-profile custom/);
    assert.equal(parseArgs([
      '--resource-profile', 'custom',
      '--heavy-max-concurrent', '1',
      '--heavy-max-threads', '2',
      '--heavy-max-rss-mb', '2560',
      '--heavy-max-swap-mb', '512',
      '--heavy-min-free-disk-gb', '20',
    ]).resourceProfile, 'custom');
    assert.equal(parseArgs(['--dependency-mode', 'off']).dependencyMode, 'off');
    assert.match(parseArgs(['--dependency-mode', 'shared']).error, /auto, isolated, off/);
  });

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
      github: READY_GITHUB,
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
      github: READY_GITHUB,
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
      github: READY_GITHUB,
      shell_wrapper: { installed: true, rc: '/fake', hint: null },
      workspace: {},
    };
    assert.deepEqual(missingSteps(report), []);
  });

  test('missingSteps maps every GitHub onboarding repair action to canonical mc verbs', async () => {
    const { missingSteps } = await import('../../../src/mc/commands/setup.js');
    const base = {
      memoro: { authenticated: true, hint: null },
      tools: {
        codex: { installed: true, version: '0.137.0', authenticated: null, hint: null, detailLines: [] },
        claude: { installed: false, version: null, authenticated: null, hint: null, detailLines: [] },
        gemini: { installed: false, version: null, authenticated: null, hint: null, detailLines: [] },
      },
      shell_wrapper: { installed: true, rc: '/fake', hint: null },
      workspace: {},
    };
    const cases = [
      ['disconnected', 'connect', 'mc github connect'],
      ['connecting', 'continue_connect', 'mc github connect'],
      ['repo_not_installed', 'select_repository', 'mc github connect'],
      ['permission_missing', 'update_installation', 'mc github connect'],
      ['suspended', 'resume_installation', 'mc github connect'],
      ['revoked', 'reconnect', 'mc github connect'],
      ['unavailable', 'retry', 'mc github status'],
    ];
    for (const [state, action, command] of cases) {
      const steps = missingSteps({
        ...base,
        github: { ...READY_GITHUB, state, repair_action: action },
      });
      assert.equal(steps.length, 1, state);
      assert.equal(steps[0].id, `github-${action}`, state);
      assert.equal(steps[0].command, command, state);
      assert.doesNotMatch(steps[0].note, /gh auth|keyring|Claude|Codex/, state);
    }
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
