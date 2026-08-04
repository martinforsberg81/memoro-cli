import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { afterEach, describe, test } from 'node:test';

import { run as open } from '../../../src/cli/open.js';
import { run as resume } from '../../../src/cli/resume.js';
import { projectLocalSessionSync } from '../../../src/mc/session-v1.js';
import { listWorkspaceAssociationsSync } from '../../../src/mc/workspace-record.js';
import { captureStream, makeV1Fixture } from './v1-fixture.js';

let fixtures = [];

afterEach(() => {
  for (const fixture of fixtures) fixture.cleanup();
  fixtures = [];
});

describe('mc open/resume V1', () => {
  test('opens an unstarted session through the journal state machine', async () => {
    const fixture = makeFixture();
    const created = fixture.create('alpha');
    const stdout = captureStream();
    const stderr = captureStream();
    const code = await open(['alpha', '--no-launch', '--json'], {
      mcHomeDir: fixture.mcHomeDir,
      stdout,
      stderr,
    });
    assert.equal(code, 0, stderr.text());
    const payload = JSON.parse(stdout.text());
    assert.equal(payload.mc_session_id, created.session.mc_session_id);
    assert.equal(payload.action, 'start');
    assert.equal(payload.launch_cwd, fixture.workspace);
    assert.equal(payload.tool, 'codex');
  });

  test('associates another repository without changing session identity', async () => {
    const fixture = makeFixture();
    const created = fixture.create('alpha');
    const second = fixture.directory('second-repository');
    const stdout = captureStream();
    const code = await open(['alpha', '--cwd', second, '--no-launch', '--json'], {
      mcHomeDir: fixture.mcHomeDir,
      stdout,
      stderr: captureStream(),
    });
    assert.equal(code, 0);
    const payload = JSON.parse(stdout.text());
    assert.equal(payload.mc_session_id, created.session.mc_session_id);
    assert.equal(payload.workspace_path, second);
    const projected = projectLocalSessionSync(created.session, {
      mcHomeDir: fixture.mcHomeDir,
    });
    assert.equal(projected.workspace_path, second);
    assert.equal(projected.workspace_count, 2);
    assert.deepEqual(listWorkspaceAssociationsSync({
      mcHomeDir: fixture.mcHomeDir,
      mcSessionId: created.session.mc_session_id,
    }).workspaces.map((item) => item.current_path).sort(), [fixture.workspace, second].sort());
  });

  test('recovers from an absent old workspace only with an explicit new cwd', async () => {
    const fixture = makeFixture();
    fixture.create('alpha');
    rmSync(fixture.workspace, { recursive: true });
    const stderr = captureStream();
    assert.equal(await open(['alpha', '--no-launch'], {
      mcHomeDir: fixture.mcHomeDir,
      stdout: captureStream(),
      stderr,
    }), 1);
    assert.match(stderr.text(), /no present launch workspace/iu);

    const replacement = fixture.directory('replacement');
    assert.equal(await open(['alpha', '--cwd', replacement, '--no-launch'], {
      mcHomeDir: fixture.mcHomeDir,
      stdout: captureStream(),
      stderr,
    }), 0);
  });

  test('resume is an exact alias and cloud cannot enter the local runtime', async () => {
    const fixture = makeFixture();
    fixture.create('alpha');
    const calls = [];
    assert.equal(await resume(['alpha', '--no-launch'], {
      mcHomeDir: fixture.mcHomeDir,
      stdout: captureStream(),
      stderr: captureStream(),
      openRuntime: async (input) => {
        calls.push(input.session.mc_session_id);
        return { ok: true, code: 0, action: 'start' };
      },
    }), 0);
    assert.equal(calls.length, 1);

    const stderr = captureStream();
    assert.equal(await open(['cloud:alpha', '--no-launch'], {
      mcHomeDir: fixture.mcHomeDir,
      stdout: captureStream(),
      stderr,
      openRuntime: async () => assert.fail('cloud must not reach a local runtime'),
    }), 1);
    assert.match(stderr.text(), /cloud sessions.*cannot be opened/iu);
  });
});

function makeFixture() {
  const fixture = makeV1Fixture('mc-open-v1-');
  fixtures.push(fixture);
  return fixture;
}
