/**
 * CLI integration tests for `mc reconcile` (§9e).
 *
 * The subprocess CLI invokes the real `defaultGh()` portal — which
 * shells out to the real `gh` binary. We strip `gh` from PATH by
 * using the same safePath the rest of the lifecycle tests use,
 * which means every entry deterministically falls through to the
 * "no signals" bucket. That's enough to verify:
 *
 *   - empty registry → all buckets empty, exit 0
 *   - `--apply` without `--only-safe` → error
 *   - `--apply --only-safe` with no candidates → "nothing to do",
 *     exit 0 (the cron-safe acceptance bar)
 *   - `--json` output carries the documented shape
 *
 * The interesting classification logic is covered by the pure-helper
 * suite, where every dep is injected.
 */
import test, { describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runMc, parseJsonOrNull } from '../_helpers/cli.js';
import { makeTempRepo } from '../_helpers/git-fixture.js';
import { writeRegistry, makeEntry } from '../_helpers/registry-fixture.js';

describe('mc reconcile', () => {
  let repo, pidDir;
  beforeEach(() => {
    repo = makeTempRepo({ name: 'reconcile' });
    pidDir = mkdtempSync(join(tmpdir(), 'mc-reconcile-pid-'));
  });
  afterEach(() => {
    repo.cleanup();
    try { rmSync(pidDir, { recursive: true, force: true }); } catch {}
  });

  test('empty registry → all buckets empty, exit 0', () => {
    writeRegistry(repo.mcHome, []);
    const r = runMc(['reconcile', '--json'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir, HOME: repo.root },
    });
    assert.equal(r.status, 0, r.stderr);
    const j = parseJsonOrNull(r.stdout);
    assert.ok(j, r.stdout);
    assert.deepEqual(j.actions.safe_to_end, []);
    assert.deepEqual(j.actions.branch_merged_recently, []);
    assert.deepEqual(j.actions.verify_and_end, []);
    assert.deepEqual(j.deferred_categories, ['file-overlap']);
    assert.equal(j.cron_safe_action, 'safe_to_end');
  });

  test('--apply without --only-safe is rejected', () => {
    writeRegistry(repo.mcHome, []);
    const r = runMc(['reconcile', '--apply'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir, HOME: repo.root },
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /--apply requires --only-safe/);
  });

  test('--apply --only-safe with no candidates → "nothing to do", exit 0 (cron acceptance)', () => {
    writeRegistry(repo.mcHome, []);
    const r = runMc(['reconcile', '--apply', '--only-safe'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir, HOME: repo.root },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /nothing to do/);
  });

  test('human output renders all three buckets even when empty', () => {
    writeRegistry(repo.mcHome, []);
    const r = runMc(['reconcile'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir, HOME: repo.root },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Safe to end \(squash-phantoms\)/);
    assert.match(r.stdout, /Branch merged recently/);
    assert.match(r.stdout, /Verify and end \(transcript-mentions\)/);
    assert.match(r.stdout, /Deferred to v2: file-overlap/);
    // Authority-lives-in-the-verbs footer points at mc end / mc list.
    assert.match(r.stdout, /mc end <name>/);
    assert.match(r.stdout, /mc list --safe-to-end --names/);
  });

  test('non-work kinds (isolation, spawn) are filtered before classify', () => {
    writeRegistry(repo.mcHome, [
      makeEntry({ name: 'iso1', kind: 'isolation' }),
      makeEntry({ name: 'spawn1', kind: 'spawn' }),
    ]);
    const r = runMc(['reconcile', '--json'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir, HOME: repo.root },
    });
    const j = parseJsonOrNull(r.stdout);
    assert.equal(j.skipped.length, 0, 'iso/spawn should be filtered upstream, not skipped');
    assert.equal(j.actions.safe_to_end.length, 0);
  });

  test('rejects unknown flag', () => {
    const r = runMc(['reconcile', '--whatever'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir, HOME: repo.root },
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /unknown flag/);
  });
});
