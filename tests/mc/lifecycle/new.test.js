/**
 * TDD spec for `mc new <name>` (§2).
 *
 * Per the plan §2:
 *   mc new <name> [--from <ref>] [--tool claude|codex|gemini]
 *     create worktree, create bootstrap branch sess/<name>, launch tool
 *
 * Open ambiguity from the design plan + existing code:
 *   The CURRENT `mc new <label>` wraps `claude` (no worktree). The new
 *   §2 contract redefines `mc new` to be a lifecycle command that
 *   creates a worktree + branch and *then* launches the tool. The
 *   wrapping behaviour is subsumed.
 *
 *   Judgment call for this spec: when run inside a git repo with a
 *   `<name>` arg, the new behaviour applies — create a worktree at
 *   `${MC_HOME}/worktrees/<repo-slug>/<name>` with branch `sess/<name>`,
 *   then emit a shell-cd directive on fd 3 (if attached) per §2b.
 *
 *   We pass `--no-launch` (a test-only escape hatch) so the test
 *   doesn't actually try to spawn `claude`. If the implementation
 *   prefers a different opt-out flag, rename here.
 */
import test, { describe, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runMc, parseJsonOrNull } from '../_helpers/cli.js';
import { makeTempRepo, git } from '../_helpers/git-fixture.js';
import { makeEntry, writeRegistry } from '../_helpers/registry-fixture.js';
import { launchNewSession } from '../../../src/mc/commands/new.js';
import * as claudeAdapter from '../../../src/adapters/claude-code.js';
import * as codexAdapter from '../../../src/adapters/codex.js';
import { LOCAL_AUTH_MODES } from '../../../src/mc/local-auth-mode.js';

describe('mc new', () => {
  let repo;
  beforeEach(() => {
    repo = makeTempRepo({ name: 'new' });
    // These tests exercise lifecycle behavior, not first-run onboarding.
    // Keep the sentinel explicit so the file is order-independent from
    // tests/mc/lifecycle/first-run-cli.test.js.
    mkdirSync(repo.mcHome, { recursive: true });
    writeFileSync(join(repo.mcHome, '.setup-done-v1'), 'test\n');
  });
  after(() => { repo?.cleanup(); });

  test('rejects missing name with non-zero exit + usage hint', () => {
    const r = runMc(['new'], { cwd: repo.dir, env: { MC_HOME: repo.mcHome } });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /usage|name|required/i,
      `expected a usage hint, got stderr:${r.stderr} stdout:${r.stdout}`);
  });

  test('rejects names with shell-unsafe characters', () => {
    const r = runMc(['new', 'has space', '--no-launch'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /invalid|name|character/i);
  });

  test('--managed-portable can prepare a worktree without opening credential custody', () => {
    const r = runMc(['new', 'managed-x', '--managed-portable', '--no-launch'], {
      cwd: repo.dir,
      env: {
        MC_HOME: repo.mcHome,
        MC_VAULT_STARTUP_DONE: '1',
        MC_MANAGED_PORTABLE: '1',
      },
    });

    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    assert.match(git(repo.dir, 'branch --list sess/managed-x'), /sess\/managed-x$/);
    assert.equal(existsSync(join(repo.mcHome, 'worktrees', 'repo', 'managed-x')), true);
    assert.equal(existsSync(join(repo.mcHome, 'credential-domains')), false);
  });

  test('refuses to run outside a git repo', () => {
    // repo.root is a tmpdir parent, not a git repo.
    const r = runMc(['new', 'foo', '--no-launch'], {
      cwd: repo.root, env: { MC_HOME: repo.mcHome },
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /git|repo/i);
  });

  test('--json output describes the created worktree + branch', () => {
    const r = runMc(['new', 'feat-x', '--no-launch', '--json'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });
    assert.equal(r.status, 0, `expected exit 0; stderr:${r.stderr}`);
    const j = parseJsonOrNull(r.stdout);
    assert.ok(j, `expected JSON on stdout, got: ${r.stdout}`);
    assert.equal(j.ok, true);
    assert.equal(j.name, 'feat-x');
    assert.equal(j.branch, 'sess/feat-x');
    assert.ok(typeof j.worktree_path === 'string' && j.worktree_path.length > 0,
      'worktree_path must be a non-empty string');
    // Worktree path must live under MC_HOME, not inside the repo (§1).
    assert.ok(j.worktree_path.startsWith(repo.mcHome),
      `worktree should be under MC_HOME (${repo.mcHome}); got ${j.worktree_path}`);
  });

  test('does not install dependencies while creating a worktree with a dev definition', () => {
    mkdirSync(join(repo.dir, '.mc'), { recursive: true });
    writeFileSync(join(repo.dir, 'package.json'), JSON.stringify({
      name: 'new-no-install',
      version: '1.0.0',
      scripts: { postinstall: 'touch INSTALL_RAN' },
    }));
    writeFileSync(join(repo.dir, 'package-lock.json'), JSON.stringify({
      name: 'new-no-install',
      version: '1.0.0',
      lockfileVersion: 3,
      packages: { '': { name: 'new-no-install', version: '1.0.0' } },
    }));
    writeFileSync(join(repo.dir, '.mc', 'dev.json'), JSON.stringify({
      schema_version: 1,
      default_service: 'web',
      services: {
        web: {
          default_profile: 'agent',
          profiles: {
            agent: {
              start: { argv: ['npm', 'run', 'dev'] },
              readiness: { kind: 'runtime-manifest', path: '.runtime/mc-dev.json', timeout_ms: 90_000 },
              resource_class: 'standard',
            },
          },
          dependencies: {
            manager: 'npm',
            fingerprint_files: ['package.json', 'package-lock.json'],
            install: { argv: ['npm', 'ci'] },
          },
          managed_argv_prefixes: [['npm', 'run', 'dev']],
        },
      },
    }));
    git(repo.dir, 'add package.json package-lock.json .mc/dev.json');
    git(repo.dir, 'commit -q -m "Add dev definition"');

    const r = runMc(['new', 'no-auto-install', '--no-launch', '--json'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome },
    });
    assert.equal(r.status, 0, r.stderr);
    const created = parseJsonOrNull(r.stdout);
    assert.equal(existsSync(join(created.worktree_path, 'node_modules')), false);
    assert.equal(existsSync(join(created.worktree_path, 'INSTALL_RAN')), false);
  });

  test('side effect: git worktree list shows the new worktree', () => {
    runMc(['new', 'feat-y', '--no-launch'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });
    const list = git(repo.dir, 'worktree list --porcelain');
    assert.match(list, /feat-y|sess\/feat-y/,
      `git worktree list should mention the new worktree; got:\n${list}`);
  });

  test('side effect: branch sess/<name> exists after creation', () => {
    runMc(['new', 'feat-z', '--no-launch'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });
    const branches = git(repo.dir, 'branch --list');
    assert.match(branches, /sess\/feat-z/,
      `expected sess/feat-z branch; got:\n${branches}`);
  });

  test('refuses duplicate names', () => {
    runMc(['new', 'dup', '--no-launch'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });
    const r = runMc(['new', 'dup', '--no-launch'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /exists|duplicate|already/i);
  });

  test('reuses a missing registry tombstone name', () => {
    writeRegistry(repo.mcHome, [
      makeEntry({
        name: 'reuse',
        branch: 'sess/reuse',
        worktree_path: join(repo.mcHome, 'worktrees', 'repo', 'reuse'),
        session_state: 'idle',
        coding_session_id: 'sess_old',
        tool_session_id: 'old-provider-session',
        dirty_files: 9,
        worktree_missing: true,
        last_storage_repair_at: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
      }),
    ]);

    const r = runMc(['new', 'reuse', '--no-launch', '--json'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome },
    });

    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const out = parseJsonOrNull(r.stdout);
    assert.equal(out.name, 'reuse');

    const registry = JSON.parse(readFileSync(join(repo.mcHome, 'registry.json'), 'utf8'));
    const entry = registry.entries.find((item) => item.name === 'reuse');
    assert.equal(entry.branch, 'sess/reuse');
    assert.equal(entry.worktree_missing, false);
    assert.equal(entry.session_state, 'no-session-yet');
    assert.equal(entry.coding_session_id, null);
    assert.equal(entry.tool_session_id, null);
    assert.equal(entry.dirty_files, 0);
  });

  test('--from <ref> roots the new branch at that ref', () => {
    // Make a side commit on main, then branch off the parent.
    const parentSha = git(repo.dir, 'rev-parse HEAD');
    git(repo.dir, 'commit --allow-empty -q -m "later"');
    const r = runMc(['new', 'from-test', '--from', parentSha, '--no-launch', '--json'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });
    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const branchSha = git(repo.dir, 'rev-parse sess/from-test');
    assert.equal(branchSha, parentSha,
      `sess/from-test should point at ${parentSha} but is ${branchSha}`);
  });

  test('--tool flag is recorded in registry / output', () => {
    const r = runMc(['new', 'codex-x', '--tool', 'codex', '--no-launch', '--json'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });
    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const j = parseJsonOrNull(r.stdout);
    assert.ok(j);
    assert.equal(j.tool, 'codex');
  });

  test('uses repo-local defaultTool from .mc/local.json when no flag is passed', () => {
    mkdirSync(join(repo.dir, '.mc'), { recursive: true });
    writeFileSync(join(repo.dir, '.mc', 'local.json'), JSON.stringify({
      defaultTool: 'codex',
    }));

    const r = runMc(['new', 'repo-default-codex', '--no-launch', '--json'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });
    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const j = parseJsonOrNull(r.stdout);
    assert.ok(j);
    assert.equal(j.tool, 'codex');
    assert.equal(j.tool_source, '.mc/local.json');
  });

  // Phase 3 — tool selection sugar: `--codex` / `--claude` are sugar over
  // `--tool <x>`; `--tool` stays the canonical form.
  test('--codex sugar selects codex (sugar over --tool)', () => {
    const r = runMc(['new', 'sugar-codex', '--codex', '--no-launch', '--json'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });
    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const j = parseJsonOrNull(r.stdout);
    assert.ok(j);
    assert.equal(j.tool, 'codex');
  });

  test('--claude sugar selects claude', () => {
    const r = runMc(['new', 'sugar-claude', '--claude', '--no-launch', '--json'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });
    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const j = parseJsonOrNull(r.stdout);
    assert.ok(j);
    assert.equal(j.tool, 'claude');
  });

  test('conflicting --tool + sugar is rejected (exit 2)', () => {
    const r = runMc(['new', 'conflict-x', '--tool', 'claude', '--codex', '--no-launch'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /conflict/i);
  });

  // Phase 2 — entry parity: the optional `<task>` positional is the soft
  // grounding focus. It's standing context, not a name and not an opening
  // prompt; multi-word tasks join without quotes.
  test('optional <task> positional is surfaced as focus (no quotes needed)', () => {
    const r = runMc(['new', 'focus-x', 'grab', 'the', 'flaky', 'test', '--no-launch', '--json'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });
    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const j = parseJsonOrNull(r.stdout);
    assert.ok(j, `expected JSON, got: ${r.stdout}`);
    assert.equal(j.name, 'focus-x', 'first positional is still the name');
    assert.equal(j.focus, 'grab the flaky test', 'remaining positionals form the focus');
  });

  test('focus is null when no <task> is given', () => {
    const r = runMc(['new', 'no-focus', '--no-launch', '--json'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });
    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const j = parseJsonOrNull(r.stdout);
    assert.ok(j);
    assert.equal(j.focus, null);
  });

  test('prelaunch for --codex uses only the codex vault adapter and broker launch payload', async () => {
    const materialiseCalls = [];
    const launchCalls = [];
    const upserts = [];
    const status = await launchNewSession({
      entry: { name: 'codex-prelaunch', tool: 'codex' },
      worktreePath: '/tmp/memoro-new-codex',
      focus: 'build the first map',
      env: { PATH: '/bin', MC_GROUNDING_TOOL: 'claude-code' },
      stderr: { write() {} },
      deps: {
        materialiseVaultBeforeLaunch: async (arg) => {
          materialiseCalls.push(arg);
          return { ok: true, materialised: [], skipped: [] };
        },
        launchBrokerOwnedSession: async (arg) => {
          launchCalls.push(arg);
          await arg.onLaunched?.({ codingSessionId: 'sess_new_codex' });
          return { code: 0 };
        },
        upsertEntry: (entry) => {
          upserts.push(entry);
          return entry;
        },
      },
    });

    assert.equal(status, 0);
    assert.equal(materialiseCalls.length, 1);
    assert.equal(materialiseCalls[0].sessionId, 'codex-prelaunch');
    assert.equal(materialiseCalls[0].worktreePath, '/tmp/memoro-new-codex');
    assert.deepEqual(materialiseCalls[0].adapters, [codexAdapter]);
    assert.notDeepEqual(materialiseCalls[0].adapters, [claudeAdapter]);

    assert.equal(launchCalls.length, 1);
    assert.equal(launchCalls[0].cwd, '/tmp/memoro-new-codex');
    assert.equal(launchCalls[0].sessionName, 'codex-prelaunch');
    assert.equal(launchCalls[0].tool, 'codex');
    assert.equal(launchCalls[0].focus, 'build the first map');
    assert.equal(launchCalls[0].localAuthMode, LOCAL_AUTH_MODES.NATIVE);
    assert.deepEqual(launchCalls[0].argv, []);
    assert.deepEqual(launchCalls[0].env, { PATH: '/bin', MC_GROUNDING_TOOL: 'claude-code' });
    assert.deepEqual(upserts, [{
      name: 'codex-prelaunch',
      coding_session_id: 'sess_new_codex',
      session_state: 'live',
    }]);
  });

  test('managed prelaunch skips legacy vault materialisation and delegates boundary setup to the broker launcher', async () => {
    const launches = [];
    const status = await launchNewSession({
      entry: { name: 'managed', tool: 'codex' },
      worktreePath: '/tmp/memoro-managed',
      localAuthMode: LOCAL_AUTH_MODES.MANAGED_PORTABLE,
      stderr: { write() {} },
      deps: {
        materialiseVaultBeforeLaunch: async () => assert.fail('must not touch vault startup'),
        launchBrokerOwnedSession: async (options) => {
          launches.push(options);
          return { code: 0 };
        },
      },
    });

    assert.equal(status, 0);
    assert.equal(launches.length, 1);
    assert.equal(launches[0].localAuthMode, LOCAL_AUTH_MODES.MANAGED_PORTABLE);
    assert.equal(launches[0].tool, 'codex');
  });
});
