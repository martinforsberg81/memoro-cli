import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { afterEach, describe, test } from 'node:test';

import { run } from '../../../src/cli/cd.js';
import { associateLocalWorkspaceSync } from '../../../src/mc/session-v1.js';
import { captureStream, makeV1Fixture } from './v1-fixture.js';

let fixtures = [];

afterEach(() => {
  for (const fixture of fixtures) fixture.cleanup();
  fixtures = [];
});

describe('mc cd V1', () => {
  test('prints the preferred associated directory without assuming a worktree', async () => {
    const fixture = makeFixture();
    fixture.create('alpha');
    const stdout = captureStream();
    const stderr = captureStream();
    const code = await run(['alpha'], {
      mcHomeDir: fixture.mcHomeDir,
      stdout,
      stderr,
      emitCd: () => false,
    });
    assert.equal(code, 0, stderr.text());
    assert.equal(stdout.text(), `${fixture.workspace}\n`);
  });

  test('selects one of several workspace associations by opaque id', async () => {
    const fixture = makeFixture();
    const created = fixture.create('alpha');
    const otherPath = fixture.directory('second-repository');
    const other = associateLocalWorkspaceSync({
      mcHomeDir: fixture.mcHomeDir,
      session: created.session,
      cwd: otherPath,
    });
    let emitted = null;
    const code = await run(['alpha', '--workspace', other.workspace_id], {
      mcHomeDir: fixture.mcHomeDir,
      stdout: captureStream(),
      stderr: captureStream(),
      emitCd(path) { emitted = path; return true; },
    });
    assert.equal(code, 0);
    assert.equal(emitted, otherPath);
  });

  test('fails closed for an absent associated path', async () => {
    const fixture = makeFixture();
    const created = fixture.create('alpha');
    rmSync(fixture.workspace, { recursive: true });
    const stderr = captureStream();
    const code = await run(['alpha', '--workspace', created.workspace.workspace_id], {
      mcHomeDir: fixture.mcHomeDir,
      stdout: captureStream(),
      stderr,
      emitCd: () => assert.fail('must not emit a missing path'),
    });
    assert.equal(code, 1);
    assert.match(stderr.text(), /workspace is missing/iu);
  });
});

function makeFixture() {
  const fixture = makeV1Fixture('mc-cd-v1-');
  fixtures.push(fixture);
  return fixture;
}
