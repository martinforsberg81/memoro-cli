import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import { beginRuntimeGenerationSync } from '../../../src/mc/session-runtime-journal.js';
import { createSessionHomeSync, sessionHomePaths } from '../../../src/mc/session-home.js';
import { SessionRuntimeClient } from '../../../src/runtime/session-host/client.js';
import { SessionRuntimeHost } from '../../../src/runtime/session-host/runtime-host.js';
import { SessionRuntimeSocketServer } from '../../../src/runtime/session-host/server.js';

const mcSessionId = 'mcs_000000000000000000000001';
const generationId = 'mcg_000000000000000000000001';
let roots = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

test('routes attach, input, output, resize, and exit over the exact per-session socket', async (t) => {
  const mcHomeDir = mkdtempSync(join(tmpdir(), 'mc-runtime-socket-e2e-'));
  roots.push(mcHomeDir);
  createSessionHomeSync({
    mcHomeDir,
    mcSessionId,
    sourceId: 'machine_test',
    name: 'socket-e2e',
    now: () => '2026-08-02T21:00:00.000Z',
  });
  beginRuntimeGenerationSync({
    mcHomeDir,
    mcSessionId,
    generationId,
    action: 'start',
    tool: 'codex',
    launchCwd: '/projects/runtime',
    now: () => '2026-08-02T21:00:01.000Z',
  });
  const pty = new FakePty();
  const host = new SessionRuntimeHost({
    mcHomeDir,
    mcSessionId,
    generationId,
    spawnPlan: {
      command: '/usr/bin/tool',
      args: [],
      cwd: '/projects/runtime',
      env: {},
    },
    ptyFactory: { spawn: () => pty },
    now: tickingClock(),
    hostPid: 40001,
  });
  host.start();
  pty.emitData('ready screen');
  const server = new SessionRuntimeSocketServer({ mcHomeDir, host });
  try {
    await server.start();
  } catch (error) {
    host.close();
    if (error?.code === 'EPERM' || error?.code === 'EINVAL') {
      t.skip(`Unix sockets unavailable in this sandbox (${error.code})`);
      return;
    }
    throw error;
  }

  const paths = sessionHomePaths({ mcHomeDir, mcSessionId });
  assert.equal(server.address().socket_path, paths.runtimeHostSocketPath);
  assert.ok(server.address().socket_path.includes(`/run/sessions/${mcSessionId}/terminal.sock`));
  assert.equal(server.address().socket_path.includes('/hosts/'), false);

  const output = new CollectingOutput();
  const client = new SessionRuntimeClient({
    mcHomeDir,
    mcSessionId,
    generationId,
    cols: 90,
    rows: 28,
    output,
  });
  await client.connect();
  assert.match(output.text(), /ready screen/u);
  client.input('hello\r');
  client.resize(110, 32);
  await turn();
  assert.deepEqual(pty.writes, ['hello\r']);
  assert.ok(pty.resizes.some(([cols, rows]) => cols === 110 && rows === 32));

  const exit = new Promise((resolve) => client.once('exit', resolve));
  pty.emitExit({ exitCode: 0, signal: null });
  assert.equal((await exit).exit_code, 0);
  client.detach();
  await server.stop();
  host.close();
});

test('runs the complete framed attach path over an in-memory duplex transport', async () => {
  const mcHomeDir = mkdtempSync(join(tmpdir(), 'mc-runtime-duplex-e2e-'));
  roots.push(mcHomeDir);
  createSessionHomeSync({
    mcHomeDir,
    mcSessionId,
    sourceId: 'machine_test',
    name: 'duplex-e2e',
    now: () => '2026-08-02T21:00:00.000Z',
  });
  beginRuntimeGenerationSync({
    mcHomeDir,
    mcSessionId,
    generationId,
    action: 'start',
    tool: 'codex',
    launchCwd: '/projects/runtime',
    now: () => '2026-08-02T21:00:01.000Z',
  });
  const pty = new FakePty();
  const host = new SessionRuntimeHost({
    mcHomeDir,
    mcSessionId,
    generationId,
    spawnPlan: { command: '/usr/bin/tool', args: [], cwd: '/projects/runtime', env: {} },
    ptyFactory: { spawn: () => pty },
    now: tickingClock(),
    hostPid: 41001,
  });
  host.start();
  pty.emitData('duplex screen');
  const server = new SessionRuntimeSocketServer({ mcHomeDir, host });
  const [clientSocket, serverSocket] = socketPair();
  server.acceptConnection(serverSocket);
  const output = new CollectingOutput();
  const client = new SessionRuntimeClient({
    mcHomeDir,
    mcSessionId,
    generationId,
    output,
    connector: () => {
      queueMicrotask(() => clientSocket.emit('connect'));
      return clientSocket;
    },
  });
  await client.connect();
  assert.match(output.text(), /duplex screen/u);
  client.input('in-memory\r');
  client.resize(120, 36);
  await turn();
  await turn();
  assert.deepEqual(pty.writes, ['in-memory\r']);
  assert.ok(pty.resizes.some(([cols, rows]) => cols === 120 && rows === 36));
  pty.emitData('\r\nlive update');
  await turn();
  assert.match(output.text(), /live update/u);
  client.detach();
  host.close();
});

test('server shutdown disconnects attached and unattached transports', async () => {
  const host = {
    mcSessionId,
    generationId,
    attach: async () => ({ client_id: 'client_0000000000000001' }),
  };
  let closed = false;
  const server = new SessionRuntimeSocketServer({
    mcHomeDir: '/tmp/mc-runtime-server-shutdown',
    host,
  });
  server.server = { close(callback) { closed = true; callback(); } };
  server.started = true;
  const first = new MemorySocket();
  const second = new MemorySocket();
  server.acceptConnection(first);
  server.acceptConnection(second);
  assert.equal(server.connections.size, 2);
  await server.stop();
  assert.equal(closed, true);
  assert.equal(first.destroyed, true);
  assert.equal(second.destroyed, true);
  assert.equal(server.connections.size, 0);
});

test('client connect fails promptly when the host closes before attach', async () => {
  const socket = new MemorySocket();
  const client = new SessionRuntimeClient({
    mcHomeDir: '/tmp/mc-runtime-client-close',
    mcSessionId,
    generationId,
    output: new CollectingOutput(),
    connector: () => {
      queueMicrotask(() => socket.destroy());
      return socket;
    },
  });
  await assert.rejects(client.connect(),
    (error) => error.reason === 'runtime-host-closed-before-attach');
});

class FakePty {
  constructor() {
    this.pid = 40002;
    this.dataHandlers = [];
    this.exitHandlers = [];
    this.writes = [];
    this.resizes = [];
  }
  onData(handler) { this.dataHandlers.push(handler); }
  onExit(handler) { this.exitHandlers.push(handler); }
  write(data) { this.writes.push(data); }
  resize(cols, rows) { this.resizes.push([cols, rows]); }
  kill() {}
  emitData(data) { for (const handler of this.dataHandlers) handler(data); }
  emitExit(event) { for (const handler of this.exitHandlers) handler(event); }
}

class CollectingOutput extends EventEmitter {
  constructor() {
    super();
    this.chunks = [];
  }
  write(data) { this.chunks.push(Buffer.from(data)); return true; }
  text() { return Buffer.concat(this.chunks).toString('utf8'); }
}

function tickingClock() {
  let time = Date.parse('2026-08-02T21:00:02.000Z');
  return () => {
    const value = new Date(time).toISOString();
    time += 1000;
    return value;
  };
}

function turn() {
  return new Promise((resolve) => setImmediate(resolve));
}

function socketPair() {
  const left = new MemorySocket();
  const right = new MemorySocket();
  left.peer = right;
  right.peer = left;
  return [left, right];
}

class MemorySocket extends EventEmitter {
  constructor() {
    super();
    this.peer = null;
    this.destroyed = false;
    this.writableLength = 0;
  }
  write(data) {
    if (this.destroyed) throw new Error('socket closed');
    const copy = Buffer.from(data);
    queueMicrotask(() => this.peer?.emit('data', copy));
    return true;
  }
  end(data) {
    if (data) this.write(data);
    queueMicrotask(() => this.destroy());
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('close');
    if (this.peer && !this.peer.destroyed) {
      this.peer.destroyed = true;
      this.peer.emit('close');
    }
  }
  pause() {}
  resume() {}
}
