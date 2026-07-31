import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { requestBroker } from '../broker/client.js';
import { CloudBrokerClient } from '../broker/cloud.js';
import { ensureCloudBrokerConnected } from '../broker/cloud-supervisor.js';
import { runBrokerDaemon } from '../broker/daemon.js';
import { brokerCloudPidPath, brokerPidPath, brokerSocketPath } from '../broker/paths.js';
import {
  ensureBrokerRunning,
  spawnBrokerDaemon,
  START_POLL_MS,
  POLL_INTERVAL_MS,
} from '../broker/supervisor.js';
import { getSecret } from '../../lib/keychain.js';
import { ACCOUNTS } from '../../commands/auth.js';
import { readConfig, getApiUrl } from '../../lib/config.js';
import { getPackageVersion } from '../../lib/version.js';
import { listLocalRepoCatalog } from '../repo-catalog.js';

const CONNECT_READY_TIMEOUT_MS = 10_000;

export async function run(argv) {
  const opts = parseArgs(argv);
  if (opts.error) {
    console.error(`mc: ${opts.error}`);
    printUsage();
    return 2;
  }
  if (opts.help || !opts.verb) {
    printUsage();
    return opts.help ? 0 : 2;
  }
  return runBrokerWith(opts, {
    request: requestBroker,
    ensureBroker: ensureBrokerRunning,
    spawnDaemon: spawnBrokerDaemon,
    runDaemon: runBrokerDaemon,
    connectCloud: runCloudConnection,
    ensureCloudBroker: ensureCloudBrokerConnected,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  });
}

export async function runBrokerWith(opts, deps) {
  const ensureBroker = deps.ensureBroker || ensureBrokerRunning;

  if (opts.daemon) {
    const controllerBinding = opts.controllerBootstrap
      ? await readControllerBootstrap(deps.stdin)
      : null;
    if (opts.controllerBootstrap && !controllerBinding) {
      deps.stderr?.write?.('mc: broker controller bootstrap unavailable\n');
      return 1;
    }
    await deps.runDaemon({
      readyFile: opts.readyFile || null,
      socketPath: opts.socketPath || undefined,
      pidPath: opts.pidPath || undefined,
      ...(controllerBinding ? { controllerBinding } : {}),
    });
    return 0;
  }

  if (opts.verb === 'status') {
    const res = await deps.request({ type: 'status' }).catch((err) => ({ ok: false, error: err.message }));
    if (opts.json) {
      deps.stdout.write(JSON.stringify(res, null, 2) + '\n');
    } else if (res.ok) {
      deps.stdout.write(formatStatus(res));
    } else {
      deps.stderr.write(`mc: broker not running (${res.error || 'unknown'})\n`);
    }
    return res.ok ? 0 : 1;
  }

  if (opts.verb === 'stop') {
    const res = await deps.request({ type: 'stop' }).catch((err) => ({ ok: false, error: err.message }));
    if (opts.json) {
      deps.stdout.write(JSON.stringify(res, null, 2) + '\n');
    } else if (res.ok) {
      deps.stdout.write('mc broker: stopped\n');
    } else {
      deps.stderr.write(`mc: broker stop failed (${res.error || 'unknown'})\n`);
    }
    return res.ok ? 0 : 1;
  }

  if (opts.verb === 'connect') {
    const broker = await ensureBroker({ request: deps.request, spawnDaemon: deps.spawnDaemon, sleep: deps.sleep });
    if (!broker.ok) {
      const out = { ok: false, error: `broker start failed (${broker.error || 'unknown'})` };
      if (opts.json) deps.stdout.write(JSON.stringify(out, null, 2) + '\n');
      else deps.stderr.write(`mc: ${out.error}\n`);
      return 1;
    }
    const res = await deps.connectCloud(opts, { stdout: deps.stdout, stderr: deps.stderr }).catch((err) => ({ ok: false, error: err.message || String(err) }));
    if (opts.json) {
      deps.stdout.write(JSON.stringify(res, null, 2) + '\n');
    } else if (res.ok) {
      deps.stdout.write(`mc broker: connected to cloud (${res.machine_id || 'unknown machine'})\n`);
    } else {
      deps.stderr.write(`mc: broker cloud connect failed (${res.error || 'unknown'})\n`);
    }
    return res.ok ? 0 : 1;
  }

  if (opts.verb === 'reconnect') {
    const broker = await ensureBroker({ request: deps.request, spawnDaemon: deps.spawnDaemon, sleep: deps.sleep });
    if (!broker.ok) {
      const out = { ok: false, error: `broker start failed (${broker.error || 'unknown'})` };
      if (opts.json) deps.stdout.write(JSON.stringify(out, null, 2) + '\n');
      else deps.stderr.write(`mc: ${out.error}\n`);
      return 1;
    }
    const ensureCloudBroker = deps.ensureCloudBroker || ensureCloudBrokerConnected;
    const res = await Promise.resolve(ensureCloudBroker({
      forceRestart: true,
      sourceId: opts.sourceId,
      sourceKind: opts.sourceKind,
      sourceName: opts.sourceName,
      cloudSessionId: opts.cloudSessionId,
      ...(opts.codingSessionId ? { codingSessionId: opts.codingSessionId } : {}),
      ...(opts.runtimeGeneration ? { runtimeGeneration: opts.runtimeGeneration } : {}),
      ...(opts.authorizationDigest ? { authorizationDigest: opts.authorizationDigest } : {}),
    })).catch((err) => ({ ok: false, error: err.message || String(err) }));
    if (opts.json) {
      deps.stdout.write(JSON.stringify(res, null, 2) + '\n');
    } else if (res.ok) {
      deps.stdout.write(`mc broker: reconnected cloud bridge (pid ${res.pid ?? '?'})\n`);
    } else {
      deps.stderr.write(`mc: broker cloud reconnect failed (${res.error || 'unknown'})\n`);
    }
    return res.ok ? 0 : 1;
  }

  if (opts.verb === 'start') {
    const res = await ensureBroker({
      request: deps.request,
      spawnDaemon: deps.spawnDaemon,
      sleep: deps.sleep,
      timeoutMs: START_POLL_MS,
      intervalMs: POLL_INTERVAL_MS,
      readyFile: opts.readyFile || null,
    });
    const out = res?.ok
      ? {
          ok: true,
          ...(res.alreadyRunning ? { already_running: true } : {}),
          ...(res.started ? { started: true } : {}),
          broker: res.broker,
        }
      : { ok: false, error: res?.error || 'broker did not become ready in time' };
    if (opts.json) deps.stdout.write(JSON.stringify(out, null, 2) + '\n');
    else if (out.already_running) deps.stdout.write(`mc broker: already running (pid ${out.broker?.pid ?? '?'})\n`);
    else if (out.ok) deps.stdout.write(`mc broker: started (pid ${out.broker?.pid ?? '?'})\n`);
    else deps.stderr.write(`mc: ${out.error}\n`);
    return out.ok ? 0 : 1;
  }

  deps.stderr.write(`mc: unknown broker verb: ${opts.verb}\n`);
  return 2;
}

async function runCloudConnection(opts, io = {}) {
  const stdout = io.stdout || process.stdout;
  const unregisterPid = opts.once ? null : registerCloudConnectorPid();
  try {
    const config = await readConfig();
    const apiUrl = getApiUrl(opts.rawArgv || []) || config.apiUrl;
    const { token } = await resolveBrokerAuthToken({ requireBrokerToken: opts.cloudRuntime === true });
    if (!token) {
      unregisterPid?.();
      return { ok: false, error: opts.cloudRuntime ? 'cloud broker token missing' : 'no Memoro token' };
    }
    const mcVersion = await getPackageVersion().catch(() => null);
    const client = new CloudBrokerClient({
      apiUrl,
      token,
      mcVersion,
      ...(opts.machineId ? { machineId: opts.machineId } : {}),
      sourceId: opts.sourceId,
      sourceKind: opts.sourceKind,
      sourceName: opts.sourceName,
      cloudSessionId: opts.cloudSessionId,
      codingSessionId: opts.codingSessionId,
      runtimeGeneration: opts.runtimeGeneration,
      authorizationDigest: opts.authorizationDigest,
      cloudRuntime: opts.cloudRuntime,
      repoCatalogProvider: listLocalRepoCatalog,
    });
    const ready = waitForCloudOpen(client, CONNECT_READY_TIMEOUT_MS);
    client.start();
    const opened = await ready.catch((err) => ({ ok: false, error: err.message || String(err) }));
    if (opened?.ok === false) {
      client.stop();
      unregisterPid?.();
      return opened;
    }
    if (opts.once) {
      let sessions = [];
      let repos = [];
      let sessionsError = null;
      let reposError = null;
      try {
        sessions = await client.refreshSessions({ refreshRepos: false });
      } catch (err) {
        sessionsError = err.message || String(err);
      }
      try {
        repos = await client.refreshRepos();
      } catch (err) {
        reposError = err.message || String(err);
      }
      client.stop();
      return {
        ok: true,
        once: true,
        machine_id: client.machineId,
        sessions_count: sessions.length,
        repos_count: repos.length,
        ...(sessionsError ? { sessions_error: sessionsError } : {}),
        ...(reposError ? { repos_error: reposError } : {}),
      };
    }
    const connected = { ok: true, machine_id: client.machineId };
    if (opts.json) stdout.write(JSON.stringify(connected, null, 2) + '\n');
    else stdout.write(`mc broker: connected to cloud (${client.machineId || 'unknown machine'})\n`);
    await new Promise(() => {});
    return connected;
  } catch (err) {
    unregisterPid?.();
    throw err;
  }
}

function registerCloudConnectorPid({
  pidPath = brokerCloudPidPath(),
  pid = process.pid,
  processImpl = process,
} = {}) {
  try {
    mkdirSync(dirname(pidPath), { recursive: true, mode: 0o700 });
    writeFileSync(pidPath, String(pid), { mode: 0o600 });
  } catch {
    return null;
  }
  const cleanup = () => {
    try {
      if (String(readFileSync(pidPath, 'utf8') || '').trim() === String(pid)) {
        rmSync(pidPath, { force: true });
      }
    } catch {}
  };
  processImpl.once?.('exit', cleanup);
  return cleanup;
}

function waitForCloudOpen(client, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('cloud broker WebSocket did not open in time'));
    }, timeoutMs);
    const onOpen = (info = {}) => {
      cleanup();
      resolve(info);
    };
    const onFatal = (info = {}) => {
      cleanup();
      reject(new Error(info.code || 'cloud broker failed'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      client.off?.('open', onOpen);
      client.off?.('fatal', onFatal);
    };
    client.once('open', onOpen);
    client.once('fatal', onFatal);
  });
}

function formatStatus(res) {
  const b = res.broker || {};
  return [
    'mc broker',
    `  pid       ${b.pid ?? '?'}`,
    `  socket    ${b.socket_path || brokerSocketPath()}`,
    `  pid_file  ${b.pid_path || brokerPidPath()}`,
    `  uptime    ${formatDuration(b.uptime_ms)}`,
    '',
  ].join('\n');
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h`;
}

function printUsage() {
  process.stdout.write(`mc broker — local PTY broker admin

USAGE
  mc broker start [--json]
  mc broker status [--json]
  mc broker stop [--json]
  mc broker connect [--json] [--source-id <id>] [--source-kind <kind>]
                    [--source-name <name>] [--cloud-session-id <id>]
  mc broker reconnect [--json] [--source-id <id>] [--source-kind <kind>]
                      [--source-name <name>] [--cloud-session-id <id>]

Normal session commands auto-start the broker when needed.

Internal:
  mc broker --daemon
`);
}

export function parseArgs(argv) {
  const opts = {
    verb: null,
    json: false,
    daemon: false,
    help: false,
    readyFile: null,
    once: false,
    cloudRuntime: false,
    sourceId: null,
    machineId: null,
    sourceKind: null,
    sourceName: null,
    cloudSessionId: null,
    codingSessionId: null,
    runtimeGeneration: null,
    authorizationDigest: null,
    controllerBootstrap: false,
    rawArgv: argv,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { opts.help = true; continue; }
    if (a === '--json') { opts.json = true; continue; }
    if (a === '--once') { opts.once = true; continue; }
    if (a === '--cloud-runtime') { opts.cloudRuntime = true; continue; }
    if (a === '--daemon') { opts.daemon = true; opts.verb = opts.verb || 'daemon'; continue; }
    if (a === '--controller-bootstrap') { opts.controllerBootstrap = true; continue; }
    if (a === '--ready-file') { opts.readyFile = argv[++i]; continue; }
    if (a === '--socket-path') {
      const next = argv[++i];
      if (!next || next.startsWith('--')) return { ...opts, error: '--socket-path requires a value' };
      opts.socketPath = next;
      continue;
    }
    if (a === '--pid-path') {
      const next = argv[++i];
      if (!next || next.startsWith('--')) return { ...opts, error: '--pid-path requires a value' };
      opts.pidPath = next;
      continue;
    }
    if (a === '--source-id') {
      const next = argv[++i];
      if (!next || next.startsWith('--')) return { ...opts, error: '--source-id requires a value' };
      opts.sourceId = next;
      continue;
    }
    if (a === '--machine-id') {
      const next = argv[++i];
      if (!next || next.startsWith('--')) return { ...opts, error: '--machine-id requires a value' };
      opts.machineId = next;
      continue;
    }
    if (a === '--source-kind') {
      const next = argv[++i];
      if (!next || next.startsWith('--')) return { ...opts, error: '--source-kind requires a value' };
      opts.sourceKind = next;
      continue;
    }
    if (a === '--source-name') {
      const next = argv[++i];
      if (!next || next.startsWith('--')) return { ...opts, error: '--source-name requires a value' };
      opts.sourceName = next;
      continue;
    }
    if (a === '--cloud-session-id') {
      const next = argv[++i];
      if (!next || next.startsWith('--')) return { ...opts, error: '--cloud-session-id requires a value' };
      opts.cloudSessionId = next;
      continue;
    }
    if (a === '--coding-session-id') {
      const next = argv[++i];
      if (!next || next.startsWith('--')) return { ...opts, error: '--coding-session-id requires a value' };
      opts.codingSessionId = next;
      continue;
    }
    if (a === '--runtime-generation') {
      const next = argv[++i];
      if (!next || next.startsWith('--')) return { ...opts, error: '--runtime-generation requires a value' };
      opts.runtimeGeneration = next;
      continue;
    }
    if (a === '--authorization-digest') {
      const next = argv[++i];
      if (!next || next.startsWith('--')) return { ...opts, error: '--authorization-digest requires a value' };
      opts.authorizationDigest = next;
      continue;
    }
    if (a.startsWith('--')) return { ...opts, error: `unknown flag: ${a}` };
    if (opts.verb) return { ...opts, error: `unexpected arg: ${a}` };
    opts.verb = a;
  }
  return opts;
}

async function readControllerBootstrap(stream, {
  maxBytes = 1024,
  timeoutMs = 2_000,
} = {}) {
  if (!stream?.on) return null;
  return new Promise((resolve) => {
    let settled = false;
    let raw = Buffer.alloc(0);
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.off?.('data', onData);
      stream.off?.('end', onEnd);
      stream.off?.('error', onError);
      resolve(value);
    };
    const parse = () => {
      try {
        const value = JSON.parse(raw.toString('utf8').trim());
        const valid = value
          && typeof value === 'object'
          && !Array.isArray(value)
          && Object.keys(value).length === 3
          && value.schema === 'mc-broker-controller-bootstrap-v1'
          && /^sess_[A-Za-z0-9_-]{6,}$/.test(value.session_id || '')
          && /^[a-f0-9]{64}$/.test(value.session_controller_capability || '');
        finish(valid ? value : null);
      } catch {
        finish(null);
      }
    };
    const onData = (chunk) => {
      raw = Buffer.concat([
        raw,
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)),
      ]);
      if (raw.length > maxBytes) finish(null);
      else if (raw.includes(10)) parse();
    };
    const onEnd = () => parse();
    const onError = () => finish(null);
    const timer = setTimeout(() => finish(null), timeoutMs);
    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);
  });
}

async function resolveBrokerAuthToken({
  env = process.env,
  getSecretFn = getSecret,
  requireBrokerToken = false,
} = {}) {
  const brokerToken = typeof env?.MEMORO_BROKER_TOKEN === 'string' ? env.MEMORO_BROKER_TOKEN.trim() : '';
  if (brokerToken) return { token: brokerToken, source: 'broker_env' };
  if (requireBrokerToken) return { token: null, source: null };
  const envToken = typeof env?.MEMORO_TOKEN === 'string' ? env.MEMORO_TOKEN.trim() : '';
  if (envToken) return { token: envToken, source: 'env' };
  const token = await getSecretFn(ACCOUNTS.TOKEN);
  return { token, source: token ? 'keychain' : null };
}

export const __test__ = {
  formatDuration,
  formatStatus,
  START_POLL_MS,
  POLL_INTERVAL_MS,
  CONNECT_READY_TIMEOUT_MS,
  registerCloudConnectorPid,
  readControllerBootstrap,
  resolveBrokerAuthToken,
};
