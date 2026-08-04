/**
 * CLI-level tests for §9j orphan daemon surfaces.
 *
 * V1 listing is projection-only and rejects the old orphan-probe flag.
 * PR10 removes the old daemon-pid cleanup surface from active `mc gc`.
 * These tests prove that neither listing nor maintenance reads or unlinks the
 * legacy orphan directory.
 */
import test, { describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runMc } from '../../mc/_helpers/cli.js';
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

describe('mc gc V1 orphan boundary', () => {
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

  test('rejects orphan and age flags without reading or unlinking pidfiles', () => {
    const f = join(pidDir, 'heartbeat-real.pid');
    writeFileSync(f, '999999');
    for (const args of [
      ['--reap-orphans'],
      ['--min-age', '10m'],
    ]) {
      const result = runMc(['gc', ...args, '--json'], {
        cwd: repo.dir,
        env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir },
      });
      assert.equal(result.status, 2);
    }
    assert.equal(existsSync(f), true);
  });
});
