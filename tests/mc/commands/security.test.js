import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  parseArgs,
  run,
  runClaudeC1,
} from '../../../src/mc/commands/security.js';

function capture() {
  let stdout = '';
  let stderr = '';
  return {
    stdout: { write: (value) => { stdout += String(value); } },
    stderr: { write: (value) => { stderr += String(value); } },
    get stdoutText() { return stdout; },
    get stderrText() { return stderr; },
  };
}

function deadHostedSession(overrides = {}) {
  return {
    id: 'sess_c1_dead',
    label: 'c1-check',
    cwd: '/work/c1-check',
    session_state: 'dead',
    broker_socket_path: '/private/tmp/mc-c1-host.sock',
    ...overrides,
  };
}

describe('mc security claude-c1', () => {
  test('parses only the fixed C1 surface', () => {
    assert.deepEqual(parseArgs(['claude-c1', 'c1-check', '--json']), {
      identifier: 'c1-check', json: true,
    });
    assert.match(parseArgs(['claude-c1']).error, /requires a local session/);
    assert.match(parseArgs(['claude-c1', 'c1-check', '--path', '/tmp/no']).error, /unknown flag/);
    assert.match(parseArgs(['claude-c1', 'c1-check', '--env=TOKEN']).error, /unknown flag/);
    assert.match(parseArgs(['claude-c1', 'c1-check', 'secret-id']).error, /unexpected argument/);
    assert.match(parseArgs(['claude-c1', 'c1-check', '--json', '--json']).error, /duplicate flag/);
  });

  test('routes the exact controller-bound request to the resolved host and returns status only', async () => {
    const calls = [];
    const result = await runClaudeC1('c1-check', {
      listSessions: async (options) => {
        calls.push({ kind: 'list', options });
        return [deadHostedSession()];
      },
      resolveSessionControllerCapability: async (input) => {
        calls.push({ kind: 'authority', input });
        return { ok: true, capability: 'c'.repeat(64) };
      },
      request: async (message, options) => {
        calls.push({ kind: 'request', message, options });
        return { ok: true, status: 'passed', ignored_diagnostic: 'must-not-escape' };
      },
    });

    assert.deepEqual(result, { ok: true, status: 'passed' });
    assert.deepEqual(calls, [
      { kind: 'list', options: { request: calls[0].options.request, includeHosts: true } },
      { kind: 'authority', input: { codingSessionId: 'sess_c1_dead' } },
      {
        kind: 'request',
        message: {
          type: 'run_claude_c1',
          id: 'sess_c1_dead',
          session_controller_capability: 'c'.repeat(64),
        },
        options: {
          socketPath: '/private/tmp/mc-c1-host.sock',
          timeoutMs: 12 * 60_000,
        },
      },
    ]);
  });

  test('refuses before authority derivation and IPC while the ordinary provider remains live', async () => {
    let authorityCalls = 0;
    let requestCalls = 0;
    const result = await runClaudeC1('c1-check', {
      listSessions: async () => [deadHostedSession({ session_state: 'live' })],
      resolveSessionControllerCapability: async () => { authorityCalls += 1; return { ok: true, capability: 'x'.repeat(64) }; },
      request: async () => { requestCalls += 1; return { ok: true, status: 'passed' }; },
    });

    assert.deepEqual(result, { ok: false, status: 'indeterminate' });
    assert.equal(authorityCalls, 0);
    assert.equal(requestCalls, 0);
  });

  test('refuses while any other local mc provider remains live', async () => {
    let authorityCalls = 0;
    let requestCalls = 0;
    const result = await runClaudeC1('c1-check', {
      listSessions: async () => [
        deadHostedSession(),
        deadHostedSession({
          id: 'sess_other_live',
          label: 'other-live',
          cwd: '/work/other-live',
          session_state: 'live',
          broker_socket_path: '/private/tmp/mc-other-host.sock',
        }),
      ],
      resolveSessionControllerCapability: async () => {
        authorityCalls += 1;
        return { ok: true, capability: 'x'.repeat(64) };
      },
      request: async () => {
        requestCalls += 1;
        return { ok: true, status: 'passed' };
      },
    });

    assert.deepEqual(result, { ok: false, status: 'indeterminate' });
    assert.equal(authorityCalls, 0);
    assert.equal(requestCalls, 0);
  });

  test('renders the live-session repair instruction and never emits a capability or broker diagnostic', async () => {
    const io = capture();
    const code = await run(['claude-c1', 'c1-check'], {
      ...io,
      listSessions: async () => [deadHostedSession({ session_state: 'live' })],
      resolveSessionControllerCapability: async () => assert.fail('authority must not be derived'),
      request: async () => assert.fail('broker must not be called'),
    });

    assert.equal(code, 1);
    assert.equal(io.stdoutText, '');
    assert.match(io.stderrText, /exit the ordinary LLM session first/i);
    assert.doesNotMatch(io.stderrText, /capability|token|secret/i);
  });

  test('JSON is exactly the two-field status contract even when the broker returns extra data', async () => {
    const io = capture();
    const rawSecret = 'credential-that-must-not-render';
    const code = await run(['claude-c1', 'c1-check', '--json'], {
      ...io,
      listSessions: async () => [deadHostedSession()],
      resolveSessionControllerCapability: async () => ({ ok: true, capability: 'd'.repeat(64) }),
      request: async () => ({ ok: false, status: 'indeterminate', diagnostic: rawSecret }),
    });

    assert.equal(code, 1);
    assert.equal(io.stderrText, '');
    assert.deepEqual(JSON.parse(io.stdoutText), { ok: false, status: 'indeterminate' });
    assert.equal(io.stdoutText.includes(rawSecret), false);
  });

  test('rejects unknown arguments before local discovery, authority derivation, or broker IPC', async () => {
    const io = capture();
    let calls = 0;
    const code = await run(['claude-c1', 'c1-check', '--tool', 'claude'], {
      ...io,
      listSessions: async () => { calls += 1; return []; },
      resolveSessionControllerCapability: async () => { calls += 1; return null; },
      request: async () => { calls += 1; return null; },
    });

    assert.equal(code, 2);
    assert.match(io.stderrText, /unknown flag: --tool/);
    assert.equal(calls, 0);
  });

  test('requires one exact local session rather than selecting a duplicate label', async () => {
    let authorityCalls = 0;
    const result = await runClaudeC1('same-label', {
      listSessions: async () => [
        deadHostedSession({ id: 'sess_one', label: 'same-label' }),
        deadHostedSession({ id: 'sess_two', label: 'same-label' }),
      ],
      resolveSessionControllerCapability: async () => { authorityCalls += 1; return null; },
      request: async () => assert.fail('broker must not be called'),
    });
    assert.deepEqual(result, { ok: false, status: 'failed' });
    assert.equal(authorityCalls, 0);
  });
});
