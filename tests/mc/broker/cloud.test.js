import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test, { describe } from 'node:test';

import {
  CloudBrokerClient,
  appendToken,
  buildBrokerWsUrl,
  createAttachBridge,
  listLocalBrokerSessions,
  nextBackoff,
} from '../../../src/mc/broker/cloud.js';

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

function makeLocalSocket() {
  const socket = new EventEmitter();
  socket.writes = [];
  socket.destroyed = false;
  socket.write = (data) => { socket.writes.push(data); };
  socket.destroy = () => { socket.destroyed = true; };
  return socket;
}

describe('cloud broker URL helpers', () => {
  test('buildBrokerWsUrl targets the broker control endpoint', () => {
    assert.equal(
      buildBrokerWsUrl('https://meetmemoro.test', { token: 'tok', machineId: 'm1' }),
      'wss://meetmemoro.test/api/mc/broker/ws?token=tok&machine_id=m1',
    );
    assert.equal(
      buildBrokerWsUrl('http://localhost:8787', { token: 'tok' }),
      'ws://localhost:8787/api/mc/broker/ws?token=tok',
    );
  });

  test('appendToken adds the broker-side attach token', () => {
    assert.equal(
      appendToken('wss://example.test/api/mc/pty/att_x/broker?x=1', 'tok'),
      'wss://example.test/api/mc/pty/att_x/broker?x=1&token=tok',
    );
  });

  test('nextBackoff doubles up to the cap', () => {
    assert.equal(nextBackoff(1_000), 2_000);
    assert.equal(nextBackoff(30_000), 30_000);
  });
});

describe('listLocalBrokerSessions', () => {
  test('uses sessions response when available', async () => {
    const sessions = await listLocalBrokerSessions({
      request: async (msg) => {
        assert.deepEqual(msg, { type: 'sessions' });
        return { ok: true, sessions: [{ id: 'sess_a' }] };
      },
    });

    assert.deepEqual(sessions, [{ id: 'sess_a' }]);
  });

  test('falls back to status.sessions for older brokers', async () => {
    const seen = [];
    const sessions = await listLocalBrokerSessions({
      request: async (msg) => {
        seen.push(msg.type);
        if (msg.type === 'sessions') return { ok: false, error: 'unknown command' };
        return { ok: true, sessions: [{ id: 'sess_b' }] };
      },
    });

    assert.deepEqual(seen, ['sessions', 'status']);
    assert.deepEqual(sessions, [{ id: 'sess_b' }]);
  });
});

describe('CloudBrokerClient', () => {
  test('sends hello and session inventory on control websocket open', async () => {
    resetFakeWs();
    const client = new CloudBrokerClient({
      apiUrl: 'https://memoro.test',
      token: 'tok',
      machineId: 'machine',
      WebSocketImpl: FakeWebSocket,
      request: async () => ({ ok: true, sessions: [{ id: 'sess_a' }] }),
      sleepImpl: async () => {},
    });

    client.start();
    const control = FakeWebSocket.instances[0];
    assert.match(control.url, /\/api\/mc\/broker\/ws/);
    control.open();
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(control.sent.map((s) => JSON.parse(s)), [
      {
        type: 'hello',
        machine_id: 'machine',
        capabilities: ['pty-stream-v1', 'resize-v1', 'writer-lease-v1', 'screen-replay-v1'],
      },
      {
        type: 'sessions',
        machine_id: 'machine',
        sessions: [{ id: 'sess_a' }],
      },
    ]);
    client.stop();
  });

  test('handles attach_request by creating a broker-side attach stream', async () => {
    resetFakeWs();
    const local = makeLocalSocket();
    const requests = [];
    const client = new CloudBrokerClient({
      apiUrl: 'https://memoro.test',
      token: 'tok',
      machineId: 'machine',
      WebSocketImpl: FakeWebSocket,
      request: async (msg) => {
        requests.push(msg);
        return { ok: true, sessions: [] };
      },
      connect: () => local,
      sleepImpl: async () => {},
    });

    client.start();
    const control = FakeWebSocket.instances[0];
    control.open();
    await Promise.resolve();
    control.message(JSON.stringify({
      type: 'attach_request',
      attach_id: 'att_a',
      coding_session_id: 'sess_a',
      broker_ws_url: 'wss://memoro.test/api/mc/pty/att_a/broker',
      token: 'stream-token',
      cols: 120,
      rows: 40,
    }));
    await Promise.resolve();

    const stream = FakeWebSocket.instances[1];
    assert.equal(stream.url, 'wss://memoro.test/api/mc/pty/att_a/broker?token=stream-token');
    stream.open();
    assert.deepEqual(JSON.parse(local.writes[0]), {
      type: 'attach_session',
      id: 'sess_a',
      attach_id: 'att_a',
      side: 'cloud',
      cols: 120,
      rows: 40,
      writer: true,
      mode: 'write',
    });

    local.emit('data', Buffer.from('{"ok":true,"writer":true,"attach":{"attach_id":"att_a"}}\nhello'));
    assert.equal(JSON.parse(stream.sent[0]).type, 'attach_accepted');
    assert.equal(stream.sent[1].toString('utf8'), 'hello');

    stream.message(Buffer.from('typed'));
    assert.equal(local.writes[1].toString('utf8'), 'typed');

    stream.message(JSON.stringify({ type: 'resize', cols: 90, rows: 25 }));
    await Promise.resolve();
    assert.deepEqual(requests.at(-1), {
      type: 'resize_session',
      id: 'sess_a',
      cols: 90,
      rows: 25,
    });

    client.stop();
  });
});

describe('createAttachBridge', () => {
  test('forwards local attach errors to the remote stream', () => {
    resetFakeWs();
    const local = makeLocalSocket();
    const bridge = createAttachBridge({
      attachId: 'att_fail',
      sessionId: 'sess_missing',
      brokerWsUrl: 'wss://memoro.test/api/mc/pty/att_fail/broker',
      WebSocketImpl: FakeWebSocket,
      connect: () => local,
    });

    bridge.start();
    const remote = FakeWebSocket.instances[0];
    remote.open();
    local.emit('data', Buffer.from('{"ok":false,"error":"missing session"}\n'));

    assert.deepEqual(JSON.parse(remote.sent[0]), {
      type: 'attach_error',
      attach_id: 'att_fail',
      error: 'missing session',
    });
    assert.equal(local.destroyed, true);
  });

  test('forwards malformed local attach acknowledgements as attach_error', () => {
    resetFakeWs();
    const local = makeLocalSocket();
    const bridge = createAttachBridge({
      attachId: 'att_bad',
      sessionId: 'sess_a',
      brokerWsUrl: 'wss://memoro.test/api/mc/pty/att_bad/broker',
      WebSocketImpl: FakeWebSocket,
      connect: () => local,
    });

    bridge.start();
    const remote = FakeWebSocket.instances[0];
    remote.open();
    local.emit('data', Buffer.from('not-json\n'));

    const out = JSON.parse(remote.sent[0]);
    assert.equal(out.type, 'attach_error');
    assert.equal(out.attach_id, 'att_bad');
    assert.match(out.error, /invalid local attach response/);
  });
});
