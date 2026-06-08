import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { afterEach, describe } from 'node:test';

import { BrokerSessionSidecars, postHeartbeatWithRetry } from '../../../src/mc/broker/session-sidecars.js';

let tmp = null;

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

describe('BrokerSessionSidecars', () => {
  test('writes metadata, handles local dispatch, and cleans up files', () => {
    const paths = tempPaths();
    const session = makeSession();
    const sidecars = new BrokerSessionSidecars({
      session,
      coding: {
        codingSessionId: 'sess_a',
        label: 'alpha',
        repo: 'repo',
        branch: 'main',
        metaPath: paths.metaPath,
        sockPath: paths.sockPath,
        heartbeat: false,
      },
      createServerImpl: fakeCreateServer,
      now: () => 2_000,
    }).start();

    assert.equal(existsSync(paths.metaPath), true);
    const meta = JSON.parse(readFileSync(paths.metaPath, 'utf8'));
    assert.equal(meta.coding_session_id, 'sess_a');
    assert.equal(meta.label, 'alpha');
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

  test('starts WS dispatch handler and heartbeat loop with current PTY excerpt', async () => {
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
        branch: 'main',
        label: 'alpha',
        metaPath: paths.metaPath,
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
    assert.equal(heartbeats[0].opts.body.last_assistant_excerpt, 'ready\n');
    assert.equal(heartbeats[0].opts.body.idle_seconds, 1);

    sidecars.stop();
    assert.equal(wsClients[0].stopped, true);
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
