import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import test, { afterEach, describe } from 'node:test';

import {
  BrokerSessionSidecars,
  buildSessionHeartbeatPayload,
  postHeartbeatWithRetry,
} from '../../../src/mc/broker/session-sidecars.js';
import {
  MC_GITHUB_BROKER_SOCKET_ENV,
  executeGitHubSessionOperation,
} from '../../../src/mc/github-session.js';

let tmp = null;
const SESSION_CAPABILITIES = {
  schema: 1,
  github: {
    state: 'ready',
    transport: 'mc-broker-v1',
    actor: 'installation',
    account: 'acme',
    repository: {
      id: 301,
      full_name: 'acme/widgets',
      owner: 'acme',
      name: 'widgets',
      private: true,
      archived: false,
      account: 'acme',
    },
    operations: ['connection.status', 'repository.metadata', 'pull_request.list'],
  },
};

afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  }
});

function tempPaths() {
  tmp = mkdtempSync(join(tmpdir(), 'mc-session-sidecars-'));
  return {
    metaPath: join(tmp, 'sess_a.json'),
    sockPath: join(tmp, 'sess_a.sock'),
  };
}

function makeSession() {
  return {
    cwd: '/repo',
    lastOutputAt: 1_000,
    dispatched: [],
    writeDispatchedMessage(message) { this.dispatched.push(message); },
    recentOutput() { return '\x1b[31mready\x1b[0m\n'; },
  };
}

function grantClient(sourceId = 'local:device:test') {
  return {
    withGrant: async (_provider, request, use) => use({
      token: 'short-lived-grant-sentinel',
      apiUrl: 'https://memoro.test',
      source: {
        id: sourceId,
        kind: sourceId.startsWith('cloud:') ? 'cloud' : 'local',
      },
      codingSessionId: request.codingSessionId,
    }),
  };
}

function fakeCreateServer(handler) {
  const server = new EventEmitter();
  server.handler = handler;
  server.listening = false;
  server.listen = (path, cb) => {
    server.path = path;
    server.listening = true;
    cb?.();
  };
  server.close = (cb) => {
    server.listening = false;
    cb?.();
  };
  return server;
}

function fakeConn() {
  const conn = new EventEmitter();
  conn.ended = [];
  conn.end = (value) => { conn.ended.push(value); };
  return conn;
}

async function startRealGitHubSidecar({ paths, memoroFetchImpl }) {
  const sidecars = new BrokerSessionSidecars({
    session: makeSession(),
    coding: {
      codingSessionId: 'sess_abcdef',
      apiUrl: 'https://memoro.test',
      token: 'memoro-secret-sentinel',
      sourceId: 'local:mac',
      sourceKind: 'local',
      sockPath: paths.sockPath,
      metaPath: paths.metaPath,
      heartbeat: false,
      upload: false,
    },
    wsClientFactory: () => ({ start() {}, stop() {} }),
    connectionClient: grantClient(),
    memoroFetchImpl,
  }).start();
  if (!sidecars.dispatchServer.listening) await once(sidecars.dispatchServer, 'listening');
  return sidecars;
}

async function startRealManagedGitHubSidecar({
  paths,
  memoroFetchImpl,
  connectionClient = grantClient(),
}) {
  const factoryCalls = [];
  const sidecars = new BrokerSessionSidecars({
    session: makeSession(),
    coding: {
      codingSessionId: 'sess_managed',
      githubCapabilities: SESSION_CAPABILITIES,
      sockPath: paths.sockPath,
      metaPath: paths.metaPath,
      heartbeat: false,
      upload: false,
    },
    wsClientFactory: () => ({ start() {}, stop() {} }),
    connectionClientFactory: (options) => {
      factoryCalls.push(options);
      return connectionClient;
    },
    memoroFetchImpl,
  }).start();
  if (!sidecars.dispatchServer.listening) await once(sidecars.dispatchServer, 'listening');
  return { sidecars, factoryCalls };
}

describe('BrokerSessionSidecars', () => {
  test('managed GitHub capability creates broker-local identity without launch credentials', () => {
    let factoryOptions = null;
    const localClient = grantClient();
    const sidecars = new BrokerSessionSidecars({
      session: makeSession(),
      coding: {
        codingSessionId: 'sess_managed',
        githubCapabilities: SESSION_CAPABILITIES,
        heartbeat: false,
        upload: false,
      },
      connectionClientFactory: (options) => {
        factoryOptions = options;
        return localClient;
      },
    });

    assert.equal(sidecars.connectionClient, localClient);
    assert.equal(factoryOptions.memoroFetch instanceof Function, true);
    assert.equal('token' in factoryOptions, false);
    assert.equal('apiUrl' in factoryOptions, false);
    assert.doesNotMatch(JSON.stringify(sidecars.coding), /token|credential/i);
  });

  test('managed presence uses broker-local identity for active and terminal lifecycle writes', async () => {
    const requests = [];
    const generation = '4f50f5a1-4c6b-4d6a-8b5c-152c5e6b8701';
    const sidecars = new BrokerSessionSidecars({
      session: makeSession(),
      coding: {
        codingSessionId: 'sess_managed_presence',
        runtimeGeneration: generation,
        label: 'managed',
        machineId: 'machine',
        source_id: 'local:machine',
        source_kind: 'local',
        source_name: 'machine',
        cloud_session_id: null,
        source: 'codex',
        repo: 'widgets',
        repoRef: 'acme/widgets',
        branch: 'main',
        presenceIdentity: 'broker-local',
        heartbeat: true,
        upload: false,
      },
      wsClientFactory: () => ({ start() {}, stop() {} }),
      localPresencePublisher: async (request) => {
        requests.push(request);
        return true;
      },
      now: () => 2_500,
      heartbeatIntervalMs: null,
    }).start();

    await sidecars.heartbeatPromise;
    await sidecars.stop({ terminal: true });

    assert.equal(requests.length, 2);
    assert.equal(requests[0].payload.presence_state, 'active');
    assert.equal(requests[1].payload.presence_state, 'terminal');
    assert.equal(requests[1].payload.runtime_generation, generation);
    assert.equal(requests[1].payload.repo, 'acme/widgets');
    assert.equal(requests[0].maxAttempts, 3);
    assert.equal(requests[1].maxAttempts, 1);
    assert.equal('token' in requests[0], false);
    assert.equal('apiUrl' in requests[0], false);
    assert.doesNotMatch(JSON.stringify(sidecars.coding), /memoro-secret|apiUrl/i);
  });

  test('managed capability executes over the real socket with broker-local identity only', async (t) => {
    const paths = tempPaths();
    const requests = [];
    const { sidecars, factoryCalls } = await startRealManagedGitHubSidecar({
      paths,
      memoroFetchImpl: async (apiUrl, path, options) => {
        requests.push({ apiUrl, path, options });
        return {
          ok: true,
          request_id: options.body.request_id,
          data: { id: 301, full_name: 'acme/widgets' },
        };
      },
    });
    t.after(() => sidecars.stop());

    const response = await executeGitHubSessionOperation({
      operation: 'repository.metadata',
      requestId: 'request_managed',
      env: { [MC_GITHUB_BROKER_SOCKET_ENV]: paths.sockPath },
    });

    assert.deepEqual(response, {
      ok: true,
      request_id: 'request_managed',
      data: { id: 301, full_name: 'acme/widgets' },
    });
    assert.equal(factoryCalls.length, 1);
    assert.equal('token' in factoryCalls[0], false);
    assert.equal('apiUrl' in factoryCalls[0], false);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].path, '/api/mc/github/sessions/sess_managed/operations');
    assert.equal(requests[0].options.token, 'short-lived-grant-sentinel');
    assert.doesNotMatch(JSON.stringify(sidecars.coding), /token|credential|apiUrl/i);
  });

  test('managed socket rejects operations absent from its exact descriptor before identity use', async (t) => {
    const paths = tempPaths();
    let grantCalls = 0;
    const { sidecars } = await startRealManagedGitHubSidecar({
      paths,
      connectionClient: {
        withGrant: async () => {
          grantCalls += 1;
          assert.fail('an unadvertised operation must not reach broker identity');
        },
      },
      memoroFetchImpl: async () => assert.fail('an unadvertised operation must not reach the network'),
    });
    t.after(() => sidecars.stop());

    const response = await executeGitHubSessionOperation({
      operation: 'pull_request.create',
      params: {
        title: 'Denied',
        body: '',
        head: 'feature',
        base: 'main',
        draft: true,
        expected_head_sha: 'a'.repeat(40),
        expected_base_sha: 'b'.repeat(40),
      },
      requestId: 'request_denied',
      env: { [MC_GITHUB_BROKER_SOCKET_ENV]: paths.sockPath },
    });

    assert.equal(response.ok, false);
    assert.equal(response.request_id, 'request_denied');
    assert.equal(response.error.code, 'operation_not_allowed');
    assert.equal(grantCalls, 0);
  });

  test('builds the shared credential-free session heartbeat envelope', () => {
    const payload = buildSessionHeartbeatPayload({
      codingSessionId: 'sess_abcdef',
      machineId: 'machine',
      sourceIdentity: {
        source_id: 'local:machine',
        source_kind: 'local',
        source_name: 'machine',
        cloud_session_id: null,
        token: 'must-not-leak',
        installation_id: 123,
      },
      source: 'codex',
      repo: 'widgets',
      branch: 'main',
      idleSeconds: 3,
      at: '2026-07-23T10:00:00.000Z',
      sessionProjection: { contract_version: 'mc-session-projection-v1' },
      label: 'feature',
    });
    assert.equal(JSON.stringify(payload).includes('must-not-leak'), false);
    assert.equal('installation_id' in payload, false);

    assert.deepEqual(payload, {
      coding_session_id: 'sess_abcdef',
      machine_id: 'machine',
      source_id: 'local:machine',
      source_kind: 'local',
      source_name: 'machine',
      cloud_session_id: null,
      source: 'codex',
      repo: 'widgets',
      branch: 'main',
      idle_seconds: 3,
      at: '2026-07-23T10:00:00.000Z',
      session_projection: { contract_version: 'mc-session-projection-v1' },
      label: 'feature',
    });
  });

  test('handoff boundary omits transcript fetch capability from the cloud sidecar', () => {
    const paths = tempPaths();
    let wsOptions = null;
    const sidecars = new BrokerSessionSidecars({
      session: makeSession(),
      coding: {
        codingSessionId: 'sess_handoff',
        apiUrl: 'https://memoro.test',
        token: 'memoro-secret-sentinel',
        source: 'codex',
        transcriptPath: '/private/source-transcript-canary.jsonl',
        transcriptAccess: false,
        sockPath: paths.sockPath,
        metaPath: paths.metaPath,
        heartbeat: false,
        upload: false,
      },
      createServerImpl: fakeCreateServer,
      wsClientFactory: (opts) => {
        wsOptions = opts;
        return { start() {}, stop() {} };
      },
      fetchTranscriptHandlerFactory: () => {
        assert.fail('handoff boundary must not construct a transcript reader');
      },
      connectionClient: grantClient(),
    }).start();

    assert.equal('fetch_transcript' in wsOptions.handlers, false);
    assert.equal(typeof wsOptions.handlers.dispatch_message, 'function');
    sidecars.stop();
  });

  test('default GitHub request IDs reach trusted execution over the real session socket', async (t) => {
    const paths = tempPaths();
    const requests = [];
    const sidecars = await startRealGitHubSidecar({
      paths,
      memoroFetchImpl: async (_apiUrl, _path, options) => {
        requests.push(options.body);
        return {
          ok: true,
          request_id: options.body.request_id,
          data: { id: 301, full_name: 'acme/widgets' },
        };
      },
    });
    t.after(() => sidecars.stop());

    const response = await executeGitHubSessionOperation({
      operation: 'repository.metadata',
      env: { [MC_GITHUB_BROKER_SOCKET_ENV]: paths.sockPath },
    });

    assert.equal(requests.length, 1);
    assert.equal(response.ok, true);
    assert.match(response.request_id, /^mcr_[a-f0-9]{24}$/);
    assert.equal(requests[0].request_id, response.request_id);
  });

  test('real session socket awaits a bounded asynchronous control-plane response', async (t) => {
    const paths = tempPaths();
    const requests = [];
    const sidecars = await startRealGitHubSidecar({
      paths,
      memoroFetchImpl: async (_apiUrl, _path, options) => {
        await sleep(1_100);
        requests.push(options.body);
        return {
          ok: true,
          request_id: options.body.request_id,
          data: { number: 42, title: 'Delayed but bounded' },
        };
      },
    });
    t.after(() => sidecars.stop());

    const response = await executeGitHubSessionOperation({
      operation: 'pull_request.view',
      params: { pull_number: 42 },
      requestId: 'request_delayed',
      env: { [MC_GITHUB_BROKER_SOCKET_ENV]: paths.sockPath },
    });

    assert.equal(requests.length, 1);
    assert.deepEqual(response, {
      ok: true,
      request_id: 'request_delayed',
      data: { number: 42, title: 'Delayed but bounded' },
    });
  });

  test('executes canonical GitHub operations outside the child with server-bound identity', async () => {
    const paths = tempPaths();
    const requests = [];
    const sidecars = new BrokerSessionSidecars({
      session: makeSession(),
      coding: {
        codingSessionId: 'sess_abcdef',
        apiUrl: 'https://memoro.test',
        token: 'memoro-secret-sentinel',
        sourceId: 'cloud:cld_123456',
        sourceKind: 'cloud',
        cloudSessionId: 'cld_123456',
        sockPath: paths.sockPath,
        metaPath: paths.metaPath,
        heartbeat: false,
        upload: false,
      },
      createServerImpl: fakeCreateServer,
      wsClientFactory: () => ({ start() {}, stop() {} }),
      connectionClient: grantClient('cloud:cld_123456'),
      memoroFetchImpl: async (apiUrl, path, options) => {
        requests.push({ apiUrl, path, options });
        return {
          ok: true,
          request_id: options.body.request_id,
          data: { pull_requests: [{ number: 7, title: 'Cloud works' }] },
        };
      },
    }).start();

    const conn = fakeConn();
    sidecars.dispatchServer.handler(conn);
    conn.emit('data', Buffer.from(JSON.stringify({
      type: 'github_operation',
      schema: 1,
      request_id: 'request_abcdefgh',
      operation: 'pull_request.list',
      params: { state: 'open', limit: 10 },
    })));
    conn.emit('end');
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(requests.length, 1);
    assert.equal(requests[0].path, '/api/mc/github/sessions/sess_abcdef/operations');
    assert.equal(requests[0].options.sourceId, undefined);
    assert.equal(requests[0].options.token, 'short-lived-grant-sentinel');
    assert.equal('source_id' in requests[0].options.body, false);
    assert.equal('coding_session_id' in requests[0].options.body, false);
    assert.equal('repository' in requests[0].options.body, false);
    const output = conn.ended.join('');
    assert.deepEqual(JSON.parse(output), {
      ok: true,
      request_id: 'request_abcdefgh',
      data: { pull_requests: [{ number: 7, title: 'Cloud works' }] },
    });
    assert.equal(output.includes('memoro-secret-sentinel'), false);
    sidecars.stop();
  });

  test('refuses source/repository/session spoofing before trusted network access', async () => {
    const paths = tempPaths();
    let networkCalls = 0;
    const sidecars = new BrokerSessionSidecars({
      session: makeSession(),
      coding: {
        codingSessionId: 'sess_abcdef',
        apiUrl: 'https://memoro.test',
        token: 'memoro-secret-sentinel',
        sourceId: 'local:mac',
        sourceKind: 'local',
        sockPath: paths.sockPath,
        metaPath: paths.metaPath,
        heartbeat: false,
        upload: false,
      },
      createServerImpl: fakeCreateServer,
      wsClientFactory: () => ({ start() {}, stop() {} }),
      connectionClient: grantClient(),
      memoroFetchImpl: async () => { networkCalls += 1; },
    }).start();

    for (const extra of [
      { source_id: 'cloud:other' },
      { coding_session_id: 'sess_other' },
      { repository: 'acme/other' },
      { url: 'https://api.github.com/user' },
      { headers: { authorization: 'secret' } },
    ]) {
      const conn = fakeConn();
      sidecars.dispatchServer.handler(conn);
      conn.emit('data', Buffer.from(JSON.stringify({
        type: 'github_operation',
        schema: 1,
        request_id: 'request_abcdefgh',
        operation: 'repository.metadata',
        params: {},
        ...extra,
      })));
      conn.emit('end');
      await new Promise((resolve) => setImmediate(resolve));
      const response = JSON.parse(conn.ended.join(''));
      assert.equal(response.ok, false);
      assert.equal(response.error.code, 'invalid_params');
      assert.equal(JSON.stringify(response).includes('secret'), false);
    }
    assert.equal(networkCalls, 0);

    const unknown = fakeConn();
    sidecars.dispatchServer.handler(unknown);
    unknown.emit('data', Buffer.from(JSON.stringify({
      type: 'github_operation',
      schema: 1,
      request_id: 'request_abcdefgh',
      operation: 'issue.create',
      params: {},
    })));
    unknown.emit('end');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(JSON.parse(unknown.ended.join('')).error.code, 'operation_not_allowed');
    assert.equal(networkCalls, 0);
    sidecars.stop();
  });

  test('writes metadata, handles local dispatch, and cleans up files', () => {
    const paths = tempPaths();
    const session = makeSession();
    const sidecars = new BrokerSessionSidecars({
      session,
      coding: {
        codingSessionId: 'sess_a',
        label: 'alpha',
        tool: 'codex',
        toolSessionId: 'cx_abc',
        transcriptPath: '/tmp/codex.jsonl',
        repo: 'repo',
        branch: 'main',
        metaPath: paths.metaPath,
        sockPath: paths.sockPath,
        heartbeat: false,
        upload: false,
      },
      createServerImpl: fakeCreateServer,
      now: () => 2_000,
    }).start();

    assert.equal(existsSync(paths.metaPath), true);
    const meta = JSON.parse(readFileSync(paths.metaPath, 'utf8'));
    assert.equal(meta.runtime_manifest_version, 1);
    assert.equal(meta.cleanup_owner, 'mc');
    assert.equal(meta.coding_session_id, 'sess_a');
    assert.equal(meta.label, 'alpha');
    assert.equal(meta.tool, 'codex');
    assert.equal(meta.source, 'codex');
    assert.equal(meta.tool_session_id, 'cx_abc');
    assert.equal(meta.tool_transcript_path, '/tmp/codex.jsonl');
    assert.equal(meta.broker_owned, true);
    assert.equal(sidecars.dispatchServer.path, paths.sockPath);

    const conn = fakeConn();
    sidecars.dispatchServer.handler(conn);
    conn.emit('data', Buffer.from('{"message":"hello"}'));
    conn.emit('end');

    assert.deepEqual(session.dispatched, ['hello']);
    assert.deepEqual(JSON.parse(conn.ended[0]), { ok: true, message: 'hello' });

    sidecars.stop();
    assert.equal(sidecars.dispatchServer.listening, false);
    assert.equal(existsSync(paths.metaPath), false);
    assert.equal(existsSync(paths.sockPath), false);
  });

  test('starts WS dispatch handler and a metadata-only heartbeat loop', async () => {
    const paths = tempPaths();
    const session = makeSession();
    const wsClients = [];
    const heartbeats = [];

    const sidecars = new BrokerSessionSidecars({
      session,
      coding: {
        codingSessionId: 'sess_a',
        apiUrl: 'https://memoro.test',
        token: 'tok',
        machineId: 'machine',
        source: 'claude-code',
        repo: 'repo',
        repoRef: 'acme/repo',
        branch: 'main',
        label: 'alpha',
        metaPath: paths.metaPath,
        upload: false,
      },
      wsClientFactory: (opts) => {
        const client = {
          opts,
          started: false,
          stopped: false,
          start() { this.started = true; },
          stop() { this.stopped = true; },
        };
        wsClients.push(client);
        return client;
      },
      memoroFetchImpl: async (apiUrl, path, opts) => {
        heartbeats.push({ apiUrl, path, opts });
        return { ok: true };
      },
      sleepImpl: async () => {},
      now: () => 2_500,
      heartbeatIntervalMs: null,
    }).start();

    assert.equal(wsClients.length, 1);
    assert.equal(wsClients[0].started, true);
    await wsClients[0].opts.handlers.dispatch_message({ message: 'remote prompt' });
    assert.deepEqual(session.dispatched, ['remote prompt']);

    await sidecars.heartbeatPromise;
    assert.equal(heartbeats.length, 1);
    assert.equal(heartbeats[0].apiUrl, 'https://memoro.test');
    assert.equal(heartbeats[0].path, '/api/sessions/heartbeat');
    assert.equal(heartbeats[0].opts.token, 'tok');
    assert.equal(heartbeats[0].opts.body.coding_session_id, 'sess_a');
    assert.equal(heartbeats[0].opts.body.machine_id, 'machine');
    assert.equal(heartbeats[0].opts.body.source_id, 'local:machine');
    assert.equal(heartbeats[0].opts.body.repo, 'acme/repo');
    assert.equal('last_assistant_excerpt' in heartbeats[0].opts.body, false);
    assert.equal('last_user_excerpt' in heartbeats[0].opts.body, false);
    assert.equal(heartbeats[0].opts.body.idle_seconds, 1);
    assert.equal(heartbeats[0].opts.body.session_projection.contract_version, 'mc-session-projection-v1');
    assert.equal(Object.hasOwn(heartbeats[0].opts.body.session_projection, 'raw_output'), false);

    sidecars.stop();
    assert.equal(wsClients[0].stopped, true);
  });

  test('publishes one metadata-only terminal presence for the exact runtime generation', async () => {
    const paths = tempPaths();
    const session = makeSession();
    const requests = [];
    const generation = '4f50f5a1-4c6b-4d6a-8b5c-152c5e6b8701';
    const sidecars = new BrokerSessionSidecars({
      session,
      coding: {
        codingSessionId: 'sess_terminal',
        runtimeGeneration: generation,
        apiUrl: 'https://memoro.test',
        token: 'memoro-secret-sentinel',
        machineId: 'machine',
        sourceId: 'local:machine',
        sourceKind: 'local',
        source: 'codex',
        repoRef: 'acme/repo',
        branch: 'main',
        metaPath: paths.metaPath,
        upload: false,
      },
      wsClientFactory: () => ({ start() {}, stop() {} }),
      memoroFetchImpl: async (_apiUrl, path, options) => {
        requests.push({ path, options });
        return { ok: true };
      },
      now: () => 2_500,
      heartbeatIntervalMs: null,
    }).start();

    await sidecars.heartbeatPromise;
    session.exit = { code: 0, signal: null, at: '1970-01-01T00:00:02.500Z' };
    await sidecars.stop({ terminal: true });

    assert.equal(requests.length, 2);
    assert.equal(requests[0].options.body.presence_state, 'active');
    assert.equal(requests[0].options.body.runtime_generation, generation);
    const terminal = requests[1].options.body;
    assert.deepEqual(Object.keys(terminal).sort(), [
      'at',
      'branch',
      'cloud_session_id',
      'coding_session_id',
      'idle_seconds',
      'machine_id',
      'presence_state',
      'repo',
      'runtime_generation',
      'source',
      'source_id',
      'source_kind',
      'source_name',
    ]);
    assert.equal(terminal.presence_state, 'terminal');
    assert.equal(terminal.runtime_generation, generation);
    assert.equal(terminal.coding_session_id, 'sess_terminal');
    assert.equal(JSON.stringify(terminal).includes('memoro-secret-sentinel'), false);
    assert.equal(JSON.stringify(terminal).includes('ready'), false);
    assert.equal('session_projection' in terminal, false);
    assert.equal('last_assistant_excerpt' in terminal, false);
  });

  test('falls back to Codex source when sidecar source is omitted', async () => {
    const paths = tempPaths();
    const session = makeSession();
    const wsClients = [];
    const fetchTranscriptCalls = [];
    const heartbeats = [];
    const uploads = [];

    const sidecars = new BrokerSessionSidecars({
      session,
      coding: {
        codingSessionId: 'sess_codex',
        apiUrl: 'https://memoro.test',
        token: 'tok',
        machineId: 'machine',
        tool: 'codex',
        repo: 'repo',
        branch: 'main',
        metaPath: paths.metaPath,
      },
      fetchTranscriptHandlerFactory: (opts) => {
        fetchTranscriptCalls.push(opts);
        return async () => ({ ok: true });
      },
      wsClientFactory: (opts) => {
        const client = {
          opts,
          start() {},
          stop() {},
        };
        wsClients.push(client);
        return client;
      },
      memoroFetchImpl: async (apiUrl, path, opts) => {
        heartbeats.push({ apiUrl, path, opts });
        return { ok: true };
      },
      sessionUploadScheduler: async (opts) => {
        uploads.push(opts);
      },
      sleepImpl: async () => {},
      now: () => 2_500,
      heartbeatIntervalMs: null,
    }).start();

    await sidecars.heartbeatPromise;
    await sidecars._scheduleUpload();

    assert.equal(fetchTranscriptCalls[0].source, 'codex');
    assert.equal(heartbeats[0].opts.body.source, 'codex');
    assert.equal(uploads[0].source, 'codex');
    assert.equal(uploads[0].codingSessionId, 'sess_codex');
  });

  test('postHeartbeatWithRetry retries then reports failure', async () => {
    const sleeps = [];
    let attempts = 0;
    const ok = await postHeartbeatWithRetry({
      apiUrl: 'https://memoro.test',
      token: 'tok',
      payload: { coding_session_id: 'sess_a' },
      maxAttempts: 3,
      retryIntervalMs: 25,
      memoroFetchImpl: async () => {
        attempts += 1;
        throw new Error('offline');
      },
      sleepImpl: async (ms) => { sleeps.push(ms); },
    });

    assert.equal(ok, false);
    assert.equal(attempts, 3);
    assert.deepEqual(sleeps, [25, 25]);
  });
});
