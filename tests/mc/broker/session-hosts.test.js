import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { describe } from 'node:test';

import {
  ensureSessionHostRunning,
  listLocalBrokerAndHostSessions,
  probeSessionHostRuntime,
  requestForSession,
} from '../../../src/mc/broker/session-hosts.js';
import { BROKER_PROTOCOL_VERSION } from '../../../src/mc/broker/daemon.js';
import { BROKER_RUNTIME_IDENTITY } from '../../../src/mc/broker/runtime-identity.js';
import { START_POLL_MS } from '../../../src/mc/broker/supervisor.js';

test('session hosts allow a bounded fifteen-second cold start', () => {
  assert.equal(START_POLL_MS, 15_000);
});

function controllerBinding(sessionId) {
  return {
    schema: 'mc-broker-controller-bootstrap-v1',
    session_id: sessionId,
    session_controller_capability: 'b'.repeat(64),
  };
}

function makeHostManifest({ hostsDir, sessionId = 'sess_a' }) {
  const dir = join(hostsDir, sessionId);
  mkdirSync(dir, { recursive: true });
  const manifest = {
    session_id: sessionId,
    socket_path: join(dir, 'broker.sock'),
    pid_path: join(dir, 'broker.pid'),
    log_path: join(dir, 'broker.log'),
  };
  writeFileSync(join(dir, 'host.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

describe('session broker hosts', () => {
  test('proves a refused session host exited only when its recorded pid is gone', async () => {
    const connectionError = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNREFUSED',
    });
    const processError = Object.assign(new Error('no such process'), {
      code: 'ESRCH',
    });
    let requests = 0;
    const result = await probeSessionHostRuntime({
      socketPath: '/tmp/dead-broker.sock',
      pidPath: '/tmp/dead-broker.pid',
    }, {
      request: async (message, options) => {
        requests += 1;
        assert.deepEqual(message, { type: 'status' });
        assert.deepEqual(options, {
          socketPath: '/tmp/dead-broker.sock',
          timeoutMs: 600,
        });
        assert.equal('session_controller_capability' in message, false);
        throw connectionError;
      },
      readFile: () => '1234\n',
      signalProcess: () => { throw processError; },
    });

    assert.equal(requests, 2);
    assert.deepEqual(result, {
      verdict: 'exited',
      reason: 'host-process-exited',
      pid: 1234,
    });
  });

  test('binds dead-host proof to the private session host manifest', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-dead-session-host-'));
    try {
      const paths = {
        socketPath: join(root, 'broker.sock'),
        pidPath: join(root, 'broker.pid'),
        lifecyclePath: join(root, 'lifecycle.json'),
        manifestPath: join(root, 'host.json'),
      };
      writeFileSync(paths.pidPath, '2468\n', { mode: 0o600 });
      writeFileSync(paths.manifestPath, JSON.stringify({
        session_id: 'sess_bound_host',
        socket_path: paths.socketPath,
        pid_path: paths.pidPath,
        log_path: join(root, 'broker.log'),
        lifecycle_path: paths.lifecyclePath,
        broker_pid: 2468,
        protocol_version: BROKER_PROTOCOL_VERSION,
        runtime_identity: BROKER_RUNTIME_IDENTITY,
        updated_at: '2026-07-31T04:00:00.000Z',
      }), { mode: 0o600 });
      const refused = Object.assign(new Error('connect ECONNREFUSED'), {
        code: 'ECONNREFUSED',
      });
      const gone = Object.assign(new Error('no such process'), { code: 'ESRCH' });

      const result = await probeSessionHostRuntime(paths, {
        expectedSessionId: 'sess_bound_host',
        request: async () => { throw refused; },
        signalProcess: () => { throw gone; },
      });

      assert.deepEqual(result, {
        verdict: 'exited',
        reason: 'host-process-exited',
        pid: 2468,
        host_manifest: {
          session_id: 'sess_bound_host',
          broker_pid: 2468,
          updated_at: '2026-07-31T04:00:00.000Z',
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('keeps session host state unknown when socket or pid evidence is inconclusive', async () => {
    const denied = Object.assign(new Error('connect EPERM'), { code: 'EPERM' });
    const refused = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNREFUSED',
    });
    const paths = {
      socketPath: '/tmp/unknown-broker.sock',
      pidPath: '/tmp/unknown-broker.pid',
    };

    const deniedResult = await probeSessionHostRuntime(paths, {
      request: async () => { throw denied; },
      readFile: () => '1234\n',
      signalProcess: () => assert.fail('permission-denied socket is not exit proof'),
    });
    const missingPidResult = await probeSessionHostRuntime(paths, {
      request: async () => { throw refused; },
      readFile: () => { throw new Error('missing'); },
      signalProcess: () => assert.fail('missing pid is not exit proof'),
    });

    assert.equal(deniedResult.verdict, 'unknown');
    assert.equal(missingPidResult.verdict, 'unknown');
  });

  test('keeps a refused session host live when the recorded pid still exists', async () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNREFUSED',
    });
    const result = await probeSessionHostRuntime({
      socketPath: '/tmp/live-broker.sock',
      pidPath: '/tmp/live-broker.pid',
    }, {
      request: async () => { throw refused; },
      readFile: () => '4321\n',
      signalProcess: (pid, signal) => {
        assert.equal(pid, 4321);
        assert.equal(signal, 0);
      },
    });

    assert.equal(result.verdict, 'live');
    assert.equal(result.reason, 'host-pid-live');
  });

  test('does not report exit when a replacement host appears during the probe', async () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNREFUSED',
    });
    const gone = Object.assign(new Error('no such process'), { code: 'ESRCH' });
    let requests = 0;
    const result = await probeSessionHostRuntime({
      socketPath: '/tmp/restarted-broker.sock',
      pidPath: '/tmp/restarted-broker.pid',
    }, {
      request: async () => {
        requests += 1;
        if (requests === 1) throw refused;
        return { ok: true };
      },
      readFile: () => '9876\n',
      signalProcess: () => { throw gone; },
    });

    assert.equal(requests, 2);
    assert.equal(result.verdict, 'live');
    assert.equal(result.reason, 'host-socket-reachable');
  });

  test('lists hosted sessions and routes requests to the host socket', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-session-hosts-'));
    try {
      const hostsDir = join(root, 'hosts');
      const host = makeHostManifest({ hostsDir });
      const seen = [];
      const request = async (message, options) => {
        seen.push({ message, options });
        if (message.type === 'sessions' && options?.socketPath === host.socket_path) {
          return { ok: true, sessions: [{ id: 'sess_a', cwd: '/repo/hosted' }] };
        }
        if (message.type === 'sessions' && !options) {
          return { ok: true, sessions: [{ id: 'sess_global', cwd: '/repo/global' }] };
        }
        if (message.type === 'session_status' && options?.socketPath === host.socket_path) {
          return { ok: true, session: { id: message.id } };
        }
        return { ok: false, error: `unexpected ${message.type}` };
      };

      const sessions = await listLocalBrokerAndHostSessions({
        request,
        includeHosts: true,
        hostsDir,
      });

      assert.equal(sessions.length, 2);
      assert.deepEqual(sessions[0], {
        id: 'sess_a',
        cwd: '/repo/hosted',
        broker_socket_path: host.socket_path,
        broker_pid_path: host.pid_path,
        broker_log_path: host.log_path,
        host_session_id: 'sess_a',
        host_kind: 'session',
      });
      assert.deepEqual(sessions[1], { id: 'sess_global', cwd: '/repo/global' });

      const routedRequest = requestForSession(sessions[0], { request });
      await routedRequest({ type: 'session_status', id: 'sess_a' });
      assert.deepEqual(seen.at(-1), {
        message: { type: 'session_status', id: 'sess_a' },
        options: { socketPath: host.socket_path },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a host that times out is reported busy-live, a refused host drops out', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-session-hosts-'));
    try {
      const hostsDir = join(root, 'hosts');
      const busy = makeHostManifest({ hostsDir, sessionId: 'sess_busy' });
      makeHostManifest({ hostsDir, sessionId: 'sess_dead' });
      const request = async (message, options) => {
        if (options?.socketPath === busy.socket_path) {
          throw new Error('broker request timed out after 3000ms');
        }
        if (options?.socketPath) {
          throw new Error('connect ECONNREFUSED');
        }
        return { ok: true, sessions: [] };
      };

      const sessions = await listLocalBrokerAndHostSessions({
        request,
        includeHosts: true,
        hostsDir,
      });

      // Timeout means the daemon's event loop is busy (active tool
      // streaming), not dead — dropping it would present a live session
      // as stale. Refused/missing sockets stay dropped.
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0].coding_session_id, 'sess_busy');
      assert.equal(sessions[0].session_state, 'live');
      assert.equal(sessions[0].attachable, true);
      assert.equal(sessions[0].host_busy, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('does not scan session-host manifests for injected requests unless requested', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-session-hosts-skip-'));
    try {
      const hostsDir = join(root, 'hosts');
      makeHostManifest({ hostsDir });
      const seen = [];
      const sessions = await listLocalBrokerAndHostSessions({
        hostsDir,
        request: async (message, options) => {
          seen.push({ message, options });
          return { ok: true, sessions: [{ id: 'sess_global' }] };
        },
      });

      assert.deepEqual(sessions, [{ id: 'sess_global' }]);
      assert.deepEqual(seen, [{ message: { type: 'sessions' }, options: undefined }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('refuses to replace an incompatible session host with a live PTY', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-session-hosts-legacy-'));
    try {
      const paths = {
        socketPath: join(root, 'broker.sock'),
        pidPath: join(root, 'broker.pid'),
        logPath: join(root, 'broker.log'),
        manifestPath: join(root, 'host.json'),
      };
      let spawned = false;
      const result = await ensureSessionHostRunning({
        sessionId: 'sess_legacy',
        controllerBinding: controllerBinding('sess_legacy'),
        paths,
        request: async () => ({
          ok: true,
          broker: { pid: 1, protocol_version: 'mc-broker-pty-v3' },
          sessions: [{ id: 'sess_legacy', session_state: 'live', tool: 'codex' }],
        }),
        spawnDaemon: () => { spawned = true; return { ok: true }; },
      });

      assert.equal(result.ok, false);
      assert.equal(result.reason, 'broker-protocol-incompatible-live');
      assert.equal(spawned, false);
      assert.match(result.error, /previous mc version/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('stops a verified-empty incompatible host before replacing it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-session-hosts-upgrade-'));
    try {
      const paths = {
        socketPath: join(root, 'broker.sock'),
        pidPath: join(root, 'broker.pid'),
        logPath: join(root, 'broker.log'),
        manifestPath: join(root, 'host.json'),
      };
      const seen = [];
      let stopped = false;
      let spawned = false;
      const result = await ensureSessionHostRunning({
        sessionId: 'sess_upgrade',
        controllerBinding: controllerBinding('sess_upgrade'),
        paths,
        request: async (message) => {
          seen.push(message.type);
          if (message.type === 'stop') {
            stopped = true;
            return { ok: true, stopping: true };
          }
          if (!stopped) {
            return {
              ok: true,
              broker: { pid: 1, protocol_version: 'mc-broker-pty-v3' },
              sessions: [],
            };
          }
          if (!spawned) throw new Error('old host stopped');
          return {
            ok: true,
            broker: {
              pid: 2,
              protocol_version: BROKER_PROTOCOL_VERSION,
              runtime_identity: BROKER_RUNTIME_IDENTITY,
            },
            sessions: [],
          };
        },
        spawnDaemon: () => {
          assert.equal(stopped, true);
          spawned = true;
          return { ok: true, pid: 2 };
        },
        sleep: async () => {},
      });

      assert.equal(result.ok, true);
      assert.equal(result.started, true);
      assert.equal(spawned, true);
      assert.deepEqual(seen, ['status', 'stop', 'status', 'status']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('removes a verified-terminal row before replacing its incompatible host', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-session-hosts-terminal-upgrade-'));
    try {
      const paths = {
        socketPath: join(root, 'broker.sock'),
        pidPath: join(root, 'broker.pid'),
        logPath: join(root, 'broker.log'),
        manifestPath: join(root, 'host.json'),
      };
      const binding = controllerBinding('sess_terminal_upgrade');
      const seen = [];
      let sessions = [{
        id: 'sess_terminal_upgrade',
        session_state: 'dead',
        exit: { code: 0, signal: 0 },
      }];
      let stopped = false;
      let spawned = false;
      const result = await ensureSessionHostRunning({
        sessionId: 'sess_terminal_upgrade',
        controllerBinding: binding,
        paths,
        expectedRuntimeIdentity: 'expected-runtime-identity',
        request: async (message) => {
          seen.push(message);
          if (message.type === 'remove_session') {
            assert.equal(message.id, 'sess_terminal_upgrade');
            assert.equal(
              message.session_controller_capability,
              binding.session_controller_capability,
            );
            sessions = [];
            return { ok: true, removed: true };
          }
          if (message.type === 'stop') {
            assert.deepEqual(sessions, []);
            stopped = true;
            return { ok: true, stopping: true };
          }
          if (!stopped) {
            return {
              ok: true,
              broker: {
                pid: 1,
                protocol_version: BROKER_PROTOCOL_VERSION,
                runtime_identity: 'stale-runtime-identity',
              },
              sessions,
            };
          }
          if (!spawned) throw new Error('old host stopped');
          return {
            ok: true,
            broker: {
              pid: 2,
              protocol_version: BROKER_PROTOCOL_VERSION,
              runtime_identity: 'expected-runtime-identity',
            },
            sessions: [],
          };
        },
        spawnDaemon: () => {
          assert.equal(stopped, true);
          spawned = true;
          return { ok: true, pid: 2 };
        },
        sleep: async () => {},
      });

      assert.equal(result.ok, true);
      assert.equal(result.started, true);
      assert.equal(spawned, true);
      assert.deepEqual(
        seen.map((message) => message.type),
        ['status', 'remove_session', 'status', 'stop', 'status', 'status'],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('prefers the hosted session when a global broker reports the same id', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-session-hosts-dedupe-'));
    try {
      const hostsDir = join(root, 'hosts');
      const host = makeHostManifest({ hostsDir });
      const sessions = await listLocalBrokerAndHostSessions({
        request: async (message, options) => {
          if (message.type === 'sessions' && options?.socketPath === host.socket_path) {
            return { ok: true, sessions: [{ id: 'sess_a', cwd: '/repo/hosted' }] };
          }
          if (message.type === 'sessions' && !options) {
            return { ok: true, sessions: [{ id: 'sess_a', cwd: '/repo/global' }] };
          }
          return { ok: false };
        },
        includeHosts: true,
        hostsDir,
      });

      assert.equal(sessions.length, 1);
      assert.equal(sessions[0].cwd, '/repo/hosted');
      assert.equal(sessions[0].broker_socket_path, host.socket_path);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('returns recent broker log lines when a host never becomes ready', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-session-hosts-timeout-'));
    try {
      const dir = join(root, 'sess_timeout');
      mkdirSync(dir, { recursive: true });
      const paths = {
        dir,
        socketPath: join(dir, 'broker.sock'),
        pidPath: join(dir, 'broker.pid'),
        logPath: join(dir, 'broker.log'),
        manifestPath: join(dir, 'host.json'),
      };

      const result = await ensureSessionHostRunning({
        sessionId: 'sess_timeout',
        controllerBinding: controllerBinding('sess_timeout'),
        paths,
        timeoutMs: 0,
        request: async () => {
          throw new Error('socket unavailable');
        },
        spawnDaemon: ({ logPath }) => {
          writeFileSync(logPath, [
            'older line',
            "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'node-pty'",
            'Node.js v24.10.0',
          ].join('\n'));
          return { ok: true, pid: 123 };
        },
      });

      assert.equal(result.ok, false);
      assert.match(result.error, /session host did not become ready in time/);
      assert.match(result.error, /Cannot find package 'node-pty'/);
      assert.equal(result.logPath, paths.logPath);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
