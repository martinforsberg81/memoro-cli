/**
 * TDD spec for `mc gc` (§2).
 *
 * Per the plan §2:
 *   mc gc [--dry-run]
 *     list/clean worktrees whose session is dead AND branch is merged;
 *     never deletes a dirty worktree
 *
 * Test scenarios:
 *   - dead + merged + clean  → eligible (deleted unless --dry-run)
 *   - dead + merged + dirty  → skipped (never delete dirty)
 *   - live + merged + clean  → skipped (don't gc a live session)
 *   - dead + unmerged + clean → skipped (work would be lost)
 *   - dry-run reports candidates without acting
 */
import test, { describe, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runMc, parseJsonOrNull } from '../../mc/_helpers/cli.js';
import { makeTempRepo, git, addWorktree } from '../../mc/_helpers/git-fixture.js';
import { writeRegistry, makeEntry } from '../../mc/_helpers/registry-fixture.js';

function setupFixture(repo) {
  // 4 worktrees covering each gc decision.
  for (const n of ['gc1', 'gc2', 'gc3', 'gc4']) {
    git(repo.dir, `branch sess/${n} main`);
    const wt = join(repo.mcHome, 'worktrees', 'repo', n);
    addWorktree(repo.dir, wt, `sess/${n}`);
  }
  writeFileSync(join(repo.mcHome, 'worktrees', 'repo', 'gc2', 'dirty.txt'), 'dirty\n');
  writeFileSync(join(repo.mcHome, 'worktrees', 'repo', 'gc4', 'ahead.txt'), 'ahead\n');
  git(join(repo.mcHome, 'worktrees', 'repo', 'gc4'), 'add ahead.txt');
  git(join(repo.mcHome, 'worktrees', 'repo', 'gc4'), 'commit -q -m "Ahead work"');
  writeRegistry(repo.mcHome, [
    makeEntry({
      name: 'gc1', branch: 'sess/gc1',
      worktree_path: join(repo.mcHome, 'worktrees', 'repo', 'gc1'),
      session_state: 'dead', ahead: 0, dirty_files: 0,
      safety_verdict: 'SAFE_TO_END',
    }),
    makeEntry({
      name: 'gc2', branch: 'sess/gc2',
      worktree_path: join(repo.mcHome, 'worktrees', 'repo', 'gc2'),
      session_state: 'dead', ahead: 0, dirty_files: 1,
      safety_verdict: 'NEEDS_REVIEW',
    }),
    makeEntry({
      name: 'gc3', branch: 'sess/gc3',
      worktree_path: join(repo.mcHome, 'worktrees', 'repo', 'gc3'),
      session_state: 'live', ahead: 0, dirty_files: 0,
      safety_verdict: 'IS_ACTIVE_NOW',
    }),
    makeEntry({
      name: 'gc4', branch: 'sess/gc4',
      worktree_path: join(repo.mcHome, 'worktrees', 'repo', 'gc4'),
      session_state: 'dead', ahead: 5, dirty_files: 0,
      safety_verdict: 'HAS_UNMERGED_WORK',
    }),
  ]);
}

describe('mc gc', () => {
  let repo;
  beforeEach(() => {
    repo = makeTempRepo({ name: 'gc' });
    setupFixture(repo);
  });
  after(() => { repo?.cleanup(); });

  test('--dry-run lists candidates and changes nothing', () => {
    const r = runMc(['gc', '--dry-run', '--json'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });
    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const j = parseJsonOrNull(r.stdout);
    assert.ok(j, `expected JSON, got: ${r.stdout}`);
    assert.equal(j.dry_run, true);
    assert.ok(Array.isArray(j.candidates));
    const candNames = j.candidates.map(c => c.name).sort();
    // Only gc1 (dead + merged + clean) is eligible.
    assert.deepEqual(candNames, ['gc1'],
      `only gc1 should be a candidate; got ${candNames.join(',')}`);

    // Side effect: nothing removed.
    const wts = git(repo.dir, 'worktree list --porcelain');
    for (const n of ['gc1', 'gc2', 'gc3', 'gc4']) {
      assert.ok(wts.includes(`/worktrees/repo/${n}`),
        `worktree ${n} should still be present after --dry-run`);
    }
  });

  test('runs without --dry-run remove only eligible worktrees', () => {
    const r = runMc(['gc', '--json'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });
    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const j = parseJsonOrNull(r.stdout);
    assert.ok(j);
    assert.ok(Array.isArray(j.removed));
    assert.deepEqual(j.removed.map(c => c.name).sort(), ['gc1']);

    const wts = git(repo.dir, 'worktree list --porcelain');
    assert.ok(!wts.includes('/worktrees/repo/gc1'),
      `gc1 should be removed; got:\n${wts}`);
    for (const n of ['gc2', 'gc3', 'gc4']) {
      assert.ok(wts.includes(`/worktrees/repo/${n}`),
        `worktree ${n} should be preserved`);
    }
  });

  test('--sidecars --dry-run reports stale runtime sidecars without removing them', () => {
    const hostDir = join(repo.mcHome, 'hosts', 'sess_stale_host');
    const guardDir = join(repo.mcHome, 'guard-bin', 'sess_stale_guard');
    mkdirSync(hostDir, { recursive: true });
    mkdirSync(guardDir, { recursive: true });

    const r = runMc(['gc', '--sidecars', '--dry-run', '--json', '--min-age', '0s'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });

    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const j = parseJsonOrNull(r.stdout);
    assert.equal(j.dry_run, true);
    assert.deepEqual(j.candidates.map((item) => [item.kind, item.session_id]).sort(), [
      ['guard-bin', 'sess_stale_guard'],
      ['host', 'sess_stale_host'],
    ]);
    assert.equal(existsSync(hostDir), true);
    assert.equal(existsSync(guardDir), true);
  });

  test('--sidecars --dry-run --json flushes payloads larger than a pipe buffer', () => {
    const hostRoot = join(repo.mcHome, 'hosts');
    for (let i = 0; i < 450; i++) {
      mkdirSync(join(hostRoot, `sess_bulk_${String(i).padStart(3, '0')}`), { recursive: true });
    }

    const r = runMc(['gc', '--sidecars', '--dry-run', '--json', '--min-age', '0s'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome },
      timeoutMs: 20_000,
    });

    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const j = parseJsonOrNull(r.stdout);
    assert.ok(j, `expected complete JSON, got ${r.stdout.length} bytes ending with ${JSON.stringify(r.stdout.slice(-80))}`);
    assert.equal(j.candidates.length, 450);
  });

  test('--runtime --dry-run reports stale sidecars and stale daemon pidfiles', () => {
    const pidDir = join(repo.root, 'pids');
    mkdirSync(pidDir, { recursive: true });
    writeFileSync(join(pidDir, 'heartbeat-llm_stale.pid'), '99999999\n');
    const hostDir = join(repo.mcHome, 'hosts', 'sess_runtime_stale');
    mkdirSync(hostDir, { recursive: true });

    const r = runMc(['gc', '--runtime', '--dry-run', '--json', '--min-age', '0s'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir },
    });

    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const j = parseJsonOrNull(r.stdout);
    assert.equal(j.dry_run, true);
    assert.equal(j.runtime.daemons.stale.length, 1);
    assert.equal(j.runtime.sidecars.candidates.length, 1);
  });

  test('--stale-worktrees derives clean merged candidates from actual git state', () => {
    const r = runMc(['gc', '--stale-worktrees', '--dry-run', '--json'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });

    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const j = parseJsonOrNull(r.stdout);
    assert.deepEqual(j.candidates.map((item) => item.name).sort(), ['gc1', 'gc3']);
    assert.ok(j.candidates.every((item) => item.reason === 'clean-merged-not-live'));
  });

  test('--stale-worktrees --only restricts cleanup to explicit names', () => {
    const dryRun = runMc(['gc', '--stale-worktrees', '--only', 'gc3,missing', '--dry-run', '--json'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });

    assert.equal(dryRun.status, 0, `stderr:${dryRun.stderr}`);
    const preview = parseJsonOrNull(dryRun.stdout);
    assert.deepEqual(preview.requested_names, ['gc3', 'missing']);
    assert.deepEqual(preview.not_candidates, ['missing']);
    assert.deepEqual(preview.candidates.map((item) => item.name), ['gc3']);

    const applied = runMc(['gc', '--stale-worktrees', '--only', 'gc3', '--apply', '--json'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });

    assert.equal(applied.status, 0, `stderr:${applied.stderr}`);
    const result = parseJsonOrNull(applied.stdout);
    assert.deepEqual(result.removed.map((item) => item.name), ['gc3']);

    const wts = git(repo.dir, 'worktree list --porcelain');
    assert.ok(wts.includes('/worktrees/repo/gc1'), 'unrequested cleanup candidate should be preserved');
    assert.ok(!wts.includes('/worktrees/repo/gc3'), 'requested cleanup candidate should be removed');
  });

  test('--all-safe requires explicit dry-run or apply', () => {
    const r = runMc(['gc', '--all-safe', '--json'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: join(repo.root, 'pids') },
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--all-safe requires --dry-run or --apply/);
  });

  test('--dependency-snapshots previews old unlocked cache entries only', () => {
    const oldDigest = 'c'.repeat(64);
    const lockedDigest = 'd'.repeat(64);
    for (const digest of [oldDigest, lockedDigest]) {
      const path = join(repo.mcHome, 'dependency-snapshots', 'v1', 'npm', digest);
      mkdirSync(join(path, 'node_modules'), { recursive: true });
      writeFileSync(join(path, 'metadata.json'), JSON.stringify({
        schema_version: 1,
        fingerprint: `sha256:${digest}`,
        created_at: new Date().toISOString(),
      }));
    }
    const locks = join(repo.mcHome, 'dependency-snapshots', 'v1', 'locks');
    mkdirSync(locks, { recursive: true });
    writeFileSync(join(locks, `${lockedDigest}.lock`), '{}');

    const missingMode = runMc(['gc', '--dependency-snapshots', '--json'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome },
    });
    assert.equal(missingMode.status, 2);
    assert.match(missingMode.stderr, /requires --dry-run or --apply/);

    const preview = runMc(['gc', '--dependency-snapshots', '--dry-run', '--json', '--min-age', '0s'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome },
    });
    assert.equal(preview.status, 0, `stderr:${preview.stderr}`);
    const json = parseJsonOrNull(preview.stdout);
    assert.deepEqual(json.dependency_snapshots.candidates.map((item) => item.digest), [oldDigest]);
    assert.equal(existsSync(join(repo.mcHome, 'dependency-snapshots', 'v1', 'npm', oldDigest)), true);
  });

  test('--all-safe --apply reaps runtime and clean merged non-live worktrees only', () => {
    const pidDir = join(repo.root, 'pids');
    mkdirSync(pidDir, { recursive: true });
    const hostDir = join(repo.mcHome, 'hosts', 'sess_runtime_stale');
    mkdirSync(hostDir, { recursive: true });
    const digest = 'a'.repeat(64);
    const snapshotPath = join(repo.mcHome, 'dependency-snapshots', 'v1', 'npm', digest);
    mkdirSync(join(snapshotPath, 'node_modules'), { recursive: true });
    writeFileSync(join(snapshotPath, 'metadata.json'), JSON.stringify({
      schema_version: 1,
      fingerprint: `sha256:${digest}`,
      created_at: new Date().toISOString(),
    }));

    const r = runMc(['gc', '--all-safe', '--apply', '--json', '--min-age', '0s'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir },
      timeoutMs: 20_000,
    });

    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const j = parseJsonOrNull(r.stdout);
    assert.equal(j.ok, true);
    assert.equal(j.dependency_snapshots.removed.length, 1);
    assert.equal(existsSync(snapshotPath), false);
    assert.deepEqual(j.worktrees.removed.map((item) => item.name).sort(), ['gc1', 'gc3']);
    assert.equal(existsSync(hostDir), false);

    const wts = git(repo.dir, 'worktree list --porcelain');
    assert.ok(wts.includes('/worktrees/repo/gc2'), 'dirty worktree should be preserved');
    assert.ok(wts.includes('/worktrees/repo/gc4'), 'ahead worktree should be preserved');
  });
});
