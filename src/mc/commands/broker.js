import { spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';

import { requestBroker } from '../broker/client.js';
import { CloudBrokerClient } from '../broker/cloud.js';
import { runBrokerDaemon } from '../broker/daemon.js';
import { brokerLogPath, brokerPidPath, brokerSocketPath } from '../broker/paths.js';
import { getSecret } from '../../lib/keychain.js';
import { ACCOUNTS } from '../../commands/auth.js';
import { readConfig, getApiUrl } from '../../lib/config.js';
import { getPackageVersion } from '../../lib/version.js';

const START_POLL_MS = 1_500;
const POLL_INTERVAL_MS = 100;
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
    spawnDaemon,
    runDaemon: runBrokerDaemon,
    connectCloud: runCloudConnection,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    stdout: process.stdout,
    stderr: process.stderr,
  });
}

export async function runBrokerWith(opts, deps) {
  if (opts.daemon) {
    await deps.runDaemon({ readyFile: opts.readyFile || null });
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

  if (opts.verb === 'start') {
    const existing = await deps.request({ type: 'status' }).catch(() => null);
    if (existing?.ok) {
      const out = { ok: true, already_running: true, broker: existing.broker };
      if (opts.json) deps.stdout.write(JSON.stringify(out, null, 2) + '\n');
      else deps.stdout.write(`mc broker: already running (pid ${existing.broker?.pid ?? '?'})\n`);
      return 0;
    }

    const spawned = deps.spawnDaemon({ readyFile: opts.readyFile || null });
    if (!spawned.ok) {
      const out = { ok: false, error: spawned.error };
      if (opts.json) deps.stdout.write(JSON.stringify(out, null, 2) + '\n');
      else deps.stderr.write(`mc: broker start failed (${spawned.error})\n`);
      return 1;
    }

    const status = await waitForBroker(deps, START_POLL_MS, POLL_INTERVAL_MS);
    const out = status?.ok
      ? { ok: true, started: true, broker: status.broker }
      : { ok: false, error: 'broker did not become ready in time' };
    if (opts.json) deps.stdout.write(JSON.stringify(out, null, 2) + '\n');
    else if (out.ok) deps.stdout.write(`mc broker: started (pid ${out.broker?.pid ?? '?'})\n`);
    else deps.stderr.write(`mc: ${out.error}\n`);
    return out.ok ? 0 : 1;
  }

  deps.stderr.write(`mc: unknown broker verb: ${opts.verb}\n`);
  return 2;
}

async function waitForBroker(deps, timeoutMs, intervalMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const res = await deps.request({ type: 'status' }).catch(() => null);
    if (res?.ok) return res;
    await deps.sleep(intervalMs);
  }
  return null;
}

function spawnDaemon({ readyFile = null } = {}) {
  const logPath = brokerLogPath();
  try {
    mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
    const out = openSync(logPath, 'a');
    const err = openSync(logPath, 'a');
    const args = [process.argv[1], 'broker', '--daemon'];
    if (readyFile) args.push('--ready-file', readyFile);
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: ['ignore', out, err],
      cwd: process.cwd(),
      env: process.env,
    });
    child.unref();
    return { ok: true, pid: child.pid };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

async function runCloudConnection(opts, io = {}) {
  const stdout = io.stdout || process.stdout;
  const config = await readConfig();
  const apiUrl = getApiUrl(opts.rawArgv || []) || config.apiUrl;
  const token = await getSecret(ACCOUNTS.TOKEN);
  if (!token) return { ok: false, error: 'no Memoro token' };
  const mcVersion = await getPackageVersion().catch(() => null);
  const client = new CloudBrokerClient({ apiUrl, token, mcVersion });
  const ready = waitForCloudOpen(client, CONNECT_READY_TIMEOUT_MS);
  client.start();
  const opened = await ready.catch((err) => ({ ok: false, error: err.message || String(err) }));
  if (opened?.ok === false) {
    client.stop();
    return opened;
  }
  if (opts.once) {
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
  const connected = { ok: true, machine_id: client.machineId };
  if (opts.json) stdout.write(JSON.stringify(connected, null, 2) + '\n');
  else stdout.write(`mc broker: connected to cloud (${client.machineId || 'unknown machine'})\n`);
  await new Promise(() => {});
  return connected;
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
    const cleanup = () => {
      clearTimeout(timer);
      client.off?.('open', onOpen);
    };
    client.once('open', onOpen);
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
  process.stdout.write(`mc broker — local PTY broker supervisor

USAGE
  mc broker start [--json]
  mc broker status [--json]
  mc broker stop [--json]
  mc broker connect [--json]

Internal:
  mc broker --daemon
`);
}

export function parseArgs(argv) {
  const opts = { verb: null, json: false, daemon: false, help: false, readyFile: null, once: false, rawArgv: argv };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { opts.help = true; continue; }
    if (a === '--json') { opts.json = true; continue; }
    if (a === '--once') { opts.once = true; continue; }
    if (a === '--daemon') { opts.daemon = true; opts.verb = opts.verb || 'daemon'; continue; }
    if (a === '--ready-file') { opts.readyFile = argv[++i]; continue; }
    if (a.startsWith('--')) return { ...opts, error: `unknown flag: ${a}` };
    if (opts.verb) return { ...opts, error: `unexpected arg: ${a}` };
    opts.verb = a;
  }
  return opts;
}

export const __test__ = { formatDuration, formatStatus, START_POLL_MS, POLL_INTERVAL_MS, CONNECT_READY_TIMEOUT_MS };
