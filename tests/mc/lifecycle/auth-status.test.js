/**
 * `mc auth status` integration spec (§11a).
 *
 * The four-section layout: Memoro account, LLM tools, Shell wrapper,
 * Workspace. We assert on `--json` so test stability doesn't ride on
 * exact text spacing.
 *
 * Real keychain reads + real `which` checks are unavoidable here (the
 * CLI binary does them at top-level), but we constrain PATH to
 * `/usr/bin:/bin` so the tool probes deterministically return
 * "not installed" — matches the safe-PATH pattern used by the rest of
 * the mc lifecycle tests.
 */
import test, { describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runMc, parseJsonOrNull } from '../_helpers/cli.js';
import { makeTempRepo } from '../_helpers/git-fixture.js';
import { writeRegistry, makeEntry } from '../_helpers/registry-fixture.js';

describe('mc auth status', () => {
  let repo;
  let pidDir;

  beforeEach(() => {
    repo = makeTempRepo({ name: 'auth-status' });
    pidDir = mkdtempSync(join(tmpdir(), 'mc-auth-pid-'));
  });
  afterEach(() => {
    repo.cleanup();
    try { rmSync(pidDir, { recursive: true, force: true }); } catch {}
  });

  test('--json shape: memoro + tools + shell_wrapper + workspace', () => {
    const r = runMc(['auth', 'status', '--json'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir, HOME: repo.root },
    });
    const j = parseJsonOrNull(r.stdout);
    assert.ok(j, `expected JSON, got: ${r.stdout}\n--stderr--\n${r.stderr}`);
    assert.ok(j.memoro);
    assert.equal(typeof j.memoro.authenticated, 'boolean');
    assert.ok(Array.isArray(j.tools));
    const ids = j.tools.map((t) => t.id).sort();
    assert.deepEqual(ids, ['claude-code', 'codex', 'gemini-cli']);
    assert.ok(j.shell_wrapper);
    assert.ok(j.workspace);
    assert.ok(j.policy);
    assert.equal(j.policy.default_tool, 'claude-code');
    assert.deepEqual(j.policy.tools.map((t) => t.tool), ['claude', 'codex', 'gemini']);
    assert.equal(j.workspace.mc_home, repo.mcHome);
  });

  test('--json policy section explains tool-specific secrets and unsupported permissions', () => {
    const r = runMc(['auth', 'status', '--json'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir, HOME: repo.root },
    });
    const j = parseJsonOrNull(r.stdout);
    const codex = j.policy.tools.find((t) => t.tool === 'codex').effective_policy;
    const claude = j.policy.tools.find((t) => t.tool === 'claude').effective_policy;
    assert.equal(codex.secrets.vault_required, false);
    assert.equal(codex.secrets.native_auth_owned_by_tool, true);
    assert.equal(codex.adapter_support.permissions.workspace, 'supported');
    assert.equal(codex.adapter_support.permissions.network, 'unsupported');
    assert.equal(codex.adapter_support.permissions.approval, 'supported');
    assert.equal(claude.secrets.vault_required, true);
    assert.equal(claude.secrets.materialisation_targets[0].provider, 'anthropic');
  });

  test('--json policy section honours repo .mc/policy.json', () => {
    mkdirSync(join(repo.dir, '.mc'), { recursive: true });
    writeFileSync(join(repo.dir, '.mc', 'policy.json'), JSON.stringify({
      permissions: { profile: 'repo-trusted', network: 'enabled' },
    }));
    const r = runMc(['auth', 'status', '--json'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir, HOME: repo.root },
    });
    const j = parseJsonOrNull(r.stdout);
    const codex = j.policy.tools.find((t) => t.tool === 'codex').effective_policy;
    assert.equal(codex.permissions.source, 'repo');
    assert.equal(codex.permissions.profile, 'repo-trusted');
    assert.equal(codex.permissions.network, 'enabled');
  });

  test('tools all report not-installed on safe PATH', () => {
    const r = runMc(['auth', 'status', '--json'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir, HOME: repo.root },
    });
    const j = parseJsonOrNull(r.stdout);
    for (const t of j.tools) {
      assert.equal(t.installed, false, `${t.id} should be not-installed under safe PATH`);
      assert.ok(t.hint, `${t.id} must carry a hint when not installed`);
    }
  });

  test('exits non-zero when Memoro token absent (fresh install)', () => {
    const r = runMc(['auth', 'status', '--json'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir, HOME: repo.root },
    });
    assert.notEqual(r.status, 0, 'no-token + no-authed-tool → non-zero exit');
  });

  test('workspace section reports session count from registry', () => {
    writeRegistry(repo.mcHome, [
      makeEntry({ name: 'a' }),
      makeEntry({ name: 'b' }),
    ]);
    const r = runMc(['auth', 'status', '--json'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir, HOME: repo.root },
    });
    const j = parseJsonOrNull(r.stdout);
    assert.equal(j.workspace.session_count, 2);
  });

  test('shell_wrapper detects managed block via HOME', () => {
    // Plant a .zshrc with the managed-block marker in the temp HOME.
    writeFileSync(join(repo.root, '.zshrc'), '# foo\n# >>> memoro mc shell wrapper >>>\nfunction mc() {}\n');
    const r = runMc(['auth', 'status', '--json'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir, HOME: repo.root },
    });
    const j = parseJsonOrNull(r.stdout);
    assert.equal(j.shell_wrapper.installed, true);
    assert.match(j.shell_wrapper.rc, /\.zshrc$/);
  });

  test('human output renders all four sections', () => {
    const r = runMc(['auth', 'status'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir, HOME: repo.root },
    });
    assert.match(r.stdout, /Memoro account:/);
    assert.match(r.stdout, /LLM tools on this machine:/);
    assert.match(r.stdout, /Shell wrapper:/);
    assert.match(r.stdout, /Policy:/);
    assert.match(r.stdout, /codex: native auth owned by tool; no vault target/);
    assert.match(r.stdout, /Workspace:/);
  });

  test('`mc auth` with no subcommand defaults to status', () => {
    const r = runMc(['auth'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir, HOME: repo.root },
    });
    assert.match(r.stdout, /Memoro account:/);
  });

  test('rejects unknown subcommand', () => {
    const r = runMc(['auth', 'whatever'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir, HOME: repo.root },
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /unknown auth subcommand/);
  });
});
