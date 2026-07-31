import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';

import {
  BrokerRuntime,
  claudeC1StatusResponse,
  isExactClaudeC1Request,
} from './runtime.js';
import { brokerPidPath, brokerSocketPath } from './paths.js';
import { runClaudeC1BrokerOperation } from './c1-runner.js';
import { getPackageVersion } from '../../lib/version.js';
import { BROKER_RUNTIME_IDENTITY } from './runtime-identity.js';

// v12 requires an exact process-bound runtime identity in addition to the
// protocol contract. This prevents a long-lived daemon from validating a
// newly generated provider domain with previously loaded adapter or hook code.
//
// v11 requires both the append-only managed-generation transaction and
// half-open request transport for asynchronous terminal receipts. Reusing a
// v10 session host could silently lose the durable cleanup acknowledgement and
// reopen the exact crash window these boundaries are designed to remove.
// Provider children still reach only reduced capability sockets and cannot
// invoke C1 or attach, read, write, resize, stop, remove, or relaunch a session.
export const BROKER_PROTOCOL_VERSION = 'mc-broker-pty-v12';
const MAX_PROVIDER_ARTIFACT_FRAME_BYTES = 20 * 1024;

export async function startBrokerServer({
  socketPath = brokerSocketPath(),
  artifactSocketPath = join(dirname(socketPath), 'provider-artifact.sock'),
  pidPath = brokerPidPath(),
  createServerImpl = createServer,
  pid = process.pid,
  mcVersion = null,
  protocolVersion = BROKER_PROTOCOL_VERSION,
  runtimeIdentity = BROKER_RUNTIME_IDENTITY,
  now = () => Date.now(),
  onStop = null,
  exitOnStop = false,
  exitProcess = (code) => process.exit(code),
  runtime = null,
} = {}) {
  const startedAtMs = now();
  const startedAt = new Date(startedAtMs).toISOString();
  let stopping = false;

  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  await rm(socketPath, { force: true });
  await rm(artifactSocketPath, { force: true });
  await writeFile(pidPath, String(pid), { mode: 0o600 });

  const status = () => {
    const response = {
      ok: true,
      broker: {
        pid,
        mc_version: mcVersion,
        protocol_version: protocolVersion,
        runtime_identity: runtimeIdentity,
        socket_path: socketPath,
        pid_path: pidPath,
        started_at: startedAt,
        uptime_ms: Math.max(0, now() - startedAtMs),
        stopping,
      },
    };
    if (runtime?.listSessions) response.sessions = runtime.listSessions();
    return response;
  };

  // requestBroker() terminates its writable side after the newline-delimited
  // request frame. Managed cleanup is deliberately asynchronous, so the
  // server must keep its writable side open until that response is durable and
  // has been sent. Node's default allowHalfOpen:false would otherwise close
  // the connection as soon as the client FIN arrives and silently discard the
  // eventual cleanup receipt.
  const server = createServerImpl({ allowHalfOpen: true }, (conn) => {
    let raw = Buffer.alloc(0);
    let handledInitialFrame = false;
    conn.on?.('error', () => {});
    const handleFrame = async (frame, initialInput = Buffer.alloc(0)) => {
      if (handledInitialFrame) return;
      handledInitialFrame = true;
      const handled = handleBrokerMessage(frame.toString('utf8'), {
        status,
        stop: () => { stopping = true; },
        runtime,
      });
      if (typeof handled.attach === 'function') {
        handled.attach(conn, initialInput);
        return;
      }
      const response = await Promise.resolve(handled.response)
        .catch(() => ({ ok: false, error: 'broker command failed' }));
      safeEnd(conn, JSON.stringify(response) + '\n');
      if (handled.stop) {
        setImmediate(async () => {
          try {
            const shutdown = await shutdownRuntime(runtime);
            if (!shutdown.ok) {
              stopping = false;
              return;
            }
            await stopBrokerServer({
              server,
              artifactServer,
              socketPath,
              artifactSocketPath,
              pidPath,
            });
            if (typeof onStop === 'function') onStop();
            if (exitOnStop) exitProcess(0);
          } catch {
            stopping = false;
            // A failed shutdown is not a completed stop. Keep the daemon,
            // socket and pid in place so the runtime can be inspected or
            // retried instead of orphaning a live session.
          }
        });
      }
    };

    conn.on('data', (chunk) => {
      if (handledInitialFrame) return;
      raw = Buffer.concat([raw, Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))]);
      const newline = raw.indexOf(10);
      if (newline === -1) return;
      const frame = raw.subarray(0, newline);
      const initialInput = raw.subarray(newline + 1);
      void handleFrame(frame, initialInput);
    });
    conn.on('end', () => {
      if (!handledInitialFrame) void handleFrame(raw);
    });
  });
  const artifactServer = createServerImpl({ allowHalfOpen: true }, (conn) => {
    let raw = Buffer.alloc(0);
    let handled = false;
    conn.on?.('error', () => {});
    const handle = async (frame) => {
      if (handled) return;
      handled = true;
      const response = await Promise.resolve(
        handleProviderArtifactMessage(frame.toString('utf8'), { runtime }).response,
      ).catch(() => ({ ok: false, error: 'provider artifact command failed' }));
      safeEnd(conn, JSON.stringify(response) + '\n');
    };
    conn.on('data', (chunk) => {
      if (handled) return;
      raw = Buffer.concat([raw, Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))]);
      if (raw.length > MAX_PROVIDER_ARTIFACT_FRAME_BYTES) {
        handled = true;
        safeEnd(conn, JSON.stringify({ ok: false, error: 'provider artifact frame too large' }) + '\n');
        return;
      }
      const newline = raw.indexOf(10);
      if (newline !== -1) void handle(raw.subarray(0, newline));
    });
    conn.on('end', () => {
      if (!handled) void handle(raw);
    });
  });

  try {
    await listenServer(server, socketPath);
    await listenServer(artifactServer, artifactSocketPath);
  } catch (error) {
    await closeServer(server);
    await closeServer(artifactServer);
    await rm(socketPath, { force: true }).catch(() => {});
    await rm(artifactSocketPath, { force: true }).catch(() => {});
    throw error;
  }

  try { await chmod(socketPath, 0o600); } catch {}
  try { await chmod(artifactSocketPath, 0o600); } catch {}

  return {
    server,
    artifactServer,
    socketPath,
    artifactSocketPath,
    pidPath,
    status,
    stop: async () => {
      const shutdown = await shutdownRuntime(runtime);
      if (!shutdown.ok) {
        throw new Error(shutdown.reason || 'managed credential cleanup was not confirmed');
      }
      return stopBrokerServer({
        server,
        artifactServer,
        socketPath,
        artifactSocketPath,
        pidPath,
      });
    },
  };
}

function safeEnd(conn, data = undefined) {
  try {
    if (data === undefined) conn.end();
    else conn.end(data);
    return true;
  } catch (err) {
    if (isBrokenPipeError(err)) return false;
    throw err;
  }
}

function isBrokenPipeError(err) {
  return err?.code === 'EPIPE'
    || err?.code === 'ECONNRESET'
    || err?.code === 'ERR_STREAM_DESTROYED';
}

export async function stopBrokerServer({
  server,
  artifactServer = null,
  socketPath = brokerSocketPath(),
  artifactSocketPath = join(dirname(socketPath), 'provider-artifact.sock'),
  pidPath = brokerPidPath(),
} = {}) {
  await closeServer(server);
  await closeServer(artifactServer);
  await rm(socketPath, { force: true }).catch(() => {});
  await rm(artifactSocketPath, { force: true }).catch(() => {});
  await rm(pidPath, { force: true }).catch(() => {});
}

async function listenServer(server, path) {
  await new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(path);
  });
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve) => server.close(() => resolve()));
}

export async function runBrokerDaemon(opts = {}) {
  const processRef = opts.processRef || process;
  const exitProcess = opts.exitProcess || ((code) => processRef.exit(code));
  const startBrokerServerImpl = opts.startBrokerServerImpl || startBrokerServer;
  const runtime = opts.runtime || await createDefaultRuntime({
    controllerBindings: opts.controllerBinding ? [opts.controllerBinding] : [],
  });
  const mcVersion = opts.mcVersion === undefined
    ? await getPackageVersion().catch(() => null)
    : opts.mcVersion;
  const state = await startBrokerServerImpl({
    ...opts,
    mcVersion,
    runtime,
    exitOnStop: opts.exitOnStop ?? true,
    exitProcess,
  });
  let cleaningUp = false;
  const cleanup = async () => {
    if (cleaningUp) return;
    cleaningUp = true;
    try {
      // Do not remove the host socket (or force process termination) while a
      // PTY's durable exit record or terminal presence is still outstanding.
      // A failed bounded finalization deliberately leaves the broker alive so
      // an operator can inspect/retry rather than converting live work into a
      // silent stale session.
      const result = await finalizeDaemonSignal({ state, exitProcess });
      if (!result.ok) throw new Error(result.reason);
    } catch {
      cleaningUp = false;
      processRef.exitCode = 1;
    }
  };
  // Keep the handlers installed after a failed bounded shutdown. A later
  // signal must retry finalization rather than falling through to the
  // platform's default termination while a live PTY still exists.
  processRef.on('SIGTERM', cleanup);
  processRef.on('SIGINT', cleanup);
  processRef.on('SIGHUP', cleanup);

  if (opts.readyFile) {
    await writeFile(opts.readyFile, JSON.stringify(state.status()) + '\n', { mode: 0o600 })
      .catch(() => {});
  }

  return new Promise(() => {});
}

// Kept separate from signal wiring so the fail-closed process boundary can be
// verified without ever sending a signal to the test runner.
export async function finalizeDaemonSignal({ state, exitProcess = (code) => process.exit(code) } = {}) {
  try {
    await state?.stop?.();
    exitProcess(0);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err?.message || 'runtime-finalization-unconfirmed' };
  }
}

async function shutdownRuntime(runtime) {
  if (typeof runtime?.shutdown !== 'function') return { ok: true };
  const result = await runtime.shutdown();
  return result?.ok ? result : {
    ok: false,
    reason: result?.reason || 'managed credential cleanup was not confirmed',
  };
}

export function brokerFilesExist({ socketPath = brokerSocketPath(), pidPath = brokerPidPath() } = {}) {
  return { socket: existsSync(socketPath), pid: existsSync(pidPath) };
}

export async function createDefaultRuntime({ controllerBindings = [] } = {}) {
  const ptyModule = await import('node-pty');
  const ptyFactory = ptyModule.default || ptyModule;
  return new BrokerRuntime({
    ptyFactory,
    controllerBindings,
    c1Runner: runClaudeC1BrokerOperation,
  });
}

export function handleBrokerMessage(raw, { status, stop, runtime } = {}) {
  let message;
  try {
    message = JSON.parse(raw || '{}');
  } catch {
    return { response: { ok: false, error: 'invalid JSON' }, stop: false };
  }

  const type = message?.type;
  if (type === 'ping' || type === 'status') {
    return { response: status(), stop: false };
  }
  if (type === 'stop') {
    if (runtime?.listSessions?.().length > 0) {
      return {
        response: {
          ok: false,
          reason: 'broker-sessions-must-be-removed',
          error: 'broker sessions must be removed before the broker can stop',
        },
        stop: false,
      };
    }
    if (typeof stop === 'function') stop();
    return { response: { ...status(), stopping: true }, stop: true };
  }
  if (type === 'attach_session' && runtime?.attachConnection) {
    return {
      response: null,
      stop: false,
      attach: (conn, initialInput) => runtime.attachConnection(message, conn, initialInput),
    };
  }
  if (type === 'run_claude_c1') {
    if (!isExactClaudeC1Request(message)) {
      return { response: claudeC1StatusResponse('failed'), stop: false };
    }
    try {
      const response = runtime?.handle ? runtime.handle(message) : null;
      return {
        response: normalizeClaudeC1Response(response),
        stop: false,
      };
    } catch {
      return { response: claudeC1StatusResponse('failed'), stop: false };
    }
  }
  let runtimeResponse = null;
  try {
    runtimeResponse = runtime?.handle ? runtime.handle(message) : null;
  } catch (err) {
    return {
      response: { ok: false, error: err.message || String(err) },
      stop: false,
    };
  }
  if (runtimeResponse) {
    return { response: runtimeResponse, stop: false };
  }
  return {
    response: { ok: false, error: `unknown broker command: ${type || '<missing>'}` },
    stop: false,
  };
}

/**
 * Capability-reduced endpoint inherited by provider SessionStart hooks.
 * No status, PTY, launch, handoff-journal, or shutdown command is reachable
 * through this socket.
 */
export function handleProviderArtifactMessage(raw, { runtime } = {}) {
  let message;
  try {
    message = JSON.parse(raw || '{}');
  } catch {
    return { response: { ok: false, error: 'invalid JSON' } };
  }
  // Provider children inherit this socket. C1 is a controller-host operation,
  // never a provider capability, even when a provider guesses the command.
  if (message?.type === 'run_claude_c1') {
    return { response: claudeC1StatusResponse('failed') };
  }
  if (message?.type !== 'capture_provider_artifact') {
    return { response: { ok: false, error: 'provider artifact command required' } };
  }
  try {
    const response = runtime?.handle ? runtime.handle(message) : null;
    return {
      response: response || { ok: false, error: 'provider artifact capture unavailable' },
    };
  } catch {
    return { response: { ok: false, error: 'provider artifact capture failed' } };
  }
}

function normalizeClaudeC1Response(response) {
  if (response && typeof response.then === 'function') {
    return Promise.resolve(response)
      .then((value) => claudeC1StatusResponse(value?.status))
      .catch(() => claudeC1StatusResponse('failed'));
  }
  return claudeC1StatusResponse(response?.status);
}
