import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { runGitHubShim } from '../../src/mc/github-shim.js';

function capture() {
  let stdout = '';
  let stderr = '';
  return {
    stdout: { write: (value) => { stdout += String(value); } },
    stderr: { write: (value) => { stderr += String(value); } },
    get out() { return stdout; },
    get err() { return stderr; },
  };
}

function portal(responses = {}) {
  const io = capture();
  const calls = [];
  const result = {
    stdout: io.stdout,
    stderr: io.stderr,
    calls,
    executeGitHubOperation: async ({ operation, params }) => {
      calls.push({ operation, params });
      return responses[operation] || {
        ok: true,
        request_id: 'request_abcdefgh',
        data: {},
      };
    },
  };
  Object.defineProperties(result, {
    out: { get: () => io.out },
    err: { get: () => io.err },
  });
  return result;
}

describe('session-scoped gh compatibility shim', () => {
  test('auth status is redacted and explicitly identifies the Memoro GitHub App', async () => {
    const deps = portal({
      'connection.status': {
        ok: true,
        request_id: 'request_abcdefgh',
        data: {
          schema: 1,
          state: 'ready',
          actor: { type: 'installation', login: 'memoro[bot]' },
          repository: { id: 301, full_name: 'acme/widgets' },
          operations: ['connection.status'],
        },
      },
    });
    const code = await runGitHubShim(['auth', 'status'], deps);

    assert.equal(code, 0);
    assert.deepEqual(deps.calls, [{ operation: 'connection.status', params: {} }]);
    assert.match(deps.out, /Memoro GitHub App/);
    assert.match(deps.out, /acme\/widgets/);
    assert.doesNotMatch(deps.out, /token|credential/i);
    assert.equal(deps.err, '');
  });

  test('maps the complete allowlisted PR surface to typed operations', async () => {
    const deps = portal({
      'pull_request.list': { ok: true, request_id: 'request_list1', data: { pull_requests: [] } },
      'pull_request.view': { ok: true, request_id: 'request_view1', data: { number: 7, title: 'Seven' } },
      'checks.list': { ok: true, request_id: 'request_check1', data: { pull_number: 7, checks: [], statuses: [] } },
    });

    assert.equal(await runGitHubShim(['pr', 'list', '--state', 'all', '--author', 'octocat', '--limit', '5', '--json'], deps), 0);
    assert.equal(await runGitHubShim(['pr', 'view', '7', '--json'], deps), 0);
    assert.equal(await runGitHubShim(['pr', 'checks', '7', '--json'], deps), 0);
    assert.deepEqual(deps.calls, [
      { operation: 'pull_request.list', params: { state: 'all', author: 'octocat', limit: 5 } },
      { operation: 'pull_request.view', params: { pull_number: 7 } },
      { operation: 'checks.list', params: { pull_number: 7 } },
    ]);
  });

  test('maps narrow gh pr create to one exact typed write with idempotent retry', async () => {
    const deps = portal();
    deps.resolveGitHubCreateContext = async ({ base }) => ({
      head: 'agent/write',
      base,
      expected_head_sha: 'a'.repeat(40),
      expected_base_sha: 'b'.repeat(40),
    });
    deps.executeGitHubOperation = async (request) => {
      deps.calls.push(request);
      if (request.operation === 'repository.metadata') {
        return {
          ok: true,
          request_id: request.requestId,
          data: { default_branch: 'main' },
        };
      }
      if (deps.calls.filter((call) => call.operation === 'pull_request.create').length === 1) {
        return {
          ok: false,
          request_id: request.requestId,
          error: { code: 'unavailable', message: 'lost response', repair_action: 'retry' },
        };
      }
      return {
        ok: true,
        request_id: request.requestId,
        data: {
          number: 17,
          title: 'Safe draft',
          draft: true,
          url: 'https://github.com/acme/widgets/pull/17',
        },
      };
    };
    let next = 0;
    deps.makeRequestId = () => `request_write_${++next}abcdefgh`;

    const code = await runGitHubShim([
      'pr', 'create',
      '--title', 'Safe draft',
      '--body', 'Exact body',
      '--draft',
    ], deps);

    assert.equal(code, 0);
    assert.match(deps.out, /https:\/\/github\.com\/acme\/widgets\/pull\/17/);
    assert.equal(deps.err, '');
    assert.equal(deps.calls.length, 3);
    assert.deepEqual(deps.calls.slice(1), [
      {
        operation: 'pull_request.create',
        params: {
          title: 'Safe draft',
          body: 'Exact body',
          head: 'agent/write',
          base: 'main',
          draft: true,
          expected_head_sha: 'a'.repeat(40),
          expected_base_sha: 'b'.repeat(40),
        },
        requestId: 'request_write_2abcdefgh',
      },
      {
        operation: 'pull_request.create',
        params: {
          title: 'Safe draft',
          body: 'Exact body',
          head: 'agent/write',
          base: 'main',
          draft: true,
          expected_head_sha: 'a'.repeat(40),
          expected_base_sha: 'b'.repeat(40),
        },
        requestId: 'request_write_2abcdefgh',
      },
    ]);
  });

  test('exposes pr update only through the restricted managed mc wrapper mode', async () => {
    const denied = portal();
    assert.equal(await runGitHubShim([
      'pr', 'update', '17', '--title', 'Updated title',
    ], denied), 2);
    assert.equal(denied.calls.length, 0);

    const managed = portal({
      'pull_request.view': {
        ok: true,
        request_id: 'request_view_update',
        data: {
          number: 17,
          head: { sha: 'a'.repeat(40) },
          updated_at: '2026-07-30T10:00:00.000Z',
        },
      },
      'pull_request.update': {
        ok: true,
        request_id: 'request_update',
        data: { number: 17, title: 'Updated title' },
      },
    });
    let next = 0;
    managed.makeRequestId = () => `request_update_${++next}abcdefgh`;

    assert.equal(await runGitHubShim([
      'pr', 'update', '17', '--title', 'Updated title',
    ], {
      ...managed,
      allowUpdate: true,
    }), 0);
    assert.deepEqual(managed.calls.map(({ operation }) => operation), [
      'pull_request.view',
      'pull_request.update',
    ]);
  });

  test('rejects every non-allowlisted surface without invoking or falling through', async () => {
    const cases = [
      ['auth', 'token'],
      ['auth', 'status', '--show-token'],
      ['api', '/user'],
      ['extension', 'list'],
      ['alias', 'list'],
      ['pr', 'create', '--title', 'missing body'],
      ['pr', 'create', '--title', 'x', '--body', 'y', '--head', 'other'],
      ['pr', 'create', '--title', 'x', '--body', 'y', '--repo', 'acme/other'],
      ['pr', 'merge', '7'],
      ['pr', 'list', '--repo', 'acme/other'],
      ['pr', 'list', '--unknown'],
      ['repo', 'view'],
      ['secret-sentinel-command'],
    ];

    for (const argv of cases) {
      const deps = portal();
      const code = await runGitHubShim(argv, deps);
      assert.equal(code, 2, argv.join(' '));
      assert.equal(deps.calls.length, 0, argv.join(' '));
      assert.equal(deps.out, '', argv.join(' '));
      assert.match(deps.err, /mc github/i, argv.join(' '));
      assert.doesNotMatch(deps.err, /gh auth login|passthrough|real gh/i, argv.join(' '));
    }
  });

  test('broker errors use stable repair guidance and never echo hostile data', async () => {
    const deps = portal({
      'pull_request.view': {
        ok: false,
        request_id: 'request_abcdefgh',
        error: { code: 'unavailable', message: 'Temporarily unavailable.', repair_action: 'retry' },
      },
    });
    const code = await runGitHubShim(['pr', 'view', '7'], deps);

    assert.equal(code, 1);
    assert.equal(deps.out, '');
    assert.match(deps.err, /mc github status/);
    assert.doesNotMatch(deps.err, /login|token/i);
  });
});
