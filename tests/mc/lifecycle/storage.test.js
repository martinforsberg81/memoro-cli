import test, { afterEach, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runMc, parseJsonOrNull } from '../_helpers/cli.js';
import { makeTempRepo, git, addWorktree } from '../_helpers/git-fixture.js';
import { writeRegistry, makeEntry } from '../_helpers/registry-fixture.js';

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

  test('storage repair --dry-run plans metadata repairs without mutating registry', () => {
    const registryPath = join(repo.mcHome, 'registry.json');
    const donePath = join(repo.mcHome, 'worktrees', 'repo', 'done');
    const missingPath = join(repo.mcHome, 'worktrees', 'repo', 'missing');
    writeRegistry(repo.mcHome, [
      makeEntry({
        name: 'live-stale',
        branch: 'sess/done',
        worktree_path: donePath,
        session_state: 'live',
        coding_session_id: 'sess_live_stale',
        tool: 'codex',
        tool_session_id: 'cx_live_stale',
      }),
      makeEntry({
        name: 'missing',
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
        branch: 'sess/done',
        worktree_path: donePath,
        session_state: 'live',
        coding_session_id: 'sess_live_stale',
        tool: 'codex',
        tool_session_id: 'cx_live_stale',
      }),
      makeEntry({
        name: 'missing',
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
    writeRegistry(repo.mcHome, [
      makeEntry({
        name: 'old-missing',
        branch: 'sess/old-missing',
        worktree_missing: true,
        last_storage_repair_at: oldIso,
      }),
      makeEntry({
        name: 'recent-missing',
        branch: 'sess/recent-missing',
        worktree_missing: true,
        last_storage_repair_at: recentIso,
      }),
      makeEntry({
        name: 'present',
        branch: 'sess/present',
        worktree_missing: false,
        last_storage_repair_at: oldIso,
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
    assert.equal(readFileSync(registryPath, 'utf8'), before);
  });

  test('storage prune-missing --apply removes matching tombstones only', () => {
    const oldIso = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const recentIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    writeRegistry(repo.mcHome, [
      makeEntry({
        name: 'old-missing',
        branch: 'sess/old-missing',
        worktree_missing: true,
        last_storage_repair_at: oldIso,
      }),
      makeEntry({
        name: 'recent-missing',
        branch: 'sess/recent-missing',
        worktree_missing: true,
        last_storage_repair_at: recentIso,
      }),
      makeEntry({
        name: 'present',
        branch: 'sess/present',
        worktree_missing: false,
        last_storage_repair_at: oldIso,
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
});
