/**
 * Trusted long-lived runtime for one managed Claude session.
 *
 * This host owns vault refresh and the SRT sentinel registry. The sandboxed
 * provider receives the stable sentinel once through anonymous FD 3. Real
 * access/refresh tokens never enter provider argv, environment, files, or IPC.
 */
import { spawn } from 'node:child_process';
import { Socket } from 'node:net';
import { pathToFileURL } from 'node:url';

import { verifyInstalledClaudeC1Artifacts } from '../../runtime/broker/c1-artifacts.js';
import { createManagedClaudeRefreshOwner } from './claude-managed-refresh-owner.js';
import {
  MANAGED_CLAUDE_CREDENTIAL_FD,
  buildManagedClaudeSandboxPolicy,
  managedClaudeExecutorEnvironment,
} from './claude-managed-policy.js';

const RUNTIME_SIGNALS = Object.freeze(['SIGINT', 'SIGTERM', 'SIGHUP']);

export async function runManagedClaudeRuntime({
  descriptor,
  argv = [],
  inheritedEnv = {},
  deps = {},
} = {}) {
  if (!validRuntimeDescriptor(descriptor)
    || !Array.isArray(argv)
    || argv.some((value) => typeof value !== 'string')) {
    return runtimeFailure('managed-claude-runtime-input-invalid');
  }
  const verifyArtifacts = deps.verifyArtifacts
    || verifyInstalledClaudeC1Artifacts;
  const verified = await Promise.resolve()
    .then(() => verifyArtifacts())
    .catch(() => null);
  if (!verified?.ok
    || verified.artifacts?.claudeBinary !== descriptor.native_binary
    || verified.artifacts?.srtModule !== descriptor.srt_module
    || verified.artifacts?.claudeSha256 !== descriptor.native_binary_sha256
    || verified.artifacts?.srtTreeSha256 !== descriptor.srt_tree_sha256) {
    return runtimeFailure(verified?.code || 'managed-claude-artifact-untrusted');
  }

  let SandboxManager;
  try {
    const imported = deps.importSrt
      ? await deps.importSrt(verified.artifacts.srtModule)
      : await import(pathToFileURL(verified.artifacts.srtModule).href);
    ({ SandboxManager } = imported);
  } catch {
    return runtimeFailure('managed-claude-srt-import-failed');
  }
  if (!validSandboxManager(SandboxManager)) {
    return runtimeFailure('managed-claude-srt-contract-invalid');
  }

  let sentinel = null;
  let child = null;
  let owner = null;
  let proxyPort = null;
  let fatalReason = null;
  let result = null;
  const signalHandlers = [];
  try {
    const policy = buildManagedClaudeSandboxPolicy({
      deniedReadPaths: descriptor.denied_read_paths,
      deniedWritePaths: descriptor.denied_write_paths,
      allowedUnixSocketPaths: descriptor.allowed_unix_socket_paths,
      getSentinel: () => sentinel,
    });
    await SandboxManager.initialize(policy, async () => true);
    const sentinelRegistry = SandboxManager.getSentinelRegistry();
    proxyPort = SandboxManager.getProxyPort?.() || null;
    owner = (deps.createRefreshOwner || createManagedClaudeRefreshOwner)({
      sentinelRegistry,
      custodyDeps: deps.custodyDeps || {},
      onFatal: (reason) => {
        fatalReason = reason || 'managed-claude-refresh-failed';
        try { child?.kill?.('SIGKILL'); } catch {}
      },
    });
    const started = await owner.start();
    if (!started?.ok || typeof started.sentinel !== 'string' || !started.sentinel) {
      result = runtimeFailure(started?.reason || 'managed-claude-refresh-owner-failed');
      return result;
    }
    sentinel = started.sentinel;

    const command = buildManagedClaudeCommand({
      claudeBinary: verified.artifacts.claudeBinary,
      argv: [
        '--settings',
        descriptor.provider_settings_path,
        ...argv,
      ],
    });
    const wrapped = await SandboxManager.wrapWithSandboxArgv(
      command,
      '/bin/bash',
      undefined,
      undefined,
      descriptor.workspace,
    );
    if (!validWrappedArgv(wrapped)) {
      result = runtimeFailure('managed-claude-srt-wrap-invalid');
      return result;
    }
    const childEnv = managedClaudeExecutorEnvironment({
      home: descriptor.executor_home,
      tmp: descriptor.executor_tmp,
      claudeConfigDir: descriptor.claude_config_dir,
      path: descriptor.safe_path,
      inherited: inheritedEnv,
    });
    child = (deps.spawn || spawn)(wrapped.argv[0], wrapped.argv.slice(1), {
      cwd: descriptor.workspace,
      env: childEnv,
      shell: false,
      detached: false,
      stdio: ['inherit', 'inherit', 'inherit', 'pipe'],
    });
    if (!child?.stdio?.[MANAGED_CLAUDE_CREDENTIAL_FD]
      || typeof child.stdio[MANAGED_CLAUDE_CREDENTIAL_FD].end !== 'function') {
      try { child?.kill?.('SIGKILL'); } catch {}
      result = runtimeFailure('managed-claude-credential-fd-unavailable');
      return result;
    }
    child.stdio[MANAGED_CLAUDE_CREDENTIAL_FD].end(sentinel);

    for (const signal of RUNTIME_SIGNALS) {
      const handler = () => {
        try { child?.kill?.(signal); } catch {}
      };
      process.on(signal, handler);
      signalHandlers.push([signal, handler]);
    }
    const exit = await waitForChild(child);
    if (fatalReason) {
      result = runtimeFailure(fatalReason);
      return result;
    }
    result = {
      ok: exit.code === 0,
      code: exit.code === 0 ? 'managed-claude-runtime-complete' : 'managed-claude-provider-exited',
      exit_code: Number.isInteger(exit.code) ? exit.code : null,
      signal: typeof exit.signal === 'string' ? exit.signal : null,
    };
    return result;
  } catch {
    try { child?.kill?.('SIGKILL'); } catch {}
    result = runtimeFailure('managed-claude-runtime-failed');
    return result;
  } finally {
    for (const [signal, handler] of signalHandlers) {
      process.removeListener(signal, handler);
    }
    try { owner?.stop?.(); } catch {}
    sentinel = null;
    try {
      await SandboxManager.reset();
      if (!await verifyManagedClaudeSandboxReset(SandboxManager, proxyPort, {
        portClosed: deps.portClosed,
      })) {
        try { child?.kill?.('SIGKILL'); } catch {}
        overwriteRuntimeFailure(result, 'managed-claude-sandbox-reset-unconfirmed');
      }
    } catch {
      try { child?.kill?.('SIGKILL'); } catch {}
      overwriteRuntimeFailure(result, 'managed-claude-sandbox-reset-unconfirmed');
    }
  }
}

export function buildManagedClaudeCommand({
  claudeBinary,
  argv = [],
} = {}) {
  if (typeof claudeBinary !== 'string'
    || !claudeBinary.startsWith('/')
    || !Array.isArray(argv)
    || argv.some((value) => typeof value !== 'string')) {
    throw new TypeError('managed Claude command input is invalid');
  }
  return [
    'exec',
    '/usr/bin/env',
    `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR=${MANAGED_CLAUDE_CREDENTIAL_FD}`,
    'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1',
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1',
    'DISABLE_TELEMETRY=1',
    'DISABLE_ERROR_REPORTING=1',
    'DO_NOT_TRACK=1',
    claudeBinary,
    ...argv,
  ].map(posixQuote).join(' ');
}

export async function verifyManagedClaudeSandboxReset(manager, priorProxyPort, {
  portClosed = loopbackPortClosed,
} = {}) {
  if (!Number.isSafeInteger(priorProxyPort)
    || priorProxyPort < 1
    || priorProxyPort > 65_535
    || typeof portClosed !== 'function') return false;
  try {
    return manager?.getProxyAuthToken?.() == null
      && manager?.getProxyPort?.() == null
      && manager?.getSentinelRegistry?.()?.size === 0
      && await portClosed(priorProxyPort);
  } catch {
    return false;
  }
}

function waitForChild(child) {
  return new Promise((resolveExit) => {
    let settled = false;
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      resolveExit({ code, signal });
    };
    child.once('error', () => finish(null, null));
    child.once('exit', finish);
  });
}

function loopbackPortClosed(port) {
  return new Promise((resolveClosed) => {
    const socket = new Socket();
    let done = false;
    const finish = (closed) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      socket.destroy();
      resolveClosed(closed);
    };
    const timeout = setTimeout(() => finish(false), 500);
    socket.once('connect', () => finish(false));
    socket.once('error', () => finish(true));
    try { socket.connect({ host: '127.0.0.1', port }); } catch { finish(true); }
  });
}

function validRuntimeDescriptor(value) {
  return plain(value)
    && [
      'allowed_unix_socket_paths',
      'claude_config_dir',
      'denied_read_paths',
      'denied_write_paths',
      'executor_home',
      'executor_tmp',
      'native_binary',
      'native_binary_sha256',
      'provider_settings_path',
      'safe_path',
      'srt_module',
      'srt_tree_sha256',
      'workspace',
    ].every((key) => value[key] != null)
    && [
      value.claude_config_dir,
      value.executor_home,
      value.executor_tmp,
      value.native_binary,
      value.provider_settings_path,
      value.srt_module,
      value.workspace,
    ].every((path) => typeof path === 'string' && path.startsWith('/'))
    && [value.denied_read_paths, value.denied_write_paths, value.allowed_unix_socket_paths]
      .every((paths) => Array.isArray(paths)
        && paths.every((path) => typeof path === 'string' && path.startsWith('/')))
    && /^[a-f0-9]{64}$/u.test(value.native_binary_sha256)
    && /^[a-f0-9]{64}$/u.test(value.srt_tree_sha256)
    && typeof value.safe_path === 'string'
    && value.safe_path.length > 0;
}

function validSandboxManager(value) {
  return value
    && typeof value.initialize === 'function'
    && typeof value.wrapWithSandboxArgv === 'function'
    && typeof value.getSentinelRegistry === 'function'
    && typeof value.reset === 'function';
}

function validWrappedArgv(value) {
  return plain(value)
    && Array.isArray(value.argv)
    && value.argv.length > 0
    && value.argv.every((part) => typeof part === 'string' && part);
}

function posixQuote(value) {
  return `'${String(value).replace(/'/gu, `'"'"'`)}'`;
}

function runtimeFailure(code) {
  return {
    ok: false,
    code,
    exit_code: null,
    signal: null,
  };
}

function overwriteRuntimeFailure(result, code) {
  if (!result) return;
  // An unconfirmed teardown still fails the run — that property is unchanged.
  // But it must not erase why the run failed in the first place: when the
  // launch never got as far as a proxy port, this check cannot confirm
  // anything, and overwriting turned every early failure into
  // `sandbox-reset-unconfirmed`, hiding the only cause worth reporting.
  if (result.ok === false && result.code) return;
  result.ok = false;
  result.code = code;
  result.exit_code = null;
  result.signal = null;
}

function plain(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null);
}
