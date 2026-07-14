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

import { ACCOUNTS } from '../../commands/auth.js';
import { memoroFetch } from '../../lib/api.js';
import { readConfig } from '../../lib/config.js';
import { getSecret } from '../../lib/keychain.js';
import { brokerConnectArgs, resolveMcBinPath } from '../broker/cloud-supervisor.js';
import { launchBrokerOwnedSession } from '../broker/launch-client.js';
import {
  parseArgs as parseCloudSessionArgs,
  runCloudSessionWith,
} from './cloud-session.js';
import {
  hydrateToolAuth,
  publicToolAuthResult,
  startToolAuthPersistWatcher,
} from '../tool-auth.js';
import {
  captureCodingBinSnapshot,
  codingBinReadiness,
  restoreCodingBinSnapshot,
} from '../cloud-runtime-snapshot.js';

export const CLOUD_RUNTIME_CONTRACT_VERSION = 'mc-cloud-runtime-v1';

export const CLOUD_LIFECYCLE = Object.freeze({
  REQUESTED: 'requested',
  RUNTIME_TOKEN_MINTED: 'runtime_token_minted',
  WAKING: 'waking',
  BROKER_CONNECTING: 'broker_connecting',
  READY: 'ready',
  SLEEPING: 'sleeping',
  FAILED: 'failed',
  STOPPED: 'stopped',
});

const CLOUD_SESSION_ID_RE = /^cld_[a-zA-Z0-9_-]{6,}$/;
const DEFAULT_RUNTIME_DIR = '/workspace/mc-runtime';
const DEFAULT_REPO_CWD = '/workspace/repo';
const DEFAULT_API_URL = 'https://meetmemoro.app';
const GITHUB_SHORTHAND_RE = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;
const SECRET_ENV_NAMES_AFTER_WORKSPACE = Object.freeze([
  'MC_CLOUD_GIT_TOKEN',
  'MC_CLOUD_GIT_SECRET_CAPABILITY',
  'MC_GIT_CLONE_TOKEN',
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
  const cloudSessionId = opts.cloudSessionId || manifest.cloud_session_id;
  const paths = runtimePaths(manifest, env, opts.manifestPath);
  const token = await resolveRuntimeToken({ env, deps });
  const apiUrl = await resolveRuntimeApiUrl({ manifest, env, deps });
  const runtime = createRuntimeRecorder({
    cloudSessionId,
    manifest,
    paths,
    token,
    apiUrl,
    deps,
  });

  await runtime.record({
    phase: CLOUD_LIFECYCLE.RUNTIME_TOKEN_MINTED,
    runtime_state: token ? 'starting' : 'runtime_token_missing',
    process_status: 'running',
    events: [{
      type: 'runtime.supervisor_started',
      data: {
        manifest_path: opts.manifestPath,
        repo_ref: manifest.repo?.ref || null,
        tool: manifest.launch?.tool || null,
      },
    }],
    readiness: initialReadiness(manifest, { tokenPresent: !!token }),
  });

  if (!token) {
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

  const workspaceDir = runtimeWorkspaceDir(manifest);
  await runtime.record({
    phase: CLOUD_LIFECYCLE.WAKING,
    runtime_state: 'preparing_workspace',
    process_status: 'running',
    events: [{ type: 'workspace.prepare.started', data: { cwd: workspaceDir } }],
  });

  const workspace = await prepareWorkspace(manifest, {
    env,
    deps,
    cwd: workspaceDir,
  });
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
    token,
    cwd: workspaceDir,
    paths,
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
    env,
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
      token,
      cwd: workspaceDir,
      paths,
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
      env: launchEnv,
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
    const cloneArgs = ['clone', '--depth', '1'];
    if (branch) cloneArgs.push('--branch', branch);
    cloneArgs.push(cloneUrl, cwd);
    const clone = await runGit(cloneArgs, {
      env,
      deps,
      runProcess,
      credentialHelper: gitCredentialHelper(manifest, env),
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
    const fallback = await initEmptyWorkspace({ cwd, repoRef, branch, env, deps, runProcess, mkdir });
    return {
      ...fallback,
      clone_failed: true,
      clone_error: clone.error || null,
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
    sourceKind: source.kind,
    sourceName: source.name,
    cloudSessionId: manifest.cloud_session_id,
  });
  if (json) args.push('--json');
  return new Promise((resolve) => {
    let connectedPromise = null;
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
      if (brokerConnectOutputIndicatesReady(chunk)) void notifyConnected();
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

async function reportRuntimeStatus({ apiUrl, token, cloudSessionId, report }) {
  return memoroFetch(apiUrl, `/api/mc/cloud-sessions/${encodeURIComponent(cloudSessionId)}/runtime-status`, {
    token,
    method: 'POST',
    body: sanitizeRuntimeData(report),
    timeoutMs: 10_000,
  });
}

function runGit(args, { env, deps = {}, runProcess, credentialHelper = null }) {
  const finalArgs = credentialHelper
    ? ['-c', `credential.helper=${credentialHelper}`, ...args]
    : args;
  const gitEnv = { ...env };
  if (!gitEnv.MC_CLOUD_GIT_TOKEN) {
    gitEnv.MC_CLOUD_GIT_TOKEN = stringOrNull(gitEnv.MC_GIT_CLONE_TOKEN) || stringOrNull(gitEnv.GITHUB_TOKEN) || '';
  }
  return runProcess('git', finalArgs, {
    env: {
      ...gitEnv,
      GIT_TERMINAL_PROMPT: '0',
      GIT_SSH_COMMAND: gitEnv.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes',
    },
    cwd: deps.cwd || process.cwd(),
  }).then((res) => ({
    ok: res?.code === 0,
    code: res?.code,
    error: res?.code === 0 ? null : (res?.stderr || res?.error || `git exited ${res?.code ?? 'unknown'}`),
    usedCredential: !!credentialHelper,
  }));
}

function runProcessDefault(cmd, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: options.cwd || process.cwd(),
      env: options.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (err) => resolve({ code: 1, error: err.message || String(err), stdout, stderr }));
    child.on('close', (code) => resolve({ code: Number.isInteger(code) ? code : 1, stdout, stderr }));
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
  if (manifest.contract_version && manifest.contract_version !== CLOUD_RUNTIME_CONTRACT_VERSION) {
    return { ok: false, error: `unsupported manifest contract: ${manifest.contract_version}` };
  }
  if (!CLOUD_SESSION_ID_RE.test(manifest.cloud_session_id || '')) {
    return { ok: false, error: 'manifest cloud_session_id is invalid' };
  }
  if (opts.cloudSessionId && manifest.cloud_session_id !== opts.cloudSessionId) {
    return { ok: false, error: 'manifest cloud_session_id does not match --cloud-session-id' };
  }
  return { ok: true };
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
  const envToken = stringOrNull(env.MEMORO_TOKEN);
  if (envToken) return envToken;
  const getSecretFn = deps.getSecret || getSecret;
  return getSecretFn(ACCOUNTS.TOKEN);
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
  const next = { ...(env || {}) };
  for (const name of SECRET_ENV_NAMES_AFTER_WORKSPACE) delete next[name];
  return next;
}

function runtimeSource(manifest) {
  return {
    id: stringOrNull(manifest?.source?.id) || `cloud:${manifest?.cloud_session_id || 'unknown'}`,
    kind: 'cloud',
    name: stringOrNull(manifest?.source?.name) || 'Memoro Cloud',
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
  const hasRuntimeCredential = !!gitCredentialHelper(manifest, env);
  return sanitizeRuntimeData({
    access: auth.access || manifest?.repo?.access || null,
    grant_kind: auth.grant_kind || manifest?.repo?.grant_kind || null,
    credential_source: credentialSource,
    ready: !privateAccess || usedCredential || auth.ready === true || hasRuntimeCredential,
    repair_required: (privateAccess && !usedCredential && !hasRuntimeCredential && auth.ready !== true) || cloneFailed,
    secret_boundary: auth.secret_boundary || 'status_only',
  });
}

function gitCredentialHelper(manifest, env = {}) {
  const repoRef = safeRuntimeRepoRef(manifest?.repo?.ref);
  if (!isGitHubCloneRef(repoRef)) return null;
  const source = stringOrNull(manifest?.repo?.credential_source || manifest?.repo?.git_auth?.credential_source);
  if (source === 'public_clone' || source === 'none') return null;
  const token = stringOrNull(env.MC_CLOUD_GIT_TOKEN) || stringOrNull(env.MC_GIT_CLONE_TOKEN) || stringOrNull(env.GITHUB_TOKEN);
  if (!token) return null;
  return '!f() { test "$1" = get || exit 0; echo username=x-access-token; echo password=$MC_CLOUD_GIT_TOKEN; }; f';
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
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (url.username || url.password) return null;
      return value;
    } catch {
      return null;
    }
  }
  if (/^(ssh:\/\/|git@)/i.test(value)) return value;
  if (GITHUB_SHORTHAND_RE.test(value)) return `https://github.com/${value.replace(/\.git$/, '')}.git`;
  return null;
}

function isGitHubCloneRef(repoRef) {
  const cloneUrl = repoCloneUrl(repoRef);
  if (!cloneUrl || !/^https?:\/\//i.test(cloneUrl)) return false;
  try {
    return new URL(cloneUrl).hostname.toLowerCase() === 'github.com';
  } catch {
    return false;
  }
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
