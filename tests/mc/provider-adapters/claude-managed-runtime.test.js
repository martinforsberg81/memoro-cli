import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  buildManagedClaudeCommand,
  runManagedClaudeRuntime,
} from '../../../src/mc/provider-adapters/claude-managed-runtime.js';

const DESCRIPTOR = Object.freeze({
  allowed_unix_socket_paths: [
    '/managed/artifact.sock',
    '/managed/github.sock',
  ],
  claude_config_dir: '/managed/executor/home/.claude',
  denied_read_paths: [
    '/managed/credential-domain',
    '/Users/test/.memoro',
    '/Users/test/Library/Keychains',
  ],
  denied_write_paths: [
    '/managed/credential-domain',
    '/Users/test/.memoro',
  ],
  executor_home: '/managed/executor/home',
  executor_tmp: '/managed/executor/tmp',
  native_binary: '/managed/artifacts/claude',
  native_binary_sha256: 'a'.repeat(64),
  provider_settings_path: '/managed/executor/home/.claude/settings.json',
  safe_path: '/managed/executor/bin:/usr/bin:/bin',
  srt_module: '/managed/artifacts/srt/index.js',
  srt_tree_sha256: 'b'.repeat(64),
  workspace: '/repo',
});

function fixture({ resetReceipt = true } = {}) {
  const observed = {
    command: null,
    credentialFd: null,
    env: null,
    policy: null,
    ownerStopped: false,
  };
  let reset = false;
  const registry = {
    size: 1,
    register: () => 'srt:opaque-sentinel',
  };
  const SandboxManager = {
    async initialize(policy) {
      observed.policy = policy;
    },
    getSentinelRegistry() {
      return reset ? { size: 0 } : registry;
    },
    getProxyPort() {
      return reset ? undefined : 43123;
    },
    getProxyAuthToken() {
      return reset ? undefined : 'proxy-capability';
    },
    async wrapWithSandboxArgv(command) {
      observed.command = command;
      return { argv: ['/usr/bin/sandbox-exec', '-p', 'fixed'] };
    },
    async reset() {
      reset = true;
    },
  };
  const spawn = (_bin, _args, options) => {
    observed.env = options.env;
    const child = new EventEmitter();
    child.stdio = [
      null,
      null,
      null,
      {
        end(value) {
          observed.credentialFd = value;
        },
      },
    ];
    child.kill = () => true;
    queueMicrotask(() => child.emit('exit', 0, null));
    return child;
  };
  return {
    observed,
    deps: {
      verifyArtifacts: () => ({
        ok: true,
        artifacts: {
          claudeBinary: DESCRIPTOR.native_binary,
          claudeSha256: DESCRIPTOR.native_binary_sha256,
          srtModule: DESCRIPTOR.srt_module,
          srtTreeSha256: DESCRIPTOR.srt_tree_sha256,
        },
      }),
      importSrt: async () => ({ SandboxManager }),
      createRefreshOwner: ({ sentinelRegistry }) => {
        assert.equal(sentinelRegistry, registry);
        return {
          async start() {
            return { ok: true, sentinel: 'srt:opaque-sentinel' };
          },
          stop() {
            observed.ownerStopped = true;
          },
        };
      },
      spawn,
      portClosed: async () => resetReceipt,
    },
  };
}

test('managed Claude runtime gives only a stable sentinel to anonymous FD 3', async () => {
  const { deps, observed } = fixture();
  const result = await runManagedClaudeRuntime({
    descriptor: DESCRIPTOR,
    argv: ['--resume', 'native-session-id'],
    inheritedEnv: {
      MEMORO_TOKEN: 'must-not-cross',
      MC_CODING_SESSION_ID: 'sess_managed_claude',
      MC_RUNTIME_GENERATION: 'runtime-generation',
      MC_PROVIDER_ARTIFACT_SOCKET: '/managed/artifact.sock',
      MC_GITHUB_BROKER_SOCKET: '/managed/github.sock',
    },
    deps,
  });

  assert.deepEqual(result, {
    ok: true,
    code: 'managed-claude-runtime-complete',
    exit_code: 0,
    signal: null,
  });
  assert.equal(observed.credentialFd, 'srt:opaque-sentinel');
  assert.match(observed.command, /CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR=3/);
  assert.doesNotMatch(observed.command, /srt:opaque-sentinel|MEMORO_TOKEN/);
  assert.equal(observed.env.MEMORO_TOKEN, undefined);
  assert.equal(observed.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(observed.env.CLAUDE_CONFIG_DIR, DESCRIPTOR.claude_config_dir);
  assert.equal(observed.env.MC_PROVIDER_ARTIFACT_SOCKET, '/managed/artifact.sock');
  assert.deepEqual(
    observed.policy.network.allowUnixSockets,
    DESCRIPTOR.allowed_unix_socket_paths,
  );
  assert.deepEqual(
    observed.policy.filesystem.denyRead,
    DESCRIPTOR.denied_read_paths,
  );
  assert.equal(
    observed.policy.allowAppleEvents,
    false,
    'Launch Services must not escape the managed credential sandbox',
  );
  assert.equal(observed.ownerStopped, true);
});

test('managed Claude runtime fails closed when SRT teardown is unconfirmed', async () => {
  const { deps } = fixture({ resetReceipt: false });
  const result = await runManagedClaudeRuntime({
    descriptor: DESCRIPTOR,
    deps,
  });
  assert.deepEqual(result, {
    ok: false,
    code: 'managed-claude-sandbox-reset-unconfirmed',
    exit_code: null,
    signal: null,
  });
});

test('managed Claude command quotes user arguments without embedding credentials', () => {
  const command = buildManagedClaudeCommand({
    claudeBinary: '/managed/claude',
    argv: ['--append-system-prompt', `don't expand $TOKEN or $(id)`],
  });
  assert.match(command, /CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR=3/);
  assert.ok(command.endsWith(`'don'"'"'t expand $TOKEN or $(id)'`));
  assert.doesNotMatch(command, /CLAUDE_CODE_OAUTH_TOKEN=/);
});
