import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { describe } from 'node:test';

import { CloudBrokerClient } from '../../../src/runtime/broker/cloud.js';
import { requestBroker } from '../../../src/runtime/broker/client.js';
import {
  createC1GlobalInterlockForTesting,
} from '../../../src/runtime/broker/c1-global-interlock.js';
import { startBrokerServer } from '../../../src/runtime/broker/daemon.js';
import { BrokerRuntime } from '../../../src/runtime/broker/runtime.js';
import {
  deriveHandoffControllerRoot,
} from '../../../src/mc/handoff-controller-capability.js';

class FakeWebSocket extends EventEmitter {
  static instances = [];

  constructor(url) {
    super();
    this.url = url;
    this.sent = [];
    this.readyState = 0;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(event, handler) {
    this.on(event, handler);
  }

  send(data) {
    this.sent.push(data);
  }

  close(code, reason) {
    this.closeCode = code;
    this.closeReason = reason;
    this.readyState = 3;
    this.emit('close', { code, reason });
  }

  open() {
    this.readyState = 1;
    this.emit('open');
  }

  message(data) {
    this.emit('message', { data });
  }
}

function resetFakeWs() {
  FakeWebSocket.instances = [];
}

function makeFakePtyFactory() {
  const ptys = [];
  const calls = [];
  const factory = {
    spawn(bin, args, options) {
      let dataHandler = null;
      let exitHandler = null;
      const pty = {
        pid: 9200 + ptys.length,
        writes: [],
        resizes: [],
        kills: [],
        onData(handler) { dataHandler = handler; },
        onExit(handler) { exitHandler = handler; },
        write(data) { this.writes.push(data); },
        resize(cols, rows) { this.resizes.push({ cols, rows }); },
        kill(signal) { this.kills.push(signal); },
        emitData(data) { dataHandler?.(data); },
        emitExit(event) { exitHandler?.(event); },
      };
      calls.push({ bin, args, options });
      ptys.push(pty);
      return pty;
    },
  };
  return { factory, calls, ptys };
}

function makeRuntime(tmp, fake) {
  return new BrokerRuntime({
    ptyFactory: fake.factory,
    cwd: () => tmp,
    c1Interlock: createC1GlobalInterlockForTesting({
      root: join(tmp, 'c1-global-interlock'),
    }),
    controllerBindings: [{
      session_id: 'sess_e2ecloud',
      session_controller_capability: deriveHandoffControllerRoot({
        token: 'tok',
        codingSessionId: 'sess_e2ecloud',
      }),
    }],
    launchResolver: (toolInput) => ({
      ok: true,
      id: toolInput,
      shortName: toolInput,
      spec: {
        bin: 'fake-tool',
        args: (argv = []) => ['--fake', ...argv],
      },
    }),
  });
}

function fakeCreateServer(_options, handler) {
  const server = new EventEmitter();
  server.handler = handler;
  server.listening = false;
  server.listen = () => {
    server.listening = true;
    queueMicrotask(() => server.emit('listening'));
  };
  server.close = (cb) => {
    server.listening = false;
    cb?.();
  };
  return server;
}

function connectToFakeServer(server) {
  const client = makeEndpoint();
  const serverConn = makeEndpoint();
  client.peer = serverConn;
  serverConn.peer = client;
  server.handler(serverConn);
  queueMicrotask(() => client.emit('connect'));
  return client;
}

function makeEndpoint() {
  const endpoint = new EventEmitter();
  endpoint.encoding = null;
  endpoint.destroyed = false;
  endpoint.setEncoding = (encoding) => { endpoint.encoding = encoding; };
  endpoint.write = (data) => {
    if (endpoint.destroyed) return false;
    deliver(endpoint.peer, data);
    return true;
  };
  endpoint.end = (data) => {
    if (data != null) endpoint.write(data);
    queueMicrotask(() => {
      endpoint.peer?.emit('end');
      endpoint.peer?.emit('close');
    });
  };
  endpoint.destroy = () => {
    if (endpoint.destroyed) return;
    endpoint.destroyed = true;
    queueMicrotask(() => {
      endpoint.emit('close');
      endpoint.peer?.emit('close');
    });
  };
  return endpoint;
}

function deliver(target, data) {
  if (!target || target.destroyed) return;
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
  const payload = target.encoding ? buffer.toString(target.encoding) : buffer;
  queueMicrotask(() => target.emit('data', payload));
}

function sentJson(ws) {
  return ws.sent
    .filter((item) => typeof item === 'string')
    .map((item) => {
      try { return JSON.parse(item); } catch { return null; }
    })
    .filter(Boolean);
}

async function waitFor(predicate, label, timeoutMs = 1_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${label}`);
}

describe('cloud broker end-to-end attach smoke', () => {
  test('relays browser attach input/output through the local broker-owned PTY', async () => {
    resetFakeWs();
    const tmp = mkdtempSync(join(tmpdir(), 'mc-cloud-e2e-'));
    const socketPath = join(tmp, 'broker.sock');
    const pidPath = join(tmp, 'broker.pid');
    let broker = null;
    let client = null;

    try {
      const fake = makeFakePtyFactory();
      const runtime = makeRuntime(tmp, fake);
      const launched = runtime.handle({
        type: 'launch_session',
        session: {
          id: 'sess_e2ecloud',
          name: 'cloud-smoke',
          cwd: tmp,
          tool: 'codex',
          session_controller_capability: deriveHandoffControllerRoot({
            token: 'tok',
            codingSessionId: 'sess_e2ecloud',
          }),
          sidecars: {
            enabled: false,
            token: 'tok',
          },
          cols: 80,
          rows: 24,
        },
      });
      assert.equal(launched.ok, true);
      fake.ptys[0].emitData('screen:ready\n');

      broker = await startBrokerServer({
        socketPath,
        pidPath,
        runtime,
        createServerImpl: fakeCreateServer,
      });
      const connectToBroker = () => connectToFakeServer(broker.server);
      client = new CloudBrokerClient({
        apiUrl: 'https://memoro.test',
        token: 'tok',
        machineId: 'machine-e2e',
        mcVersion: '0.7.6-test',
        WebSocketImpl: FakeWebSocket,
        request: (message) => requestBroker(message, { socketPath, timeoutMs: 1_000, connect: connectToBroker }),
        connect: connectToBroker,
        brokerSocket: socketPath,
        sleepImpl: async () => {},
      });

      client.start();
      const control = FakeWebSocket.instances[0];
      assert.match(control.url, /\/api\/mc\/broker\/ws/);
      assert.equal(control.binaryType, 'arraybuffer');
      control.open();

      await waitFor(() => sentJson(control).some((msg) => msg.type === 'sessions'), 'session advertisement');
      const controlMessages = sentJson(control);
      const hello = controlMessages.find((msg) => msg.type === 'hello');
      assert.equal(hello.machine_id, 'machine-e2e');
      assert.equal(hello.device_name, 'machine-e2e');
      assert.equal(hello.mc_version, '0.7.6-test');

      const sessions = controlMessages.find((msg) => msg.type === 'sessions').sessions;
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0].id, 'sess_e2ecloud');
      assert.equal(sessions[0].attachable, true);

      control.message(JSON.stringify({
        type: 'attach_request',
        attach_id: 'att_e2e',
        coding_session_id: 'sess_e2ecloud',
        broker_ws_url: 'wss://memoro.test/api/mc/pty/att_e2e/broker',
        token: 'stream-token',
        cols: 100,
        rows: 30,
      }));

      await waitFor(() => FakeWebSocket.instances.length === 2, 'broker-side attach stream');
      const stream = FakeWebSocket.instances[1];
      assert.equal(stream.url, 'wss://memoro.test/api/mc/pty/att_e2e/broker?token=stream-token');
      assert.equal(stream.binaryType, 'arraybuffer');
      stream.open();

      await waitFor(() => sentJson(stream).some((msg) => msg.type === 'attach_accepted'), 'attach acceptance');
      const accepted = sentJson(stream).find((msg) => msg.type === 'attach_accepted');
      assert.equal(accepted.attach_id, 'att_e2e');
      assert.equal(accepted.writer, true);

      await waitFor(
        () => stream.sent.some((item) => Buffer.isBuffer(item) && item.toString('utf8') === 'screen:ready\n'),
        'initial PTY replay',
      );

      stream.message(new Uint8Array(Buffer.from('typed')).buffer);
      await waitFor(() => fake.ptys[0].writes.includes('typed'), 'browser input relay');

      stream.message(JSON.stringify({ type: 'resize', cols: 120, rows: 35 }));
      await waitFor(
        () => fake.ptys[0].resizes.some((entry) => entry.cols === 120 && entry.rows === 35),
        'browser resize relay',
      );

      fake.ptys[0].emitData('assistant output\n');
      await waitFor(
        () => stream.sent.some((item) => Buffer.isBuffer(item) && item.toString('utf8') === 'assistant output\n'),
        'PTY output relay',
      );

      stream.message(JSON.stringify({ type: 'detach' }));
      await waitFor(() => stream.readyState === 3, 'cloud stream detach');
      assert.deepEqual(fake.ptys[0].kills, []);
      const afterDetach = runtime.handle({ type: 'session_status', id: 'sess_e2ecloud' });
      assert.equal(afterDetach.ok, true);
      assert.equal(afterDetach.session.session_state, 'live');
      assert.equal(afterDetach.session.writer_attach_id, null);
    } finally {
      client?.stop();
      await broker?.stop?.().catch(() => {});
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
