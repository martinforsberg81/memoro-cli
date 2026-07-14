import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { hostname } from 'node:os';

import { ACCOUNTS } from '../../commands/auth.js';
import { getSecret } from '../../lib/keychain.js';
import { readConfig } from '../../lib/config.js';
import { getPackageVersion } from '../../lib/version.js';
import { requestBroker as defaultRequestBroker } from '../broker/client.js';
import { CloudBrokerClient } from '../broker/cloud.js';
import { ensureBrokerRunning, spawnBrokerDaemon } from '../broker/supervisor.js';
import { prepareCloudRuntimeRepo } from './repo.js';
import { restoreCodingBinSnapshot } from './snapshot.js';

export const CLOUD_RUNTIME_CONTRACT_VERSION = 'mc-cloud-runtime-v1';

const DEFAULT_API_URL = 'https://meetmemoro.app';
const DEFAULT_RUNTIME_DIR = '/workspace/mc-runtime';
const DEFAULT_REPO_ROOT = '/workspace/repo';
const SECRET_ENV_UNSET = Object.freeze([
  'MEMORO_TOKEN',
  'MC_CLOUD_GIT_TOKEN',
  'MC_CLOUD_GIT_SECRET_CAPABILITY',
  'MC_CODEX_API_KEY',
  'OPENAI_API_KEY',
  'CODEX_ACCESS_TOKEN',
  'ANTHROPIC_API_KEY',
  'CLAUDE_API_KEY',
  'GITHUB_TOKEN',
  'MC_GIT_CLONE_TOKEN',
  'MC_CLOUD_TOOL_AUTH_MODE',
]);

export async function runCloudRuntimeSupervisor(opts = {}, deps = {}) {
  const env = deps.env || process.env;
  const now = deps.now || (() => new Date().toISOString());
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const events = [];
  let ctx = null;

  try {
    const manifest = await readRuntimeManifest(opts.manifest, { readFileImpl: deps.readFile || readFile });
    ctx = await buildRuntimeContext({ opts, manifest, env, deps, now });
    await ensureRuntimeDir(ctx.paths, { mkdirImpl: deps.mkdir || mkdir });

    await recordEvent(ctx, events, 'runtime.supervisor_started', {
      manifest_path: opts.manifest,
      tool: ctx.tool,
      policy: ctx.policy,
    }, deps);

    if (!ctx.token) {
      return await failRuntime(ctx, events, {
        error_code: 'runtime_token_missing',
        error: 'runtime token missing',
      }, deps, { stdout, stderr, json: opts.json });
    }
    if (!ctx.cloudSessionId || !ctx.codingSessionId) {
      return await failRuntime(ctx, events, {
        error_code: 'invalid_manifest',
        error: 'manifest missing cloud_session_id or coding_session_id',
      }, deps, { stdout, stderr, json: opts.json });
    }

    const startingStatus = buildStatus(ctx, {
      phase: 'broker_connecting',
      runtime_state: 'starting',
      process_status: 'running',
      now,
    });
    const startingReadiness = buildReadiness(ctx, { ready: false, phase: 'broker_connecting' });
    await writeRuntimeStatus(ctx.paths, startingStatus, deps);
    await writeRuntimeReadiness(ctx.paths, startingReadiness, deps);
    await reportRuntimeStatus({ ...ctx, status: startingStatus, readiness: startingReadiness, events }, deps);

    const repo = await prepareCloudRuntimeRepo({
      manifest: ctx.manifest,
      root: ctx.repoRoot,
      env,
      spawn: deps.spawn,
      mkdirImpl: deps.mkdir || mkdir,
      rmImpl: deps.rm,
    });
    await recordEvent(ctx, events, repo.ok ? 'runtime.repo_ready' : 'runtime.repo_failed', {
      cloned: repo.cloned === true,
      initialized: repo.initialized === true,
      fallback: repo.fallback === true,
      repo_ref: repo.repo_ref || null,
      branch: repo.branch || null,
      error: repo.ok ? null : repo.error,
    }, deps);
    if (!repo.ok) {
      return await failRuntime(ctx, events, {
        error_code: 'repo_prepare_failed',
        error: repo.error || 'repo preparation failed',
      }, deps, { stdout, stderr, json: opts.json });
    }

    const restored = await (deps.restoreSnapshot || restoreCodingBinSnapshot)(ctx.latestSnapshot, {
      root: ctx.repoRoot,
      token: ctx.token,
      fetchImpl: deps.fetch || globalThis.fetch,
      extractArchive: deps.extractArchive,
      tempDir: deps.tempDir,
      now,
    });
    await recordEvent(ctx, events, restored.ok ? 'runtime.coding_bin_restore' : 'runtime.coding_bin_restore_failed', {
      coding_bin_snapshot_id: ctx.latestSnapshot?.id || null,
      restored: restored.restored === true,
      skipped: restored.skipped === true,
      reason: restored.reason || null,
      byte_count: restored.byte_count || ctx.latestSnapshot?.byte_count || 0,
      error: restored.ok ? null : restored.error,
    }, deps);
    if (!restored.ok) {
      return await failRuntime(ctx, events, {
        error_code: 'coding_bin_restore_failed',
        error: restored.error || 'coding-bin restore failed',
      }, deps, { stdout, stderr, json: opts.json });
    }

    const broker = await (deps.ensureBroker || ensureBrokerRunning)({
      request: ctx.request,
      spawnDaemon: deps.spawnDaemon || spawnBrokerDaemon,
      sleep: deps.sleep,
    });
    if (!broker?.ok) {
      return await failRuntime(ctx, events, {
        error_code: 'broker_start_failed',
        error: broker?.error || 'broker did not become ready',
      }, deps, { stdout, stderr, json: opts.json });
    }
    await recordEvent(ctx, events, 'runtime.broker_ready', {
      already_running: broker.alreadyRunning === true,
      started: broker.started === true,
      pid: broker.broker?.pid || null,
    }, deps);

    const launched = await launchBrokerSession(ctx);
    await recordEvent(ctx, events, launched.ok ? 'runtime.provider_launched' : 'runtime.provider_launch_failed', {
      reused: launched.reused === true,
      session_state: launched.session?.session_state || null,
      tool: ctx.tool,
      error: launched.ok ? null : launched.error,
    }, deps);
    if (!launched.ok) {
      return await failRuntime(ctx, events, {
        error_code: 'provider_launch_failed',
        error: launched.error || 'provider launch failed',
      }, deps, { stdout, stderr, json: opts.json });
    }

    const cloud = await (deps.connectCloud || connectCloudRuntime)({
      apiUrl: ctx.apiUrl,
      token: ctx.token,
      once: opts.once === true,
      request: ctx.request,
      WebSocketImpl: deps.WebSocket,
    });
    if (!cloud?.ok) {
      return await failRuntime(ctx, events, {
        error_code: 'cloud_broker_connect_failed',
        error: cloud?.error || 'cloud broker connection failed',
      }, deps, { stdout, stderr, json: opts.json });
    }
    await recordEvent(ctx, events, 'runtime.cloud_connected', {
      machine_id: cloud.machine_id || null,
      once: cloud.once === true,
      sessions_count: cloud.sessions_count ?? null,
    }, deps);

    const readyStatus = buildStatus(ctx, {
      phase: 'ready',
      runtime_state: 'ready',
      process_status: 'running',
      now,
      coding_bin_snapshot: restoredSnapshotReport(ctx, restored),
    });
    const readyReadiness = buildReadiness(ctx, {
      ready: true,
      phase: 'ready',
      repo,
      restored,
      broker,
      launched,
      cloud,
    });
    await writeRuntimeStatus(ctx.paths, readyStatus, deps);
    await writeRuntimeReadiness(ctx.paths, readyReadiness, deps);
    await reportRuntimeStatus({ ...ctx, status: readyStatus, readiness: readyReadiness, events }, deps);

    const result = {
      ok: true,
      status: readyStatus,
      readiness: readyReadiness,
      events,
      repo,
      restore: restored,
      broker: { ok: true, already_running: broker.alreadyRunning === true, started: broker.started === true },
      provider: { ok: true, reused: launched.reused === true },
      cloud,
    };
    if (opts.json) stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (!opts.once && typeof cloud.wait === 'function') await cloud.wait();
    return { ...result, exitCode: 0 };
  } catch (err) {
    const error = err?.message || String(err);
    if (ctx) {
      return await failRuntime(ctx, events, {
        error_code: 'runtime_supervisor_failed',
        error,
      }, deps, { stdout, stderr, json: opts.json });
    }
    const result = { ok: false, error, error_code: 'runtime_supervisor_failed', exitCode: 1 };
    if (opts.json) stdout.write(JSON.stringify(result, null, 2) + '\n');
    else stderr.write(`mc cloud-runtime: ${error}\n`);
    return result;
  }
}

export async function readRuntimeManifest(manifestPath, { readFileImpl = readFile } = {}) {
  if (!manifestPath || typeof manifestPath !== 'string') {
    throw new Error('manifest path required');
  }
  const raw = await readFileImpl(manifestPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('runtime manifest must be a JSON object');
  }
  return parsed;
}

export async function writeRuntimeStatus(paths, status, deps = {}) {
  return writeJsonFile(paths.status, redactRuntimeMetadata(status), deps);
}

export async function writeRuntimeReadiness(paths, readiness, deps = {}) {
  return writeJsonFile(paths.readiness, redactRuntimeMetadata(readiness), deps);
}

export async function appendRuntimeEvent(paths, event, deps = {}) {
  if (!paths?.events) return;
  const appendFileImpl = deps.appendFile || appendFile;
  await mkdir(dirname(paths.events), { recursive: true }).catch(() => {});
  await appendFileImpl(paths.events, JSON.stringify(redactRuntimeMetadata(event)) + '\n');
}

export async function reportRuntimeStatus(ctx, deps = {}) {
  const fetchImpl = deps.fetch || globalThis.fetch;
  if (!ctx?.apiUrl || !ctx?.token || !ctx?.cloudSessionId || typeof fetchImpl !== 'function') {
    return { ok: false, skipped: true, reason: 'missing_report_dependency' };
  }
  const report = redactRuntimeMetadata({
    contract_version: CLOUD_RUNTIME_CONTRACT_VERSION,
    phase: ctx.status.phase,
    runtime_state: ctx.status.runtime_state,
    process_status: ctx.status.process_status,
    exit_code: ctx.status.exit_code,
    error_code: ctx.status.error_code,
    error: ctx.status.error,
    coding_bin_id: ctx.status.coding_bin_id,
    coding_bin_snapshot_id: ctx.status.coding_bin_snapshot_id,
    coding_bin_snapshot: ctx.status.coding_bin_snapshot,
    readiness: ctx.readiness,
    events: Array.isArray(ctx.events) ? ctx.events.slice(-20) : [],
  });
  const res = await fetchImpl(`${ctx.apiUrl.replace(/\/$/, '')}/api/mc/cloud-sessions/${encodeURIComponent(ctx.cloudSessionId)}/runtime-status`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ctx.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(report),
  }).catch((err) => ({ ok: false, status: 0, error: err.message || String(err), text: async () => '' }));
  if (!res?.ok) {
    const text = typeof res?.text === 'function' ? await res.text().catch(() => '') : '';
    return { ok: false, status: res?.status || 0, error: res?.error || text || 'runtime status report failed' };
  }
  return { ok: true };
}

export async function connectCloudRuntime({
  apiUrl,
  token,
  once = false,
  request = defaultRuntimeRequest,
  WebSocketImpl = globalThis.WebSocket,
  mcVersion = null,
  timeoutMs = 10_000,
} = {}) {
  if (!apiUrl) return { ok: false, error: 'apiUrl missing' };
  if (!token) return { ok: false, error: 'runtime token missing' };
  if (typeof WebSocketImpl !== 'function') return { ok: false, error: 'WebSocket unavailable' };
  const version = mcVersion || await getPackageVersion().catch(() => null);
  const client = new CloudBrokerClient({ apiUrl, token, mcVersion: version, request, WebSocketImpl });
  const opened = waitForCloudOpen(client, timeoutMs);
  client.start();
  const open = await opened.catch((err) => ({ ok: false, error: err.message || String(err) }));
  if (open?.ok === false) {
    client.stop();
    return open;
  }
  if (once) {
    let sessions = [];
    let sessionsError = null;
    try {
      sessions = await client.refreshSessions();
    } catch (err) {
      sessionsError = err.message || String(err);
    }
    client.stop();
    return {
      ok: true,
      once: true,
      machine_id: client.machineId,
      sessions_count: sessions.length,
      ...(sessionsError ? { sessions_error: sessionsError } : {}),
    };
  }
  return {
    ok: true,
    machine_id: client.machineId,
    wait: () => new Promise(() => {}),
    stop: () => client.stop(),
  };
}

async function buildRuntimeContext({ opts, manifest, env, deps, now }) {
  const config = deps.readConfig === false ? {} : await (deps.readConfig || readConfig)().catch(() => ({}));
  const paths = runtimePaths({ manifest, manifestPath: opts.manifest, env });
  const token = await resolveRuntimeToken({ env, getSecretImpl: deps.getSecret || getSecret });
  const tool = stringOrDefault(manifest?.launch?.tool, 'codex');
  const policy = stringOrDefault(manifest?.launch?.policy, env.MC_CLOUD_SESSION_POLICY || 'workspace-write');
  const cloudSessionId = stringOrDefault(opts.cloudSessionId, manifest.cloud_session_id || env.MC_CLOUD_SESSION_ID || '');
  const codingSessionId = stringOrDefault(manifest.coding_session_id, env.MC_CODING_SESSION_ID || '');
  const repoRoot = stringOrDefault(manifest?.coding_bin?.root, manifest?.runtime?.cwd || DEFAULT_REPO_ROOT);
  const apiUrl = stringOrDefault(env.MEMORO_API_URL, manifest?.runtime?.api_url || config.apiUrl || DEFAULT_API_URL);
  const request = deps.request || defaultRuntimeRequest;
  return {
    manifest,
    paths,
    token,
    apiUrl,
    cloudSessionId,
    codingSessionId,
    codingBinId: stringOrDefault(manifest.coding_bin_id, env.MC_CODING_BIN_ID || ''),
    sourceId: stringOrDefault(manifest?.source?.id, env.MC_SOURCE_ID || `cloud:${cloudSessionId || 'unknown'}`),
    sourceName: stringOrDefault(manifest?.source?.name, env.MC_SOURCE_NAME || 'Memoro Cloud'),
    tool,
    policy,
    task: stringOrDefault(manifest?.launch?.task, ''),
    launchName: stringOrDefault(manifest?.launch?.name, `cloud-${cloudSessionId || 'session'}`),
    repoRoot,
    latestSnapshot: manifest?.coding_bin?.latest_snapshot || null,
    sandboxId: manifest?.runtime?.sandbox_id || null,
    processId: manifest?.runtime?.process_id || null,
    request,
    now,
  };
}

async function launchBrokerSession(ctx) {
  const existing = await ctx.request({ type: 'session_status', id: ctx.codingSessionId }).catch(() => null);
  if (existing?.ok) return { ok: true, reused: true, session: existing.session || null };
  const result = await ctx.request({
    type: 'launch_session',
    session: {
      id: ctx.codingSessionId,
      name: ctx.launchName,
      cwd: ctx.repoRoot,
      tool: ctx.tool,
      argv: [],
      cols: 120,
      rows: 40,
      launch_options: {
        startupMessage: ctx.task || null,
        effectivePolicy: effectivePolicyForRuntime(ctx),
      },
      env_unset: SECRET_ENV_UNSET,
      env: {
        MEMORO_MC_CLOUD_RUNTIME: '1',
        MC_CLOUD_SESSION_ID: ctx.cloudSessionId,
        MC_CODING_SESSION_ID: ctx.codingSessionId,
        MC_CODING_BIN_ID: ctx.codingBinId || '',
        MC_SOURCE_ID: ctx.sourceId,
        MC_SOURCE_KIND: 'cloud',
        MC_SOURCE_NAME: ctx.sourceName,
      },
    },
  }).catch((err) => ({ ok: false, error: err.message || String(err) }));
  if (!result?.ok) return { ok: false, error: result?.error || 'launch_session failed' };
  return { ok: true, reused: false, session: result.session || null };
}

async function failRuntime(ctx, events, failure, deps, io) {
  await recordEvent(ctx, events, 'runtime.failed', {
    error_code: failure.error_code,
    error: failure.error,
  }, deps).catch(() => {});
  const status = buildStatus(ctx, {
    phase: 'failed',
    runtime_state: 'failed',
    process_status: 'failed',
    error_code: failure.error_code,
    error: failure.error,
    now: ctx.now,
  });
  const readiness = buildReadiness(ctx, {
    ready: false,
    phase: 'failed',
    error_code: failure.error_code,
    error: failure.error,
  });
  await writeRuntimeStatus(ctx.paths, status, deps).catch(() => {});
  await writeRuntimeReadiness(ctx.paths, readiness, deps).catch(() => {});
  await reportRuntimeStatus({ ...ctx, status, readiness, events }, deps).catch(() => null);
  const result = { ok: false, error: failure.error, error_code: failure.error_code, status, readiness, events, exitCode: 1 };
  if (io.json) io.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else io.stderr.write(`mc cloud-runtime: ${failure.error}\n`);
  return result;
}

function buildStatus(ctx, {
  phase,
  runtime_state,
  process_status,
  exit_code = null,
  error_code = null,
  error = null,
  now,
  coding_bin_snapshot = null,
} = {}) {
  const snapshotId = coding_bin_snapshot?.id || null;
  return redactRuntimeMetadata({
    contract_version: CLOUD_RUNTIME_CONTRACT_VERSION,
    phase,
    status: error ? 'failed' : 'running',
    cloud_session_id: ctx.cloudSessionId || null,
    coding_session_id: ctx.codingSessionId || null,
    coding_bin_id: ctx.codingBinId || null,
    coding_bin_snapshot_id: snapshotId,
    coding_bin_snapshot,
    source_id: ctx.sourceId,
    tool: ctx.tool,
    policy: ctx.policy,
    sandbox_id: ctx.sandboxId,
    process_id: ctx.processId,
    runtime_state,
    process_status,
    exit_code,
    error_code,
    error: error ? String(error).slice(0, 500) : null,
    updated_at: now(),
  });
}

function buildReadiness(ctx, {
  ready,
  phase,
  repo = null,
  restored = null,
  broker = null,
  launched = null,
  cloud = null,
  error_code = null,
  error = null,
} = {}) {
  return redactRuntimeMetadata({
    ok: error ? false : true,
    ready: ready === true,
    phase,
    cloud_session_id: ctx.cloudSessionId || null,
    coding_session_id: ctx.codingSessionId || null,
    coding_bin_id: ctx.codingBinId || null,
    tool: ctx.tool,
    policy: ctx.policy,
    repo: {
      ready: repo ? repo.ok === true : ready === true,
      root: ctx.repoRoot,
      ref: ctx.manifest?.repo?.ref || null,
      workspace_ref: ctx.manifest?.repo?.workspace_ref || null,
      access: ctx.manifest?.repo?.access || null,
      credential_source: ctx.manifest?.repo?.credential_source || ctx.manifest?.repo?.git_auth?.credential_source || null,
      secret_boundary: 'runtime_only',
      exposes_secrets_to_llm: false,
      cloned: repo?.cloned === true,
      initialized: repo?.initialized === true,
      fallback: repo?.fallback === true,
    },
    vault: {
      mode: 'mc vault',
      ready: true,
      secret_boundary: 'runtime_only',
      exposes_secrets_to_llm: false,
    },
    tool_auth: {
      tool: ctx.tool,
      mode: 'native_or_vault',
      status: 'unknown',
      ready: null,
      hydrated: false,
      repair_required: false,
      secret_boundary: 'status_only',
      exposes_secrets_to_llm: false,
    },
    coding_bin: {
      root: ctx.repoRoot,
      latest_snapshot_id: ctx.latestSnapshot?.id || null,
      restored: restored?.restored === true,
      restore_skipped: restored?.skipped === true,
      byte_count: restored?.byte_count || ctx.latestSnapshot?.byte_count || 0,
    },
    broker: broker ? { ok: broker.ok === true, already_running: broker.alreadyRunning === true, started: broker.started === true } : null,
    provider: launched ? { ok: launched.ok === true, reused: launched.reused === true, session_state: launched.session?.session_state || null } : null,
    cloud: cloud ? { ok: cloud.ok === true, machine_id: cloud.machine_id || null, once: cloud.once === true } : null,
    error_code,
    error: error ? String(error).slice(0, 500) : null,
    updated_at: ctx.now(),
  });
}

function restoredSnapshotReport(ctx, restored) {
  if (!ctx.latestSnapshot?.id || restored?.restored !== true) return null;
  return {
    id: ctx.latestSnapshot.id,
    status: 'restored',
    source: 'runtime_restore',
    base_ref: ctx.latestSnapshot.base_ref || null,
    head_ref: ctx.latestSnapshot.head_ref || null,
    file_count: ctx.latestSnapshot.file_count || 0,
    byte_count: restored.byte_count || ctx.latestSnapshot.byte_count || 0,
    skipped_count: ctx.latestSnapshot.skipped_count || 0,
  };
}

async function recordEvent(ctx, events, type, data, deps) {
  const event = buildEvent(ctx, type, data);
  events.push(event);
  await appendRuntimeEvent(ctx.paths, event, deps);
  return event;
}

function buildEvent(ctx, type, data = {}) {
  return redactRuntimeMetadata({
    contract_version: CLOUD_RUNTIME_CONTRACT_VERSION,
    type,
    at: ctx.now(),
    cloud_session_id: ctx.cloudSessionId || null,
    coding_session_id: ctx.codingSessionId || null,
    coding_bin_id: ctx.codingBinId || null,
    source_id: ctx.sourceId,
    data,
  });
}

function runtimePaths({ manifest, manifestPath, env }) {
  const configured = manifest?.runtime?.paths && typeof manifest.runtime.paths === 'object'
    ? manifest.runtime.paths
    : {};
  const dir = configured.dir || env.MC_CLOUD_RUNTIME_DIR || dirname(manifestPath || '') || DEFAULT_RUNTIME_DIR;
  return {
    dir,
    manifest: manifestPath || configured.manifest || env.MC_CLOUD_RUNTIME_MANIFEST || `${dir}/manifest.json`,
    status: configured.status || env.MC_CLOUD_RUNTIME_STATUS || `${dir}/status.json`,
    events: configured.events || env.MC_CLOUD_RUNTIME_EVENTS || `${dir}/events.jsonl`,
    readiness: configured.readiness || env.MC_CLOUD_RUNTIME_READINESS || `${dir}/readiness.json`,
  };
}

async function ensureRuntimeDir(paths, { mkdirImpl = mkdir } = {}) {
  await mkdirImpl(paths.dir || dirname(paths.status), { recursive: true });
}

async function writeJsonFile(path, value, deps = {}) {
  const writeFileImpl = deps.writeFile || writeFile;
  const mkdirImpl = deps.mkdir || mkdir;
  await mkdirImpl(dirname(path), { recursive: true });
  await writeFileImpl(path, JSON.stringify(value, null, 2), { mode: 0o600 });
}

async function resolveRuntimeToken({ env, getSecretImpl }) {
  if (typeof env.MEMORO_TOKEN === 'string' && env.MEMORO_TOKEN.trim()) return env.MEMORO_TOKEN.trim();
  return getSecretImpl(ACCOUNTS.TOKEN).catch(() => null);
}

function defaultRuntimeRequest(message) {
  return defaultRequestBroker(message, { timeoutMs: 10_000 });
}

function effectivePolicyForRuntime(ctx) {
  const workspace = ctx.policy === 'read-only'
    ? 'read-only'
    : ctx.policy === 'danger-full-access' || ctx.policy === 'full'
      ? 'full'
      : 'worktree';
  return {
    permissions: {
      source: 'cloud-runtime-manifest',
      rendered_for: ctx.tool,
      workspace,
      network: 'tool-default',
      approval: 'tool-default',
      secrets: 'mc-vault-explicit',
    },
    explicit_permissions: ['workspace'],
    secrets: {
      vault_required: false,
      native_auth_owned_by_tool: true,
      materialisation_targets: [],
    },
  };
}

function waitForCloudOpen(client, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('cloud broker WebSocket did not open in time'));
    }, timeoutMs);
    timer.unref?.();
    const onOpen = (info = {}) => {
      cleanup();
      resolve({ ok: true, machine_id: info.machine_id || hostname() });
    };
    const cleanup = () => {
      clearTimeout(timer);
      client.off?.('open', onOpen);
    };
    client.once('open', onOpen);
  });
}

function redactRuntimeMetadata(value, depth = 0) {
  if (depth > 6) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactRuntimeMetadata(item, depth + 1));
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string') return redactSecretString(value);
    return value;
  }
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (!isSafeRuntimeMetadataKey(key) && /(token|secret|password|passphrase|private.?key|access.?key|refresh|auth.?json|api.?key|env|credential(?!_source)|capability)/i.test(key)) {
      out[key] = '[redacted]';
      continue;
    }
    out[key] = redactRuntimeMetadata(child, depth + 1);
  }
  return out;
}

function isSafeRuntimeMetadataKey(key) {
  return ['credential_source', 'secret_boundary', 'exposes_secrets_to_llm'].includes(key);
}

function redactSecretString(value) {
  return String(value)
    .replace(/\bmem_[a-zA-Z0-9._:-]{8,}\b/g, '[redacted]')
    .replace(/\bgh[pousr]_[a-zA-Z0-9_]{8,}\b/g, '[redacted]')
    .replace(/\bsk-[a-zA-Z0-9_-]{8,}\b/g, '[redacted]');
}

function stringOrDefault(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}
