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

describe('mc V1 storage / doctor / gc', () => {
  test('storage status reports only session-home and runtime maintenance state', () => {
    const fixture = setup();
    const { session } = fixture.create('alpha');
    terminalRuntime(fixture.mcHomeDir, session.mc_session_id);

    const result = cli(fixture, ['storage', 'status', '--json']);

    assert.equal(result.status, 0, result.stderr);
    const output = parseJsonOrNull(result.stdout);
    assert.equal(output.summary.sessions, 1);
    assert.equal(output.summary.runtime_stale, 1);
    assert.equal(output.summary.runtime_active, 0);
    assert.equal('registry_entries' in output.summary, false);
    assert.equal('dependency_snapshots' in output.summary, false);
  });

  test('storage explain resolves one exact local session without granting cleanup authority', () => {
    const fixture = setup();
    const { session } = fixture.create('alpha');

    const result = cli(fixture, ['storage', 'explain', 'alpha', '--json']);

    assert.equal(result.status, 0, result.stderr);
    const output = parseJsonOrNull(result.stdout);
    assert.equal(output.mc_session_id, session.mc_session_id);
    assert.equal(output.lifecycle, 'open');
    assert.equal(output.runtime_artifacts.state, 'absent');
    assert.deepEqual(output.owned_resources.plans, []);
  });

  test('storage repair plans and then removes only stale runtime artifacts', () => {
    const fixture = setup();
    const { session } = fixture.create('alpha');
    terminalRuntime(fixture.mcHomeDir, session.mc_session_id);
    const runtimePath = sessionHomePaths({
      mcHomeDir: fixture.mcHomeDir,
      mcSessionId: session.mc_session_id,
    }).ephemeralRunPath;

    const planned = cli(fixture, ['storage', 'repair', '--dry-run', '--json']);
    assert.equal(planned.status, 0, planned.stderr);
    assert.equal(parseJsonOrNull(planned.stdout).actions.some((action) => (
      action.action === 'remove-stale-runtime-artifacts'
      && action.mc_session_id === session.mc_session_id
    )), true);
    assert.equal(existsSync(runtimePath), true);

    const applied = cli(fixture, ['storage', 'repair', '--apply', '--json']);
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(parseJsonOrNull(applied.stdout).applied, true);
    assert.equal(existsSync(runtimePath), false);
    assert.equal(existsSync(fixture.workspace), true);
  });

  test('doctor applies the same bounded repair and leaves session data intact', () => {
    const fixture = setup();
    const { session } = fixture.create('alpha');
    terminalRuntime(fixture.mcHomeDir, session.mc_session_id);

    const result = cli(fixture, ['doctor', '--repair', '--json']);

    assert.equal(result.status, 0, result.stderr);
    const output = parseJsonOrNull(result.stdout);
    assert.equal(output.applied, true);
    assert.equal(output.summary.sessions, 1);
    assert.equal(output.summary.runtime_stale, 0);
    assert.equal(existsSync(fixture.workspace), true);
  });

  test('gc never treats an external workspace as cleanup authority', () => {
    const fixture = setup();
    const { session } = fixture.create('alpha');
    terminalRuntime(fixture.mcHomeDir, session.mc_session_id);

    const result = cli(fixture, ['gc', '--apply', '--json']);

    assert.equal(result.status, 0, result.stderr);
    const output = parseJsonOrNull(result.stdout);
    assert.equal(output.applied, true);
    assert.equal(output.summary.runtime_stale, 0);
    assert.equal(existsSync(fixture.workspace), true);
  });

  test('legacy registry and implicit worktree-cleanup options are rejected', () => {
    const fixture = setup();
    fixture.create('alpha');

    assert.equal(cli(fixture, ['storage', 'candidates', '--json']).status, 2);
    assert.equal(cli(fixture, ['storage', 'prune-deps', '--apply', '--json']).status, 2);
    assert.equal(cli(fixture, ['doctor', '--min-age', '0s', '--json']).status, 2);
    assert.equal(cli(fixture, ['gc', '--stale-worktrees', '--json']).status, 2);
  });
});

function setup() {
  const fixture = makeV1Fixture('mc-v1-storage-cli-');
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

function terminalRuntime(mcHomeDir, mcSessionId) {
  writeRuntimeHostManifestSync({
    mcHomeDir,
    mcSessionId,
    generationId,
    state: 'exited',
    hostPid: 2_147_483_647,
    processPid: 2_147_483_646,
    cols: 80,
    rows: 24,
    startedAt: timestamp,
    updatedAt: timestamp,
    exit: { exit_code: 0, signal: null, recorded_at: timestamp },
  });
}
