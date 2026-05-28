/**
 * CLI-level tests for §9j orphan daemon surfaces.
 *
 * Drives the binary as a subprocess against a tmp pid dir populated
 * with synthetic heartbeat-*.pid files. We can't fake `ps` over a
 * subprocess boundary cheaply, so the cases here exercise the
 * always-true branches:
 *   - empty pid dir → "(no orphan daemons)" + clean stdout
 *   - dead-pid pidfile → bucketed as stale; --dry-run does NOT unlink;
 *     normal --reap-orphans DOES unlink and reports it
 *
 * Live-process orphan reaping (ppid=1 with mtime>minAge) is covered
 * end-to-end by the pure helper suite; here we only need to confirm
 * the CLI wires the helper, parses flags, and produces the documented
 * shape.
 */
import test, { describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runMc, parseJsonOrNull } from '../_helpers/cli.js';
import { makeTempRepo } from '../_helpers/git-fixture.js';
import { writeRegistry, makeEntry } from '../_helpers/registry-fixture.js';

describe('mc list --orphans', () => {
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

  test('empty pid dir → "(no orphan daemons)"', () => {
    const r = runMc(['list', '--orphans'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /no orphan daemons/);
  });

  test('--json shape: { orphan: [], stale: [] }', () => {
    const r = runMc(['list', '--orphans', '--json'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir },
    });
    const j = parseJsonOrNull(r.stdout);
    assert.ok(j, `expected JSON, got: ${r.stdout}`);
    assert.deepEqual(j.orphan, []);
    assert.deepEqual(j.stale, []);
  });

  test('dead-pid pidfile is bucketed as stale', () => {
    // PID 999999 is overwhelmingly unlikely to be alive on a test host.
    writeFileSync(join(pidDir, 'heartbeat-abc.pid'), '999999');
    const r = runMc(['list', '--orphans', '--json'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir },
    });
    const j = parseJsonOrNull(r.stdout);
    assert.ok(j, r.stdout);
    assert.equal(j.stale.length, 1);
    assert.equal(j.stale[0].llm_session_id, 'abc');
    assert.equal(j.stale[0].reason, 'dead-pid');
  });

  test('default mc list footer warns when orphans/stale present', () => {
    writeFileSync(join(pidDir, 'heartbeat-xyz.pid'), '999999');
    writeRegistry(repo.mcHome, [makeEntry({ name: 'one' })]);
    const r = runMc(['list'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /1 stale pidfile/);
    assert.match(r.stdout, /mc gc --reap-orphans/);
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
