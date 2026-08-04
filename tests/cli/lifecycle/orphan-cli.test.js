/**
 * CLI-level tests for §9j orphan daemon surfaces.
 *
 * V1 listing is projection-only and rejects the old orphan-probe flag.
 * Cleanup remains on `mc gc --reap-orphans` until its planned V1 cutover.
 * We can't fake `ps` over a subprocess boundary cheaply, so the gc cases
 * exercise dead-pid state: --dry-run does not unlink, while normal apply
 * removes the exact stale pidfile.
 *
 * Live-process orphan reaping (ppid=1 with mtime>minAge) is covered
 * end-to-end by the pure helper suite; here we only need to confirm
 * the CLI wires the helper, parses flags, and produces the documented
 * boundary.
 */
import test, { describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runMc, parseJsonOrNull } from '../../mc/_helpers/cli.js';
import { makeTempRepo } from '../../mc/_helpers/git-fixture.js';
import { writeRegistry } from '../../mc/_helpers/registry-fixture.js';

describe('mc list V1 diagnostics boundary', () => {
  let repo;
  let pidDir;

  beforeEach(() => {
    repo = makeTempRepo({ name: 'orphan-list' });
    pidDir = mkdtempSync(join(tmpdir(), 'mc-orphan-pid-'));
    writeRegistry(repo.mcHome, []); // empty registry is fine
  });
  afterEach(() => {
    repo.cleanup();
    try { rmSync(pidDir, { recursive: true, force: true }); } catch {}
  });

  test('rejects legacy orphan probes before reading pid state', () => {
    const pidfile = join(pidDir, 'heartbeat-abc.pid');
    writeFileSync(pidfile, '999999');
    const r = runMc(['list', '--orphans'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir },
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown flag: --orphans/);
    assert.ok(existsSync(pidfile));
  });
});

describe('mc gc --reap-orphans', () => {
  let repo;
  let pidDir;

  beforeEach(() => {
    repo = makeTempRepo({ name: 'orphan-gc' });
    pidDir = mkdtempSync(join(tmpdir(), 'mc-orphan-pid-'));
    writeRegistry(repo.mcHome, []);
  });
  afterEach(() => {
    repo.cleanup();
    try { rmSync(pidDir, { recursive: true, force: true }); } catch {}
  });

  test('--dry-run does not unlink stale pidfiles', () => {
    const f = join(pidDir, 'heartbeat-dry.pid');
    writeFileSync(f, '999999');
    const r = runMc(['gc', '--reap-orphans', '--dry-run', '--json'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir },
    });
    assert.equal(r.status, 0, r.stderr);
    const j = parseJsonOrNull(r.stdout);
    assert.ok(j, r.stdout);
    assert.equal(j.dry_run, true);
    assert.equal(j.stale.length, 1);
    assert.ok(existsSync(f), 'dry-run must leave pidfiles in place');
  });

  test('reaps stale pidfiles (dead pid)', () => {
    const f = join(pidDir, 'heartbeat-real.pid');
    writeFileSync(f, '999999');
    const r = runMc(['gc', '--reap-orphans', '--json'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir },
    });
    assert.equal(r.status, 0, r.stderr);
    const j = parseJsonOrNull(r.stdout);
    assert.ok(j, r.stdout);
    assert.equal(j.unlinked.length, 1);
    assert.equal(j.unlinked[0].removed, true);
    assert.ok(!existsSync(f), 'stale pidfile must be removed');
  });

  test('--min-age accepts duration shorthand', () => {
    const r = runMc(['gc', '--reap-orphans', '--min-age', '10m', '--dry-run', '--json'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir },
    });
    assert.equal(r.status, 0, r.stderr);
  });

  test('rejects unknown --min-age unit', () => {
    const r = runMc(['gc', '--reap-orphans', '--min-age', 'not-a-duration'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir },
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /--min-age/);
  });
});

// Make linter happy about utimesSync being imported but not used by every
// case; keep it for any future test that needs to backdate a pidfile.
void utimesSync;
