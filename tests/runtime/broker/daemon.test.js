import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { afterEach, describe } from 'node:test';

import {
  BROKER_PROTOCOL_VERSION,
  finalizeDaemonSignal,
  handleBrokerMessage,
  handleProviderArtifactMessage,
  runBrokerDaemon,
  startBrokerServer,
} from '../../../src/runtime/broker/daemon.js';
import { BROKER_RUNTIME_IDENTITY } from '../../../src/runtime/broker/runtime-identity.js';
import { requestBroker } from '../../../src/runtime/broker/client.js';

const PROVIDER_HOOK_RUNNER = fileURLToPath(new URL(
  '../../../src/mc/provider-artifact-hook-runner.js',
  import.meta.url,
));
let tmp = null;
let state = null;

function paths() {
  tmp = mkdtempSync(join(tmpdir(), 'mc-broker-daemon-'));
  return {
    socketPath: join(tmp, 'broker.sock'),
    artifactSocketPath: join(tmp, 'provider-artifact.sock'),
    pidPath: join(tmp, 'broker.pid'),
  };
}

function fakeCreateServer(options, handler) {
  const server = new EventEmitter();
  server.options = options;
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

  test('provider cannot stop a broker while it still owns a live session', () => {
    let stopped = false;
    const out = handleBrokerMessage('{"type":"stop"}', {
      status: () => ({ ok: true }),
      stop: () => { stopped = true; },
      runtime: {
        listSessions: () => [{ id: 'sess_live' }],
      },
    });

    assert.equal(stopped, false);
    assert.equal(out.stop, false);
    assert.equal(out.response.reason, 'broker-sessions-must-be-removed');
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

  test('run_claude_c1 requires exactly its controller-bound request and shapes status only', async () => {
    const seen = [];
    const runtime = {
      handle(message) {
        seen.push(message);
        return { ok: true, status: 'passed', diagnostic: 'not-public' };
      },
    };
    const request = {
      type: 'run_claude_c1',
      id: 'sess_c1daemon',
      session_controller_capability: 'a'.repeat(64),
    };
    const accepted = handleBrokerMessage(JSON.stringify(request), {
      status: () => ({ ok: true }),
      runtime,
    });
    assert.deepEqual(await accepted.response, { ok: true, status: 'passed' });
    assert.deepEqual(seen, [request]);

    for (const key of [
      'argv', 'env', 'path', 'secret_id', 'callback', 'tool', 'generation', 'unknown',
    ]) {
      const rejected = handleBrokerMessage(JSON.stringify({ ...request, [key]: 'attacker-choice' }), {
        status: () => ({ ok: true }),
        runtime,
      });
      assert.deepEqual(await rejected.response, { ok: false, status: 'failed' }, key);
    }
    assert.deepEqual(await handleBrokerMessage(JSON.stringify({ type: 'run_claude_c1' }), {
      status: () => ({ ok: true }),
      runtime,
    }).response, { ok: false, status: 'failed' });
    assert.equal(seen.length, 1);
  });

  test('preserves asynchronous runtime cleanup responses for the socket handler', async () => {
    const out = handleBrokerMessage('{"type":"remove_session","id":"sess_a"}', {
      status: () => ({ ok: true }),
      runtime: {
        handle: async () => ({
          ok: true,
          removed: true,
          credential_cleanup: 'confirmed',
        }),
      },
    });

    assert.deepEqual(await out.response, {
      ok: true,
      removed: true,
      credential_cleanup: 'confirmed',
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

describe('handleProviderArtifactMessage', () => {
  test('delegates only provider artifact capture', async () => {
    const seen = [];
    const runtime = {
      handle(message) {
        seen.push(message);
        return { ok: true };
      },
    };
    assert.deepEqual(await handleProviderArtifactMessage(JSON.stringify({
      type: 'capture_provider_artifact',
      id: 'sess_a',
    }), { runtime }).response, { ok: true });
    assert.deepEqual(seen, [{ type: 'capture_provider_artifact', id: 'sess_a' }]);

    for (const type of ['status', 'launch_session', 'handoff_switch_read', 'stop']) {
      const rejected = handleProviderArtifactMessage(JSON.stringify({ type }), { runtime });
      assert.equal((await rejected.response).ok, false);
    }
    assert.deepEqual(await handleProviderArtifactMessage(JSON.stringify({
      type: 'run_claude_c1',
      id: 'sess_a',
      session_controller_capability: 'a'.repeat(64),
    }), { runtime }).response, { ok: false, status: 'failed' });
    assert.equal(seen.length, 1);
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
    assert.equal(res.broker.runtime_identity, BROKER_RUNTIME_IDENTITY);
    assert.equal(res.broker.socket_path, p.socketPath);
    assert.equal(res.broker.pid_path, p.pidPath);
    assert.equal(res.broker.uptime_ms, 1_500);
    assert.equal(existsSync(p.pidPath), true);
    assert.equal(state.server.listening, true);
    assert.equal(state.artifactServer.listening, true);
    assert.deepEqual(state.server.options, { allowHalfOpen: true });
    assert.deepEqual(state.artifactServer.options, { allowHalfOpen: true });
  });

  test('returns an asynchronous cleanup receipt after the client half-closes its request', async () => {
    const p = paths();
    state = await startBrokerServer({
      ...p,
      runtime: {
        listSessions: () => [],
        handle: async (message) => {
          assert.equal(message.type, 'remove_session');
          await new Promise((resolve) => setImmediate(resolve));
          return {
            ok: true,
            removed: true,
            credential_cleanup: 'confirmed',
          };
        },
      },
    });

    const response = await requestBroker({
      type: 'remove_session',
      id: 'sess_async_cleanup',
    }, {
      socketPath: p.socketPath,
      timeoutMs: 1_000,
    });

    assert.deepEqual(response, {
      ok: true,
      removed: true,
      credential_cleanup: 'confirmed',
    });
  });

  test('provider hook waits beyond one second for its durable broker receipt', async () => {
    const p = paths();
    let committed = false;
    state = await startBrokerServer({
      ...p,
      runtime: {
        listSessions: () => [],
        handle: async (message) => {
          assert.equal(message.type, 'capture_provider_artifact');
          await new Promise((resolve) => setTimeout(resolve, 1_250));
          committed = true;
          return { ok: true };
        },
      },
    });

    const child = spawn(process.execPath, [PROVIDER_HOOK_RUNNER, '--tool', 'codex'], {
      env: {
        MEMORO_MC_PARENT: '1',
        MC_CODING_SESSION_ID: 'sess_slow_receipt',
        MC_RUNTIME_GENERATION: '4f50f5a1-4c6b-4d6a-8b5c-152c5e6b8701',
        MC_PROVIDER_ARTIFACT_SOCKET: p.artifactSocketPath,
      },
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.stdin.end(JSON.stringify({
      hook_event_name: 'SessionStart',
      session_id: '019dbb46-5772-7493-a627-f8ae48954a64',
      transcript_path: '/private/codex.jsonl',
      cwd: '/private/worktree',
    }));
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });

    assert.equal(code, 0, stderr);
    assert.equal(committed, true);
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
    assert.equal(state.artifactServer.listening, false);
    assert.equal(existsSync(p.pidPath), false);
    assert.equal(existsSync(p.socketPath), false);
    assert.equal(existsSync(p.artifactSocketPath), false);
    state = null;
  });

  test('stop waits for managed credential shutdown before removing broker files', async () => {
    const p = paths();
    let finishShutdown;
    state = await startBrokerServer({
      ...p,
      createServerImpl: fakeCreateServer,
      runtime: {
        listSessions: () => [],
        shutdown: () => new Promise((resolve) => { finishShutdown = resolve; }),
      },
    });

    const stopping = state.stop();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(state.server.listening, true);
    assert.equal(existsSync(p.pidPath), true);

    finishShutdown({ ok: true, credential_cleanup: 'confirmed' });
    await stopping;
    assert.equal(state.server.listening, false);
    assert.equal(existsSync(p.pidPath), false);
    state = null;
  });

  test('stop fails closed and keeps the host available when runtime finalization is unconfirmed', async () => {
    const p = paths();
    state = await startBrokerServer({
      ...p,
      createServerImpl: fakeCreateServer,
      runtime: {
        listSessions: () => [{ id: 'sess_a' }],
        shutdown: async () => ({ ok: false, reason: 'runtime-finalization-timeout' }),
      },
    });

    await assert.rejects(state.stop(), /runtime-finalization-timeout/);
    assert.equal(state.server.listening, true);
    assert.equal(existsSync(p.pidPath), true);
  });

  test('signal finalization does not exit or remove the host before runtime finalization succeeds', async () => {
    const p = paths();
    const exits = [];
    state = await startBrokerServer({
      ...p,
      mcVersion: null,
      createServerImpl: fakeCreateServer,
      runtime: {
        listSessions: () => [{ id: 'sess_a' }],
        shutdown: async () => ({ ok: false, reason: 'runtime-finalization-timeout' }),
      },
    });
    const result = await finalizeDaemonSignal({ state, exitProcess: (code) => exits.push(code) });

    assert.deepEqual(result, { ok: false, reason: 'runtime-finalization-timeout' });
    assert.deepEqual(exits, []);
    assert.equal(state.server.listening, true);
    assert.equal(existsSync(p.pidPath), true);
  });

  test('socket stop keeps the daemon alive when shutdown throws', async () => {
    const p = paths();
    const exits = [];
    let stopped = false;
    state = await startBrokerServer({
      ...p,
      createServerImpl: fakeCreateServer,
      exitOnStop: true,
      exitProcess: (code) => exits.push(code),
      onStop: () => { stopped = true; },
      runtime: {
        listSessions: () => [{ id: 'sess_a' }],
        shutdown: async () => { throw new Error('runtime finalization failed'); },
      },
    });
    const conn = new EventEmitter();
    conn.on = conn.on.bind(conn);
    conn.end = () => {};
    state.server.handler(conn);
    conn.emit('data', Buffer.from('{"type":"stop"}\n'));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(exits, []);
    assert.equal(stopped, false);
    assert.equal(state.server.listening, true);
    assert.equal(existsSync(p.pidPath), true);
  });

  test('signal handlers retry a failed finalization instead of falling through to default termination', async () => {
    const processRef = new EventEmitter();
    processRef.exitCode = 0;
    const exits = [];
    let stops = 0;
    let receivedExitProcess = null;
    const brokerState = {
      stop: async () => {
        stops += 1;
        if (stops === 1) throw new Error('runtime finalization failed');
      },
      status: () => ({ ok: true }),
    };

    void runBrokerDaemon({
      processRef,
      exitProcess: (code) => exits.push(code),
      mcVersion: null,
      runtime: {},
      startBrokerServerImpl: async (options) => {
        receivedExitProcess = options.exitProcess;
        return brokerState;
      },
    });
    await new Promise((resolve) => setImmediate(resolve));

    processRef.emit('SIGTERM');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stops, 1);
    assert.equal(processRef.exitCode, 1);
    assert.deepEqual(exits, []);
    assert.equal(processRef.listenerCount('SIGTERM'), 1);

    processRef.emit('SIGTERM');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stops, 2);
    assert.deepEqual(exits, [0]);
    assert.equal(typeof receivedExitProcess, 'function');
    processRef.removeAllListeners();
  });
});
