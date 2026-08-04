import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { existsSync } from 'node:fs';

import { parseJsonOrNull, runMc } from '../../mc/_helpers/cli.js';
import { makeV1Fixture } from './v1-fixture.js';
import { readSessionHomeSync } from '../../../src/mc/session-home.js';

let fixtures = [];

afterEach(() => {
  for (const fixture of fixtures) fixture.cleanup();
  fixtures = [];
});

describe('mc end/delete V1', () => {
  test('end archives one exact local session and keeps its external workspace', () => {
    const fixture = setup();
    const { session } = fixture.create('alpha');

    const result = cli(fixture, ['end', 'alpha', '--json']);

    assert.equal(result.status, 0, result.stderr);
    const output = parseJsonOrNull(result.stdout);
    assert.equal(output.mc_session_id, session.mc_session_id);
    assert.equal(output.lifecycle, 'archived');
    assert.equal(readSessionHomeSync({
      mcHomeDir: fixture.mcHomeDir,
      mcSessionId: session.mc_session_id,
    }).projection.lifecycle, 'archived');
    assert.equal(existsSync(fixture.workspace), true);
  });

  test('delete is explicit, requires force, and preserves external workspaces', () => {
    const fixture = setup();
    const { session } = fixture.create('alpha');

    assert.equal(cli(fixture, ['delete', 'alpha', '--json']).status, 2);
    assert.equal(cli(fixture, ['delete', 'alpha', '--force', '--json']).status, 1);
    assert.equal(cli(fixture, ['end', 'alpha', '--json']).status, 0);

    const deleted = cli(fixture, ['delete', 'alpha', '--force', '--json']);
    assert.equal(deleted.status, 0, deleted.stderr);
    assert.equal(parseJsonOrNull(deleted.stdout).mc_session_id, session.mc_session_id);
    assert.equal(readSessionHomeSync({
      mcHomeDir: fixture.mcHomeDir,
      mcSessionId: session.mc_session_id,
    }).kind, 'absent');
    assert.equal(existsSync(fixture.workspace), true);
  });

  test('end requires an explicit session and never auto-detects a worktree', () => {
    const fixture = setup();
    fixture.create('alpha');

    assert.equal(cli(fixture, ['end']).status, 2);
    assert.equal(cli(fixture, ['end', '.']).status, 1);
  });

  test('legacy destructive end options are rejected before session mutation', () => {
    const fixture = setup();
    const { session } = fixture.create('alpha');

    for (const flag of ['--force', '--keep-branch', '--dry-run']) {
      assert.equal(cli(fixture, ['end', 'alpha', flag, '--json']).status, 2);
    }
    assert.equal(readSessionHomeSync({
      mcHomeDir: fixture.mcHomeDir,
      mcSessionId: session.mc_session_id,
    }).projection.lifecycle, 'open');
  });

  test('unknown local sessions fail without changing another session', () => {
    const fixture = setup();
    const { session } = fixture.create('alpha');

    const result = cli(fixture, ['end', 'missing', '--json']);

    assert.equal(result.status, 1);
    assert.equal(parseJsonOrNull(result.stdout).reason, 'absent');
    assert.equal(readSessionHomeSync({
      mcHomeDir: fixture.mcHomeDir,
      mcSessionId: session.mc_session_id,
    }).projection.lifecycle, 'open');
  });
});

function setup() {
  const fixture = makeV1Fixture('mc-v1-end-cli-');
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
