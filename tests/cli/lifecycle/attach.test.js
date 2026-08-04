import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import { parseArgs, run } from '../../../src/cli/attach.js';
import { captureStream, makeV1Fixture } from './v1-fixture.js';

let fixtures = [];

afterEach(() => {
  for (const fixture of fixtures) fixture.cleanup();
  fixtures = [];
});

describe('mc attach V1', () => {
  test('routes only to the exact machine-local session runtime', async () => {
    const fixture = makeFixture();
    const created = fixture.create('alpha');
    const calls = [];
    const code = await run(['alpha'], {
      mcHomeDir: fixture.mcHomeDir,
      stderr: captureStream(),
      stdin: { name: 'stdin' },
      stdout: { name: 'stdout' },
      attachTerminal: async (input) => { calls.push(input); return { ok: true, code: 7 }; },
    });
    assert.equal(code, 7);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].mcSessionId, created.session.mc_session_id);
    assert.equal(calls[0].mcHomeDir, fixture.mcHomeDir);
  });

  test('does not reinterpret a cloud identifier as local', async () => {
    const fixture = makeFixture();
    fixture.create('alpha');
    const stderr = captureStream();
    assert.equal(await run(['cloud:alpha'], {
      mcHomeDir: fixture.mcHomeDir,
      stderr,
      attachTerminal: async () => assert.fail('cloud must not reach the local socket'),
    }), 1);
    assert.match(stderr.text(), /not found|not-local/iu);
  });

  test('parses one bounded session identifier', () => {
    assert.deepEqual(parseArgs(['alpha']), { identifier: 'alpha' });
    assert.match(parseArgs(['alpha', 'beta']).error, /unexpected arg/iu);
    assert.match(parseArgs(['--unknown']).error, /unknown flag/iu);
  });
});

function makeFixture() {
  const fixture = makeV1Fixture('mc-attach-v1-');
  fixtures.push(fixture);
  return fixture;
}
