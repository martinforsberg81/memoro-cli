import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { existsSync } from 'node:fs';

import { parseJsonOrNull, runMc } from '../../mc/_helpers/cli.js';
import { makeV1Fixture } from './v1-fixture.js';
import { sessionHomePaths } from '../../../src/mc/session-home.js';
import { writeRuntimeHostManifestSync } from '../../../src/runtime/session-host/ephemeral-state.js';

const generationId = 'mcg_000000000000000000000001';
const timestamp = '2026-08-04T12:00:00.000Z';
let fixtures = [];

afterEach(() => {
  for (const fixture of fixtures) fixture.cleanup();
  fixtures = [];
});

describe('mc gc V1', () => {
  test('dry-run reports exact stale runtime artifacts without removing them', () => {
    const fixture = setup();
    const { session } = fixture.create('alpha');
    terminalRuntime(fixture.mcHomeDir, session.mc_session_id);
    const runtimePath = runPath(fixture, session.mc_session_id);

    const result = cli(fixture, ['gc', '--dry-run', '--json']);

    assert.equal(result.status, 0, result.stderr);
    const output = parseJsonOrNull(result.stdout);
    assert.equal(output.applied, false);
    assert.deepEqual(output.actions.filter((action) => action.safe).map((action) => ({
      action: action.action,
      mc_session_id: action.mc_session_id,
    })), [{
      action: 'remove-stale-runtime-artifacts',
      mc_session_id: session.mc_session_id,
    }]);
    assert.equal(existsSync(runtimePath), true);
  });

  test('apply removes only stale runtime artifacts and preserves external workspaces', () => {
    const fixture = setup();
    const { session } = fixture.create('alpha');
    terminalRuntime(fixture.mcHomeDir, session.mc_session_id);

    const result = cli(fixture, ['gc', '--apply', '--json']);

    assert.equal(result.status, 0, result.stderr);
    const output = parseJsonOrNull(result.stdout);
    assert.equal(output.applied, true);
    assert.equal(output.summary.runtime_stale, 0);
    assert.equal(existsSync(runPath(fixture, session.mc_session_id)), false);
    assert.equal(existsSync(fixture.workspace), true);
  });

  test('gc defaults to a non-mutating plan', () => {
    const fixture = setup();
    const { session } = fixture.create('alpha');
    terminalRuntime(fixture.mcHomeDir, session.mc_session_id);

    const result = cli(fixture, ['gc', '--json']);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(parseJsonOrNull(result.stdout).applied, false);
    assert.equal(existsSync(runPath(fixture, session.mc_session_id)), true);
  });

  test('an unsafe live manifest is reported and never reaped', () => {
    const fixture = setup();
    const { session } = fixture.create('alpha');
    liveRuntime(fixture.mcHomeDir, session.mc_session_id);

    const result = cli(fixture, ['gc', '--apply', '--json']);

    assert.equal(result.status, 1);
    const output = parseJsonOrNull(result.stdout);
    assert.equal(output.summary.runtime_unsafe, 1);
    assert.equal(output.issues.some((issue) => issue.reason === 'runtime-host-process-absent'), true);
    assert.equal(existsSync(runPath(fixture, session.mc_session_id)), true);
  });

  test('legacy implicit cleanup and orphan-reaping flags are rejected', () => {
    const fixture = setup();
    fixture.create('alpha');

    for (const args of [
      ['--stale-worktrees'],
      ['--all-safe', '--apply'],
      ['--reap-orphans'],
      ['--sidecars'],
      ['--runtime'],
      ['--dependency-snapshots'],
      ['--min-age', '0s'],
    ]) {
      assert.equal(cli(fixture, ['gc', ...args, '--json']).status, 2);
    }
  });
});

function setup() {
  const fixture = makeV1Fixture('mc-v1-gc-cli-');
  fixtures.push(fixture);
  return fixture;
}

function cli(fixture, args) {
  return runMc(args, {
    cwd: fixture.workspace,
    env: { MC_HOME: fixture.mcHomeDir },
    timeoutMs: 30_000,
  });
}

function runPath(fixture, mcSessionId) {
  return sessionHomePaths({
    mcHomeDir: fixture.mcHomeDir,
    mcSessionId,
  }).ephemeralRunPath;
}

function terminalRuntime(mcHomeDir, mcSessionId) {
  runtime(mcHomeDir, mcSessionId, 'exited', {
    exit: { exit_code: 0, signal: null, recorded_at: timestamp },
  });
}

function liveRuntime(mcHomeDir, mcSessionId) {
  runtime(mcHomeDir, mcSessionId, 'live');
}

function runtime(mcHomeDir, mcSessionId, state, extra = {}) {
  writeRuntimeHostManifestSync({
    mcHomeDir,
    mcSessionId,
    generationId,
    state,
    hostPid: 2_147_483_647,
    processPid: 2_147_483_646,
    cols: 80,
    rows: 24,
    startedAt: timestamp,
    updatedAt: timestamp,
    ...extra,
  });
}
