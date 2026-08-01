import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import {
  brokerSessionPaths,
  launchBrokerOwnedSession,
} from '../../src/runtime/broker/launch-client.js';
import { requestBroker } from '../../src/runtime/broker/client.js';
import { sessionHostPaths } from '../../src/runtime/broker/paths.js';
import { spawnBrokerDaemon } from '../../src/runtime/broker/supervisor.js';
import {
  executeGitHubSessionOperation,
  MC_GITHUB_BROKER_SOCKET_ENV,
} from '../../src/capabilities/github/github-session.js';
import { LOCAL_AUTH_MODES } from '../../src/mc/local-auth-mode.js';
import { inspectManagedGenerationSync } from '../../src/mc/managed-generation-journal.js';
import {
  inspectManagedCredentialDomainPresence,
} from '../../src/mc/managed-provider-registry.js';
import {
  resolveSessionControllerCapability,
} from '../../src/mc/session-controller-capability.js';

const SCHEMA = 'mc-managed-codex-github-live-smoke/v3';
const SOCKET_WAIT_MS = 20_000;
const STARTUP_INSPECTION_MS = 4_000;
const CLEANUP_TIMEOUT_MS = 60_000;
const MC_ENTRYPOINT = fileURLToPath(new URL('../../src/mc-cli.js', import.meta.url));
const CODEX_TRUST_PROMPT = 'Do you trust the contents of this directory?';
const CODEX_HOOK_FAILURE = 'SessionStart hook (failed)';
const GITHUB_READS = Object.freeze([
  Object.freeze({ operation: 'connection.status', params: Object.freeze({}) }),
  Object.freeze({ operation: 'repository.metadata', params: Object.freeze({}) }),
  Object.freeze({
    operation: 'pull_request.list',
    params: Object.freeze({ state: 'open', limit: 1 }),
  }),
]);

const repository = parseRepository(process.argv.slice(2));
const codingSessionId = `sess_live_${randomBytes(10).toString('hex')}`;
const temporaryRepository = mkdtempSync(
  join(tmpdir(), 'mc-managed-codex-github-smoke-'),
);
const githubSocketPath = brokerSessionPaths(codingSessionId).sockPath;
const hostSocketPath = sessionHostPaths(codingSessionId).socketPath;
let launchDiagnostic = '';
const quietOutput = { columns: 80, rows: 24, write() {} };
const capturedError = {
  write(value) {
    launchDiagnostic += String(value || '');
    if (launchDiagnostic.length > 8_000) launchDiagnostic = launchDiagnostic.slice(-8_000);
  },
};
const report = {
  schema: SCHEMA,
  ok: false,
  repository,
  launch: { ok: false },
  startup: {
    ok: false,
    output_observed: false,
    trust_prompt_absent: false,
    hook_failure_absent: false,
  },
  github: {
    ok: false,
    operations: [],
  },
  cleanup: { ok: false },
  cleanup_attempts: [],
  journal: { ok: false, phase: null },
};

let runtimeGeneration = null;
let launched = false;
let removed = false;

try {
  initializeRepository({ cwd: temporaryRepository, repository });
  const launch = await launchBrokerOwnedSession({
    cwd: temporaryRepository,
    tool: 'codex',
    codingSessionId,
    argv: [],
    sendStartupMessage: true,
    attachAfterLaunch: false,
    localAuthMode: LOCAL_AUTH_MODES.MANAGED_PORTABLE,
    ensureCloudBroker: async () => ({ ok: true }),
    stdout: quietOutput,
    stderr: capturedError,
    deps: {
      spawnBrokerDaemon: (options) => spawnBrokerDaemon({
        ...options,
        argv: [process.execPath, MC_ENTRYPOINT],
      }),
    },
  });
  const launchReason = launch?.reason || classifyLaunchDiagnostic(launchDiagnostic);
  report.launch = {
    ok: launch?.code === 0,
    ...(launchReason ? { reason: launchReason } : {}),
  };
  if (launch?.code !== 0) throw new Error(launchReason || 'managed-launch-failed');
  launched = true;

  await waitForPath(githubSocketPath, SOCKET_WAIT_MS);
  const status = await requestBroker({
    type: 'session_status',
    id: codingSessionId,
  }, {
    socketPath: hostSocketPath,
    timeoutMs: 5_000,
  });
  runtimeGeneration = status?.session?.runtime_generation || null;
  if (
    status?.ok !== true
    || status?.session?.managed_provider !== true
    || typeof runtimeGeneration !== 'string'
  ) {
    throw new Error('managed-session-status-unverified');
  }

  report.startup = await inspectManagedStartup();
  if (!report.startup.ok) {
    throw new Error(
      !report.startup.trust_prompt_absent
        ? 'managed-codex-trust-prompt-visible'
        : !report.startup.hook_failure_absent
          ? 'managed-codex-provider-hook-failed'
          : 'managed-codex-startup-output-unverified',
    );
  }

  const githubOperations = [];
  for (const request of GITHUB_READS) {
    const response = await executeGitHubSessionOperation({
      ...request,
      env: {
        [MC_GITHUB_BROKER_SOCKET_ENV]: githubSocketPath,
      },
    });
    githubOperations.push({
      operation: request.operation,
      ok: response?.ok === true,
      ...(response?.error?.code ? { error_code: response.error.code } : {}),
    });
  }
  report.github = {
    ok: githubOperations.every((operation) => operation.ok),
    operations: githubOperations,
  };
  if (!report.github.ok) throw new Error('github-operation-failed');

  const cleanup = await removeManagedSession();
  removed = cleanup.ok === true;
  report.cleanup = cleanup;
  if (!removed || cleanup.credential_cleanup !== 'confirmed') {
    throw new Error(cleanup.reason || 'managed-cleanup-unconfirmed');
  }

  const journal = inspectManagedGenerationSync({
    codingSessionId,
    runtimeGeneration,
  });
  report.journal = {
    ok: journal.kind === 'present' && journal.phase === 'ready' && journal.terminal === true,
    phase: journal.kind === 'present' ? journal.phase : null,
    terminal: journal.kind === 'present' ? journal.terminal === true : false,
  };
  if (!report.journal.ok) throw new Error(journal.reason || 'managed-journal-not-ready');

  report.ok = true;
} catch (error) {
  report.reason = safeReason(error);
} finally {
  if (launched && !removed) {
    const cleanup = await removeManagedSession().catch(() => ({
      ok: false,
      reason: 'managed-cleanup-request-failed',
    }));
    report.cleanup = cleanup;
    removed = cleanup.ok === true;
  }
  await stopEmptyHost().catch(() => {});
  if (temporaryRepository.startsWith(join(tmpdir(), 'mc-managed-codex-github-smoke-'))) {
    rmSync(temporaryRepository, { recursive: true, force: true });
  }
}

process.stdout.write(`${JSON.stringify(report)}\n`);
process.exitCode = report.ok ? 0 : 1;

async function removeManagedSession() {
  const authority = await resolveSessionControllerCapability({ codingSessionId });
  if (!authority?.ok) {
    return {
      ok: false,
      reason: authority?.reason || 'session-controller-capability-unavailable',
    };
  }
  const result = await requestBroker({
    type: 'remove_session',
    id: codingSessionId,
    session_controller_capability: authority.capability,
  }, {
    socketPath: hostSocketPath,
    timeoutMs: CLEANUP_TIMEOUT_MS,
  }).catch(() => ({
    ok: false,
    reason: 'remove-session-request-failed',
  }));
  report.cleanup_attempts.push({
    response_ok: result?.ok === true,
    response_removed: result?.removed === true,
    response_cleanup: result?.credential_cleanup === 'confirmed',
    error_class: classifyRemoveError(result),
    error_detail: sanitizeBrokerError(result?.error),
  });
  if (
    result?.ok === true
    && result?.removed !== false
    && result?.credential_cleanup === 'confirmed'
  ) {
    return {
      ok: true,
      credential_cleanup: 'confirmed',
    };
  }
  const evidence = await inspectCleanupEvidence();
  if (evidence.confirmed) {
    return {
      ok: true,
      credential_cleanup: 'confirmed',
      reconciled: true,
    };
  }
  return {
    ok: false,
    reason: result?.reason || 'managed-cleanup-unconfirmed',
    evidence: {
      response_ok: result?.ok === true,
      response_removed: result?.removed === true,
      response_cleanup: result?.credential_cleanup === 'confirmed',
      session_absent: evidence.sessionAbsent,
      journal_ready: evidence.journalReady,
      domain_absent: evidence.domainAbsent,
    },
  };
}

async function inspectManagedStartup() {
  await sleep(STARTUP_INSPECTION_MS);
  const authority = await resolveSessionControllerCapability({ codingSessionId });
  if (!authority?.ok) {
    return {
      ok: false,
      output_observed: false,
      trust_prompt_absent: false,
      hook_failure_absent: false,
    };
  }
  const response = await requestBroker({
    type: 'fetch_session_output',
    id: codingSessionId,
    session_controller_capability: authority.capability,
  }, {
    socketPath: hostSocketPath,
    timeoutMs: 5_000,
  }).catch(() => null);
  const output = typeof response?.output === 'string' ? response.output : '';
  const outputObserved = response?.ok === true && output.length > 0;
  const trustPromptAbsent = !output.includes(CODEX_TRUST_PROMPT);
  const hookFailureAbsent = !output.includes(CODEX_HOOK_FAILURE);
  return {
    ok: outputObserved && trustPromptAbsent && hookFailureAbsent,
    output_observed: outputObserved,
    trust_prompt_absent: trustPromptAbsent,
    hook_failure_absent: hookFailureAbsent,
  };
}

async function inspectCleanupEvidence() {
  if (typeof runtimeGeneration !== 'string') {
    return {
      confirmed: false,
      sessionAbsent: false,
      journalReady: false,
      domainAbsent: false,
    };
  }
  const journal = inspectManagedGenerationSync({
    codingSessionId,
    runtimeGeneration,
  });
  const domain = inspectManagedCredentialDomainPresence({
    tool: 'codex',
    codingSessionId,
  });
  const status = await requestBroker({
    type: 'session_status',
    id: codingSessionId,
  }, {
    socketPath: hostSocketPath,
    timeoutMs: 3_000,
  }).catch(() => null);
  const sessionAbsent = status == null
    || (status.ok === false && status.reason === 'session-not-found');
  const journalReady = journal.kind === 'present'
    && journal.phase === 'ready'
    && journal.terminal === true;
  const domainAbsent = domain.kind === 'absent';
  return {
    confirmed: journalReady && domainAbsent && sessionAbsent,
    sessionAbsent,
    journalReady,
    domainAbsent,
  };
}

async function stopEmptyHost() {
  if (!existsSync(hostSocketPath)) return;
  await requestBroker({ type: 'stop' }, {
    socketPath: hostSocketPath,
    timeoutMs: 5_000,
  }).catch(() => null);
}

async function waitForPath(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await sleep(50);
  }
  throw new Error('github-session-socket-timeout');
}

function initializeRepository({ cwd, repository: repo }) {
  git(cwd, ['init', '-q', '-b', 'main']);
  git(cwd, ['config', 'user.name', 'mc live smoke']);
  git(cwd, ['config', 'user.email', 'mc-live-smoke@invalid.example']);
  writeFileSync(join(cwd, 'README.md'), '# mc managed live smoke\n', {
    encoding: 'utf8',
    mode: 0o600,
  });
  git(cwd, ['add', 'README.md']);
  git(cwd, ['commit', '-q', '-m', 'Initialize live smoke repository']);
  git(cwd, ['remote', 'add', 'origin', `https://github.com/${repo}.git`]);
}

function git(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  if (result.status !== 0) throw new Error('temporary-repository-setup-failed');
}

function parseRepository(argv) {
  const value = argv.find((arg) => arg.startsWith('--repository='))
    ?.slice('--repository='.length);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value || '')) {
    throw new Error('usage: managed-codex-github-live-smoke.mjs --repository=owner/repo');
  }
  return value;
}

function safeReason(error) {
  const value = typeof error?.message === 'string' ? error.message : 'live-smoke-failed';
  return /^[a-z0-9-]+$/u.test(value) ? value : 'live-smoke-failed';
}

function classifyRemoveError(result) {
  const error = typeof result?.error === 'string' ? result.error : '';
  if (result?.reason === 'remove-session-request-failed') return 'request-failed';
  if (result?.reason === 'runtime-finalization-timeout') return 'finalization-timeout';
  if (result?.reason === 'runtime-finalization-unconfirmed') return 'finalization-unconfirmed';
  if (result?.reason === 'managed-domain-cleanup-unconfirmed') return 'cleanup-unconfirmed';
  if (result?.reason === 'session-controller-capability-invalid') return 'controller-invalid';
  if (result?.ok === false && result?.error === 'broker command failed') {
    return 'broker-command-failed';
  }
  if (error.includes('unknown broker session')) return 'unknown-session';
  if (error.includes('controller capability')) return 'controller-invalid';
  if (error.includes('managed generation')) return 'managed-generation-error';
  if (error.includes('credential')) return 'credential-error';
  if (error.includes('finalization')) return 'finalization-error';
  return result?.ok === true ? null : 'broker-error';
}

function sanitizeBrokerError(value) {
  if (typeof value !== 'string' || !value) return null;
  return value
    .replace(/sess_[A-Za-z0-9_-]+/gu, '<session>')
    .replace(/\/[^\s)]+/gu, '<path>')
    .replace(/[A-Za-z0-9_-]{32,}/gu, '<opaque>')
    .replace(/[^A-Za-z0-9 <>():._-]+/gu, ' ')
    .slice(0, 160);
}

function classifyLaunchDiagnostic(value) {
  const text = String(value || '');
  const parenthesized = [...text.matchAll(/\(([a-z0-9-]+)\)/gu)].at(-1)?.[1];
  if (parenthesized) return parenthesized;
  if (text.includes('cannot launch')) return 'tool-launch-unavailable';
  if (text.includes('no Memoro token')) return 'memoro-auth-missing';
  if (text.includes('not inside a git repository')) return 'git-repository-unavailable';
  if (text.includes('session controller authority is unavailable')) {
    return 'session-controller-capability-unavailable';
  }
  if (text.includes('session host start failed')) return 'session-host-start-failed';
  if (text.includes('failed to install GitHub session boundary')) {
    return 'github-session-boundary-install-failed';
  }
  if (text.includes('broker launch failed')) return 'broker-launch-failed';
  return null;
}
