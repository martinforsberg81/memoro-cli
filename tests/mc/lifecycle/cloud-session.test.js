import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  cloudPolicyForLaunch,
  parseArgs,
  runCloudSessionWith,
  validateCloudSessionOptions,
} from '../../../src/mc/commands/cloud-session.js';

function io() {
  let stdout = '';
  let stderr = '';
  return {
    stdout: {
      columns: 100,
      rows: 30,
      write: (s) => { stdout += s; },
    },
    stderr: {
      write: (s) => { stderr += s; },
    },
    out: () => stdout,
    err: () => stderr,
  };
}

describe('mc cloud-session parseArgs', () => {
  test('parses structured start fields', () => {
    const opts = parseArgs([
      'start',
      '--cloud-session-id',
      'cld_123456',
      '--coding-session-id',
      'sess_server123',
      '--name',
      'cloud_coord',
      '--task',
      'Analyse cloud mc',
      '--tool',
      'codex',
      '--policy',
      'workspace-write',
      '--repo-ref',
      'memoro',
      '--workspace-ref',
      'main',
      '--json',
    ]);

    assert.equal(opts.verb, 'start');
    assert.equal(opts.cloudSessionId, 'cld_123456');
    assert.equal(opts.codingSessionId, 'sess_server123');
    assert.equal(opts.name, 'cloud_coord');
    assert.equal(opts.task, 'Analyse cloud mc');
    assert.equal(opts.tool, 'codex');
    assert.equal(opts.policy, 'workspace-write');
    assert.equal(opts.repoRef, 'memoro');
    assert.equal(opts.workspaceRef, 'main');
    assert.equal(opts.json, true);
  });

  test('rejects free command flags', () => {
    assert.match(parseArgs(['start', '--cmd', 'bash']).error, /free command field/);
    assert.match(parseArgs(['start', '--shell', '/bin/zsh']).error, /free command field/);
    assert.match(parseArgs(['start', '--cwd', '/tmp']).error, /free command field/);
    assert.match(parseArgs(['start', '--env', 'X=Y']).error, /free command field/);
    assert.match(parseArgs(['start', '--args', '--anything']).error, /free command field/);
  });
});

describe('mc cloud-session validation', () => {
  test('requires cloud session id and supported policy', () => {
    assert.match(validateCloudSessionOptions(parseArgs(['start'])).error, /cloud session id is required/);
    assert.match(
      validateCloudSessionOptions(parseArgs(['start', '--cloud-session-id', 'cld_123456', '--policy', 'danger-full-access'])).error,
      /policy must be/,
    );
    assert.match(
      validateCloudSessionOptions(parseArgs(['start', '--cloud-session-id', 'cld_123456', '--coding-session-id', 'not_a_session'])).error,
      /coding session id/,
    );
  });

  test('builds explicit policy for adapter launch rendering', () => {
    const write = cloudPolicyForLaunch('workspace-write', 'codex');
    assert.equal(write.permissions.workspace, 'worktree');
    assert.deepEqual(write.explicit_permissions, ['workspace']);

    const readOnly = cloudPolicyForLaunch('read-only', 'codex');
    assert.equal(readOnly.permissions.workspace, 'read-only');
    assert.deepEqual(readOnly.explicit_permissions, ['workspace']);
  });
});

describe('mc cloud-session start', () => {
  test('launches headlessly with cloud source identity and prints JSON', async () => {
    const streams = io();
    let launchArgs = null;

    const code = await runCloudSessionWith(parseArgs([
      'start',
      '--cloud-session-id',
      'cld_123456',
      '--coding-session-id',
      'sess_server123',
      '--name',
      'cloud_coord',
      '--task',
      'Analyse cloud mc',
      '--tool',
      'codex',
      '--policy',
      'workspace-write',
      '--repo-ref',
      'memoro',
      '--json',
    ]), {
      cwd: () => '/workspace/memoro',
      env: { PATH: '/bin', TERM: 'xterm-256color' },
      stdout: streams.stdout,
      stderr: streams.stderr,
      launchBrokerOwnedSession: async (args) => {
        launchArgs = args;
        return {
          code: 0,
          codingSessionId: 'sess_cloud123',
          broker: { pid: 42 },
          attached: false,
        };
      },
    });

    assert.equal(code, 0);
    assert.equal(streams.err(), '');
    const out = JSON.parse(streams.out());
    assert.equal(out.ok, true);
    assert.equal(out.cloud_session_id, 'cld_123456');
    assert.equal(out.coding_session_id, 'sess_cloud123');
    assert.equal(out.source_id, 'cloud:cld_123456');
    assert.equal(out.source_kind, 'cloud');
    assert.equal(out.source_name, 'Memoro Cloud');
    assert.equal(out.attached, false);

    assert.equal(launchArgs.cwd, '/workspace/memoro');
    assert.equal(launchArgs.codingSessionId, 'sess_server123');
    assert.equal(launchArgs.sessionName, 'cloud_coord');
    assert.equal(launchArgs.focus, 'Analyse cloud mc');
    assert.equal(launchArgs.tool, 'codex');
    assert.equal(launchArgs.attachAfterLaunch, false);
    assert.deepEqual(launchArgs.cloudBroker, {
      sourceId: 'cloud:cld_123456',
      sourceKind: 'cloud',
      sourceName: 'Memoro Cloud',
      cloudSessionId: 'cld_123456',
    });
    assert.equal(launchArgs.env.MC_SOURCE_ID, 'cloud:cld_123456');
    assert.equal(launchArgs.env.MC_SOURCE_KIND, 'cloud');
    assert.equal(launchArgs.env.MC_CLOUD_SESSION_ID, 'cld_123456');
    assert.equal(launchArgs.stdout.columns, 100);
    assert.equal(typeof launchArgs.stdout.write, 'function');

    const policy = launchArgs.deps.resolvePolicyForWrap({ tool: 'codex' });
    assert.equal(policy.permissions.workspace, 'worktree');
    assert.deepEqual(policy.explicit_permissions, ['workspace']);
  });

  test('uses MC_CODING_SESSION_ID as the cloud runtime session id', async () => {
    const streams = io();
    let launchArgs = null;

    const code = await runCloudSessionWith(parseArgs([
      'start',
      '--cloud-session-id',
      'cld_123456',
      '--name',
      'cloud_coord',
      '--tool',
      'codex',
      '--json',
    ]), {
      cwd: () => '/workspace/memoro',
      env: {
        PATH: '/bin',
        TERM: 'xterm-256color',
        MC_CODING_SESSION_ID: 'sess_env123',
      },
      stdout: streams.stdout,
      stderr: streams.stderr,
      launchBrokerOwnedSession: async (args) => {
        launchArgs = args;
        return {
          code: 0,
          codingSessionId: args.codingSessionId,
          broker: { pid: 42 },
          attached: false,
        };
      },
    });

    assert.equal(code, 0);
    assert.equal(streams.err(), '');
    assert.equal(launchArgs.codingSessionId, 'sess_env123');
    const out = JSON.parse(streams.out());
    assert.equal(out.coding_session_id, 'sess_env123');
  });
});
