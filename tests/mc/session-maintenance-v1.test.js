import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSessionHomeSync, sessionHomePaths } from '../../src/mc/session-home.js';
import {
  inspectSessionRuntimeArtifactsSync,
  repairSessionMaintenanceSync,
  scanSessionMaintenanceSync,
} from '../../src/mc/session-maintenance-v1.js';
import { writeRuntimeHostManifestSync } from '../../src/runtime/session-host/ephemeral-state.js';

const first = 'mcs_000000000000000000000001';
const second = 'mcs_000000000000000000000002';
const generation = 'mcg_000000000000000000000001';
const timestamp = '2026-08-04T12:00:00.000Z';
let roots = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

test('classifies terminal dead runtime artifacts as stale and a live host as active', () => {
  const mcHomeDir = home();
  session(mcHomeDir, first, 'first');
  terminalManifest(mcHomeDir, first, 51001);
  assert.equal(inspectSessionRuntimeArtifactsSync({
    mcHomeDir,
    mcSessionId: first,
    processIsAlive: () => false,
  }).state, 'stale');
  assert.equal(inspectSessionRuntimeArtifactsSync({
    mcHomeDir,
    mcSessionId: first,
    processIsAlive: (pid) => pid === 51001,
  }).state, 'active');
});

test('a live manifest whose host is gone is unsafe rather than silently reaped', () => {
  const mcHomeDir = home();
  session(mcHomeDir, first, 'first');
  writeRuntimeHostManifestSync({
    mcHomeDir,
    mcSessionId: first,
    generationId: generation,
    state: 'live',
    hostPid: 51001,
    processPid: 51002,
    cols: 80,
    rows: 24,
    startedAt: timestamp,
    updatedAt: timestamp,
  });
  const inspected = inspectSessionRuntimeArtifactsSync({
    mcHomeDir,
    mcSessionId: first,
    processIsAlive: () => false,
  });
  assert.equal(inspected.state, 'unsafe');
  assert.equal(inspected.reason, 'runtime-host-process-absent');
});

test('maintenance removes only stale session runtime homes and keeps active ones', () => {
  const mcHomeDir = home();
  session(mcHomeDir, first, 'first');
  session(mcHomeDir, second, 'second');
  terminalManifest(mcHomeDir, first, 51001);
  terminalManifest(mcHomeDir, second, 51002);
  const processIsAlive = (pid) => pid === 51002;

  const scan = scanSessionMaintenanceSync({ mcHomeDir, processIsAlive });
  assert.equal(scan.summary.runtime_stale, 1);
  assert.equal(scan.summary.runtime_active, 1);
  const planned = repairSessionMaintenanceSync({ mcHomeDir, apply: false, processIsAlive });
  assert.deepEqual(planned.actions.filter((item) => item.action === 'remove-stale-runtime-artifacts')
    .map((item) => item.mc_session_id), [first]);

  const applied = repairSessionMaintenanceSync({ mcHomeDir, apply: true, processIsAlive });
  assert.equal(applied.ok, true);
  assert.equal(existsSync(sessionHomePaths({ mcHomeDir, mcSessionId: first }).ephemeralRunPath), false);
  assert.equal(existsSync(sessionHomePaths({ mcHomeDir, mcSessionId: second }).ephemeralRunPath), true);
});

test('maintenance reports and safely reaps a terminal runtime home without a session', () => {
  const mcHomeDir = home();
  terminalManifest(mcHomeDir, first, 51001);
  const processIsAlive = () => false;
  const scan = scanSessionMaintenanceSync({ mcHomeDir, processIsAlive });
  assert.equal(scan.ok, false);
  assert.equal(scan.issues[0].reason, 'runtime-session-absent');
  const repaired = repairSessionMaintenanceSync({ mcHomeDir, apply: true, processIsAlive });
  assert.equal(repaired.ok, true);
  assert.equal(existsSync(sessionHomePaths({ mcHomeDir, mcSessionId: first }).ephemeralRunPath), false);
});

function home() {
  const root = mkdtempSync(join(tmpdir(), 'mc-session-maintenance-'));
  roots.push(root);
  return root;
}

function session(mcHomeDir, mcSessionId, name) {
  createSessionHomeSync({
    mcHomeDir,
    mcSessionId,
    sourceId: 'machine_test',
    name,
    now: () => timestamp,
  });
}

function terminalManifest(mcHomeDir, mcSessionId, hostPid) {
  writeRuntimeHostManifestSync({
    mcHomeDir,
    mcSessionId,
    generationId: generation,
    state: 'exited',
    hostPid,
    processPid: hostPid + 100,
    cols: 80,
    rows: 24,
    startedAt: timestamp,
    updatedAt: timestamp,
    exit: { exit_code: 0, signal: null, recorded_at: timestamp },
  });
}
