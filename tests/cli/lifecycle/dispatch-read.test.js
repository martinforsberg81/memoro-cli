import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import { run as dispatch } from '../../../src/cli/dispatch.js';
import { run as read } from '../../../src/cli/read.js';
import { captureStream, makeV1Fixture } from './v1-fixture.js';

let fixtures = [];

afterEach(() => {
  for (const fixture of fixtures) fixture.cleanup();
  fixtures = [];
});

describe('mc local send/read V1', () => {
  test('sends input directly to each exact local session runtime', async () => {
    const fixture = makeFixture();
    const alpha = fixture.create('alpha');
    const beta = fixture.create('beta', { cwd: fixture.directory('beta') });
    const calls = [];
    const stdout = captureStream();
    const stderr = captureStream();
    const code = await dispatch(['alpha', 'beta', '--message', 'Continue now', '--json'], {
      mcHomeDir: fixture.mcHomeDir,
      stdout,
      stderr,
      sendInput: async (input) => {
        calls.push(input);
        return { ok: true, generation_id: 'mcg_000000000000000000000001' };
      },
    });

    assert.equal(code, 0, stderr.text());
    assert.deepEqual(calls.map((call) => call.mcSessionId), [
      alpha.session.mc_session_id,
      beta.session.mc_session_id,
    ]);
    assert.deepEqual(calls.map((call) => call.message), ['Continue now', 'Continue now']);
    assert.equal(JSON.parse(stdout.text()).ok, true);
  });

  test('reads the bounded current screen from the exact local host', async () => {
    const fixture = makeFixture();
    const created = fixture.create('alpha');
    const stdout = captureStream();
    const code = await read(['alpha', '--last', '3', '--json'], {
      mcHomeDir: fixture.mcHomeDir,
      stdout,
      stderr: captureStream(),
      readScreen: async (input) => ({
        ok: true,
        mc_session_id: input.mcSessionId,
        generation_id: 'mcg_000000000000000000000001',
        text: 'screen state',
      }),
    });
    assert.equal(code, 0);
    const payload = JSON.parse(stdout.text());
    assert.equal(payload.mc_session_id, created.session.mc_session_id);
    assert.equal(payload.text, 'screen state');
  });

  test('never falls back from cloud or unknown identifiers to local runtime control', async () => {
    const fixture = makeFixture();
    fixture.create('alpha');
    let calls = 0;
    const stderr = captureStream();
    assert.equal(await dispatch(['cloud:alpha', '--message', 'hello'], {
      mcHomeDir: fixture.mcHomeDir,
      stdout: captureStream(),
      stderr,
      sendInput: async () => { calls += 1; return { ok: true }; },
    }), 1);
    assert.equal(await read(['cloud:alpha'], {
      mcHomeDir: fixture.mcHomeDir,
      stdout: captureStream(),
      stderr,
      readScreen: async () => { calls += 1; return { ok: true, text: '' }; },
    }), 1);
    assert.equal(await read(['ghost'], {
      mcHomeDir: fixture.mcHomeDir,
      stdout: captureStream(),
      stderr,
      readScreen: async () => { calls += 1; return { ok: true, text: '' }; },
    }), 1);
    assert.equal(calls, 0);
    assert.match(stderr.text(), /unavailable|not found/iu);
  });
});

function makeFixture() {
  const fixture = makeV1Fixture('mc-send-read-v1-');
  fixtures.push(fixture);
  return fixture;
}
