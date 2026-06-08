import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname } from 'node:path';

import { BrokerRuntime } from './runtime.js';
import { brokerPidPath, brokerSocketPath } from './paths.js';

export async function startBrokerServer({
  socketPath = brokerSocketPath(),
  pidPath = brokerPidPath(),
  createServerImpl = createServer,
  pid = process.pid,
  now = () => Date.now(),
  onStop = null,
  exitOnStop = false,
  runtime = null,
} = {}) {
  const startedAtMs = now();
  const startedAt = new Date(startedAtMs).toISOString();
  let stopping = false;

  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  await rm(socketPath, { force: true });
  await writeFile(pidPath, String(pid), { mode: 0o600 });

  const status = () => {
    const response = {
      ok: true,
      broker: {
        pid,
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

  const server = createServerImpl((conn) => {
    let raw = Buffer.alloc(0);
    let handledInitialFrame = false;
    const handleFrame = (frame, initialInput = Buffer.alloc(0)) => {
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
      conn.end(JSON.stringify(handled.response) + '\n');
      if (handled.stop) {
        setImmediate(() => {
          stopBrokerServer({ server, socketPath, pidPath })
            .then(() => {
              if (typeof onStop === 'function') onStop();
              if (exitOnStop) process.exit(0);
            })
            .catch(() => {
              if (typeof onStop === 'function') onStop();
              if (exitOnStop) process.exit(1);
            });
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
      handleFrame(frame, initialInput);
    });
    conn.on('end', () => {
      if (!handledInitialFrame) handleFrame(raw);
    });
  });

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
    server.listen(socketPath);
  });

  try { await chmod(socketPath, 0o600); } catch {}

  return {
    server,
    socketPath,
    pidPath,
    status,
    stop: () => stopBrokerServer({ server, socketPath, pidPath }),
  };
}

export async function stopBrokerServer({ server, socketPath = brokerSocketPath(), pidPath = brokerPidPath() } = {}) {
  if (server?.listening) {
    await new Promise((resolve) => server.close(() => resolve()));
  }
  await rm(socketPath, { force: true }).catch(() => {});
  await rm(pidPath, { force: true }).catch(() => {});
}

export async function runBrokerDaemon(opts = {}) {
  const runtime = opts.runtime || await createDefaultRuntime();
  const state = await startBrokerServer({
    ...opts,
    runtime,
    exitOnStop: opts.exitOnStop ?? true,
  });
  const cleanup = () => {
    stopBrokerServer(state).finally(() => process.exit(0));
  };
  process.once('SIGTERM', cleanup);
  process.once('SIGINT', cleanup);
  process.once('SIGHUP', cleanup);

  if (opts.readyFile) {
    await writeFile(opts.readyFile, JSON.stringify(state.status()) + '\n', { mode: 0o600 })
      .catch(() => {});
  }

  return new Promise(() => {});
}

export function brokerFilesExist({ socketPath = brokerSocketPath(), pidPath = brokerPidPath() } = {}) {
  return { socket: existsSync(socketPath), pid: existsSync(pidPath) };
}

export async function createDefaultRuntime() {
  const ptyModule = await import('node-pty');
  const ptyFactory = ptyModule.default || ptyModule;
  return new BrokerRuntime({ ptyFactory });
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
