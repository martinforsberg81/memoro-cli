import { spawn } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { memoroFetch } from '../lib/api.js';
import { readConfig } from '../lib/config.js';
import { brokerConnectArgs, resolveMcBinPath } from '../runtime/broker/cloud-supervisor.js';
import { launchBrokerOwnedSession } from '../runtime/broker/launch-client.js';
import { redactCredentialText } from '../mc/runtime-redaction.js';
import { RELEASE_TRUST_CODES, verifyReleaseTrust } from '../mc/release-trust.js';
import { scrubRuntimeSecretsFromEnv } from '../mc/runtime-secrets.js';
import { prepareCloudCodexAuth } from '../mc/cloud-codex-auth.js';
import {
  parseArgs as parseCloudSessionArgs,
  runCloudSessionWith,
} from './cloud-session.js';
import {
  hydrateToolAuth,
  publicToolAuthResult,
  startToolAuthPersistWatcher,
} from '../mc/tool-auth.js';
import {
  captureCodingBinSnapshot,
  codingBinReadiness,
  restoreCodingBinSnapshot,
} from '../mc/cloud-runtime-snapshot.js';
import {
  CLOUD_LIFECYCLE,
  CLOUD_RUNTIME_CONTRACT_VERSION,
} from '../mc/cloud-runtime-contract.js';

export {
  CLOUD_LIFECYCLE,
  CLOUD_RUNTIME_CONTRACT_VERSION,
} from '../mc/cloud-runtime-contract.js';

const CLOUD_SESSION_ID_RE = /^cld_[a-zA-Z0-9_-]{6,}$/;
const DEFAULT_RUNTIME_DIR = '/workspace/mc-runtime';
const DEFAULT_REPO_CWD = '/workspace/repo';
const DEFAULT_API_URL = 'https://meetmemoro.app';
const DEFAULT_WORKSPACE_CLONE_TIMEOUT_MS = 90_000;
const WORKSPACE_PREPARE_WATCHDOG_GRACE_MS = 15_000;
const PROCESS_FORCE_KILL_GRACE_MS = 2_000;
const PROCESS_FORCE_RESOLVE_GRACE_MS = 250;
const GITHUB_SHORTHAND_RE = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;
const RUNTIME_GENERATION_RE = /^rtg_[a-z0-9]{16}$/;
const AUTHORIZATION_DIGEST_RE = /^[a-f0-9]{64}$/;
const SECRET_ENV_NAMES_AFTER_WORKSPACE = Object.freeze([
  'MEMORO_TOKEN',
  'MEMORO_BROKER_TOKEN',
  'MC_CLOUD_GIT_TOKEN',
  'MC_CLOUD_GIT_SECRET_CAPABILITY',
  'MC_GIT_CLONE_TOKEN',
  'MC_CLOUD_RUNTIME_GENERATION',
  'MC_CLOUD_AUTHORIZATION_DIGEST',
  'GITHUB_TOKEN',
  'MC_CODEX_API_KEY',
  'OPENAI_API_KEY',
  'CODEX_ACCESS_TOKEN',
]);

export async function run(argv) {
  const opts = parseArgs(argv);
  return runCloudRuntimeWith(opts, {
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    cwd: () => process.cwd(),
  });
}

export async function runCloudRuntimeWith(opts, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  if (opts.error) {
    stderr.write(`mc: ${opts.error}\n`);
    printUsage(stderr);
    return 2;
  }
  if (opts.help || !opts.verb) {
    printUsage(stdout);
    return opts.help ? 0 : 2;
  }
  if (opts.verb !== 'run') {
    stderr.write(`mc: unknown cloud-runtime verb: ${opts.verb}\n`);
    printUsage(stderr);
    return 2;
  }

  const validation = validateCloudRuntimeOptions(opts);
  if (!validation.ok) {
    stderr.write(`mc: ${validation.error}\n`);
    if (opts.json) writeJson(stdout, { ok: false, error: validation.error });
    return 2;
  }

  let manifest;
  try {
    manifest = await readRuntimeManifest(opts.manifestPath, deps);
  } catch (err) {
    const error = `manifest read failed (${safeError(err)})`;
    stderr.write(`mc: ${error}\n`);
    if (opts.json) writeJson(stdout, { ok: false, error });
    return 1;
  }

  const manifestValidation = validateManifest(manifest, opts);
  if (!manifestValidation.ok) {
    stderr.write(`mc: ${manifestValidation.error}\n`);
    if (opts.json) writeJson(stdout, { ok: false, error: manifestValidation.error });
    return 2;
  }

  const env = { ...(deps.env || process.env) };
  const runtimeAuthorization = validateRuntimeAuthorization(manifest, env);
  if (!runtimeAuthorization.ok) {
    stderr.write(`mc: ${runtimeAuthorization.error}\n`);
    if (opts.json) writeJson(stdout, { ok: false, error: runtimeAuthorization.error });
    return 2;
  }
  const releaseGate = deps.verifyRuntimeRelease || verifyRuntimeRelease;
  let releaseVerification;
  try {
    releaseVerification = await releaseGate({
      manifest,
      runtimeAuthorization,
      deps,
    });
  } catch {
    releaseVerification = { ok: false, code: 'platform_identity_unavailable' };
  }
  if (!releaseVerification?.ok) {
    const code = stableReleaseGateCode(releaseVerification?.code);
    const error = 'release verification blocked';
    stderr.write(`mc: ${error} (${code})\n`);
    if (opts.json) writeJson(stdout, { ok: false, error, code });
    return 1;
  }
  const cloudSessionId = opts.cloudSessionId || manifest.cloud_session_id;
  const paths = runtimePaths(manifest, env, opts.manifestPath);
  const runtimeToken = await (deps.resolveRuntimeToken || resolveRuntimeToken)({ env, deps });
  const brokerToken = resolveBrokerToken({ env });
  const apiUrl = await resolveRuntimeApiUrl({ manifest, env, deps });
  const runtime = createRuntimeRecorder({
    cloudSessionId,
    manifest,
    paths,
    token: runtimeToken,
    apiUrl,
    runtimeAuthorization,
    deps,
  });

  await runtime.record({
    phase: CLOUD_LIFECYCLE.RUNTIME_TOKEN_MINTED,
    runtime_state: runtimeToken ? 'starting' : 'runtime_token_missing',
    process_status: 'running',
    events: [{
      type: 'runtime.supervisor_started',
      data: {
        manifest_path: opts.manifestPath,
        repo_ref: manifest.repo?.ref || null,
        tool: manifest.launch?.tool || null,
      },
    }],
    readiness: initialReadiness(manifest, { tokenPresent: !!runtimeToken }),
  });

  if (!runtimeToken) {
    const error = 'runtime token missing';
    await runtime.record({
      phase: CLOUD_LIFECYCLE.FAILED,
      runtime_state: 'failed',
      process_status: 'exited',
      error_code: 'runtime_token_missing',
      error,
      events: [{ type: 'runtime.failed', data: { reason: 'runtime_token_missing' } }],
    });
    stderr.write(`mc: ${error}\n`);
    if (opts.json) writeJson(stdout, { ok: false, error });
    return 1;
  }

  // The broker WebSocket has its own cloud-scoped credential. In particular,
  // never borrow the runtime-status/snapshot token when this token is absent.
  // Failing before workspace or tool launch keeps a partial runtime from being
  // presented as a connected coding session.
  if (!brokerToken) {
    const error = 'broker token missing';
    await runtime.record({
      phase: CLOUD_LIFECYCLE.FAILED,
      runtime_state: 'failed',
      process_status: 'exited',
      error_code: 'broker_token_missing',
      error,
      events: [{ type: 'runtime.failed', data: { reason: 'broker_token_missing' } }],
    });
    stderr.write(`mc: ${error}\n`);
    if (opts.json) writeJson(stdout, { ok: false, error });
    return 1;
  }

  if ((manifest.launch?.tool || 'codex') === 'codex') {
    const codexPreflight = await prepareCloudCodexAuth({
      codingSessionId: manifest.coding_session_id,
      env,
    });
    if (!codexPreflight.ok) {
      await runtime.record({
        phase: CLOUD_LIFECYCLE.FAILED,
        runtime_state: 'failed',
        process_status: 'exited',
        error_code: codexPreflight.reason || 'cloud_codex_auth_preflight_failed',
        error: codexPreflight.error || 'Codex cloud auth preflight failed',
        events: [{ type: 'provider.launch.failed', data: { reason: codexPreflight.reason || null } }],
        readiness: {
          ...initialReadiness(manifest, { tokenPresent: true }),
          tool_auth: { ready: false, repair_required: true, repair_action: 'contact_support' },
        },
      });
      stderr.write(`mc: ${codexPreflight.error || 'Codex cloud auth preflight failed'}\n`);
      if (opts.json) writeJson(stdout, { ok: false, error: codexPreflight.error || 'Codex cloud auth preflight failed' });
      return 1;
    }
  }

  const workspaceDir = runtimeWorkspaceDir(manifest);
  await runtime.record({
    phase: CLOUD_LIFECYCLE.WAKING,
    runtime_state: 'preparing_workspace',
    process_status: 'running',
    events: [{
      type: 'workspace.prepare.started',
      data: {
        cwd: workspaceDir,
        repo_ref: safeRuntimeRepoRef(manifest.repo?.ref),
        workspace_ref: stringOrNull(manifest.repo?.workspace_ref),
        strategy: repoCloneUrl(safeRuntimeRepoRef(manifest.repo?.ref)) ? 'partial_clone' : 'empty_init',
      },
    }],
  });

  const workspaceAbortController = new AbortController();
  const cloneTimeoutMs = workspaceCloneTimeoutMs(deps.workspaceCloneTimeoutMs);
  const workspaceTimeoutMs = workspacePrepareTimeoutMs(
    deps.workspacePrepareTimeoutMs,
    cloneTimeoutMs,
  );
  const prepareWorkspaceFn = deps.prepareWorkspace || prepareWorkspace;
  const workspaceOperation = Promise.resolve()
    .then(() => prepareWorkspaceFn(manifest, {
      env,
      cwd: workspaceDir,
      deps: {
        ...deps,
        workspaceCloneTimeoutMs: cloneTimeoutMs,
        workspaceAbortSignal: workspaceAbortController.signal,
        onWorkspaceProgress: async ({ type, data }) => {
          await runtime.record({
            phase: CLOUD_LIFECYCLE.WAKING,
            runtime_state: 'preparing_workspace',
            process_status: 'running',
            events: [{ type, data }],
          });
        },
      },
    }))
    .catch((err) => ({
      ok: false,
      code: 'workspace_prepare_failed',
      error: `workspace prepare failed: ${safeError(err)}`,
      cwd: workspaceDir,
      repo_ref: safeRuntimeRepoRef(manifest.repo?.ref),
      workspace_ref: stringOrNull(manifest.repo?.workspace_ref),
    }));
  const workspace = await withWorkspacePrepareWatchdog(
    workspaceOperation,
    {
      timeoutMs: workspaceTimeoutMs,
      abortController: workspaceAbortController,
      cwd: workspaceDir,
      repoRef: safeRuntimeRepoRef(manifest.repo?.ref),
      workspaceRef: stringOrNull(manifest.repo?.workspace_ref),
    },
  );
  if (!workspace.ok) {
    await runtime.record({
      phase: CLOUD_LIFECYCLE.FAILED,
      runtime_state: 'failed',
      process_status: 'exited',
      error_code: workspace.code || 'workspace_prepare_failed',
      error: workspace.error || 'workspace prepare failed',
      events: [{ type: 'workspace.prepare.failed', data: workspace }],
      readiness: readinessFromWorkspace(manifest, workspace),
    });
    stderr.write(`mc: ${workspace.error || 'workspace prepare failed'}\n`);
    if (opts.json) writeJson(stdout, { ok: false, error: workspace.error || 'workspace prepare failed' });
    return 1;
  }

  await runtime.record({
    phase: CLOUD_LIFECYCLE.WAKING,
    runtime_state: 'workspace_ready',
    process_status: 'running',
    events: [{ type: 'workspace.prepare.finished', data: workspace }],
    readiness: readinessFromWorkspace(manifest, workspace),
  });

  const restore = await restoreCodingBinSnapshot(manifest, {
    env,
    deps,
    token: runtimeToken,
    cwd: workspaceDir,
    paths,
    runtimeGeneration: runtimeAuthorization.runtimeGeneration,
    authorizationDigest: runtimeAuthorization.authorizationDigest,
  });
  if (!restore.ok) {
    await runtime.record({
      phase: CLOUD_LIFECYCLE.FAILED,
      runtime_state: 'failed',
      process_status: 'exited',
      error_code: restore.code || 'coding_bin_restore_failed',
      error: restore.error || 'coding bin restore failed',
      events: [{ type: 'coding_bin.restore.failed', data: restore }],
      readiness: {
        ...readinessFromWorkspace(manifest, workspace),
        coding_bin: codingBinReadiness(manifest, { restore }),
      },
    });
    stderr.write(`mc: ${restore.error || 'coding bin restore failed'}\n`);
    if (opts.json) writeJson(stdout, { ok: false, error: restore.error || 'coding bin restore failed' });
    return 1;
  }
  if (restore.restored) {
    await runtime.record({
      phase: CLOUD_LIFECYCLE.WAKING,
      runtime_state: 'coding_bin_restored',
      process_status: 'running',
      coding_bin_snapshot_id: restore.snapshot?.id || null,
      coding_bin_snapshot: restore.snapshot || null,
      events: [{ type: 'coding_bin.restore.finished', data: restore }],
      readiness: {
        ...readinessFromWorkspace(manifest, workspace),
        coding_bin: codingBinReadiness(manifest, { restore }),
      },
    });
  }

  const toolAuthHydrate = deps.hydrateToolAuth || hydrateToolAuth;
  const toolAuth = await toolAuthHydrate({
    tool: manifest.launch?.tool || 'codex',
    cloudSessionId,
    env: providerLaunchEnv(env),
    deps: deps.toolAuthDeps || deps,
  }).catch((err) => ({
    ok: true,
    tool: manifest.launch?.tool || 'codex',
    hydrated: false,
    repair_required: true,
    repair_action: 'retry',
    reason: err.message || String(err),
  }));
  const toolAuthStatus = publicToolAuthResult(toolAuth);
  const workspaceReadiness = readinessFromWorkspace(manifest, workspace);
  const readyToolAuth = toolAuthReadiness(toolAuthStatus);
  await runtime.record({
    phase: CLOUD_LIFECYCLE.WAKING,
    runtime_state: 'tool_auth_ready',
    process_status: 'running',
    events: [{ type: 'tool.auth_hydrate.finished', data: toolAuthStatus }],
    readiness: {
      ...workspaceReadiness,
      tool_auth: readyToolAuth,
    },
  });

  const launchEnv = providerLaunchEnv({
    ...env,
    ...(toolAuth.env || {}),
  });
  await runtime.record({
    phase: CLOUD_LIFECYCLE.WAKING,
    runtime_state: 'provider_launching',
    process_status: 'running',
    events: [{
      type: 'provider.launch.started',
      data: {
        tool: manifest.launch?.tool || 'codex',
        auth_ready: toolAuthStatus.hydrated === true && toolAuthStatus.repair_required !== true,
      },
    }],
    readiness: {
      ...workspaceReadiness,
      tool_auth: readyToolAuth,
    },
  });
  const launch = await launchCloudSessionFromManifest(manifest, {
    deps,
    env: launchEnv,
    cwd: workspaceDir,
    stdout,
    stderr,
  });
  if (launch.code !== 0) {
    await runtime.record({
      phase: CLOUD_LIFECYCLE.FAILED,
      runtime_state: 'failed',
      process_status: 'exited',
      exit_code: launch.code,
      error_code: launch.error ? 'cloud_session_launch_failed' : null,
      error: launch.error || 'cloud session launch failed',
      events: [{ type: 'provider.launch.failed', data: { code: launch.code, error: launch.error || null } }],
    });
    if (opts.json) writeJson(stdout, { ok: false, error: launch.error || 'cloud session launch failed', code: launch.code });
    return launch.code || 1;
  }
  const launchedCodingSessionId = launch.payload?.coding_session_id || manifest.coding_session_id || null;

  await runtime.record({
    phase: CLOUD_LIFECYCLE.BROKER_CONNECTING,
    runtime_state: 'broker_connecting',
    process_status: 'running',
    events: [
      {
        type: 'provider.launch.finished',
        data: {
          coding_session_id: launchedCodingSessionId,
          source_id: runtimeSource(manifest).id,
        },
      },
      { type: 'broker.connecting', data: { source_id: runtimeSource(manifest).id } },
    ],
    readiness: {
      ...workspaceReadiness,
      ready: true,
      broker: { connecting: true },
      tool_auth: readyToolAuth,
    },
  });

  let brokerReady = false;
  let currentToolAuthReadiness = readyToolAuth;
  const brokerReadiness = () => (brokerReady ? { connected: true } : { connecting: true });
  const recordBrokerReady = async () => {
    if (brokerReady) return;
    brokerReady = true;
    await runtime.record({
      phase: CLOUD_LIFECYCLE.READY,
      runtime_state: 'ready',
      process_status: 'running',
      events: [
        { type: 'broker.connected', data: { source_id: runtimeSource(manifest).id } },
        { type: 'runtime.ready', data: { coding_session_id: launchedCodingSessionId, source_id: runtimeSource(manifest).id } },
      ],
      readiness: {
        ...workspaceReadiness,
        ready: true,
        broker: brokerReadiness(),
        tool_auth: currentToolAuthReadiness,
      },
    });
  };

  const startPersistWatcher = deps.startToolAuthPersistWatcher || startToolAuthPersistWatcher;
  const stopToolAuthWatcher = startPersistWatcher({
    tool: manifest.launch?.tool || 'codex',
    cloudSessionId,
    env: launchEnv,
    deps: deps.toolAuthDeps || deps,
    intervalMs: deps.toolAuthPersistIntervalMs,
    onResult: async (result) => {
      const status = publicToolAuthResult(result);
      currentToolAuthReadiness = toolAuthReadiness(status);
      await runtime.record({
        phase: brokerReady ? CLOUD_LIFECYCLE.READY : CLOUD_LIFECYCLE.BROKER_CONNECTING,
        runtime_state: brokerReady ? 'ready' : 'broker_connecting',
        process_status: 'running',
        events: [{ type: 'tool.auth_persist.finished', data: status }],
        readiness: {
          ...workspaceReadiness,
          ready: true,
          broker: brokerReadiness(),
          tool_auth: currentToolAuthReadiness,
        },
      });
    },
  });
  const connectBroker = deps.connectBroker || connectBrokerInForeground;
  let brokerCode;
  let shutdownHandled = false;
  const handleRuntimeShutdown = async (signal) => {
    if (shutdownHandled) return 0;
    shutdownHandled = true;
    if (typeof stopToolAuthWatcher === 'function') {
      await stopToolAuthWatcher({ flush: true }).catch(() => null);
    }
    await runtime.record({
      phase: CLOUD_LIFECYCLE.SLEEPING,
      runtime_state: 'snapshotting',
      process_status: 'stopping',
      events: [{ type: 'coding_bin.snapshot.started', data: { signal } }],
      readiness: {
        ...workspaceReadiness,
        ready: false,
        broker: { stopping: true },
        tool_auth: readyToolAuth,
        coding_bin: codingBinReadiness(manifest, { snapshotting: true }),
      },
    });
    const captured = await captureCodingBinSnapshot(manifest, {
      env: launchEnv,
      deps,
      token: runtimeToken,
      cwd: workspaceDir,
      paths,
      runtimeGeneration: runtimeAuthorization.runtimeGeneration,
      authorizationDigest: runtimeAuthorization.authorizationDigest,
      trigger: signal || 'runtime_shutdown',
    });
    const eventType = captured.ok ? 'coding_bin.snapshot.finished' : 'coding_bin.snapshot.failed';
    await runtime.record({
      phase: CLOUD_LIFECYCLE.SLEEPING,
      runtime_state: 'sleeping',
      process_status: 'exited',
      exit_code: 0,
      coding_bin_snapshot_id: captured.snapshot?.id || null,
      coding_bin_snapshot: captured.snapshot || null,
      events: [
        { type: eventType, data: captured },
        { type: 'runtime.sleeping', data: { signal, snapshot_id: captured.snapshot?.id || null } },
      ],
      readiness: {
        ...workspaceReadiness,
        ready: false,
        broker: { connected: false },
        tool_auth: readyToolAuth,
        coding_bin: codingBinReadiness(manifest, { capture: captured }),
      },
    });
    return 0;
  };
  const shutdownHandlers = installRuntimeShutdownHandlers(deps, handleRuntimeShutdown);
  try {
    brokerCode = await connectBroker({
      manifest,
      runtimeAuthorization,
      env: brokerConnectEnvironment(env, brokerToken),
      cwd: workspaceDir,
      json: opts.json,
      stdout,
      stderr,
      onConnected: recordBrokerReady,
    });
  } finally {
    shutdownHandlers.uninstall();
    if (typeof stopToolAuthWatcher === 'function') {
      await stopToolAuthWatcher({ flush: true }).catch(() => null);
    }
  }
  if (shutdownHandled) {
    await shutdownHandlers.wait();
    return 0;
  }
  const code = Number.isInteger(brokerCode) ? brokerCode : 0;
  await runtime.record({
    phase: code === 0 ? CLOUD_LIFECYCLE.STOPPED : CLOUD_LIFECYCLE.FAILED,
    runtime_state: code === 0 ? 'stopped' : 'failed',
    process_status: 'exited',
    exit_code: code,
    ...(code === 0 ? {} : { error_code: 'broker_connect_exited', error: `broker connect exited ${code}` }),
    events: [{ type: 'broker.connect_exited', data: { code } }],
  });

  if (opts.json) {
    writeJson(stdout, {
      ok: code === 0,
      cloud_session_id: cloudSessionId,
      coding_session_id: launchedCodingSessionId,
      broker_exit_code: code,
    });
  }
  return code;
}

// The production gate intentionally has no manifest/env/self-report fallback.
// A platform/control-plane integration must supply opaque, trusted inputs and
// a real installed-byte verifier before a credential-bearing runtime can start.
export async function verifyRuntimeRelease({
  manifest,
  runtimeAuthorization,
  deps = {},
} = {}) {
  const loadTrustedReleaseInputs = deps.loadTrustedReleaseInputs;
  const commitTrustedReleaseState = deps.commitTrustedReleaseState;
  if (typeof loadTrustedReleaseInputs !== 'function' || typeof commitTrustedReleaseState !== 'function') {
    return { ok: false, code: 'platform_identity_unavailable' };
  }
  let trusted;
  const binding = runtimeReleaseBinding(manifest, runtimeAuthorization);
  if (!binding) return { ok: false, code: 'platform_identity_unavailable' };
  try {
    trusted = await loadTrustedReleaseInputs({
      ...binding,
    });
  } catch {
    return { ok: false, code: 'platform_identity_unavailable' };
  }
  if (!trusted || typeof trusted !== 'object' || !trusted.release_trust_inputs) {
    return { ok: false, code: 'platform_identity_unavailable' };
  }
  let verified;
  try {
    const now = typeof deps.now === 'function' ? deps.now() : Date.now();
    if (!Number.isSafeInteger(now)) return { ok: false, code: 'platform_identity_unavailable' };
    verified = await (deps.verifyReleaseTrust || verifyReleaseTrust)({
      ...trusted.release_trust_inputs,
      now_ms: now,
      expected_platform: binding,
    });
  } catch {
    return { ok: false, code: 'platform_identity_unavailable' };
  }
  if (!verified?.ok) {
    return { ok: false, code: stableReleaseGateCode(verified?.code) };
  }
  if (!verified.next_state || typeof verified.next_state !== 'object' || Array.isArray(verified.next_state)) {
    return { ok: false, code: 'platform_identity_unavailable' };
  }
  let artifacts;
  try {
    artifacts = await (deps.verifyInstalledReleaseArtifacts || verifyInstalledReleaseArtifacts)({
      manifest,
      runtimeAuthorization,
      binding,
      verified_release: verified,
      artifact_verification: trusted.artifact_verification || null,
    });
  } catch {
    return { ok: false, code: 'release_artifact_mismatch' };
  }
  if (!artifacts?.ok) return { ok: false, code: 'release_artifact_mismatch' };
  try {
    const committed = await commitTrustedReleaseState({
      binding,
      next_state: verified.next_state,
    });
    if (committed !== true && committed?.ok !== true) return { ok: false, code: 'platform_identity_unavailable' };
  } catch {
    return { ok: false, code: 'platform_identity_unavailable' };
  }
  return {
    ok: true,
    release_id: typeof verified.release_id === 'string' ? verified.release_id : null,
    release_epoch: Number.isSafeInteger(verified.release_epoch) ? verified.release_epoch : null,
  };
}

export function runtimeReleaseBinding(manifest, runtimeAuthorization) {
  const accountId = stringOrNull(manifest?.account_id);
  const authorizationDigest = runtimeAuthorization?.authorizationDigest;
  if (!validManifestAccountId(accountId) || !AUTHORIZATION_DIGEST_RE.test(authorizationDigest || '')) return null;
  return {
    account_id: accountId,
    cloud_session_id: manifest?.cloud_session_id,
    coding_session_id: manifest?.coding_session_id,
    runtime_generation: runtimeAuthorization?.runtimeGeneration,
    authorization_digest: authorizationDigest,
    nonce: authorizationDigest,
  };
}

// Deliberately fail closed until the next step supplies the signed descriptor
// and hashes every installed executable tree before model launch.
export async function verifyInstalledReleaseArtifacts() {
  return { ok: false };
}

function stableReleaseGateCode(code) {
  return Object.values(RELEASE_TRUST_CODES).includes(code)
    ? code
    : 'platform_identity_unavailable';
}

export function parseArgs(argv) {
  const opts = {
    verb: null,
    json: false,
    help: false,
    cloudSessionId: null,
    manifestPath: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { opts.help = true; continue; }
    if (a === '--json') { opts.json = true; continue; }
    if (a === '--cloud-session-id') {
      opts.cloudSessionId = valueAfter(argv, ++i);
      if (isMissing(opts.cloudSessionId)) return missingValue(opts, a);
      continue;
    }
    if (a === '--manifest') {
      opts.manifestPath = valueAfter(argv, ++i);
      if (isMissing(opts.manifestPath)) return missingValue(opts, a);
      continue;
    }
    if (a.startsWith('--')) return { ...opts, error: `unknown flag: ${a}` };
    if (opts.verb) return { ...opts, error: `unexpected arg: ${a}` };
    opts.verb = a;
  }
  return opts;
}

export function validateCloudRuntimeOptions(opts) {
  if (!opts?.cloudSessionId || !CLOUD_SESSION_ID_RE.test(opts.cloudSessionId)) {
    return { ok: false, error: 'cloud session id is required and must match /^cld_[a-zA-Z0-9_-]{6,}$/' };
  }
  if (!opts.manifestPath || typeof opts.manifestPath !== 'string') {
    return { ok: false, error: '--manifest is required' };
  }
  return { ok: true };
}

export async function prepareWorkspace(manifest, {
  env = process.env,
  deps = {},
  cwd = runtimeWorkspaceDir(manifest),
} = {}) {
  const repoRef = safeRuntimeRepoRef(manifest?.repo?.ref);
  const cloneUrl = repoCloneUrl(repoRef);
  const branch = stringOrNull(manifest?.repo?.workspace_ref);
  const existing = deps.existsSync || existsSync;
  const runProcess = deps.runProcess || runProcessDefault;
  const mkdir = deps.mkdir || mkdirSync;
  const remove = deps.rm || rmSync;

  await reportWorkspaceProgress(deps, 'workspace.prepare.inspecting', {
    cwd,
    repo_ref: repoRef,
    workspace_ref: branch,
  });

  // A cloud session that names a repository must never degrade into an
  // initialized-but-empty workspace when its repository reference is absent
  // or malformed. That would let the runtime report ready for the wrong
  // project after an authorization or manifest error.
  if (requiresRepositoryCheckout(manifest) && !cloneUrl) {
    return {
      ok: false,
      code: 'repository_clone_target_missing',
      error: 'repository checkout requires a valid clone target',
      cwd,
      repo_ref: repoRef,
      workspace_ref: branch,
      initialized_empty: false,
      clone_failed: false,
      git_auth: gitAuthReadiness(manifest, env, { cloneFailed: true }),
    };
  }

  if (existing(join(cwd, '.git'))) {
    return {
      ok: true,
      cwd,
      reused_existing: true,
      cloned: false,
      initialized_empty: false,
      repo_ref: repoRef,
      workspace_ref: branch,
      git_auth: gitAuthReadiness(manifest, env, { usedCredential: false }),
    };
  }

  if (existing(cwd)) {
    if (!isSafeRuntimeRmPath(cwd)) {
      return {
        ok: false,
        code: 'unsafe_workspace_path',
        error: `refusing to replace unsafe workspace path: ${cwd}`,
      };
    }
    remove(cwd, { recursive: true, force: true });
  }
  mkdir(dirname(cwd), { recursive: true, mode: 0o700 });

  if (cloneUrl) {
    const cloneTimeoutMs = workspaceCloneTimeoutMs(deps.workspaceCloneTimeoutMs);
    const cloneArgs = [
      '-c',
      'protocol.version=2',
      'clone',
      '--depth',
      '1',
      '--filter=blob:none',
      '--single-branch',
      '--no-tags',
    ];
    if (branch) cloneArgs.push('--branch', branch);
    cloneArgs.push(cloneUrl, cwd);
    await reportWorkspaceProgress(deps, 'workspace.clone.started', {
      cwd,
      repo_ref: repoRef,
      workspace_ref: branch,
      timeout_ms: cloneTimeoutMs,
      strategy: 'partial_clone',
    });
    const clone = await runGit(cloneArgs, {
      env,
      deps,
      runProcess,
      timeoutMs: cloneTimeoutMs,
    });
    await reportWorkspaceProgress(deps, 'workspace.clone.finished', {
      cwd,
      repo_ref: repoRef,
      workspace_ref: branch,
      ok: clone.ok,
      exit_code: Number.isInteger(clone.code) ? clone.code : null,
      timed_out: clone.timedOut === true,
    });
    if (clone.ok) {
      return {
        ok: true,
        cwd,
        reused_existing: false,
        cloned: true,
        initialized_empty: false,
        repo_ref: repoRef,
        workspace_ref: branch,
        git_auth: gitAuthReadiness(manifest, env, { usedCredential: clone.usedCredential }),
      };
    }
    if (isSafeRuntimeRmPath(cwd)) remove(cwd, { recursive: true, force: true });
    return {
      ok: false,
      code: clone.timedOut ? 'workspace_clone_timeout' : 'workspace_clone_failed',
      error: clone.timedOut
        ? `repo clone timed out after ${Math.ceil(cloneTimeoutMs / 1000)}s`
        : `repo clone failed: ${boundedProcessError(clone.error)}`,
      cwd,
      reused_existing: false,
      cloned: false,
      initialized_empty: false,
      repo_ref: repoRef,
      workspace_ref: branch,
      clone_failed: true,
      clone_error: boundedProcessError(clone.error),
      git_auth: gitAuthReadiness(manifest, env, { usedCredential: clone.usedCredential, cloneFailed: true }),
    };
  }

  return initEmptyWorkspace({ cwd, repoRef, branch, env, deps, runProcess, mkdir });
}

async function initEmptyWorkspace({ cwd, repoRef, branch, env, deps, runProcess, mkdir }) {
  mkdir(cwd, { recursive: true, mode: 0o700 });
  const init = await runGit(['-C', cwd, 'init'], { env, deps, runProcess });
  if (!init.ok) {
    return { ok: false, code: 'git_init_failed', error: init.error || 'git init failed', cwd };
  }
  if (repoRef) {
    await runGit(['-C', cwd, 'remote', 'add', 'origin', repoRef], { env, deps, runProcess });
  }
  if (branch) {
    await runGit(['-C', cwd, 'checkout', '-B', branch], { env, deps, runProcess });
  }
  return {
    ok: true,
    cwd,
    reused_existing: false,
    cloned: false,
    initialized_empty: true,
    repo_ref: repoRef,
    workspace_ref: branch,
    git_auth: gitAuthReadiness({ repo: { ref: repoRef } }, env, { usedCredential: false }),
  };
}

async function launchCloudSessionFromManifest(manifest, {
  deps = {},
  env = process.env,
  cwd,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const source = runtimeSource(manifest);
  const launch = manifest.launch || {};
  const repo = manifest.repo || {};
  const args = [
    'start',
    '--cloud-session-id',
    manifest.cloud_session_id,
    '--source-id',
    source.id,
    '--source-name',
    source.name,
    '--name',
    launch.name || defaultLaunchName(manifest),
    '--tool',
    launch.tool || 'codex',
    '--policy',
    launch.policy || 'workspace-write',
    '--json',
  ];
  addArg(args, '--coding-session-id', manifest.coding_session_id);
  addArg(args, '--task', launch.task);
  addArg(args, '--repo-ref', repo.ref);
  addArg(args, '--workspace-ref', repo.workspace_ref);

  const launchStdout = stringWriter(stdout);
  const runCloudSession = deps.runCloudSessionWith || runCloudSessionWith;
  const launchFn = deps.launchBrokerOwnedSession || launchBrokerOwnedSession;
  const code = await runCloudSession(parseCloudSessionArgs(args), {
    cwd: () => cwd,
    env,
    stdout: launchStdout,
    stderr,
    launchBrokerOwnedSession: async (launchArgs) => launchFn({
      ...launchArgs,
      // The runtime supervisor owns the foreground broker connection. Attaching
      // here would block on the provider session before that bridge can start.
      attachAfterLaunch: false,
      ensureCloudBroker: async () => ({ ok: true, skipped: true, supervisor_managed: true }),
    }),
  });
  return {
    code,
    payload: parseJsonSafe(launchStdout.value()),
    error: code === 0 ? null : launchStdout.value(),
  };
}

function connectBrokerInForeground({
  manifest,
  runtimeAuthorization = null,
  env = process.env,
  cwd = process.cwd(),
  json = false,
  stdout = process.stdout,
  stderr = process.stderr,
  onConnected = null,
} = {}) {
  const source = runtimeSource(manifest);
  const args = brokerConnectArgs({
    sourceId: source.id,
    machineId: source.machineId,
    sourceKind: source.kind,
    sourceName: source.name,
    cloudSessionId: manifest.cloud_session_id,
    codingSessionId: manifest.coding_session_id,
    cloudRuntime: true,
    runtimeGeneration: runtimeAuthorization?.runtimeGeneration || manifest.authorization?.runtime_generation,
    authorizationDigest: runtimeAuthorization?.authorizationDigest || manifest.authorization?.authorization_digest,
  });
  if (json) args.push('--json');
  return new Promise((resolve) => {
    let connectedPromise = null;
    let stdoutBuffer = '';
    const notifyConnected = () => {
      if (connectedPromise || typeof onConnected !== 'function') return connectedPromise;
      connectedPromise = Promise.resolve(onConnected()).catch(() => null);
      return connectedPromise;
    };
    const child = spawn(process.execPath, [resolveMcBinPath(), ...args], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => {
      stdout.write(chunk);
      stdoutBuffer = `${stdoutBuffer}${String(chunk || '')}`.slice(-4096);
      if (brokerConnectOutputIndicatesReady(stdoutBuffer)) void notifyConnected();
    });
    child.stderr.on('data', (chunk) => stderr.write(chunk));
    child.on('error', (err) => {
      stderr.write(`mc: broker connect spawn failed (${safeError(err)})\n`);
      resolve(1);
    });
    child.on('close', async (code) => {
      if (connectedPromise) await connectedPromise;
      resolve(Number.isInteger(code) ? code : 1);
    });
  });
}

export function brokerConnectOutputIndicatesReady(chunk) {
  const text = String(chunk || '');
  if (/connected to cloud/i.test(text)) return true;
  const candidates = [text.trim()];
  const objectStart = text.lastIndexOf('{');
  if (objectStart > 0) candidates.push(text.slice(objectStart).trim());
  for (const candidate of candidates) {
    const parsed = parseJsonSafe(candidate);
    if (parsed?.ok === true && parsed.machine_id) return true;
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('{')) continue;
    const parsed = parseJsonSafe(trimmed);
    if (parsed?.ok === true && parsed.machine_id) return true;
  }
  return false;
}

function createRuntimeRecorder({
  cloudSessionId,
  manifest,
  paths,
  token,
  apiUrl,
  runtimeAuthorization,
  deps = {},
}) {
  return {
    async record(report) {
      const now = isoNow(deps);
      const normalized = {
        phase: report.phase || CLOUD_LIFECYCLE.REQUESTED,
        runtime_state: report.runtime_state || report.phase || CLOUD_LIFECYCLE.REQUESTED,
        process_status: report.process_status || 'running',
        exit_code: Number.isInteger(report.exit_code) ? report.exit_code : null,
        error_code: report.error_code || null,
        error: report.error ? safeError(report.error) : null,
        coding_bin_id: report.coding_bin_id || manifest.coding_bin_id || manifest.coding_bin?.id || null,
        coding_bin_snapshot_id: report.coding_bin_snapshot_id || report.coding_bin_snapshot?.id || null,
        coding_bin_snapshot: report.coding_bin_snapshot || null,
        readiness: report.readiness || null,
        events: (report.events || []).map((event) => runtimeEvent(manifest, event.type, {
          at: now,
          data: event.data || {},
        })),
      };
      writeRuntimeFiles(paths, normalized, deps);
      if (token && apiUrl) {
        const reporter = deps.reportRuntimeStatus || reportRuntimeStatus;
        await reporter({
          apiUrl,
          token,
          cloudSessionId,
          report: normalized,
          runtimeGeneration: runtimeAuthorization.runtimeGeneration,
          authorizationDigest: runtimeAuthorization.authorizationDigest,
        }).catch(() => null);
      }
    },
  };
}

function writeRuntimeFiles(paths, report, deps = {}) {
  const mkdir = deps.mkdir || mkdirSync;
  const writeFile = deps.writeFile || writeFileSync;
  const appendFile = deps.appendFile || appendFileSync;
  mkdir(paths.dir, { recursive: true, mode: 0o700 });
  writeFile(paths.status, JSON.stringify(runtimeStatusFile(report), null, 2), { mode: 0o600 });
  if (report.readiness) {
    writeFile(paths.readiness, JSON.stringify(sanitizeRuntimeData(report.readiness), null, 2), { mode: 0o600 });
  }
  for (const event of report.events || []) {
    appendFile(paths.events, JSON.stringify(sanitizeRuntimeData(event)) + '\n', { mode: 0o600 });
  }
}

function runtimeStatusFile(report) {
  return sanitizeRuntimeData({
    contract_version: CLOUD_RUNTIME_CONTRACT_VERSION,
    phase: report.phase,
    runtime_state: report.runtime_state,
    process_status: report.process_status,
    exit_code: report.exit_code,
    error_code: report.error_code,
    error: report.error,
    coding_bin_id: report.coding_bin_id,
    coding_bin_snapshot_id: report.coding_bin_snapshot_id,
    coding_bin_snapshot: report.coding_bin_snapshot,
    readiness: report.readiness,
    updated_at: isoNow({}),
  });
}

async function reportRuntimeStatus({ apiUrl, token, cloudSessionId, report, runtimeGeneration, authorizationDigest }) {
  return memoroFetch(apiUrl, `/api/mc/cloud-sessions/${encodeURIComponent(cloudSessionId)}/runtime-status`, {
    token,
    method: 'POST',
    body: sanitizeRuntimeData(report),
    requestHeaders: runtimeAuthorizationHeaders({ runtimeGeneration, authorizationDigest }),
    timeoutMs: 10_000,
  });
}

function runGit(args, {
  env,
  deps = {},
  runProcess,
  timeoutMs = null,
}) {
  // Cloud runtime accepts only the credential-free HTTPS transport. Do not
  // inherit Git configuration, hooks, askpass, SSH agent, proxy, or GitHub CLI
  // state: private access belongs to a future typed pre-launch operation, not
  // to a generic git child process.
  const finalArgs = [
    '-c', 'credential.helper=',
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'init.templateDir=',
    '-c', 'http.proxy=',
    '-c', 'http.sslVerify=true',
    '-c', 'protocol.file.allow=never',
    '-c', 'protocol.ext.allow=never',
    ...args,
  ];
  const gitEnv = isolatedGitEnvironment(env);
  const processCwd = typeof deps.cwd === 'function' ? deps.cwd() : deps.cwd;
  return runProcess('git', finalArgs, {
    env: {
      ...gitEnv,
      GIT_TERMINAL_PROMPT: '0',
      GIT_LFS_SKIP_SMUDGE: '1',
    },
    cwd: processCwd || process.cwd(),
    timeoutMs,
    signal: deps.workspaceAbortSignal,
  }).then((res) => ({
    ok: res?.code === 0,
    code: res?.code,
    timedOut: res?.timedOut === true,
    error: res?.code === 0 ? null : (res?.stderr || res?.error || `git exited ${res?.code ?? 'unknown'}`),
    usedCredential: false,
  }));
}

export function runProcessDefault(cmd, args, options = {}) {
  return new Promise((resolve) => {
    const timeoutMs = positiveTimeoutMs(options.timeoutMs);
    const abortSignal = options.signal;
    const ownsProcessGroup = timeoutMs !== null && process.platform !== 'win32';
    const child = spawn(cmd, args, {
      cwd: options.cwd || process.cwd(),
      env: options.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: ownsProcessGroup,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let timeoutTimer = null;
    let forceKillTimer = null;
    let forceResolveTimer = null;
    let abortListener = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (forceResolveTimer) clearTimeout(forceResolveTimer);
      if (abortSignal && abortListener) {
        abortSignal.removeEventListener('abort', abortListener);
      }
      resolve({ ...result, stdout, stderr, timedOut });
    };
    const killOwnedProcess = (signal) => {
      if (ownsProcessGroup && Number.isInteger(child.pid)) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // The group may already be gone; fall through to the direct child.
        }
      }
      try {
        child.kill(signal);
      } catch {
        // A concurrent process exit is completed by the close handler.
      }
    };
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (err) => finish({ code: 1, error: err.message || String(err) }));
    child.on('close', (code, signal) => finish({
      code: timedOut ? 124 : (Number.isInteger(code) ? code : 1),
      error: timedOut ? `process timed out after ${Math.ceil(timeoutMs / 1000)}s` : null,
      signal: signal || null,
    }));
    const terminateForTimeout = () => {
      if (settled || timedOut) return;
      timedOut = true;
      killOwnedProcess('SIGTERM');
      forceKillTimer = setTimeout(() => {
        killOwnedProcess('SIGKILL');
        forceResolveTimer = setTimeout(() => finish({
          code: 124,
          error: `process timed out after ${Math.ceil(timeoutMs / 1000)}s`,
          signal: 'SIGKILL',
        }), PROCESS_FORCE_RESOLVE_GRACE_MS);
      }, PROCESS_FORCE_KILL_GRACE_MS);
    };
    timeoutTimer = timeoutMs ? setTimeout(terminateForTimeout, timeoutMs) : null;
    if (abortSignal) {
      abortListener = terminateForTimeout;
      if (abortSignal.aborted) {
        queueMicrotask(terminateForTimeout);
      } else {
        abortSignal.addEventListener('abort', abortListener, { once: true });
      }
    }
  });
}

function installRuntimeShutdownHandlers(deps = {}, onShutdown) {
  const proc = deps.process || process;
  if (!proc || typeof proc.once !== 'function' || typeof onShutdown !== 'function') {
    return { uninstall() {}, wait: async () => null };
  }
  let handled = false;
  let shutdownPromise = null;
  const handler = (signal) => {
    if (handled) return;
    handled = true;
    shutdownPromise = Promise.resolve()
      .then(() => onShutdown(signal))
      .then((code) => {
        if (typeof proc.exit === 'function') proc.exit(Number.isInteger(code) ? code : 0);
        return code;
      })
      .catch(() => {
        if (typeof proc.exit === 'function') proc.exit(1);
        return 1;
      });
  };
  proc.once('SIGTERM', handler);
  proc.once('SIGINT', handler);
  return {
    uninstall() {
      if (typeof proc.off === 'function') {
        proc.off('SIGTERM', handler);
        proc.off('SIGINT', handler);
      } else if (typeof proc.removeListener === 'function') {
        proc.removeListener('SIGTERM', handler);
        proc.removeListener('SIGINT', handler);
      }
    },
    wait: async () => shutdownPromise,
  };
}

async function readRuntimeManifest(path, deps = {}) {
  const readFile = deps.readFile || readFileSync;
  return JSON.parse(readFile(path, 'utf8'));
}

function validateManifest(manifest, opts) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, error: 'manifest must be a JSON object' };
  }
  if (manifest.contract_version !== CLOUD_RUNTIME_CONTRACT_VERSION) {
    return { ok: false, error: `unsupported manifest contract: ${manifest.contract_version}` };
  }
  if (!CLOUD_SESSION_ID_RE.test(manifest.cloud_session_id || '')) {
    return { ok: false, error: 'manifest cloud_session_id is invalid' };
  }
  if (!validManifestAccountId(manifest.account_id)) {
    return { ok: false, error: 'manifest account_id is invalid' };
  }
  if (opts.cloudSessionId && manifest.cloud_session_id !== opts.cloudSessionId) {
    return { ok: false, error: 'manifest cloud_session_id does not match --cloud-session-id' };
  }
  const authorization = manifest.authorization || {};
  if (!RUNTIME_GENERATION_RE.test(stringOrNull(authorization.runtime_generation) || '')) {
    return { ok: false, error: 'manifest runtime authorization generation is invalid' };
  }
  if (!AUTHORIZATION_DIGEST_RE.test(stringOrNull(authorization.authorization_digest) || '')) {
    return { ok: false, error: 'manifest runtime authorization digest is invalid' };
  }
  return { ok: true };
}

function validateRuntimeAuthorization(manifest, env = {}) {
  const runtimeGeneration = stringOrNull(manifest?.authorization?.runtime_generation);
  const authorizationDigest = stringOrNull(manifest?.authorization?.authorization_digest);
  if (!RUNTIME_GENERATION_RE.test(runtimeGeneration || '') || !AUTHORIZATION_DIGEST_RE.test(authorizationDigest || '')) {
    return { ok: false, error: 'manifest runtime authorization metadata is invalid' };
  }
  const envGeneration = stringOrNull(env.MC_CLOUD_RUNTIME_GENERATION);
  const envDigest = stringOrNull(env.MC_CLOUD_AUTHORIZATION_DIGEST);
  if (!envGeneration || !envDigest) {
    return { ok: false, error: 'runtime authorization metadata is missing from supervisor environment' };
  }
  if (envGeneration !== runtimeGeneration || envDigest !== authorizationDigest) {
    return { ok: false, error: 'runtime authorization metadata does not match supervisor environment' };
  }
  return { ok: true, runtimeGeneration, authorizationDigest };
}

function validManifestAccountId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function runtimeAuthorizationHeaders({ runtimeGeneration, authorizationDigest } = {}) {
  return {
    'X-MC-Runtime-Generation': runtimeGeneration,
    'X-MC-Authorization-Digest': authorizationDigest,
  };
}

function runtimePaths(manifest, env = {}, manifestPath = null) {
  const paths = manifest.runtime?.paths || {};
  const status = env.MC_CLOUD_RUNTIME_STATUS || paths.status || join(DEFAULT_RUNTIME_DIR, 'status.json');
  const events = env.MC_CLOUD_RUNTIME_EVENTS || paths.events || join(DEFAULT_RUNTIME_DIR, 'events.jsonl');
  const readiness = env.MC_CLOUD_RUNTIME_READINESS || paths.readiness || join(DEFAULT_RUNTIME_DIR, 'readiness.json');
  return {
    dir: paths.dir || dirname(status),
    manifest: env.MC_CLOUD_RUNTIME_MANIFEST || manifestPath || paths.manifest || join(DEFAULT_RUNTIME_DIR, 'manifest.json'),
    status,
    events,
    readiness,
  };
}

function runtimeWorkspaceDir(manifest) {
  return stringOrNull(manifest?.runtime?.cwd) || DEFAULT_REPO_CWD;
}

async function resolveRuntimeToken({ env = process.env, deps = {} }) {
  return stringOrNull(env.MEMORO_TOKEN);
}

async function resolveRuntimeApiUrl({ manifest, env = process.env, deps = {} }) {
  const manifestUrl = safeUrl(manifest?.runtime?.api_url);
  if (manifestUrl) return manifestUrl;
  const envUrl = safeUrl(env.MEMORO_API_URL);
  if (envUrl) return envUrl;
  const read = deps.readConfig || readConfig;
  const config = await read().catch(() => ({}));
  return safeUrl(config.apiUrl) || DEFAULT_API_URL;
}

function providerLaunchEnv(env = {}) {
  const next = scrubRuntimeSecretsFromEnv(env);
  for (const name of SECRET_ENV_NAMES_AFTER_WORKSPACE) delete next[name];
  return next;
}

function brokerConnectEnvironment(env = {}, brokerToken = null) {
  const next = { ...(env || {}) };
  delete next.MEMORO_TOKEN;
  delete next.MEMORO_BROKER_TOKEN;
  delete next.MC_CLOUD_RUNTIME_GENERATION;
  delete next.MC_CLOUD_AUTHORIZATION_DIGEST;
  if (brokerToken) next.MEMORO_BROKER_TOKEN = brokerToken;
  return next;
}

function resolveBrokerToken({ env = process.env } = {}) {
  return stringOrNull(env.MEMORO_BROKER_TOKEN);
}

function runtimeSource(manifest) {
  return {
    id: stringOrNull(manifest?.source?.id) || `cloud:${manifest?.cloud_session_id || 'unknown'}`,
    kind: 'cloud',
    name: stringOrNull(manifest?.source?.name) || 'Memoro Cloud',
    machineId: stringOrNull(manifest?.source?.machine_id) || `memoro-cloud-${manifest?.cloud_session_id || 'unknown'}`,
  };
}

function initialReadiness(manifest, { tokenPresent }) {
  const git = gitAuthReadiness(manifest, {}, {});
  return sanitizeRuntimeData({
    ok: tokenPresent,
    ready: false,
    runtime_token: { present: tokenPresent, secret_boundary: 'env_only' },
    repo: {
      ref: manifest.repo?.ref || null,
      workspace_ref: manifest.repo?.workspace_ref || null,
      access: manifest.repo?.access || null,
      credential_source: manifest.repo?.credential_source || null,
    },
    git,
    vault: vaultReadiness(manifest),
    tool_auth: {
      tool: manifest.launch?.tool || 'codex',
      mode: 'vault',
      ready: false,
      hydrated: false,
      repair_required: false,
      secret_boundary: 'status_only',
    },
  });
}

function readinessFromWorkspace(manifest, workspace) {
  const git = workspace.git_auth || gitAuthReadiness(manifest, {}, {});
  return sanitizeRuntimeData({
    ok: workspace.ok === true,
    ready: workspace.ok === true,
    repo: {
      cwd: workspace.cwd || runtimeWorkspaceDir(manifest),
      ref: workspace.repo_ref || manifest.repo?.ref || null,
      workspace_ref: workspace.workspace_ref || manifest.repo?.workspace_ref || null,
      cloned: workspace.cloned === true,
      reused_existing: workspace.reused_existing === true,
      initialized_empty: workspace.initialized_empty === true,
      clone_failed: workspace.clone_failed === true,
    },
    git,
    git_auth: git,
    vault: vaultReadiness(manifest),
    tool_auth: {
      tool: manifest.launch?.tool || 'codex',
      mode: 'vault',
      ready: false,
      hydrated: false,
      repair_required: false,
      secret_boundary: 'status_only',
    },
  });
}

function toolAuthReadiness(status = {}) {
  const repairRequired = status.repair_required === true;
  const hydrated = status.hydrated === true;
  return sanitizeRuntimeData({
    tool: status.tool || null,
    label: status.label || null,
    mode: 'vault',
    present: status.present === true,
    ready: hydrated && !repairRequired,
    hydrated,
    persisted: status.persisted === true,
    repair_required: repairRequired,
    repair_action: status.repair_action || null,
    reason: status.reason || null,
    secret_boundary: 'status_only',
  });
}

function vaultReadiness(manifest) {
  return sanitizeRuntimeData({
    mode: 'mc vault',
    ready: true,
    git_credential_source: manifest?.repo?.credential_source || manifest?.repo?.git_auth?.credential_source || null,
    tool_auth_profile: manifest?.launch?.tool ? `tool_auth.${manifest.launch.tool}` : null,
    exposes_secrets_to_llm: false,
    secret_boundary: 'runtime_only',
  });
}

function gitAuthReadiness(manifest, env = {}, {
  usedCredential = false,
  cloneFailed = false,
} = {}) {
  const auth = manifest?.repo?.git_auth || {};
  const credentialSource = stringOrNull(auth.credential_source || manifest?.repo?.credential_source);
  const privateAccess = /private|capability/i.test(String(auth.access || manifest?.repo?.access || ''));
  return sanitizeRuntimeData({
    access: auth.access || manifest?.repo?.access || null,
    grant_kind: auth.grant_kind || manifest?.repo?.grant_kind || null,
    credential_source: credentialSource,
    // `ready` is control-plane descriptor metadata, not a local credential
    // source. The runtime never upgrades it from an ambient token.
    ready: !privateAccess || usedCredential || auth.ready === true,
    repair_required: (privateAccess && !usedCredential && auth.ready !== true) || cloneFailed,
    secret_boundary: auth.secret_boundary || 'status_only',
  });
}

function isolatedGitEnvironment(env = {}) {
  const gitEnv = { ...env };
  for (const name of Object.keys(gitEnv)) {
    if (
      name.startsWith('GIT_')
      || name.startsWith('GH_')
      || name.startsWith('GITHUB_')
      || name === 'MC_CLOUD_GIT_TOKEN'
      || name === 'MC_CLOUD_GIT_SECRET_CAPABILITY'
      || name === 'MC_GIT_CLONE_TOKEN'
      || name === 'SSH_AUTH_SOCK'
      || name === 'SSH_AGENT_PID'
      || name === 'SSH_ASKPASS'
      || name === 'SSH_ASKPASS_REQUIRE'
      || /^(?:ALL|HTTP|HTTPS|NO)_PROXY$/i.test(name)
    ) {
      delete gitEnv[name];
    }
  }
  // These explicit values disable system/global config and interactive Git
  // prompts even when the sandbox image happens to contain user state. A
  // non-directory home also prevents ambient netrc/XDG credential discovery.
  gitEnv.GIT_CONFIG_NOSYSTEM = '1';
  gitEnv.GIT_CONFIG_GLOBAL = '/dev/null';
  gitEnv.HOME = '/dev/null';
  gitEnv.XDG_CONFIG_HOME = '/dev/null';
  return gitEnv;
}

function requiresRepositoryCheckout(manifest) {
  const repo = manifest?.repo || {};
  return repo.required === true
    || Boolean(stringOrNull(repo.id))
    || Boolean(stringOrNull(repo.ref));
}

function runtimeEvent(manifest, type, { at, data = {} } = {}) {
  return sanitizeRuntimeData({
    contract_version: CLOUD_RUNTIME_CONTRACT_VERSION,
    type,
    at,
    cloud_session_id: manifest.cloud_session_id,
    coding_session_id: manifest.coding_session_id || null,
    source_id: runtimeSource(manifest).id,
    data,
  });
}

function sanitizeRuntimeData(value, depth = 0) {
  if (depth > 6) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeRuntimeData(item, depth + 1));
  if (typeof value === 'string') return redactCredentialText(value);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (!isSafeRuntimeMetadataKey(key) && /(token|secret|password|passphrase|private.?key|access.?key|refresh|auth.?json|api.?key|credential(?!_source)|capability)/i.test(key)) {
      out[key] = '[redacted]';
      continue;
    }
    out[key] = sanitizeRuntimeData(child, depth + 1);
  }
  return out;
}

function isSafeRuntimeMetadataKey(key) {
  return [
    'credential_source',
    'secret_boundary',
    'exposes_secrets_to_llm',
  ].includes(key);
}

function safeRuntimeRepoRef(value) {
  const repoRef = stringOrNull(value);
  if (!repoRef || !/^https?:\/\//i.test(repoRef)) return repoRef;
  try {
    const url = new URL(repoRef);
    if (url.username || url.password) return null;
    return repoRef;
  } catch {
    return null;
  }
}

function repoCloneUrl(repoRef) {
  const value = stringOrNull(repoRef);
  if (!value) return null;
  if (/^https:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (url.username || url.password || url.search || url.hash) return null;
      return value;
    } catch {
      return null;
    }
  }
  // SSH can implicitly consult agents, known-host configuration, command
  // wrappers, and key files. It is not a supported cloud-runtime transport.
  if (/^(ssh:\/\/|git@)/i.test(value)) return null;
  if (GITHUB_SHORTHAND_RE.test(value)) return `https://github.com/${value.replace(/\.git$/, '')}.git`;
  return null;
}

function isSafeRuntimeRmPath(path) {
  const p = String(path || '').replace(/\/+$/, '');
  return p.startsWith('/workspace/') || p.startsWith('/tmp/') || p.startsWith('/private/tmp/');
}

function defaultLaunchName(manifest) {
  const base = stringOrNull(manifest?.launch?.task)
    || stringOrNull(manifest?.cloud_session_id)
    || 'cloud-session';
  return base
    .replace(/^cld_/, 'cloud-')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^[^a-zA-Z0-9]+/, '')
    .replace(/-+/g, '-')
    .slice(0, 64) || 'cloud-session';
}

function addArg(args, flag, value) {
  if (typeof value === 'string' && value.trim()) args.push(flag, value.trim());
}

function valueAfter(argv, index) {
  return argv[index];
}

function isMissing(value) {
  return !value || value.startsWith('--');
}

function missingValue(opts, flag) {
  return { ...opts, error: `${flag} requires a value` };
}

function stringWriter(base = process.stdout) {
  let value = '';
  return {
    columns: base?.columns || 80,
    rows: base?.rows || 24,
    write(chunk) { value += String(chunk); },
    value() { return value; },
  };
}

function parseJsonSafe(value) {
  try {
    return JSON.parse(String(value || '').trim());
  } catch {
    return null;
  }
}

function writeJson(stdout, payload) {
  stdout.write(JSON.stringify(payload, null, 2) + '\n');
}

function isoNow(deps = {}) {
  const now = deps.now || (() => new Date().toISOString());
  return now();
}

function safeUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    return url.origin;
  } catch {
    return null;
  }
}

function safeError(err) {
  return String(err?.message || err || 'unknown').slice(0, 500);
}

function boundedProcessError(error) {
  return stringOrNull(error)?.replace(/\s+/g, ' ').slice(0, 500) || 'unknown git error';
}

function positiveTimeoutMs(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

function workspaceCloneTimeoutMs(value) {
  return positiveTimeoutMs(value) || DEFAULT_WORKSPACE_CLONE_TIMEOUT_MS;
}

function workspacePrepareTimeoutMs(value, cloneTimeoutMs) {
  return positiveTimeoutMs(value)
    || cloneTimeoutMs + WORKSPACE_PREPARE_WATCHDOG_GRACE_MS;
}

async function withWorkspacePrepareWatchdog(workspacePromise, {
  timeoutMs,
  abortController,
  cwd,
  repoRef,
  workspaceRef,
}) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      abortController.abort();
      resolve({
        ok: false,
        code: 'workspace_prepare_timeout',
        error: `workspace prepare timed out after ${Math.ceil(timeoutMs / 1000)}s`,
        cwd,
        repo_ref: repoRef,
        workspace_ref: workspaceRef,
        timed_out: true,
      });
    }, timeoutMs);
  });
  try {
    return await Promise.race([workspacePromise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function reportWorkspaceProgress(deps, type, data) {
  if (typeof deps.onWorkspaceProgress !== 'function') return;
  await Promise.resolve(deps.onWorkspaceProgress({ type, data })).catch(() => null);
}

function stringOrNull(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function printUsage(stream = process.stdout) {
  stream.write(`mc cloud-runtime — internal cloud sandbox runtime supervisor

USAGE
  mc cloud-runtime run --cloud-session-id <cld_id> --manifest <path> [--json]

This command reads the server-written runtime manifest, prepares the runtime
workspace, launches a typed mc cloud-session, reports readiness/status, and
keeps the cloud broker connection in the foreground.
`);
}
