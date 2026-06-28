import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { afterEach, describe } from 'node:test';

import {
  BROKER_PROTOCOL_VERSION,
  handleBrokerMessage,
  startBrokerServer,
} from '../../../src/mc/broker/daemon.js';

let tmp = null;
let state = null;

function paths() {
  tmp = mkdtempSync(join(tmpdir(), 'mc-broker-daemon-'));
  return {
    socketPath: join(tmp, 'broker.sock'),
    pidPath: join(tmp, 'broker.pid'),
  };
}

function fakeCreateServer(handler) {
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

afterEach(async () => {
  if (state) {
    await state.stop().catch(() => {});
    state = null;
  }
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  }
});

describe('handleBrokerMessage', () => {
  test('returns status for status and ping', () => {
    const status = () => ({ ok: true, broker: { pid: 123 } });

    assert.deepEqual(handleBrokerMessage('{"type":"status"}', { status }).response, {
      ok: true,
      broker: { pid: 123 },
    });
    assert.deepEqual(handleBrokerMessage('{"type":"ping"}', { status }).response, {
      ok: true,
      broker: { pid: 123 },
    });
  });

  test('returns structured errors for bad input', () => {
    const status = () => ({ ok: true });

    assert.deepEqual(handleBrokerMessage('{', { status }), {
      response: { ok: false, error: 'invalid JSON' },
      stop: false,
    });
    assert.match(handleBrokerMessage('{"type":"bogus"}', { status }).response.error, /unknown broker command/);
  });

  test('stop marks the response and invokes stop callback', () => {
    let stopped = false;
    const out = handleBrokerMessage('{"type":"stop"}', {
      status: () => ({ ok: true, broker: { pid: 5 } }),
      stop: () => { stopped = true; },
    });

    assert.equal(stopped, true);
    assert.equal(out.stop, true);
    assert.equal(out.response.ok, true);
    assert.equal(out.response.stopping, true);
  });

  test('delegates session commands to an injected runtime', () => {
    let seen = null;
    const runtime = {
      handle(message) {
        seen = message;
        return { ok: true, sessions: [{ id: 'sess_a' }] };
      },
    };

    const out = handleBrokerMessage('{"type":"sessions"}', {
      status: () => ({ ok: true }),
      runtime,
    });

    assert.deepEqual(seen, { type: 'sessions' });
    assert.deepEqual(out, {
      response: { ok: true, sessions: [{ id: 'sess_a' }] },
      stop: false,
    });
  });

  test('returns structured errors when runtime delegation fails', () => {
    const runtime = {
      handle() {
        throw new Error('runtime exploded');
      },
    };

    assert.deepEqual(handleBrokerMessage('{"type":"sessions"}', {
      status: () => ({ ok: true }),
      runtime,
    }), {
      response: { ok: false, error: 'runtime exploded' },
      stop: false,
    });
  });

  test('returns an attach continuation for attach_session', () => {
    let attached = null;
    const runtime = {
      attachConnection(message, conn, initialInput) {
        attached = { message, conn, initialInput: initialInput.toString('utf8') };
        return { ok: true };
      },
    };
    const conn = {};
    const out = handleBrokerMessage('{"type":"attach_session","id":"sess_a"}', {
      status: () => ({ ok: true }),
      runtime,
    });

    assert.equal(typeof out.attach, 'function');
    out.attach(conn, Buffer.from('queued'));
    assert.equal(out.response, null);
    assert.equal(out.stop, false);
    assert.deepEqual(attached, {
      message: { type: 'attach_session', id: 'sess_a' },
      conn,
      initialInput: 'queued',
    });
  });
});

describe('broker daemon lifecycle', () => {
  test('starts with injected server and writes broker files', async () => {
    const p = paths();
    let now = 1_000;
    state = await startBrokerServer({
      ...p,
      pid: 12345,
      now: () => now,
      createServerImpl: fakeCreateServer,
    });

    now = 2_500;
    const res = state.status();

    assert.equal(res.ok, true);
    assert.equal(res.broker.pid, 12345);
    assert.equal(res.broker.mc_version, null);
    assert.equal(res.broker.protocol_version, BROKER_PROTOCOL_VERSION);
    assert.equal(res.broker.socket_path, p.socketPath);
    assert.equal(res.broker.pid_path, p.pidPath);
    assert.equal(res.broker.uptime_ms, 1_500);
    assert.equal(existsSync(p.pidPath), true);
    assert.equal(state.server.listening, true);
  });

  test('status includes sessions when a runtime is attached', async () => {
    const p = paths();
    state = await startBrokerServer({
      ...p,
      createServerImpl: fakeCreateServer,
      runtime: { listSessions: () => [{ id: 'sess_a' }] },
    });

    assert.deepEqual(state.status().sessions, [{ id: 'sess_a' }]);
  });

  test('attach_session is processed after the first JSON line', async () => {
    const p = paths();
    let attached = null;
    state = await startBrokerServer({
      ...p,
      createServerImpl: fakeCreateServer,
      runtime: {
        listSessions: () => [],
        attachConnection(message, conn, initialInput) {
          attached = { message, conn, initialInput: initialInput.toString('utf8') };
        },
      },
    });
    const conn = new EventEmitter();
    conn.write = () => {};
    conn.end = () => {};

    state.server.handler(conn);
    conn.emit('data', Buffer.from('{"type":"attach_session","id":"sess_a"}\nqueued-input'));

    assert.equal(attached.message.id, 'sess_a');
    assert.equal(attached.conn, conn);
    assert.equal(attached.initialInput, 'queued-input');
  });

  test('client disconnect during command response does not crash the broker', async () => {
    const p = paths();
    state = await startBrokerServer({
      ...p,
      createServerImpl: fakeCreateServer,
    });
    const conn = new EventEmitter();
    conn.on = conn.on.bind(conn);
    conn.end = () => {
      const err = new Error('write EPIPE');
      err.code = 'EPIPE';
      throw err;
    };

    state.server.handler(conn);

    assert.doesNotThrow(() => {
      conn.emit('data', Buffer.from('{"type":"status"}\n'));
    });
  });

  test('stop closes injected server and removes broker files', async () => {
    const p = paths();
    state = await startBrokerServer({
      ...p,
      createServerImpl: fakeCreateServer,
    });

    await state.stop();

    assert.equal(state.server.listening, false);
    assert.equal(existsSync(p.pidPath), false);
    assert.equal(existsSync(p.socketPath), false);
    state = null;
  });
});
