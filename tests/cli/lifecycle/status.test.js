import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import { run } from '../../../src/cli/status.js';
import { writeSessionProjectionSync } from '../../../src/mc/session-home.js';
import { captureStream, makeV1Fixture } from './v1-fixture.js';

let fixtures = [];

afterEach(() => {
  for (const fixture of fixtures) fixture.cleanup();
  fixtures = [];
});

describe('mc status V1', () => {
  test('reports durable session-home, workspace, and journal state', async () => {
    const fixture = makeFixture();
    const created = fixture.create('alpha', { objective: 'Make lifecycle exact' });
    writeSessionProjectionSync({
      mcHomeDir: fixture.mcHomeDir,
      mcSessionId: created.session.mc_session_id,
      expectedRevision: 1,
      lifecycle: 'open',
      runtimeState: 'running',
      activeRuntimeGeneration: 'mcg_000000000000000000000001',
      tool: 'codex',
    });
    const stdout = captureStream();
    const stderr = captureStream();
    const code = await run(['alpha', '--json'], {
      mcHomeDir: fixture.mcHomeDir,
      stdout,
      stderr,
    });

    assert.equal(code, 0, stderr.text());
    const status = JSON.parse(stdout.text());
    assert.equal(status.mc_session_id, created.session.mc_session_id);
    assert.equal(status.source_kind, 'local');
    assert.equal(status.source_id, fixture.source.source_id);
    assert.equal(status.runtime_state, 'running');
    assert.equal(status.tool, 'codex');
    assert.equal(status.workspace_path, fixture.workspace);
    assert.equal(status.workspace_count, 1);
    assert.equal(status.objective, 'Make lifecycle exact');
    assert.equal(status.runtime.kind, 'present');
    assert.equal('repository' in status, false);
    assert.equal('branch' in status, false);
  });

  test('human output identifies source and opaque mc-id', async () => {
    const fixture = makeFixture();
    const created = fixture.create('alpha');
    const stdout = captureStream();
    assert.equal(await run(['alpha'], {
      mcHomeDir: fixture.mcHomeDir,
      stdout,
      stderr: captureStream(),
    }), 0);
    assert.match(stdout.text(), new RegExp(created.session.mc_session_id, 'u'));
    assert.match(stdout.text(), new RegExp(`local:${fixture.source.source_id}`, 'u'));
    assert.match(stdout.text(), /workspace\s+.*workspace/u);
  });

  test('fails clearly for an unknown local name', async () => {
    const fixture = makeFixture();
    const stderr = captureStream();
    assert.equal(await run(['ghost'], {
      mcHomeDir: fixture.mcHomeDir,
      stdout: captureStream(),
      stderr,
    }), 1);
    assert.match(stderr.text(), /not found/iu);
  });
});

function makeFixture() {
  const fixture = makeV1Fixture('mc-status-v1-');
  fixtures.push(fixture);
  return fixture;
}
