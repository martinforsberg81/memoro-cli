import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import { run } from '../../../src/cli/rename.js';
import { resolveSessionHomeSync, sessionHomePaths } from '../../../src/mc/session-home.js';
import { listWorkspaceAssociationsSync } from '../../../src/mc/workspace-record.js';
import { captureStream, makeV1Fixture } from './v1-fixture.js';

let fixtures = [];

afterEach(() => {
  for (const fixture of fixtures) fixture.cleanup();
  fixtures = [];
});

describe('mc rename V1', () => {
  test('renames metadata and name claim without moving identity or workspace', async () => {
    const fixture = makeFixture();
    const created = fixture.create('alpha');
    const homeBefore = sessionHomePaths({
      mcHomeDir: fixture.mcHomeDir,
      mcSessionId: created.session.mc_session_id,
    }).home;
    const stdout = captureStream();
    const stderr = captureStream();
    const code = await run(['alpha', 'beta', '--json'], {
      mcHomeDir: fixture.mcHomeDir,
      stdout,
      stderr,
    });

    assert.equal(code, 0, stderr.text());
    const payload = JSON.parse(stdout.text());
    assert.equal(payload.mc_session_id, created.session.mc_session_id);
    assert.equal(payload.old_name, 'alpha');
    assert.equal(payload.new_name, 'beta');
    assert.equal(resolveSessionHomeSync('alpha', { mcHomeDir: fixture.mcHomeDir }).ok, false);
    const renamed = resolveSessionHomeSync('beta', { mcHomeDir: fixture.mcHomeDir });
    assert.equal(renamed.session.mc_session_id, created.session.mc_session_id);
    assert.equal(sessionHomePaths({
      mcHomeDir: fixture.mcHomeDir,
      mcSessionId: created.session.mc_session_id,
    }).home, homeBefore);
    assert.deepEqual(listWorkspaceAssociationsSync({
      mcHomeDir: fixture.mcHomeDir,
      mcSessionId: created.session.mc_session_id,
    }).workspaces.map((item) => item.current_path), [fixture.workspace]);
  });

  test('rejects duplicate and unknown source-local names', async () => {
    const fixture = makeFixture();
    fixture.create('alpha');
    fixture.create('beta', { cwd: fixture.directory('beta-workspace') });
    const stderr = captureStream();
    assert.equal(await run(['alpha', 'beta'], {
      mcHomeDir: fixture.mcHomeDir,
      stdout: captureStream(),
      stderr,
    }), 1);
    assert.match(stderr.text(), /name-(?:claim-)?conflict/iu);
    assert.equal(await run(['ghost', 'new-name'], {
      mcHomeDir: fixture.mcHomeDir,
      stdout: captureStream(),
      stderr,
    }), 1);
    assert.match(stderr.text(), /not found/iu);
  });
});

function makeFixture() {
  const fixture = makeV1Fixture('mc-rename-v1-');
  fixtures.push(fixture);
  return fixture;
}
