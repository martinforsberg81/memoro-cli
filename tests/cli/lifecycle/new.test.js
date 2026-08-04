import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';

import { parseArgs, run } from '../../../src/cli/new.js';
import { listSessionHomesSync } from '../../../src/mc/session-home.js';
import { listWorkspaceAssociationsSync } from '../../../src/mc/workspace-record.js';
import { captureStream, makeV1Fixture } from './v1-fixture.js';

let fixtures = [];

afterEach(() => {
  for (const fixture of fixtures) fixture.cleanup();
  fixtures = [];
});

describe('mc new V1', () => {
  test('creates one source-owned session in cwd without Git resources', async () => {
    const fixture = makeFixture();
    const stdout = captureStream();
    const stderr = captureStream();
    const code = await run([
      'alpha',
      'Investigate lifecycle',
      '--tool', 'codex',
      '--no-launch',
      '--json',
    ], {
      mcHomeDir: fixture.mcHomeDir,
      cwd: fixture.workspace,
      stdout,
      stderr,
      ensureSentinel() {},
    });

    assert.equal(code, 0, stderr.text());
    const payload = JSON.parse(stdout.text());
    assert.equal(payload.name, 'alpha');
    assert.equal(payload.objective, 'Investigate lifecycle');
    assert.equal(payload.source_kind, 'local');
    assert.equal(payload.workspace_path, fixture.workspace);
    assert.equal(payload.launched, false);
    assert.match(payload.mc_session_id, /^mcs_[a-f0-9]{24}$/u);

    const listed = listSessionHomesSync({ mcHomeDir: fixture.mcHomeDir });
    assert.equal(listed.sessions.length, 1);
    assert.equal(listed.sessions[0].identity.owner.source_id, fixture.source.source_id);
    const workspaces = listWorkspaceAssociationsSync({
      mcHomeDir: fixture.mcHomeDir,
      mcSessionId: payload.mc_session_id,
    });
    assert.deepEqual(workspaces.workspaces.map((item) => item.current_path), [fixture.workspace]);
    assert.equal(workspaces.workspaces[0].ownership.kind, 'external');
    assert.equal(existsSync(join(fixture.workspace, '.git')), false);
    assert.equal(existsSync(join(fixture.mcHomeDir, 'worktrees')), false);
  });

  test('fails a duplicate source-local name without damaging the first session', async () => {
    const fixture = makeFixture();
    const deps = {
      mcHomeDir: fixture.mcHomeDir,
      cwd: fixture.workspace,
      stdout: captureStream(),
      stderr: captureStream(),
      ensureSentinel() {},
    };
    assert.equal(await run(['alpha', '--tool', 'codex', '--no-launch'], deps), 0);
    assert.equal(await run(['ALPHA', '--tool', 'codex', '--no-launch'], deps), 1);
    assert.equal(listSessionHomesSync({ mcHomeDir: fixture.mcHomeDir }).sessions.length, 1);
    assert.match(deps.stderr.text(), /name-claim-conflict/iu);
  });

  test('accepts only the certified tool choices and bounded arguments', () => {
    assert.deepEqual(parseArgs(['alpha', 'objective', '--claude']), {
      name: 'alpha',
      task: 'objective',
      tool: 'claude',
      noLaunch: false,
      json: false,
    });
    assert.match(parseArgs(['alpha', '--unknown-mode']).error, /unknown flag/iu);
    assert.match(parseArgs(['alpha', 'one', 'two']).error, /unexpected arg/iu);
  });

  test('rejects interactive JSON before creating session state', async () => {
    const stderr = captureStream();
    let touched = false;
    const code = await run(['alpha', '--json'], {
      stderr,
      checkAndPrintFreshInstall() { touched = true; },
      ensureV1SessionStorage() { touched = true; },
    });

    assert.equal(code, 2);
    assert.equal(touched, false);
    assert.match(stderr.text(), /--json requires --no-launch/iu);
  });
});

function makeFixture() {
  const fixture = makeV1Fixture('mc-new-v1-');
  fixtures.push(fixture);
  return fixture;
}
