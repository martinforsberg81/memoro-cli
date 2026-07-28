import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { describe } from 'node:test';

import {
  CloudBrokerClient,
  BOOTSTRAP_SUBPROTOCOL_PREFIX,
  BROKER_SUBPROTOCOL,
  CONTROL_PROTOCOL_VERSION,
  MAX_BOOTSTRAP_TICKET_BYTES,
  appendToken,
  buildBrokerWsUrl,
  buildCloudBrokerSubprotocols,
  createCloudBootstrapTicketProvider,
  createAttachBridge,
  listLocalBrokerSessions,
  nextBackoff,
  readLocalSessionOutput,
} from '../../../src/mc/broker/cloud.js';
import {
  deriveHandoffControllerRoot,
} from '../../../src/mc/handoff-controller-capability.js';

const controllerCapability = deriveHandoffControllerRoot({
  token: 'tok',
  codingSessionId: 'sess_a',
});

class FakeWebSocket extends EventEmitter {
  static instances = [];

  constructor(url, protocols = undefined) {
    super();
    this.url = url;
    this.protocols = protocols;
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

  test('buildBrokerWsUrl carries the runtime authorization binding when present', () => {
    const url = new URL(buildBrokerWsUrl('https://meetmemoro.test', {
      token: 'tok',
      runtimeGeneration: 'rtg_0123456789abcdef',
      authorizationDigest: 'a'.repeat(64),
    }));

    assert.equal(url.searchParams.get('runtime_generation'), 'rtg_0123456789abcdef');
    assert.equal(url.searchParams.get('authorization_digest'), 'a'.repeat(64));
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

  test('encodes a strict bootstrap ticket only in the WebSocket subprotocol offer', () => {
    assert.deepEqual(buildCloudBrokerSubprotocols('abc_DEF-123'), [
      BROKER_SUBPROTOCOL,
      `${BOOTSTRAP_SUBPROTOCOL_PREFIX}abc_DEF-123`,
    ]);
    assert.throws(() => buildCloudBrokerSubprotocols('has=padding'), /invalid cloud broker bootstrap ticket/);
    assert.throws(() => buildCloudBrokerSubprotocols('a'.repeat(MAX_BOOTSTRAP_TICKET_BYTES + 1)), /invalid cloud broker bootstrap ticket/);
  });

  test('requests a bootstrap ticket through Authorization-bound HTTP without serialising the broker token', async () => {
    let call = null;
    const provider = createCloudBootstrapTicketProvider({
      apiUrl: 'https://memoro.test',
      token: 'broker-secret',
      machineId: 'machine',
      codingSessionId: 'coding_123456',
      sourceIdentity: {
        source_id: 'cloud:cld_123456',
        source_kind: 'cloud',
        source_name: 'Cloud worker',
        cloud_session_id: 'cld_123456',
        runtime_generation: 'rtg_0123456789abcdef',
        authorization_digest: 'a'.repeat(64),
      },
      memoroFetchImpl: async (apiUrl, path, options) => {
        call = { apiUrl, path, options };
        return { bootstrap_ticket: 'ticket_123' };
      },
    });

    assert.deepEqual(await provider(), { ticket: 'ticket_123' });
    assert.equal(call.apiUrl, 'https://memoro.test');
    assert.equal(call.path, '/api/mc/cloud-sessions/cld_123456/broker-ticket');
    assert.equal(call.options.token, 'broker-secret');
    assert.equal(call.options.method, 'POST');
    assert.equal(JSON.stringify(call.options.body).includes('broker-secret'), false);
    assert.deepEqual(call.options.body, {
      protocol_version: 'mc-broker-bootstrap-v1',
      machine_id: 'machine',
      source_id: 'cloud:cld_123456',
      source_kind: 'cloud',
      source_name: 'Cloud worker',
      cloud_session_id: 'cld_123456',
      coding_session_id: 'coding_123456',
    });
    assert.deepEqual(call.options.requestHeaders, {
      'X-MC-Runtime-Generation': 'rtg_0123456789abcdef',
      'X-MC-Authorization-Digest': 'a'.repeat(64),
    });
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
  test('cloud runtime uses a fresh bootstrap ticket per reconnect and keeps secrets out of URLs and frames', async () => {
    resetFakeWs();
    const tickets = ['ticket_one', 'ticket_two'];
    const warnings = [];
    const client = new CloudBrokerClient({
      apiUrl: 'https://memoro.test',
      token: 'broker-secret',
      machineId: 'machine',
      sourceId: 'cloud:cld_123456',
      sourceKind: 'cloud',
      sourceName: 'Cloud worker',
      cloudSessionId: 'cld_123456',
      codingSessionId: 'coding_123456',
      runtimeGeneration: 'rtg_0123456789abcdef',
      authorizationDigest: 'a'.repeat(64),
      cloudRuntime: true,
      bootstrapTicketProvider: async () => ({ ticket: tickets.shift() }),
      WebSocketImpl: FakeWebSocket,
      request: async () => ({ ok: true, sessions: [] }),
      sessionRefreshIntervalMs: 0,
      sleepImpl: async () => {},
      logger: { warn: (message) => warnings.push(message), info() {}, error() {} },
    });

    client.start();
    await new Promise((resolve) => setImmediate(resolve));
    const first = FakeWebSocket.instances[0];
    const firstUrl = new URL(first.url);
    assert.equal(firstUrl.search, '');
    assert.equal(firstUrl.searchParams.get('token'), null);
    assert.equal(first.url.includes('broker-secret'), false);
    assert.deepEqual(first.protocols, [
      BROKER_SUBPROTOCOL,
      `${BOOTSTRAP_SUBPROTOCOL_PREFIX}ticket_one`,
    ]);
    first.open();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(JSON.stringify(first.sent).includes('broker-secret'), false);
    assert.equal(JSON.stringify(first.sent).includes('ticket_one'), false);
    assert.equal(JSON.parse(first.sent[0]).protocol_version, CONTROL_PROTOCOL_VERSION);

    first.close(1006, 'lost');
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    const second = FakeWebSocket.instances[1];
    assert.ok(second);
    assert.deepEqual(second.protocols, [
      BROKER_SUBPROTOCOL,
      `${BOOTSTRAP_SUBPROTOCOL_PREFIX}ticket_two`,
    ]);
    assert.equal(second.url.includes('token='), false);
    assert.equal(JSON.stringify(warnings).includes('broker-secret'), false);
    assert.equal(JSON.stringify(warnings).includes('ticket_one'), false);
    client.stop();
  });

  test('cloud runtime permanent bootstrap failures stop reconnects without leaking the ticket', async () => {
    resetFakeWs();
    const warnings = [];
    const fatal = [];
    const client = new CloudBrokerClient({
      apiUrl: 'https://memoro.test',
      token: 'broker-secret',
      machineId: 'machine',
      sourceId: 'cloud:cld_123456',
      sourceKind: 'cloud',
      sourceName: 'Cloud worker',
      cloudSessionId: 'cld_123456',
      codingSessionId: 'coding_123456',
      runtimeGeneration: 'rtg_0123456789abcdef',
      authorizationDigest: 'a'.repeat(64),
      cloudRuntime: true,
      bootstrapTicketProvider: async () => ({ ticket: 'x'.repeat(MAX_BOOTSTRAP_TICKET_BYTES + 1) }),
      WebSocketImpl: FakeWebSocket,
      sleepImpl: async () => assert.fail('must not retry a permanent bootstrap failure'),
      logger: { warn: (message) => warnings.push(message), info() {}, error() {} },
    });
    client.on('fatal', (event) => fatal.push(event));

    client.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(FakeWebSocket.instances.length, 0);
    assert.deepEqual(fatal, [{ code: 'cloud_broker_bootstrap_ticket_invalid' }]);
    assert.equal(JSON.stringify(warnings).includes('x'.repeat(16)), false);
    assert.equal(JSON.stringify(warnings).includes('broker-secret'), false);
  });

  test('cloud runtime rejects unversioned, malformed, or oversized control frames fail-closed', async () => {
    resetFakeWs();
    const fatal = [];
    const client = new CloudBrokerClient({
      apiUrl: 'https://memoro.test',
      token: 'broker-secret',
      machineId: 'machine',
      sourceId: 'cloud:cld_123456',
      sourceKind: 'cloud',
      sourceName: 'Cloud worker',
      cloudSessionId: 'cld_123456',
      codingSessionId: 'coding_123456',
      runtimeGeneration: 'rtg_0123456789abcdef',
      authorizationDigest: 'a'.repeat(64),
      cloudRuntime: true,
      bootstrapTicketProvider: async () => ({ ticket: 'ticket_one' }),
      WebSocketImpl: FakeWebSocket,
      request: async () => ({ ok: true, sessions: [] }),
      sessionRefreshIntervalMs: 0,
      sleepImpl: async () => {},
    });
    client.on('fatal', (event) => fatal.push(event));
    client.start();
    await new Promise((resolve) => setImmediate(resolve));
    const control = FakeWebSocket.instances[0];
    control.open();
    await new Promise((resolve) => setImmediate(resolve));
    control.message(JSON.stringify({ type: 'ack' }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(fatal, [{ code: 'cloud_broker_protocol_version_invalid' }]);

    const oversized = new CloudBrokerClient({
      apiUrl: 'https://memoro.test', token: 'broker-secret', machineId: 'machine',
      sourceId: 'cloud:cld_123456', sourceKind: 'cloud', sourceName: 'Cloud worker', cloudSessionId: 'cld_123456', codingSessionId: 'coding_123456',
      runtimeGeneration: 'rtg_0123456789abcdef', authorizationDigest: 'a'.repeat(64), cloudRuntime: true,
      bootstrapTicketProvider: async () => ({ ticket: 'ticket_two' }), WebSocketImpl: FakeWebSocket,
      request: async () => ({ ok: true, sessions: [] }), sessionRefreshIntervalMs: 0, sleepImpl: async () => {},
    });
    const oversizedFatal = [];
    oversized.on('fatal', (event) => oversizedFatal.push(event));
    oversized.start();
    await new Promise((resolve) => setImmediate(resolve));
    const oversizeControl = FakeWebSocket.instances[1];
    oversizeControl.open();
    oversizeControl.message('x'.repeat(64 * 1024 + 1));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(oversizedFatal, [{ code: 'cloud_broker_frame_too_large' }]);

    const malformed = new CloudBrokerClient({
      apiUrl: 'https://memoro.test', token: 'broker-secret', machineId: 'machine',
      sourceId: 'cloud:cld_123456', sourceKind: 'cloud', sourceName: 'Cloud worker', cloudSessionId: 'cld_123456', codingSessionId: 'coding_123456',
      runtimeGeneration: 'rtg_0123456789abcdef', authorizationDigest: 'a'.repeat(64), cloudRuntime: true,
      bootstrapTicketProvider: async () => ({ ticket: 'ticket_three' }), WebSocketImpl: FakeWebSocket,
      request: async () => ({ ok: true, sessions: [] }), sessionRefreshIntervalMs: 0, sleepImpl: async () => {},
    });
    const malformedFatal = [];
    malformed.on('fatal', (event) => malformedFatal.push(event));
    malformed.start();
    await new Promise((resolve) => setImmediate(resolve));
    const malformedControl = FakeWebSocket.instances[2];
    malformedControl.open();
    malformedControl.message('{not-json');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(malformedFatal, [{ code: 'cloud_broker_frame_invalid' }]);

    const unknown = new CloudBrokerClient({
      apiUrl: 'https://memoro.test', token: 'broker-secret', machineId: 'machine',
      sourceId: 'cloud:cld_123456', sourceKind: 'cloud', sourceName: 'Cloud worker', cloudSessionId: 'cld_123456', codingSessionId: 'coding_123456',
      runtimeGeneration: 'rtg_0123456789abcdef', authorizationDigest: 'a'.repeat(64), cloudRuntime: true,
      bootstrapTicketProvider: async () => ({ ticket: 'ticket_four' }), WebSocketImpl: FakeWebSocket,
      request: async () => ({ ok: true, sessions: [] }), sessionRefreshIntervalMs: 0, sleepImpl: async () => {},
    });
    const unknownFatal = [];
    unknown.on('fatal', (event) => unknownFatal.push(event));
    unknown.start();
    await new Promise((resolve) => setImmediate(resolve));
    const unknownControl = FakeWebSocket.instances[3];
    unknownControl.open();
    unknownControl.message(JSON.stringify({ type: 'not_a_cloud_control_type', protocol_version: CONTROL_PROTOCOL_VERSION }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unknownFatal, [{ code: 'cloud_broker_control_type_invalid' }]);
  });

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
        capabilities: ['pty-stream-v1', 'resize-v1', 'screen-replay-v1', 'environment-status-v1'],
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

  test('forwards only validated session projection metadata to cloud inventory', async () => {
    resetFakeWs();
    const projection = {
      contract_version: 'mc-session-projection-v1',
      status: 'active',
      reason_code: 'tool_activity',
      observed_at: '2026-07-21T08:00:00.000Z',
      classifier_version: 'mc-session-projector-v1',
      classification_basis: 'structured_event',
      runtime: { lifecycle: 'live', observed_at: '2026-07-21T08:00:00.000Z' },
      git: null,
    };
    const client = new CloudBrokerClient({
      apiUrl: 'https://memoro.test',
      token: 'tok',
      machineId: 'machine',
      WebSocketImpl: FakeWebSocket,
      request: async () => ({
        ok: true,
        sessions: [
          {
            id: 'sess_valid',
            transcript_path: '/private/transcript-canary.jsonl',
            provider_sessions_dir: '/private/provider-sessions-canary',
            codex_artifact_capture: { cwd: '/private/worktree-canary' },
            provider_artifact: {
              provider_session_id: 'provider-id-canary',
              transcript_path: '/private/provider-artifact-canary.jsonl',
            },
            session_projection: projection,
          },
          { id: 'sess_invalid', session_projection: { ...projection, raw_output: 'secret' } },
        ],
      }),
      sleepImpl: async () => {},
    });

    client.start();
    const control = FakeWebSocket.instances[0];
    control.open();
    await new Promise((resolve) => setImmediate(resolve));

    const inventory = control.sent.map((value) => JSON.parse(value))
      .find((message) => message.type === 'sessions');
    assert.deepEqual(inventory.sessions[0].session_projection, projection);
    assert.equal(Object.hasOwn(inventory.sessions[1], 'session_projection'), false);
    assert.doesNotMatch(
      JSON.stringify(inventory),
      /secret|transcript-canary|provider-sessions-canary|worktree-canary|provider-id-canary|provider-artifact-canary/,
    );
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
      {
        type: 'stop_session',
        id: 'sess_a',
        signal: 'SIGHUP',
        session_controller_capability: controllerCapability,
      },
      {
        type: 'remove_session',
        id: 'sess_a',
        session_controller_capability: controllerCapability,
      },
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
      capabilities: ['pty-stream-v1', 'resize-v1', 'screen-replay-v1', 'environment-status-v1'],
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
      session_controller_capability: controllerCapability,
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
      session_controller_capability: controllerCapability,
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
      {
        type: 'session_status',
        id: 'sess_a',
      },
      {
        type: 'write_session',
        id: 'sess_a',
        data: 'ship it\r',
        session_controller_capability: controllerCapability,
      },
      {
        type: 'write_session',
        id: 'sess_a',
        data: '\r',
        session_controller_capability: controllerCapability,
      },
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
      {
        type: 'write_session',
        id: 'sess_a',
        data: 'ship it\r',
        session_controller_capability: controllerCapability,
      },
      {
        type: 'dispatch_session',
        id: 'sess_a',
        message: 'ship it',
        session_controller_capability: controllerCapability,
      },
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
      transcriptFinder: async () => null,
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
      session_controller_capability: controllerCapability,
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
      transcriptFinder: async () => null,
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

  test('discovers and parses the current tool transcript before using recent PTY output', async () => {
    resetFakeWs();
    const findCalls = [];
    const factoryCalls = [];
    const handlerCalls = [];
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
            output: 'raw terminal fallback',
            session: { id: 'sess_a', tool: 'codex', cwd: '/repo' },
          };
        }
        return { ok: false, error: `unexpected ${msg.type}` };
      },
      transcriptFinder: async (query) => {
        findCalls.push(query);
        return { path: '/tmp/discovered-codex.jsonl' };
      },
      fetchTranscriptHandlerFactory: (opts) => {
        factoryCalls.push(opts);
        return async (args) => {
          handlerCalls.push(args);
          return {
            source: opts.source,
            messages: [
              { role: 'user', content: 'Review this' },
              { role: 'assistant', content: 'Done' },
            ],
          };
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
      command_id: 'cmd_fetch_discovered',
      coding_session_id: 'sess_a',
      kind: 'fetch_transcript',
      args: { limit: 24 },
    }));
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(findCalls, [{ source: 'codex', cwd: '/repo' }]);
    assert.deepEqual(factoryCalls, [{
      transcriptPath: '/tmp/discovered-codex.jsonl',
      source: 'codex',
    }]);
    assert.deepEqual(handlerCalls, [{ limit: 24 }]);
    const result = JSON.parse(control.sent.at(-1));
    assert.equal(result.ok, true);
    assert.deepEqual(result.data.messages, [
      { role: 'user', content: 'Review this' },
      { role: 'assistant', content: 'Done' },
    ]);
    assert.equal(result.data.fallback, undefined);

    control.message(JSON.stringify({
      type: 'command',
      command_id: 'cmd_fetch_discovered_again',
      coding_session_id: 'sess_a',
      kind: 'fetch_transcript',
      args: { limit: 24 },
    }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(findCalls.length, 1);
    assert.equal(factoryCalls.length, 1);
    client.stop();
  });

  test('handles fetch_environment_status from runtime status files without exposing secrets', async () => {
    resetFakeWs();
    const dir = mkdtempSync(join(tmpdir(), 'mc-cloud-status-'));
    const manifestPath = join(dir, 'manifest.json');
    const statusPath = join(dir, 'status.json');
    const readinessPath = join(dir, 'readiness.json');
    writeFileSync(manifestPath, JSON.stringify({
      contract_version: 'mc-cloud-runtime-v1',
      cloud_session_id: 'cld_status123',
      coding_session_id: 'sess_a',
      source: { id: 'cloud:cld_status123', name: 'Cloud sandbox' },
      repo: {
        id: 'repo_1',
        ref: 'https://github.com/example/repo.git',
        workspace_ref: 'main',
        access: 'private',
        credential_source: 'repo_grant',
        token: 'secret-token',
      },
      launch: { tool: 'codex', policy: 'workspace-write', name: 'Status check' },
      coding_bin_id: 'cbin_status123',
      coding_bin: {
        id: 'cbin_status123',
        root: '/workspace/repo',
        snapshot: { enabled: true },
        latest_snapshot: { id: 'cbsnap_ready123', file_count: 2, byte_count: 99, skipped_count: 1 },
      },
    }));
    writeFileSync(statusPath, JSON.stringify({
      phase: 'ready',
      runtime_state: 'ready',
      process_status: 'running',
      coding_bin_id: 'cbin_status123',
      coding_bin_snapshot_id: 'cbsnap_ready123',
      coding_bin_snapshot: {
        id: 'cbsnap_ready123',
        status: 'ready',
        storageKey: 'secret-storage-key',
        fileCount: 2,
        byteCount: 99,
        skippedCount: 1,
      },
      access_token: 'secret-status-token',
    }));
    writeFileSync(readinessPath, JSON.stringify({
      ready: true,
      repo: { ready: true, cwd: '/workspace/repo' },
      git_auth: {
        ready: true,
        access: 'private',
        grant_kind: 'github_oauth',
        credential_source: 'repo_grant',
        credential: 'secret-credential',
      },
      tool_auth: {
        tool: 'codex',
        mode: 'vault',
        hydrated: true,
        auth_json: 'secret-auth-json',
        error: 'provider returned Bearer opaque-broker-canary-123',
      },
      coding_bin: {
        id: 'cbin_status123',
        root: '/workspace/repo',
        snapshot_policy_enabled: true,
        latest_snapshot_id: 'cbsnap_ready123',
        ready: true,
        secret_boundary: 'status_only',
      },
    }));
    const client = new CloudBrokerClient({
      apiUrl: 'https://memoro.test',
      token: 'tok',
      machineId: 'machine',
      sourceId: 'cloud:cld_status123',
      sourceKind: 'cloud',
      sourceName: 'Cloud sandbox',
      cloudSessionId: 'cld_status123',
      WebSocketImpl: FakeWebSocket,
      env: {
        MC_CLOUD_RUNTIME_MANIFEST: manifestPath,
        MC_CLOUD_RUNTIME_STATUS: statusPath,
        MC_CLOUD_RUNTIME_READINESS: readinessPath,
      },
      request: async (msg) => {
        if (msg.type === 'sessions') return { ok: true, sessions: [] };
        if (msg.type === 'session_status') {
          return { ok: true, session: { id: 'sess_a', tool: 'codex', cwd: '/workspace/repo' } };
        }
        return { ok: false, error: `unexpected ${msg.type}` };
      },
      sessionRefreshIntervalMs: 0,
      sleepImpl: async () => {},
    });

    try {
      client.start();
      const control = FakeWebSocket.instances[0];
      control.open();
      await new Promise((resolve) => setImmediate(resolve));
      control.message(JSON.stringify({
        type: 'command',
        command_id: 'cmd_env',
        coding_session_id: 'sess_a',
        kind: 'fetch_environment_status',
        args: { scope: 'all' },
      }));
      await new Promise((resolve) => setImmediate(resolve));

      const result = JSON.parse(control.sent.at(-1));
      assert.equal(result.type, 'result');
      assert.equal(result.command_id, 'cmd_env');
      assert.equal(result.ok, true);
      assert.equal(result.data.runtime.live, true);
      assert.equal(result.data.commands.status, true);
      assert.equal(result.data.commands.transcript, true);
      assert.equal(result.data.repo.ready, true);
      assert.equal(result.data.repo.credential_source, 'repo_grant');
      assert.equal(result.data.vault.exposes_secrets_to_llm, false);
      assert.equal(result.data.tool_auth.ready, true);
      assert.equal(result.data.coding_bin.id, 'cbin_status123');
      assert.equal(result.data.coding_bin.latest_snapshot_id, 'cbsnap_ready123');
      assert.equal(result.data.coding_bin.snapshot_policy_enabled, true);
      assert.equal(result.data.coding_bin.snapshot_status, 'ready');
      assert.equal(result.data.coding_bin.snapshot_ready, true);
      assert.equal(result.data.coding_bin.file_count, 2);
      assert.equal(result.data.coding_bin.byte_count, 99);
      assert.equal(result.data.cloud_session.id, 'cld_status123');
      assert.doesNotMatch(JSON.stringify(result.data), /secret-/);
      assert.doesNotMatch(JSON.stringify(result.data), /opaque-broker-canary-123/);
    } finally {
      client.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('maps fetch_environment_status commands from runtime phase semantics', async () => {
    const cases = [
      { phase: 'ready', live: true, wakeable: false, canContinue: true, action: 'live', commandReady: true },
      { phase: 'broker_connecting', live: false, wakeable: false, canContinue: true, action: 'wait', commandReady: false },
      { phase: 'runtime_pending', live: false, wakeable: true, canContinue: true, action: 'wake', commandReady: false },
      { phase: 'sleeping', live: false, wakeable: true, canContinue: true, action: 'wake', commandReady: false },
      { phase: 'failed', live: false, wakeable: false, canContinue: false, action: null, commandReady: false },
    ];

    for (const item of cases) {
      resetFakeWs();
      const dir = mkdtempSync(join(tmpdir(), 'mc-cloud-phase-status-'));
      const manifestPath = join(dir, 'manifest.json');
      const statusPath = join(dir, 'status.json');
      const readinessPath = join(dir, 'readiness.json');
      writeFileSync(manifestPath, JSON.stringify({
        contract_version: 'mc-cloud-runtime-v1',
        cloud_session_id: `cld_${item.phase.replace(/[^a-z0-9]/g, '')}1`,
        coding_session_id: 'sess_phase',
        repo: { id: 'repo_1', ref: 'example/repo', access: 'public_clone' },
        launch: { tool: 'codex', policy: 'workspace-write', name: 'Phase check' },
      }));
      writeFileSync(statusPath, JSON.stringify({
        phase: item.phase,
        runtime_state: item.phase,
        process_status: item.live ? 'running' : null,
      }));
      writeFileSync(readinessPath, JSON.stringify({
        ready: item.live,
        repo: { ready: true, cwd: '/workspace/repo' },
        git_auth: { ready: true, access: 'public_clone', secret_boundary: 'status_only' },
        tool_auth: { tool: 'codex', mode: 'vault', hydrated: item.live },
      }));
      const client = new CloudBrokerClient({
        apiUrl: 'https://memoro.test',
        token: 'tok',
        machineId: 'machine',
        sourceId: `cloud:${item.phase}`,
        sourceKind: 'cloud',
        sourceName: 'Cloud sandbox',
        cloudSessionId: `cld_${item.phase.replace(/[^a-z0-9]/g, '')}1`,
        WebSocketImpl: FakeWebSocket,
        env: {
          MC_CLOUD_RUNTIME_MANIFEST: manifestPath,
          MC_CLOUD_RUNTIME_STATUS: statusPath,
          MC_CLOUD_RUNTIME_READINESS: readinessPath,
        },
        request: async (msg) => {
          if (msg.type === 'sessions') return { ok: true, sessions: [] };
          if (msg.type === 'session_status') return { ok: true, session: { id: 'sess_phase', tool: 'codex' } };
          return { ok: false, error: `unexpected ${msg.type}` };
        },
        sessionRefreshIntervalMs: 0,
        sleepImpl: async () => {},
      });

      try {
        client.start();
        const control = FakeWebSocket.instances[0];
        control.open();
        await new Promise((resolve) => setImmediate(resolve));
        control.message(JSON.stringify({
          type: 'command',
          command_id: `cmd_${item.phase}`,
          coding_session_id: 'sess_phase',
          kind: 'fetch_environment_status',
          args: { scope: 'all' },
        }));
        await new Promise((resolve) => setImmediate(resolve));

        const result = JSON.parse(control.sent.at(-1));
        assert.equal(result.ok, true, item.phase);
        assert.equal(result.data.runtime.phase, item.phase);
        assert.equal(result.data.runtime.live, item.live, item.phase);
        assert.equal(result.data.runtime.wakeable, item.wakeable, item.phase);
        assert.equal(result.data.runtime.can_continue, item.canContinue, item.phase);
        assert.equal(result.data.runtime.continue_action, item.action, item.phase);
        assert.equal(result.data.commands.transcript, item.commandReady, item.phase);
        assert.equal(result.data.commands.message, item.commandReady, item.phase);
      } finally {
        client.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    }
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
      controllerCapability,
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
      controllerCapability,
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
