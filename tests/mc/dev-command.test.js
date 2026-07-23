import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { run } from '../../src/mc/commands/dev.js';

function output() {
  let value = '';
  return {
    stream: { write(chunk) { value += String(chunk); } },
    read: () => value,
  };
}

describe('mc dev ensure command', () => {
  test('passes service, profile, and explicit restart through the command boundary', async () => {
    const stdout = output();
    const stderr = output();
    const plan = {
      service: { name: 'web' },
      profile: { name: 'agent' },
    };
    const calls = [];
    const code = await run(['ensure', 'web', '--profile', 'agent', '--restart', '--json'], {
      stdout: stdout.stream,
      stderr: stderr.stream,
      cwd: '/repo',
      resolveDevPlan: async (input) => {
        calls.push({ type: 'resolve', input });
        return plan;
      },
      ensureDevServer: async (resolved, options) => {
        calls.push({ type: 'ensure', resolved, options });
        return {
          ok: true,
          changed: true,
          action: 'restarted',
          server: { service: 'web', profile: 'agent', instance_id: 'dev-1' },
        };
      },
    });

    assert.equal(code, 0, stderr.read());
    assert.deepEqual(calls[0], {
      type: 'resolve',
      input: { cwd: '/repo', serviceName: 'web', profileName: 'agent' },
    });
    assert.equal(calls[1].resolved, plan);
    assert.equal(calls[1].options.restart, true);
    assert.equal(JSON.parse(stdout.read()).action, 'restarted');
  });

  test('keeps --restart scoped to ensure', async () => {
    const stdout = output();
    const stderr = output();
    const code = await run(['plan', '--restart'], {
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
    assert.equal(code, 2);
    assert.match(stderr.read(), /--restart is only valid with mc dev ensure/);
  });

  test('returns structured refusals without hiding the ensure reason', async () => {
    const stdout = output();
    const stderr = output();
    const code = await run(['ensure', '--json'], {
      stdout: stdout.stream,
      stderr: stderr.stream,
      resolveDevPlan: async () => ({ service: { name: 'web' }, profile: { name: 'agent' } }),
      ensureDevServer: async () => ({
        ok: false,
        changed: false,
        reason: 'server-plan-mismatch',
        error: 'profile differs',
      }),
    });
    assert.equal(code, 1);
    assert.equal(JSON.parse(stdout.read()).reason, 'server-plan-mismatch');
    assert.equal(stderr.read(), '');
  });
});
