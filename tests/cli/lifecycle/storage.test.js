import test, { afterEach, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runMc, parseJsonOrNull } from '../../mc/_helpers/cli.js';
import { makeTempRepo, git, addWorktree } from '../../mc/_helpers/git-fixture.js';
import { writeRegistry, makeEntry } from '../../mc/_helpers/registry-fixture.js';
import { run as runDoctor } from '../../../src/cli/doctor.js';
import { classifyWorktreeEntry } from '../../../src/mc/storage-management.js';

function setupStorageFixture(repo) {
  for (const n of ['done', 'dirty']) {
    git(repo.dir, `branch sess/${n} main`);
    addWorktree(repo.dir, join(repo.mcHome, 'worktrees', 'repo', n), `sess/${n}`);
  }
  writeFileSync(join(repo.mcHome, 'worktrees', 'repo', 'dirty', 'dirty.txt'), 'dirty\n');
  mkdirSync(join(repo.mcHome, 'hosts', 'sess_stale_sidecar'), { recursive: true });
  writeRegistry(repo.mcHome, [
    makeEntry({
      name: 'done',
      branch: 'sess/done',
      worktree_path: join(repo.mcHome, 'worktrees', 'repo', 'done'),
      session_state: 'idle',
      coding_session_id: 'sess_done',
      tool: 'codex',
      tool_session_id: 'cx_done',
    }),
    makeEntry({
      name: 'dirty',
      branch: 'sess/dirty',
      worktree_path: join(repo.mcHome, 'worktrees', 'repo', 'dirty'),
      session_state: 'live',
      coding_session_id: 'sess_dirty',
      tool: 'codex',
    }),
  ]);
}

describe('mc storage / doctor', () => {
  let repo;
  let pidDir;

  beforeEach(() => {
    repo = makeTempRepo({ name: 'storage' });
    pidDir = join(repo.root, 'pids');
    mkdirSync(pidDir, { recursive: true });
    setupStorageFixture(repo);
  });

  afterEach(() => {
    repo?.cleanup();
    repo = null;
  });

  test('storage status reports registry, runtime, provider, and cleanup summaries', () => {
    const digest = 'a'.repeat(64);
    const snapshotPath = join(repo.mcHome, 'dependency-snapshots', 'v1', 'npm', digest);
    mkdirSync(join(snapshotPath, 'node_modules'), { recursive: true });
    writeFileSync(join(snapshotPath, 'metadata.json'), JSON.stringify({
      schema_version: 1,
      fingerprint: `sha256:${digest}`,
      created_at: new Date().toISOString(),
    }));
    const r = runMc(['storage', 'status', '--json', '--min-age', '0s'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir },
    });

    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const j = parseJsonOrNull(r.stdout);
    assert.equal(j.summary.registry_entries, 2);
    assert.equal(j.summary.worktrees.stale_candidates, 1);
    assert.equal(j.summary.worktrees.dirty, 1);
    assert.equal(j.summary.provider.missing_native_id, 1);
    assert.equal(j.summary.runtime.sidecar_candidates, 1);
    assert.equal(j.summary.dependency_snapshots.ready, 1);
    assert.equal(j.summary.dependency_snapshots.candidates, 0);
    assert.equal(j.disk.dependency_snapshots > 0, true);
  });

  test('modern entries are not protected by a same-named live session in another repo', () => {
    const classified = classifyWorktreeEntry(makeEntry({
      session_id: 'mcs_aaaaaaaaaaaaaaaaaaaaaaaa',
      repository_id: 'repo_bbbbbbbbbbbbbbbbbbbbbbbb',
      name: 'shared',
      coding_session_id: null,
      worktree_path: '/missing/repo-a/shared',
    }), {
      liveSessions: [{ name: 'shared', cwd: '/missing/repo-b/shared' }],
    });

    assert.equal(classified.live, false);
  });

  test('storage candidates exposes the same stale worktree policy as gc', () => {
    writeFileSync(join(repo.dir, 'large.bin'), 'x'.repeat(128 * 1024));
    git(repo.dir, 'add large.bin');
    git(repo.dir, 'commit -q -m "Large base file"');
    git(repo.dir, 'branch sess/big main');
    const bigPath = join(repo.mcHome, 'worktrees', 'repo', 'big');
    addWorktree(repo.dir, bigPath, 'sess/big');
    writeRegistry(repo.mcHome, [
      makeEntry({
        name: 'done',
        branch: 'sess/done',
        worktree_path: join(repo.mcHome, 'worktrees', 'repo', 'done'),
        session_state: 'idle',
        coding_session_id: 'sess_done',
        tool: 'codex',
        tool_session_id: 'cx_done',
      }),
      makeEntry({
        name: 'dirty',
        branch: 'sess/dirty',
        worktree_path: join(repo.mcHome, 'worktrees', 'repo', 'dirty'),
        session_state: 'live',
        coding_session_id: 'sess_dirty',
        tool: 'codex',
      }),
      makeEntry({
        name: 'big',
        branch: 'sess/big',
        worktree_path: bigPath,
        session_state: 'idle',
        coding_session_id: 'sess_big',
        tool: 'codex',
        tool_session_id: 'cx_big',
      }),
    ]);

    const r = runMc(['storage', 'candidates', '--json', '--min-age', '0s'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir },
    });

    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const j = parseJsonOrNull(r.stdout);
    assert.deepEqual(j.stale_worktrees.map((item) => item.name), ['big', 'done']);
    assert.ok(j.stale_worktrees[0].reclaimable_bytes > j.stale_worktrees[1].reclaimable_bytes);
    assert.equal(typeof j.stale_worktrees[0].disk_bytes, 'number');
    assert.equal(j.runtime.sidecars.candidates.length, 1);
  });

  test('storage explain shows why a session is or is not a cleanup candidate', () => {
    const r = runMc(['storage', 'explain', 'done', '--json'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir },
    });

    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const j = parseJsonOrNull(r.stdout);
    assert.equal(j.ok, true);
    assert.equal(j.entry.name, 'done');
    assert.equal(j.provider.resumable, true);
    assert.equal(j.cleanup_candidate, true);
    assert.equal(j.cleanup_reason, 'clean-merged-not-live');
  });

  test('unknown default branch never becomes a cleanup candidate', () => {
    git(repo.dir, 'branch competing main');
    git(repo.dir, 'push -q origin competing');
    git(repo.dir, 'fetch -q origin');
    git(repo.dir, 'remote set-head origin -d');

    const r = runMc(['storage', 'explain', 'done', '--json'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir },
    });

    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const j = parseJsonOrNull(r.stdout);
    assert.equal(j.cleanup_candidate, false);
    assert.equal(j.git.ahead, null);
    assert.equal(j.git.default_branch, null);
    assert.equal(j.git.default_branch_reason, 'default-branch-unknown');
  });

  test('doctor summarizes storage issues without mutating', () => {
    const r = runMc(['doctor', '--json', '--min-age', '0s'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir },
    });

    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const j = parseJsonOrNull(r.stdout);
    assert.equal(j.ok, false);
    assert.ok(j.issues.some((issue) => issue.code === 'stale-runtime'));
    assert.ok(j.issues.some((issue) => issue.code === 'stale-worktrees'));
    assert.ok(j.issues.some((issue) => issue.code === 'provider-native-id-missing'));
  });

  test('doctor includes unhealthy and orphaned dev servers', async () => {
    const stdout = [];
    const code = await runDoctor(['--json'], {
      stdout: { write: (value) => stdout.push(value) },
      stderr: { write: () => {} },
      readRegistry: () => ({ entries: [] }),
      buildStorageSnapshot: async () => ({ summary: { registry_entries: 0 }, issues: [] }),
      listDevServers: async () => [
        { instance_id: 'ready', state: 'ready' },
        { instance_id: 'bad', state: 'unhealthy' },
        { instance_id: 'gone', state: 'orphan' },
      ],
      buildTranscriptPrunePlan: () => ({
        counts: {
          total: 0,
          bytes: 0,
          kept: { recent: 0, protected: 0 },
          protected_ids: 0,
        },
      }),
    });

    assert.equal(code, 0);
    const result = JSON.parse(stdout.join(''));
    assert.equal(result.ok, false);
    assert.deepEqual(result.summary.dev_servers, {
      total: 3,
      ready: 1,
      starting: 0,
      unhealthy: 1,
      orphan: 1,
    });
    assert.deepEqual(result.issues.slice(-2).map((issue) => issue.code), [
      'dev-servers-unhealthy',
      'dev-servers-orphan',
    ]);
  });

  test('storage repair --dry-run plans metadata repairs without mutating registry', () => {
    const registryPath = join(repo.mcHome, 'registry.json');
    const donePath = join(repo.mcHome, 'worktrees', 'repo', 'done');
    const missingPath = join(repo.mcHome, 'worktrees', 'repo', 'missing');
    writeRegistry(repo.mcHome, [
      makeEntry({
        name: 'live-stale',
        primary_worktree: repo.dir,
        branch: 'sess/done',
        worktree_path: donePath,
        session_state: 'live',
        coding_session_id: 'sess_live_stale',
        tool: 'codex',
        tool_session_id: 'cx_live_stale',
      }),
      makeEntry({
        name: 'missing',
        primary_worktree: repo.dir,
        branch: 'sess/missing',
        worktree_path: missingPath,
        session_state: 'idle',
        coding_session_id: 'sess_missing',
        tool: 'codex',
        tool_session_id: 'cx_missing',
      }),
    ]);
    const before = readFileSync(registryPath, 'utf8');

    const r = runMc(['storage', 'repair', '--dry-run', '--json'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir },
    });

    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const j = parseJsonOrNull(r.stdout);
    assert.equal(j.dry_run, true);
    assert.deepEqual(j.actions.map((action) => action.type).sort(), [
      'mark-idle',
      'mark-worktree-missing',
    ]);
    assert.equal(readFileSync(registryPath, 'utf8'), before);
  });

  test('storage repair --apply writes safe registry metadata repairs', () => {
    const donePath = join(repo.mcHome, 'worktrees', 'repo', 'done');
    const missingPath = join(repo.mcHome, 'worktrees', 'repo', 'missing');
    writeRegistry(repo.mcHome, [
      makeEntry({
        name: 'live-stale',
        primary_worktree: repo.dir,
        branch: 'sess/done',
        worktree_path: donePath,
        session_state: 'live',
        coding_session_id: 'sess_live_stale',
        tool: 'codex',
        tool_session_id: 'cx_live_stale',
      }),
      makeEntry({
        name: 'missing',
        primary_worktree: repo.dir,
        branch: 'sess/missing',
        worktree_path: missingPath,
        session_state: 'idle',
        coding_session_id: 'sess_missing',
        tool: 'codex',
        tool_session_id: 'cx_missing',
      }),
    ]);

    const r = runMc(['storage', 'repair', '--apply', '--json'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir },
    });

    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const j = parseJsonOrNull(r.stdout);
    assert.equal(j.dry_run, false);
    assert.deepEqual(j.applied.map((action) => action.type).sort(), [
      'mark-idle',
      'mark-worktree-missing',
    ]);

    const reg = JSON.parse(readFileSync(join(repo.mcHome, 'registry.json'), 'utf8'));
    const live = reg.entries.find((entry) => entry.name === 'live-stale');
    const missing = reg.entries.find((entry) => entry.name === 'missing');
    assert.equal(live.session_state, 'idle');
    assert.equal(missing.worktree_missing, true);
    assert.ok(live.last_storage_repair_at);
    assert.ok(missing.last_storage_repair_at);
  });

  test('storage prune-missing --dry-run reports only tombstones older than 7 days', () => {
    const registryPath = join(repo.mcHome, 'registry.json');
    const oldIso = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const recentIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const repairIso = new Date().toISOString();
    writeRegistry(repo.mcHome, [
      makeEntry({
        name: 'old-missing',
        primary_worktree: repo.dir,
        branch: 'sess/old-missing',
        worktree_missing: true,
        created_at: oldIso,
        last_storage_repair_at: repairIso,
      }),
      makeEntry({
        name: 'recent-missing',
        primary_worktree: repo.dir,
        branch: 'sess/recent-missing',
        worktree_missing: true,
        created_at: oldIso,
        last_opened_at: recentIso,
        last_storage_repair_at: repairIso,
      }),
      makeEntry({
        name: 'present',
        primary_worktree: repo.dir,
        branch: 'sess/present',
        worktree_missing: false,
        created_at: oldIso,
        last_storage_repair_at: repairIso,
      }),
    ]);
    const before = readFileSync(registryPath, 'utf8');

    const r = runMc(['storage', 'prune-missing', '--dry-run', '--json'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir },
    });

    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const j = parseJsonOrNull(r.stdout);
    assert.equal(j.dry_run, true);
    assert.deepEqual(j.candidates.map((item) => item.name), ['old-missing']);
    assert.equal(j.candidates[0].retention_anchor_at, oldIso);
    assert.equal(readFileSync(registryPath, 'utf8'), before);
  });

  test('storage prune-missing --apply removes matching tombstones only', () => {
    const oldIso = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const recentIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const repairIso = new Date().toISOString();
    writeRegistry(repo.mcHome, [
      makeEntry({
        name: 'old-missing',
        branch: 'sess/old-missing',
        worktree_missing: true,
        created_at: oldIso,
        last_storage_repair_at: repairIso,
      }),
      makeEntry({
        name: 'recent-missing',
        branch: 'sess/recent-missing',
        worktree_missing: true,
        created_at: oldIso,
        last_opened_at: recentIso,
        last_storage_repair_at: repairIso,
      }),
      makeEntry({
        name: 'present',
        branch: 'sess/present',
        worktree_missing: false,
        created_at: oldIso,
        last_storage_repair_at: repairIso,
      }),
    ]);

    const r = runMc(['storage', 'prune-missing', '--apply', '--json'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir },
    });

    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const j = parseJsonOrNull(r.stdout);
    assert.equal(j.dry_run, false);
    assert.deepEqual(j.removed.map((item) => item.name), ['old-missing']);

    const registry = JSON.parse(readFileSync(join(repo.mcHome, 'registry.json'), 'utf8'));
    assert.deepEqual(registry.entries.map((item) => item.name).sort(), [
      'present',
      'recent-missing',
    ]);
  });

  test('storage prune-missing --apply never removes a same-named entry that is not the planned tombstone', () => {
    // Historic registries carry duplicate names: an aged tombstone and a
    // current entry can share a name. Name-keyed filtering once removed 81
    // entries from an 8-candidate dry-run. Apply must match the exact
    // planned entries only.
    const oldIso = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    writeRegistry(repo.mcHome, [
      makeEntry({
        name: 'dup',
        branch: 'sess/dup-old',
        worktree_path: '/tmp/dup-old',
        worktree_missing: true,
        created_at: oldIso,
      }),
      makeEntry({
        name: 'dup',
        branch: 'sess/dup-current',
        worktree_path: '/tmp/dup-current',
        worktree_missing: false,
        created_at: oldIso,
      }),
      makeEntry({
        name: 'dup',
        branch: 'sess/dup-fresh-tombstone',
        worktree_path: '/tmp/dup-fresh',
        worktree_missing: true,
        created_at: new Date().toISOString(),
      }),
    ]);

    const r = runMc(['storage', 'prune-missing', '--apply', '--json'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir },
    });

    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const j = parseJsonOrNull(r.stdout);
    assert.deepEqual(j.removed.map((item) => item.branch), ['sess/dup-old']);
    const registry = JSON.parse(readFileSync(join(repo.mcHome, 'registry.json'), 'utf8'));
    assert.deepEqual(registry.entries.map((item) => item.branch).sort(), [
      'sess/dup-current',
      'sess/dup-fresh-tombstone',
    ]);
  });

  test('storage prune-deps --dry-run reports old inactive node_modules without mutating', () => {
    const oldIso = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const recentIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    for (const n of ['old-deps', 'recent-deps', 'live-deps']) {
      git(repo.dir, `branch sess/${n} main`);
      addWorktree(repo.dir, join(repo.mcHome, 'worktrees', 'repo', n), `sess/${n}`);
      mkdirSync(join(repo.mcHome, 'worktrees', 'repo', n, 'node_modules'), { recursive: true });
      writeFileSync(join(repo.mcHome, 'worktrees', 'repo', n, 'node_modules', 'dep.bin'), 'x'.repeat(4096));
    }
    writeRegistry(repo.mcHome, [
      makeEntry({
        name: 'old-deps',
        branch: 'sess/old-deps',
        worktree_path: join(repo.mcHome, 'worktrees', 'repo', 'old-deps'),
        session_state: 'idle',
        created_at: oldIso,
      }),
      makeEntry({
        name: 'recent-deps',
        branch: 'sess/recent-deps',
        worktree_path: join(repo.mcHome, 'worktrees', 'repo', 'recent-deps'),
        session_state: 'idle',
        created_at: oldIso,
        last_opened_at: recentIso,
      }),
      makeEntry({
        name: 'live-deps',
        branch: 'sess/live-deps',
        worktree_path: join(repo.mcHome, 'worktrees', 'repo', 'live-deps'),
        session_state: 'live',
        created_at: oldIso,
      }),
    ]);

    const r = runMc(['storage', 'prune-deps', '--dry-run', '--json'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir },
    });

    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const j = parseJsonOrNull(r.stdout);
    assert.equal(j.dry_run, true);
    assert.deepEqual(j.candidates.map((item) => item.name), ['old-deps']);
    assert.equal(j.candidates[0].kind, 'node_modules');
    assert.equal(j.candidates[0].retention_anchor_at, oldIso);
    assert.ok(j.candidates[0].reclaimable_bytes > 0);
    assert.equal(existsSync(join(repo.mcHome, 'worktrees', 'repo', 'old-deps', 'node_modules')), true);
  });

  test('storage prune-deps --apply removes only matching dependency directories', () => {
    const oldIso = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const recentIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    for (const n of ['old-deps', 'recent-deps']) {
      git(repo.dir, `branch sess/${n} main`);
      addWorktree(repo.dir, join(repo.mcHome, 'worktrees', 'repo', n), `sess/${n}`);
      mkdirSync(join(repo.mcHome, 'worktrees', 'repo', n, 'node_modules'), { recursive: true });
      writeFileSync(join(repo.mcHome, 'worktrees', 'repo', n, 'node_modules', 'dep.bin'), 'x'.repeat(4096));
    }
    writeRegistry(repo.mcHome, [
      makeEntry({
        name: 'old-deps',
        branch: 'sess/old-deps',
        worktree_path: join(repo.mcHome, 'worktrees', 'repo', 'old-deps'),
        session_state: 'idle',
        created_at: oldIso,
      }),
      makeEntry({
        name: 'recent-deps',
        branch: 'sess/recent-deps',
        worktree_path: join(repo.mcHome, 'worktrees', 'repo', 'recent-deps'),
        session_state: 'idle',
        created_at: oldIso,
        last_activity: recentIso,
      }),
    ]);

    const r = runMc(['storage', 'prune-deps', '--apply', '--json'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir },
    });

    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const j = parseJsonOrNull(r.stdout);
    assert.equal(j.dry_run, false);
    assert.deepEqual(j.removed.map((item) => item.name), ['old-deps']);
    assert.deepEqual(j.failed, []);
    assert.equal(existsSync(join(repo.mcHome, 'worktrees', 'repo', 'old-deps', 'node_modules')), false);
    assert.equal(existsSync(join(repo.mcHome, 'worktrees', 'repo', 'recent-deps', 'node_modules')), true);
  });

  test('storage prune-generated --dry-run reports old ignored generated directories only', () => {
    writeFileSync(join(repo.dir, '.gitignore'), '.next\n');
    git(repo.dir, 'add .gitignore');
    git(repo.dir, 'commit -q -m "Ignore generated cache"');

    const oldIso = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const recentIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    for (const n of ['old-generated', 'recent-generated', 'live-generated', 'unignored-generated']) {
      git(repo.dir, `branch sess/${n} main`);
      addWorktree(repo.dir, join(repo.mcHome, 'worktrees', 'repo', n), `sess/${n}`);
    }
    mkdirSync(join(repo.mcHome, 'worktrees', 'repo', 'old-generated', '.next'), { recursive: true });
    writeFileSync(join(repo.mcHome, 'worktrees', 'repo', 'old-generated', '.next', 'cache.bin'), 'x'.repeat(4096));
    mkdirSync(join(repo.mcHome, 'worktrees', 'repo', 'recent-generated', '.next'), { recursive: true });
    writeFileSync(join(repo.mcHome, 'worktrees', 'repo', 'recent-generated', '.next', 'cache.bin'), 'x'.repeat(4096));
    mkdirSync(join(repo.mcHome, 'worktrees', 'repo', 'live-generated', '.next'), { recursive: true });
    writeFileSync(join(repo.mcHome, 'worktrees', 'repo', 'live-generated', '.next', 'cache.bin'), 'x'.repeat(4096));
    mkdirSync(join(repo.mcHome, 'worktrees', 'repo', 'unignored-generated', 'coverage'), { recursive: true });
    writeFileSync(join(repo.mcHome, 'worktrees', 'repo', 'unignored-generated', 'coverage', 'index.html'), 'coverage\n');

    writeRegistry(repo.mcHome, [
      makeEntry({
        name: 'old-generated',
        branch: 'sess/old-generated',
        worktree_path: join(repo.mcHome, 'worktrees', 'repo', 'old-generated'),
        session_state: 'idle',
        created_at: oldIso,
      }),
      makeEntry({
        name: 'recent-generated',
        branch: 'sess/recent-generated',
        worktree_path: join(repo.mcHome, 'worktrees', 'repo', 'recent-generated'),
        session_state: 'idle',
        created_at: oldIso,
        last_opened_at: recentIso,
      }),
      makeEntry({
        name: 'live-generated',
        branch: 'sess/live-generated',
        worktree_path: join(repo.mcHome, 'worktrees', 'repo', 'live-generated'),
        session_state: 'live',
        created_at: oldIso,
      }),
      makeEntry({
        name: 'unignored-generated',
        branch: 'sess/unignored-generated',
        worktree_path: join(repo.mcHome, 'worktrees', 'repo', 'unignored-generated'),
        session_state: 'idle',
        created_at: oldIso,
      }),
    ]);

    const r = runMc(['storage', 'prune-generated', '--dry-run', '--json'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir },
    });

    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const j = parseJsonOrNull(r.stdout);
    assert.equal(j.dry_run, true);
    assert.deepEqual(j.candidates.map((item) => item.name), ['old-generated']);
    assert.equal(j.candidates[0].kind, '.next');
    assert.equal(j.candidates[0].git_ignored, true);
    assert.ok(j.candidates[0].reclaimable_bytes > 0);
    assert.equal(existsSync(join(repo.mcHome, 'worktrees', 'repo', 'old-generated', '.next')), true);
    assert.equal(existsSync(join(repo.mcHome, 'worktrees', 'repo', 'unignored-generated', 'coverage')), true);
  });

  test('storage prune-generated --apply removes matching ignored directories only', () => {
    writeFileSync(join(repo.dir, '.gitignore'), '.next\n');
    git(repo.dir, 'add .gitignore');
    git(repo.dir, 'commit -q -m "Ignore generated cache"');

    const oldIso = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const recentIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    for (const n of ['old-generated', 'recent-generated', 'unignored-generated']) {
      git(repo.dir, `branch sess/${n} main`);
      addWorktree(repo.dir, join(repo.mcHome, 'worktrees', 'repo', n), `sess/${n}`);
    }
    mkdirSync(join(repo.mcHome, 'worktrees', 'repo', 'old-generated', '.next'), { recursive: true });
    writeFileSync(join(repo.mcHome, 'worktrees', 'repo', 'old-generated', '.next', 'cache.bin'), 'x'.repeat(4096));
    mkdirSync(join(repo.mcHome, 'worktrees', 'repo', 'recent-generated', '.next'), { recursive: true });
    writeFileSync(join(repo.mcHome, 'worktrees', 'repo', 'recent-generated', '.next', 'cache.bin'), 'x'.repeat(4096));
    mkdirSync(join(repo.mcHome, 'worktrees', 'repo', 'unignored-generated', 'coverage'), { recursive: true });
    writeFileSync(join(repo.mcHome, 'worktrees', 'repo', 'unignored-generated', 'coverage', 'index.html'), 'coverage\n');

    writeRegistry(repo.mcHome, [
      makeEntry({
        name: 'old-generated',
        branch: 'sess/old-generated',
        worktree_path: join(repo.mcHome, 'worktrees', 'repo', 'old-generated'),
        session_state: 'idle',
        created_at: oldIso,
      }),
      makeEntry({
        name: 'recent-generated',
        branch: 'sess/recent-generated',
        worktree_path: join(repo.mcHome, 'worktrees', 'repo', 'recent-generated'),
        session_state: 'idle',
        created_at: oldIso,
        last_activity: recentIso,
      }),
      makeEntry({
        name: 'unignored-generated',
        branch: 'sess/unignored-generated',
        worktree_path: join(repo.mcHome, 'worktrees', 'repo', 'unignored-generated'),
        session_state: 'idle',
        created_at: oldIso,
      }),
    ]);

    const r = runMc(['storage', 'prune-generated', '--apply', '--json'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir },
    });

    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const j = parseJsonOrNull(r.stdout);
    assert.equal(j.dry_run, false);
    assert.deepEqual(j.removed.map((item) => item.name), ['old-generated']);
    assert.deepEqual(j.failed, []);
    assert.equal(existsSync(join(repo.mcHome, 'worktrees', 'repo', 'old-generated', '.next')), false);
    assert.equal(existsSync(join(repo.mcHome, 'worktrees', 'repo', 'recent-generated', '.next')), true);
    assert.equal(existsSync(join(repo.mcHome, 'worktrees', 'repo', 'unignored-generated', 'coverage')), true);
  });
});

describe('mc doctor session liveness', () => {
  const doctorDeps = (overrides = {}) => ({
    stderr: { write: () => {} },
    buildStorageSnapshot: async () => ({ summary: { registry_entries: 3 }, issues: [] }),
    listDevServers: async () => [],
    buildTranscriptPrunePlan: () => ({
      counts: { total: 0, bytes: 0, kept: { recent: 0, protected: 0 }, protected_ids: 0 },
    }),
    ...overrides,
  });

  test('every live row is judged by the engine and each verdict names its remedy', async () => {
    const stdout = [];
    const verdicts = {
      sess_ok: { verdict: 'live' },
      sess_gone: { verdict: 'exited' },
      sess_stuck: { verdict: 'unreachable' },
    };
    const code = await runDoctor(['--json'], doctorDeps({
      stdout: { write: (value) => stdout.push(value) },
      readRegistry: () => ({
        entries: [
          { name: 'healthy', session_state: 'live', coding_session_id: 'sess_ok' },
          { name: 'gone', session_state: 'live', coding_session_id: 'sess_gone' },
          { name: 'stuck', session_state: 'live', coding_session_id: 'sess_stuck' },
          { name: 'idle-row', session_state: 'idle', coding_session_id: 'sess_idle' },
        ],
      }),
      inspectPresence: async (entry) => verdicts[entry.coding_session_id],
    }));

    assert.equal(code, 0);
    const result = JSON.parse(stdout.join(''));
    assert.deepEqual(result.summary.sessions, {
      live_rows: 3, confirmed_live: 1, exited: 1, unreachable: 1, unknown: 0,
    });
    const gone = result.issues.find((issue) => issue.code === 'session-live-row-exited');
    assert.equal(gone.name, 'gone');
    assert.match(gone.hint, /mc open gone/);
    const stuck = result.issues.find((issue) => issue.code === 'session-runtime-unreachable');
    assert.equal(stuck.name, 'stuck');
    assert.match(stuck.hint, /exit the running tool.*nothing is deleted/);
    assert.equal(result.ok, false);
  });

  test('a failing presence probe degrades to unknown with the repair hint', async () => {
    const stdout = [];
    const code = await runDoctor(['--json'], doctorDeps({
      stdout: { write: (value) => stdout.push(value) },
      readRegistry: () => ({
        entries: [{ name: 'mystery', session_state: 'live', coding_session_id: 'sess_x' }],
      }),
      inspectPresence: async () => { throw new Error('probe offline'); },
    }));

    assert.equal(code, 0);
    const result = JSON.parse(stdout.join(''));
    assert.equal(result.summary.sessions.unknown, 1);
    const issue = result.issues.find((item) => item.code === 'session-liveness-unknown');
    assert.match(issue.hint, /mc storage repair --apply/);
  });
});
