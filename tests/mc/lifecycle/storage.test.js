import test, { afterEach, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
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
    const r = runMc(['storage', 'candidates', '--json', '--min-age', '0s'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir },
    });

    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const j = parseJsonOrNull(r.stdout);
    assert.deepEqual(j.stale_worktrees.map((item) => item.name), ['done']);
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
});
