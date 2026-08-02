import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { run as runRestart } from '../../../src/cli/restart.js';
import { makeEntry } from '../../mc/_helpers/registry-fixture.js';

describe('mc restart', () => {
  const entry = makeEntry({
    name: 'target',
    session_id: 'mcs_aaaaaaaaaaaaaaaaaaaaaaaa',
    repository_id: 'repo_aaaaaaaaaaaaaaaaaaaaaaaa',
    worktree_path: '/mc/worktrees/repo/target',
  });

  function invoke(argv, overrides = {}) {
    const calls = { stops: [], opens: [] };
    let stdout = '';
    let stderr = '';
    const code = runRestart(argv, {
      cwd: '/elsewhere',
      stdout: { write: (chunk) => { stdout += chunk; } },
      stderr: { write: (chunk) => { stderr += chunk; } },
      readRegistry: () => ({ entries: [entry] }),
      removeBrokerSessionForEntry: async (target) => {
        calls.stops.push(target.name);
        return { ok: true, id: 'sess_x' };
      },
      runOpen: async (openArgv) => {
        calls.opens.push(openArgv);
        return 0;
      },
      ...overrides,
    });
    return code.then((value) => ({ code: value, calls, stdout, stderr }));
  }

  test('stops the running session, then delegates to open', async () => {
    const order = [];
    const result = await invoke(['target'], {
      removeBrokerSessionForEntry: async () => {
        order.push('stop');
        return { ok: true };
      },
      runOpen: async (openArgv) => {
        order.push('open');
        assert.deepEqual(openArgv, ['target']);
        return 0;
      },
    });

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(order, ['stop', 'open']);
    assert.match(result.stdout, /stopped target/);
  });

  test('a session that is not running skips the stop and just opens', async () => {
    const result = await invoke(['target'], {
      removeBrokerSessionForEntry: async () => ({ ok: false, skipped: true, reason: 'not-found' }),
    });

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(result.calls.opens, [['target']]);
    assert.doesNotMatch(result.stdout, /stopped/);
  });

  test('a runtime that exists but cannot be stopped refuses before touching anything', async () => {
    const result = await invoke(['target'], {
      removeBrokerSessionForEntry: async () => ({
        ok: false,
        reason: 'session-controller-capability-unavailable',
        error: 'authority unavailable',
      }),
    });

    assert.equal(result.code, 1);
    assert.deepEqual(result.calls.opens, []);
    assert.match(result.stderr, /could not stop/);
    assert.match(result.stderr, /session-controller-capability-unavailable/);
    assert.match(result.stderr, /nothing was changed/);
  });

  test('open flags pass through to the open path', async () => {
    const result = await invoke(['target', '--codex']);

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(result.calls.opens, [['target', '--codex']]);
  });

  test('an unknown session name fails with the resolution error', async () => {
    const result = await invoke(['nope']);

    assert.equal(result.code, 1);
    assert.deepEqual(result.calls.opens, []);
    assert.match(result.stderr, /nope/);
  });

  test('usage requires exactly one name', async () => {
    const none = await invoke([]);
    assert.equal(none.code, 2);
    const two = await invoke(['a', 'b']);
    assert.equal(two.code, 2);
  });
});
