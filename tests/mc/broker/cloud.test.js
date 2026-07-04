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
  readLocalSessionOutput,
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

  test('buildBrokerWsUrl carries source identity query params when present', () => {
    const url = new URL(buildBrokerWsUrl('https://meetmemoro.test', {
      token: 'tok',
      machineId: 'm1',
      sourceId: 'cloud:cloud_sess_123',
      sourceKind: 'cloud',
      sourceName: 'Cloud worker',
      cloudSessionId: 'cloud_sess_123',
    }));

    assert.equal(url.searchParams.get('token'), 'tok');
    assert.equal(url.searchParams.get('machine_id'), 'm1');
    assert.equal(url.searchParams.get('source_id'), 'cloud:cloud_sess_123');
    assert.equal(url.searchParams.get('source_kind'), 'cloud');
    assert.equal(url.searchParams.get('source_name'), 'Cloud worker');
    assert.equal(url.searchParams.get('cloud_session_id'), 'cloud_sess_123');
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

describe('readLocalSessionOutput', () => {
  test('reads recent output through fetch_session_output without monitor attach', async () => {
    const seen = [];
    const output = await readLocalSessionOutput({
      sessionId: 'sess_a',
      request: async (msg) => {
        seen.push(msg);
        return { ok: true, output: '\x1b[32mlatest screen\x1b[0m' };
      },
    });

    assert.deepEqual(seen, [{
      type: 'fetch_session_output',
      id: 'sess_a',
    }]);
    assert.equal(output, 'latest screen');
  });
});

describe('CloudBrokerClient', () => {
  test('sends hello and session inventory on control websocket open', async () => {
    resetFakeWs();
    const client = new CloudBrokerClient({
      apiUrl: 'https://memoro.test',
      token: 'tok',
      machineId: 'machine',
      mcVersion: '0.7.6',
      WebSocketImpl: FakeWebSocket,
      request: async () => ({ ok: true, sessions: [{ id: 'sess_a' }] }),
      sleepImpl: async () => {},
    });
    const opened = [];
    const sessionsEvents = [];
    client.on('open', (info) => opened.push(info));
    client.on('sessions', (sessions) => sessionsEvents.push(sessions));

    client.start();
    const control = FakeWebSocket.instances[0];
    assert.match(control.url, /\/api\/mc\/broker\/ws/);
    assert.equal(control.binaryType, 'arraybuffer');
    const controlUrl = new URL(control.url);
    assert.equal(controlUrl.searchParams.get('machine_id'), 'machine');
    assert.equal(controlUrl.searchParams.get('source_id'), 'local:machine');
    assert.equal(controlUrl.searchParams.get('source_kind'), 'local');
    assert.equal(controlUrl.searchParams.get('source_name'), 'machine');
    control.open();
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(control.sent.map((s) => JSON.parse(s)), [
      {
        type: 'hello',
        machine_id: 'machine',
        device_name: 'machine',
        mc_version: '0.7.6',
        source_id: 'local:machine',
        source_kind: 'local',
        source_name: 'machine',
        capabilities: ['pty-stream-v1', 'resize-v1', 'screen-replay-v1'],
      },
      {
        type: 'sessions',
        machine_id: 'machine',
        source_id: 'local:machine',
        source_kind: 'local',
        source_name: 'machine',
        sessions: [{ id: 'sess_a' }],
      },
    ]);
    assert.deepEqual(opened, [{ machine_id: 'machine' }]);
    assert.deepEqual(sessionsEvents, [[{ id: 'sess_a' }]]);
    client.stop();
  });

  test('executes cloud stop/remove commands against the local broker', async () => {
    resetFakeWs();
    const requests = [];
    const client = new CloudBrokerClient({
      apiUrl: 'https://memoro.test',
      token: 'tok',
      machineId: 'machine',
      WebSocketImpl: FakeWebSocket,
      request: async (msg) => {
        requests.push(msg);
        if (msg.type === 'sessions') return { ok: true, sessions: [] };
        if (msg.type === 'stop_session') return { ok: true, stopped: true };
        if (msg.type === 'remove_session') return { ok: true, removed: true };
        throw new Error(`unexpected request: ${msg.type}`);
      },
      sleepImpl: async () => {},
      sessionRefreshIntervalMs: null,
    });

    client.start();
    const control = FakeWebSocket.instances[0];
    control.open();
    await new Promise((resolve) => setImmediate(resolve));
    control.sent = [];

    control.message(JSON.stringify({
      type: 'command',
      command_id: 'cmd_stop',
      kind: 'stop_session',
      coding_session_id: 'sess_a',
      args: { signal: 'SIGHUP' },
    }));
    control.message(JSON.stringify({
      type: 'command',
      command_id: 'cmd_remove',
      kind: 'remove_session',
      coding_session_id: 'sess_a',
      args: {},
    }));
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(requests.filter((msg) => msg.type !== 'sessions').slice(-2), [
      { type: 'stop_session', id: 'sess_a', signal: 'SIGHUP' },
      { type: 'remove_session', id: 'sess_a' },
    ]);
    assert.deepEqual(control.sent.map((s) => JSON.parse(s)).filter((msg) => msg.type === 'result'), [
      {
        type: 'result',
        command_id: 'cmd_stop',
        ok: true,
        data: { ok: true, stopped: true },
      },
      {
        type: 'result',
        command_id: 'cmd_remove',
        ok: true,
        data: { ok: true, removed: true },
      },
    ]);
    client.stop();
  });

  test('refreshes session inventory periodically while connected', async () => {
    resetFakeWs();
    let tick = null;
    let cleared = null;
    const inventories = [
      [{ id: 'sess_old' }],
      [{ id: 'sess_current' }],
    ];
    const client = new CloudBrokerClient({
      apiUrl: 'https://memoro.test',
      token: 'tok',
      machineId: 'machine',
      WebSocketImpl: FakeWebSocket,
      request: async () => ({ ok: true, sessions: inventories.shift() || [] }),
      sessionRefreshIntervalMs: 25,
      setIntervalImpl: (fn, ms) => {
        tick = fn;
        return { ms, unref() {} };
      },
      clearIntervalImpl: (timer) => {
        cleared = timer;
      },
      sleepImpl: async () => {},
    });

    client.start();
    const control = FakeWebSocket.instances[0];
    const controlUrl = new URL(control.url);
    assert.equal(controlUrl.searchParams.get('machine_id'), 'machine');
    assert.equal(controlUrl.searchParams.get('source_id'), 'local:machine');
    assert.equal(controlUrl.searchParams.get('source_kind'), 'local');
    assert.equal(controlUrl.searchParams.get('source_name'), 'machine');
    assert.equal(controlUrl.searchParams.get('cloud_session_id'), null);
    control.open();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(typeof tick, 'function');
    assert.deepEqual(JSON.parse(control.sent.at(-1)), {
      type: 'sessions',
      machine_id: 'machine',
      source_id: 'local:machine',
      source_kind: 'local',
      source_name: 'machine',
      sessions: [{ id: 'sess_old' }],
    });

    await tick();
    assert.deepEqual(JSON.parse(control.sent.at(-1)), {
      type: 'sessions',
      machine_id: 'machine',
      source_id: 'local:machine',
      source_kind: 'local',
      source_name: 'machine',
      sessions: [{ id: 'sess_current' }],
    });

    client.stop();
    assert.ok(cleared);
  });

  test('advertises local repo catalog as a separate source frame', async () => {
    resetFakeWs();
    const client = new CloudBrokerClient({
      apiUrl: 'https://memoro.test',
      token: 'tok',
      machineId: 'machine',
      WebSocketImpl: FakeWebSocket,
      request: async () => ({ ok: true, sessions: [] }),
      repoCatalogProvider: async () => [{
        repo: 'memoro',
        repo_ref: 'martinforsberg81/memoro',
        branch: 'main',
        workspace_ref: 'main',
      }],
      sessionRefreshIntervalMs: 0,
      sleepImpl: async () => {},
    });

    client.start();
    const control = FakeWebSocket.instances[0];
    control.open();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(JSON.parse(control.sent.at(-1)), {
      type: 'repos',
      machine_id: 'machine',
      source_id: 'local:machine',
      source_kind: 'local',
      source_name: 'machine',
      repos: [{
        repo: 'memoro',
        repo_ref: 'martinforsberg81/memoro',
        branch: 'main',
        workspace_ref: 'main',
      }],
    });
    client.stop();
  });

  test('can suppress background repo refresh for deterministic one-shot connect', async () => {
    let repoCalls = 0;
    const client = new CloudBrokerClient({
      apiUrl: 'https://memoro.test',
      token: 'tok',
      machineId: 'machine',
      request: async () => ({ ok: true, sessions: [] }),
      repoCatalogProvider: async () => {
        repoCalls += 1;
        return [{ repo_ref: 'owner/repo' }];
      },
      sleepImpl: async () => {},
    });

    await client.refreshSessions({ refreshRepos: false });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(repoCalls, 0);
  });

  test('sends control frames when websocket readyState is absent', async () => {
    resetFakeWs();
    const client = new CloudBrokerClient({
      apiUrl: 'https://memoro.test',
      token: 'tok',
      machineId: 'machine',
      WebSocketImpl: FakeWebSocket,
      request: async () => ({ ok: true, sessions: [] }),
      sessionRefreshIntervalMs: 0,
      sleepImpl: async () => {},
    });

    client.start();
    const control = FakeWebSocket.instances[0];
    delete control.readyState;
    control.open = function openWithoutReadyState() {
      this.emit('open');
    };
    control.open();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(JSON.parse(control.sent[0]).type, 'hello');
    assert.equal(JSON.parse(control.sent[1]).type, 'sessions');
    client.stop();
  });

  test('advertises explicit cloud source identity on hello and sessions payloads', async () => {
    resetFakeWs();
    const client = new CloudBrokerClient({
      apiUrl: 'https://memoro.test',
      token: 'tok',
      machineId: 'local-machine',
      deviceName: 'Local Machine',
      sourceId: 'cloud:cloud_sess_123',
      sourceKind: 'cloud',
      sourceName: 'Cloud sandbox',
      cloudSessionId: 'cloud_sess_123',
      WebSocketImpl: FakeWebSocket,
      request: async () => ({ ok: true, sessions: [{ id: 'sess_cloud' }] }),
      sleepImpl: async () => {},
    });

    client.start();
    const control = FakeWebSocket.instances[0];
    const controlUrl = new URL(control.url);
    assert.equal(controlUrl.searchParams.get('machine_id'), 'local-machine');
    assert.equal(controlUrl.searchParams.get('source_id'), 'cloud:cloud_sess_123');
    assert.equal(controlUrl.searchParams.get('source_kind'), 'cloud');
    assert.equal(controlUrl.searchParams.get('source_name'), 'Cloud sandbox');
    assert.equal(controlUrl.searchParams.get('cloud_session_id'), 'cloud_sess_123');
    control.open();
    await new Promise((resolve) => setImmediate(resolve));

    const messages = control.sent.map((s) => JSON.parse(s));
    assert.deepEqual(messages[0], {
      type: 'hello',
      machine_id: 'local-machine',
      device_name: 'Local Machine',
      source_id: 'cloud:cloud_sess_123',
      source_kind: 'cloud',
      source_name: 'Cloud sandbox',
      cloud_session_id: 'cloud_sess_123',
      capabilities: ['pty-stream-v1', 'resize-v1', 'screen-replay-v1'],
    });
    assert.deepEqual(messages[1], {
      type: 'sessions',
      machine_id: 'local-machine',
      source_id: 'cloud:cloud_sess_123',
      source_kind: 'cloud',
      source_name: 'Cloud sandbox',
      cloud_session_id: 'cloud_sess_123',
      sessions: [{ id: 'sess_cloud' }],
    });
    client.stop();
  });

  test('advertises env source identity on hello and sessions payloads', async () => {
    resetFakeWs();
    const client = new CloudBrokerClient({
      apiUrl: 'https://memoro.test',
      token: 'tok',
      machineId: 'machine',
      deviceName: 'Device',
      env: {
        MC_SOURCE_ID: 'cloud:env_src',
        MC_SOURCE_KIND: 'cloud',
        MC_SOURCE_NAME: 'Env source',
        MC_CLOUD_SESSION_ID: 'env_cloud_session',
      },
      WebSocketImpl: FakeWebSocket,
      request: async () => ({ ok: true, sessions: [{ id: 'sess_env' }] }),
      sleepImpl: async () => {},
    });

    client.start();
    const control = FakeWebSocket.instances[0];
    const controlUrl = new URL(control.url);
    assert.equal(controlUrl.searchParams.get('source_id'), 'cloud:env_src');
    assert.equal(controlUrl.searchParams.get('source_kind'), 'cloud');
    assert.equal(controlUrl.searchParams.get('source_name'), 'Env source');
    assert.equal(controlUrl.searchParams.get('cloud_session_id'), 'env_cloud_session');
    control.open();
    await new Promise((resolve) => setImmediate(resolve));

    const [hello, sessions] = control.sent.map((s) => JSON.parse(s));
    assert.equal(hello.type, 'hello');
    assert.equal(hello.source_id, 'cloud:env_src');
    assert.equal(hello.source_kind, 'cloud');
    assert.equal(hello.source_name, 'Env source');
    assert.equal(hello.cloud_session_id, 'env_cloud_session');
    assert.equal(sessions.type, 'sessions');
    assert.equal(sessions.source_id, 'cloud:env_src');
    assert.equal(sessions.source_kind, 'cloud');
    assert.equal(sessions.source_name, 'Env source');
    assert.equal(sessions.cloud_session_id, 'env_cloud_session');
    assert.deepEqual(sessions.sessions, [{ id: 'sess_env' }]);
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
    await new Promise((resolve) => setImmediate(resolve));

    const stream = FakeWebSocket.instances[1];
    assert.equal(stream.url, 'wss://memoro.test/api/mc/pty/att_a/broker?token=stream-token');
    assert.equal(stream.binaryType, 'arraybuffer');
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

    stream.message(new Uint8Array([65, 66]).buffer);
    assert.equal(local.writes[2].toString('utf8'), 'AB');

    stream.message(JSON.stringify({ type: 'resize', cols: 90, rows: 25 }));
    await Promise.resolve();
    assert.deepEqual(requests.at(-1), {
      type: 'resize_session',
      id: 'sess_a',
      cols: 90,
      rows: 25,
      side: 'cloud',
      attach_id: 'att_a',
    });

    client.stop();
  });

  test('handles dispatch_message commands through the local broker runtime', async () => {
    resetFakeWs();
    const requests = [];
    const sleeps = [];
    const client = new CloudBrokerClient({
      apiUrl: 'https://memoro.test',
      token: 'tok',
      machineId: 'machine',
      WebSocketImpl: FakeWebSocket,
      request: async (msg) => {
        requests.push(msg);
        if (msg.type === 'sessions') return { ok: true, sessions: [] };
        if (msg.type === 'session_status') return { ok: true, session: { id: 'sess_a', tool: 'codex' } };
        if (msg.type === 'write_session') return { ok: true };
        return { ok: false, error: `unexpected ${msg.type}` };
      },
      sessionRefreshIntervalMs: 0,
      sleepImpl: async (ms) => { sleeps.push(ms); },
    });

    client.start();
    const control = FakeWebSocket.instances[0];
    control.open();
    await new Promise((resolve) => setImmediate(resolve));
    control.message(JSON.stringify({
      type: 'command',
      command_id: 'cmd_dispatch',
      coding_session_id: 'sess_a',
      kind: 'dispatch_message',
      args: { message: 'ship it' },
    }));
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(requests.slice(-3), [
      { type: 'session_status', id: 'sess_a' },
      { type: 'write_session', id: 'sess_a', data: 'ship it\r' },
      { type: 'write_session', id: 'sess_a', data: '\r' },
    ]);
    assert.deepEqual(sleeps, [150]);
    assert.deepEqual(JSON.parse(control.sent.at(-1)), {
      type: 'result',
      command_id: 'cmd_dispatch',
      ok: true,
      data: { ok: true, transport: 'write_session', session: { id: 'sess_a', tool: 'codex' } },
    });
    client.stop();
  });

  test('dispatch_message falls back to dispatch_session if raw write is unavailable', async () => {
    resetFakeWs();
    const requests = [];
    const client = new CloudBrokerClient({
      apiUrl: 'https://memoro.test',
      token: 'tok',
      machineId: 'machine',
      WebSocketImpl: FakeWebSocket,
      request: async (msg) => {
        requests.push(msg);
        if (msg.type === 'sessions') return { ok: true, sessions: [] };
        if (msg.type === 'session_status') return { ok: true, session: { id: 'sess_a', tool: 'claude' } };
        if (msg.type === 'write_session') return { ok: false, error: 'unknown broker command: write_session' };
        if (msg.type === 'dispatch_session') return { ok: true, dispatched: true };
        return { ok: false, error: `unexpected ${msg.type}` };
      },
      sessionRefreshIntervalMs: 0,
      sleepImpl: async () => {},
    });

    client.start();
    const control = FakeWebSocket.instances[0];
    control.open();
    await new Promise((resolve) => setImmediate(resolve));
    control.message(JSON.stringify({
      type: 'command',
      command_id: 'cmd_dispatch_fallback',
      coding_session_id: 'sess_a',
      kind: 'dispatch_message',
      args: { message: 'ship it' },
    }));
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(requests.slice(-2), [
      { type: 'write_session', id: 'sess_a', data: 'ship it\r' },
      { type: 'dispatch_session', id: 'sess_a', message: 'ship it' },
    ]);
    assert.deepEqual(JSON.parse(control.sent.at(-1)), {
      type: 'result',
      command_id: 'cmd_dispatch_fallback',
      ok: true,
      data: { ok: true, dispatched: true, transport: 'dispatch_session' },
    });
    client.stop();
  });

  test('returns command errors for invalid dispatch_message commands', async () => {
    resetFakeWs();
    const client = new CloudBrokerClient({
      apiUrl: 'https://memoro.test',
      token: 'tok',
      machineId: 'machine',
      WebSocketImpl: FakeWebSocket,
      request: async () => ({ ok: true, sessions: [] }),
      sessionRefreshIntervalMs: 0,
      sleepImpl: async () => {},
    });

    client.start();
    const control = FakeWebSocket.instances[0];
    control.open();
    await new Promise((resolve) => setImmediate(resolve));
    control.message(JSON.stringify({
      type: 'command',
      command_id: 'cmd_bad_dispatch',
      coding_session_id: 'sess_a',
      kind: 'dispatch_message',
      args: {},
    }));
    await new Promise((resolve) => setImmediate(resolve));

    const result = JSON.parse(control.sent.at(-1));
    assert.equal(result.type, 'result');
    assert.equal(result.command_id, 'cmd_bad_dispatch');
    assert.equal(result.ok, false);
    assert.match(result.error, /message is required/);
    client.stop();
  });

  test('handles fetch_transcript commands through the transcript handler', async () => {
    resetFakeWs();
    const factoryCalls = [];
    const handlerCalls = [];
    const client = new CloudBrokerClient({
      apiUrl: 'https://memoro.test',
      token: 'tok',
      machineId: 'machine',
      WebSocketImpl: FakeWebSocket,
      request: async () => ({ ok: true, sessions: [] }),
      fetchTranscriptHandlerFactory: (opts) => {
        factoryCalls.push(opts);
        return async (args) => {
          handlerCalls.push(args);
          return { source: opts.source, messages: [{ role: 'assistant', text: 'done' }] };
        };
      },
      sessionRefreshIntervalMs: 0,
      sleepImpl: async () => {},
    });

    client.start();
    const control = FakeWebSocket.instances[0];
    control.open();
    await new Promise((resolve) => setImmediate(resolve));
    control.message(JSON.stringify({
      type: 'command',
      command_id: 'cmd_fetch',
      coding_session_id: 'sess_a',
      kind: 'fetch_transcript',
      args: { transcript_path: '/tmp/session.jsonl', source: 'codex', limit: 50 },
    }));
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(factoryCalls, [{ transcriptPath: '/tmp/session.jsonl', source: 'codex' }]);
    assert.deepEqual(handlerCalls, [{ transcript_path: '/tmp/session.jsonl', source: 'codex', limit: 50 }]);
    assert.deepEqual(JSON.parse(control.sent.at(-1)), {
      type: 'result',
      command_id: 'cmd_fetch',
      ok: true,
      data: { source: 'codex', messages: [{ role: 'assistant', text: 'done' }] },
    });
    client.stop();
  });

  test('uses command tool hint as transcript source when transcript path is explicit', async () => {
    resetFakeWs();
    const factoryCalls = [];
    const client = new CloudBrokerClient({
      apiUrl: 'https://memoro.test',
      token: 'tok',
      machineId: 'machine',
      WebSocketImpl: FakeWebSocket,
      request: async () => ({ ok: true, sessions: [] }),
      fetchTranscriptHandlerFactory: (opts) => {
        factoryCalls.push(opts);
        return async () => ({ source: opts.source, messages: [] });
      },
      sessionRefreshIntervalMs: 0,
      sleepImpl: async () => {},
    });

    client.start();
    const control = FakeWebSocket.instances[0];
    control.open();
    await new Promise((resolve) => setImmediate(resolve));
    control.message(JSON.stringify({
      type: 'command',
      command_id: 'cmd_fetch_tool_hint',
      coding_session_id: 'sess_a',
      tool: 'codex',
      kind: 'fetch_transcript',
      args: { transcript_path: '/tmp/session.jsonl' },
    }));
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(factoryCalls, [{ transcriptPath: '/tmp/session.jsonl', source: 'codex' }]);
    assert.equal(JSON.parse(control.sent.at(-1)).data.source, 'codex');
    client.stop();
  });

  test('falls back to broker recent output when fetch_transcript has no transcript path', async () => {
    resetFakeWs();
    const requests = [];
    const client = new CloudBrokerClient({
      apiUrl: 'https://memoro.test',
      token: 'tok',
      machineId: 'machine',
      WebSocketImpl: FakeWebSocket,
      request: async (msg) => {
        requests.push(msg);
        if (msg.type === 'sessions') return { ok: true, sessions: [] };
        if (msg.type === 'fetch_session_output') {
          return {
            ok: true,
            output: 'latest screen',
            session: {
              id: 'sess_a',
              cwd: '/repo',
              started_at: '2026-06-09T12:00:00.000Z',
            },
          };
        }
        return { ok: false, error: `unexpected ${msg.type}` };
      },
      sessionRefreshIntervalMs: 0,
      sleepImpl: async () => {},
    });

    client.start();
    const control = FakeWebSocket.instances[0];
    control.open();
    await new Promise((resolve) => setImmediate(resolve));
    control.message(JSON.stringify({
      type: 'command',
      command_id: 'cmd_fetch_fallback',
      coding_session_id: 'sess_a',
      kind: 'fetch_transcript',
      args: { source: 'codex' },
    }));
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(requests.at(-1), {
      type: 'fetch_session_output',
      id: 'sess_a',
    });
    assert.deepEqual(JSON.parse(control.sent.at(-1)), {
      type: 'result',
      command_id: 'cmd_fetch_fallback',
      ok: true,
      data: {
        source: 'codex',
        session_id: 'sess_a',
        cwd: '/repo',
        tool_version: null,
        started_at: '2026-06-09T12:00:00.000Z',
        ended_at: null,
        messages: [{ role: 'assistant', text: 'latest screen' }],
        activities: [],
        fallback: 'broker_recent_output',
      },
    });
    client.stop();
  });

  test('derives recent-output transcript source from broker session tool when command omits source', async () => {
    resetFakeWs();
    const client = new CloudBrokerClient({
      apiUrl: 'https://memoro.test',
      token: 'tok',
      machineId: 'machine',
      WebSocketImpl: FakeWebSocket,
      request: async (msg) => {
        if (msg.type === 'sessions') return { ok: true, sessions: [] };
        if (msg.type === 'fetch_session_output') {
          return {
            ok: true,
            output: 'codex screen',
            session: { id: 'sess_a', tool: 'codex', cwd: '/repo' },
          };
        }
        return { ok: false, error: `unexpected ${msg.type}` };
      },
      sessionRefreshIntervalMs: 0,
      sleepImpl: async () => {},
    });

    client.start();
    const control = FakeWebSocket.instances[0];
    control.open();
    await new Promise((resolve) => setImmediate(resolve));
    control.message(JSON.stringify({
      type: 'command',
      command_id: 'cmd_fetch_tool_from_session',
      coding_session_id: 'sess_a',
      kind: 'fetch_transcript',
      args: {},
    }));
    await new Promise((resolve) => setImmediate(resolve));

    const result = JSON.parse(control.sent.at(-1));
    assert.equal(result.ok, true);
    assert.equal(result.data.source, 'codex');
    assert.deepEqual(result.data.messages, [{ role: 'assistant', text: 'codex screen' }]);
    client.stop();
  });

  test('does not open a monitor attach when broker recent output is unavailable', async () => {
    resetFakeWs();
    const local = makeLocalSocket();
    const client = new CloudBrokerClient({
      apiUrl: 'https://memoro.test',
      token: 'tok',
      machineId: 'machine',
      WebSocketImpl: FakeWebSocket,
      request: async (msg) => {
        if (msg.type === 'sessions') return { ok: true, sessions: [] };
        if (msg.type === 'fetch_session_output') return { ok: false, error: 'unknown broker command: fetch_session_output' };
        return { ok: false, error: `unexpected ${msg.type}` };
      },
      connect: () => local,
      localTranscriptReadMs: 50,
      sessionRefreshIntervalMs: 0,
      sleepImpl: async () => {},
    });

    client.start();
    const control = FakeWebSocket.instances[0];
    control.open();
    await new Promise((resolve) => setImmediate(resolve));
    control.message(JSON.stringify({
      type: 'command',
      command_id: 'cmd_fetch_attach',
      coding_session_id: 'sess_a',
      kind: 'fetch_transcript',
      args: { source: 'codex' },
    }));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(local.writes.length, 0);
    assert.deepEqual(JSON.parse(control.sent.at(-1)), {
      type: 'result',
      command_id: 'cmd_fetch_attach',
      ok: true,
      data: {
        source: 'codex',
        session_id: 'sess_a',
        cwd: null,
        tool_version: null,
        started_at: null,
        ended_at: null,
        messages: [],
        activities: [],
        fallback: 'broker_recent_output_unavailable',
      },
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
