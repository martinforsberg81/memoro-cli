import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { describe } from 'node:test';

import { __test__, parseArgs, runBrokerWith } from '../../../src/mc/commands/broker.js';
import { BROKER_PROTOCOL_VERSION } from '../../../src/mc/broker/daemon.js';
import { spawnBrokerDaemon } from '../../../src/mc/broker/supervisor.js';

function io() {
  let stdout = '';
  let stderr = '';
  return {
    stdout: { write: (s) => { stdout += s; } },
    stderr: { write: (s) => { stderr += s; } },
    out: () => stdout,
    err: () => stderr,
  };
}

describe('mc broker parseArgs', () => {
  test('parses verbs and --json', () => {
    assert.deepEqual(parseArgs(['status', '--json']), {
      verb: 'status',
      json: true,
      daemon: false,
      help: false,
      readyFile: null,
      once: false,
      cloudRuntime: false,
      sourceId: null,
      machineId: null,
      sourceKind: null,
      sourceName: null,
      cloudSessionId: null,
      codingSessionId: null,
      runtimeGeneration: null,
      authorizationDigest: null,
      controllerBootstrap: false,
      rawArgv: ['status', '--json'],
    });
  });

  test('parses daemon mode', () => {
    const opts = parseArgs(['--daemon', '--ready-file', '/tmp/ready']);
    assert.equal(opts.daemon, true);
    assert.equal(opts.verb, 'daemon');
    assert.equal(opts.readyFile, '/tmp/ready');
  });

  test('parses cloud runtime broker mode', () => {
    const opts = parseArgs(['connect', '--once', '--json', '--cloud-runtime']);
    assert.equal(opts.verb, 'connect');
    assert.equal(opts.once, true);
    assert.equal(opts.json, true);
    assert.equal(opts.cloudRuntime, true);
  });

  test('parses cloud source identity flags', () => {
    const opts = parseArgs([
      'connect',
      '--source-id',
      'cloud:abc',
      '--source-kind',
      'cloud',
      '--source-name',
      'Cloud worker',
      '--cloud-session-id',
      'cloud_sess_abc',
    ]);
    assert.equal(opts.verb, 'connect');
    assert.equal(opts.sourceId, 'cloud:abc');
    assert.equal(opts.sourceKind, 'cloud');
    assert.equal(opts.sourceName, 'Cloud worker');
    assert.equal(opts.cloudSessionId, 'cloud_sess_abc');
  });

  test('rejects unknown flags and extra positionals', () => {
    assert.match(parseArgs(['--wat']).error, /unknown flag/);
    assert.match(parseArgs(['start', 'extra']).error, /unexpected arg/);
    assert.match(parseArgs(['connect', '--source-id']).error, /requires a value/);
  });
});

describe('mc broker command', () => {
  test('status prints JSON and exits 0 when broker responds', async () => {
    const streams = io();
    const code = await runBrokerWith({ verb: 'status', json: true }, {
      request: async () => ({ ok: true, broker: { pid: 42, uptime_ms: 0 } }),
      spawnDaemon: () => assert.fail('must not spawn'),
      runDaemon: () => assert.fail('must not daemon'),
      sleep: async () => {},
      stdout: streams.stdout,
      stderr: streams.stderr,
    });

    assert.equal(code, 0);
    assert.equal(JSON.parse(streams.out()).broker.pid, 42);
    assert.equal(streams.err(), '');
  });

  test('status exits 1 when broker is unavailable', async () => {
    const streams = io();
    const code = await runBrokerWith({ verb: 'status', json: false }, {
      request: async () => { throw new Error('ENOENT'); },
      spawnDaemon: () => assert.fail('must not spawn'),
      runDaemon: () => assert.fail('must not daemon'),
      sleep: async () => {},
      stdout: streams.stdout,
      stderr: streams.stderr,
    });

    assert.equal(code, 1);
    assert.match(streams.err(), /not running/);
  });

  test('start is a no-op when broker is already running', async () => {
    const streams = io();
    let spawned = false;
    const code = await runBrokerWith({ verb: 'start', json: true }, {
      request: async () => ({ ok: true, broker: { pid: 9, uptime_ms: 10, protocol_version: BROKER_PROTOCOL_VERSION } }),
      spawnDaemon: () => { spawned = true; return { ok: true }; },
      runDaemon: () => assert.fail('must not daemon'),
      sleep: async () => {},
      stdout: streams.stdout,
      stderr: streams.stderr,
    });

    const out = JSON.parse(streams.out());
    assert.equal(code, 0);
    assert.equal(out.already_running, true);
    assert.equal(out.broker.pid, 9);
    assert.equal(spawned, false);
  });

  test('start spawns and waits for ready status', async () => {
    const streams = io();
    let requests = 0;
    let spawned = false;
    const code = await runBrokerWith({ verb: 'start', json: true }, {
      request: async () => {
        requests += 1;
        if (!spawned) throw new Error('not running');
        return { ok: true, broker: { pid: 77, uptime_ms: 0, protocol_version: BROKER_PROTOCOL_VERSION } };
      },
      spawnDaemon: () => { spawned = true; return { ok: true, pid: 77 }; },
      runDaemon: () => assert.fail('must not daemon'),
      sleep: async () => {},
      stdout: streams.stdout,
      stderr: streams.stderr,
    });

    const out = JSON.parse(streams.out());
    assert.equal(code, 0);
    assert.equal(out.started, true);
    assert.equal(out.broker.pid, 77);
    assert.equal(requests >= 2, true);
  });

  test('spawnBrokerDaemon does not pass runtime secrets to the daemon env', () => {
    const calls = [];
    const dir = mkdtempSync(join(tmpdir(), 'mc-broker-daemon-'));
    try {
      const res = spawnBrokerDaemon({
        logPath: join(dir, 'broker.log'),
        argv: ['/node', '/pkg/src/bin-mc.js'],
        cwd: '/repo',
        env: { MEMORO_TOKEN: 'mem_secret', PATH: '/bin' },
        openSyncImpl: () => 99,
        spawnImpl: (bin, args, opts) => {
          calls.push({ bin, args, opts });
          return { pid: 123, unref() { calls.push({ unref: true }); } };
        },
      });

      assert.equal(res.ok, true);
      assert.equal(calls[0].opts.env.MEMORO_TOKEN, undefined);
      assert.equal(calls[0].opts.env.PATH, '/bin');
      assert.equal(calls[1].unref, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('session controller bootstrap crosses only the anonymous daemon stdin pipe', () => {
    const calls = [];
    const dir = mkdtempSync(join(tmpdir(), 'mc-broker-bootstrap-'));
    const stdin = new PassThrough();
    let payload = '';
    stdin.on('data', (chunk) => { payload += chunk.toString(); });
    try {
      const capability = 'b'.repeat(64);
      const res = spawnBrokerDaemon({
        controllerBinding: {
          schema: 'mc-broker-controller-bootstrap-v1',
          session_id: 'sess_bootstrap',
          session_controller_capability: capability,
        },
        logPath: join(dir, 'broker.log'),
        argv: ['/node', '/pkg/src/bin-mc.js'],
        cwd: '/repo',
        env: { PATH: '/bin' },
        openSyncImpl: () => 99,
        spawnImpl: (bin, args, opts) => {
          calls.push({ bin, args, opts });
          return {
            pid: 123,
            stdin,
            unref() { calls.push({ unref: true }); },
          };
        },
      });

      assert.equal(res.ok, true);
      assert.equal(calls[0].opts.stdio[0], 'pipe');
      assert.equal(calls[0].args.includes('--controller-bootstrap'), true);
      assert.doesNotMatch(JSON.stringify(calls[0]), new RegExp(capability));
      assert.deepEqual(JSON.parse(payload), {
        schema: 'mc-broker-controller-bootstrap-v1',
        session_id: 'sess_bootstrap',
        session_controller_capability: capability,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('daemon bootstrap parser accepts only the strict bounded pipe payload', async () => {
    const stream = new PassThrough();
    const reading = __test__.readControllerBootstrap(stream);
    stream.end(`${JSON.stringify({
      schema: 'mc-broker-controller-bootstrap-v1',
      session_id: 'sess_bootstrap',
      session_controller_capability: 'b'.repeat(64),
    })}\n`);

    assert.deepEqual(await reading, {
      schema: 'mc-broker-controller-bootstrap-v1',
      session_id: 'sess_bootstrap',
      session_controller_capability: 'b'.repeat(64),
    });
  });

  test('daemon mode passes the pipe-bound controller only to the runtime bootstrap', async () => {
    const streams = io();
    const stdin = new PassThrough();
    let daemonOptions = null;
    const running = runBrokerWith({
      verb: 'daemon',
      daemon: true,
      controllerBootstrap: true,
    }, {
      stdin,
      stdout: streams.stdout,
      stderr: streams.stderr,
      runDaemon: async (options) => { daemonOptions = options; },
    });
    stdin.end(`${JSON.stringify({
      schema: 'mc-broker-controller-bootstrap-v1',
      session_id: 'sess_bootstrap',
      session_controller_capability: 'b'.repeat(64),
    })}\n`);

    assert.equal(await running, 0);
    assert.deepEqual(daemonOptions.controllerBinding, {
      schema: 'mc-broker-controller-bootstrap-v1',
      session_id: 'sess_bootstrap',
      session_controller_capability: 'b'.repeat(64),
    });
    assert.equal(streams.out(), '');
    assert.equal(streams.err(), '');
  });

  test('stop sends the stop command', async () => {
    const streams = io();
    let sent = null;
    const code = await runBrokerWith({ verb: 'stop', json: false }, {
      request: async (msg) => {
        sent = msg;
        return { ok: true, stopping: true, broker: { pid: 7 } };
      },
      spawnDaemon: () => assert.fail('must not spawn'),
      runDaemon: () => assert.fail('must not daemon'),
      sleep: async () => {},
      stdout: streams.stdout,
      stderr: streams.stderr,
    });

    assert.equal(code, 0);
    assert.deepEqual(sent, { type: 'stop' });
    assert.match(streams.out(), /stopped/);
  });

  test('connect delegates to the cloud connector', async () => {
    const streams = io();
    let connected = null;
    let ensured = false;
    const code = await runBrokerWith({ verb: 'connect', json: true, once: true }, {
      request: async () => assert.fail('must not request directly'),
      spawnDaemon: () => assert.fail('must not spawn'),
      ensureBroker: async () => {
        ensured = true;
        return { ok: true, broker: { pid: 11 } };
      },
      runDaemon: () => assert.fail('must not daemon'),
      connectCloud: async (opts, ioArg) => {
        connected = opts;
        assert.equal(ioArg.stdout, streams.stdout);
        assert.equal(ioArg.stderr, streams.stderr);
        return { ok: true, once: true, machine_id: 'machine' };
      },
      sleep: async () => {},
      stdout: streams.stdout,
      stderr: streams.stderr,
    });

    assert.equal(code, 0);
    assert.equal(ensured, true);
    assert.equal(connected.once, true);
    assert.equal(JSON.parse(streams.out()).machine_id, 'machine');
  });

  test('reconnect restarts the background cloud connector', async () => {
    const streams = io();
    let ensured = false;
    let reconnect = null;
    const code = await runBrokerWith({
      verb: 'reconnect',
      json: true,
      sourceId: 'cloud:cld_123456',
      sourceKind: 'cloud',
      sourceName: 'Cloud runner',
      cloudSessionId: 'cld_123456',
      codingSessionId: null,
    }, {
      request: async () => assert.fail('must not request directly'),
      spawnDaemon: () => assert.fail('must not spawn'),
      ensureBroker: async () => {
        ensured = true;
        return { ok: true, broker: { pid: 11 } };
      },
      ensureCloudBroker: async (opts) => {
        reconnect = opts;
        return { ok: true, restarted: true, previous_pid: 22, pid: 33 };
      },
      runDaemon: () => assert.fail('must not daemon'),
      connectCloud: async () => assert.fail('must not foreground-connect cloud'),
      sleep: async () => {},
      stdout: streams.stdout,
      stderr: streams.stderr,
    });

    assert.equal(code, 0);
    assert.equal(ensured, true);
    assert.deepEqual(reconnect, {
      forceRestart: true,
      sourceId: 'cloud:cld_123456',
      sourceKind: 'cloud',
      sourceName: 'Cloud runner',
      cloudSessionId: 'cld_123456',
    });
    assert.equal(JSON.parse(streams.out()).pid, 33);
  });

  test('connect fails before cloud connector when broker cannot start', async () => {
    const streams = io();
    const code = await runBrokerWith({ verb: 'connect', json: true, once: true }, {
      request: async () => assert.fail('must not request directly'),
      spawnDaemon: () => assert.fail('must not spawn'),
      ensureBroker: async () => ({ ok: false, error: 'permission denied' }),
      runDaemon: () => assert.fail('must not daemon'),
      connectCloud: async () => assert.fail('must not connect cloud'),
      sleep: async () => {},
      stdout: streams.stdout,
      stderr: streams.stderr,
    });

    assert.equal(code, 1);
    assert.match(JSON.parse(streams.out()).error, /broker start failed/);
  });

  test('cloud connector pid registration writes and cleans pid file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-broker-command-'));
    try {
      const pidPath = join(dir, 'broker-cloud.pid');
      const listeners = new Map();
      const cleanup = __test__.registerCloudConnectorPid({
        pidPath,
        pid: 12345,
        processImpl: {
          once(event, handler) { listeners.set(event, handler); },
        },
      });

      assert.equal(readFileSync(pidPath, 'utf8'), '12345');
      assert.equal(typeof cleanup, 'function');
      listeners.get('exit')();
      assert.equal(existsSync(pidPath), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('broker cloud auth uses its dedicated broker token before the runtime token', async () => {
    let keychainRead = false;
    const auth = await __test__.resolveBrokerAuthToken({
      env: {
        MEMORO_TOKEN: '  mem_runtime_token  ',
        MEMORO_BROKER_TOKEN: '  mem_broker_token  ',
      },
      getSecretFn: async () => {
        keychainRead = true;
        return 'mem_keychain_token';
      },
    });

    assert.deepEqual(auth, { token: 'mem_broker_token', source: 'broker_env' });
    assert.equal(keychainRead, false);
  });

  test('cloud runtime broker auth fails closed instead of falling back to runtime or keychain tokens', async () => {
    let keychainRead = false;
    const auth = await __test__.resolveBrokerAuthToken({
      env: { MEMORO_TOKEN: 'mem_runtime_token' },
      requireBrokerToken: true,
      getSecretFn: async () => {
        keychainRead = true;
        return 'mem_keychain_token';
      },
    });

    assert.deepEqual(auth, { token: null, source: null });
    assert.equal(keychainRead, false);
  });

  test('broker cloud auth falls back to keychain when env token is absent', async () => {
    const auth = await __test__.resolveBrokerAuthToken({
      env: {},
      getSecretFn: async () => 'mem_keychain_token',
    });

    assert.deepEqual(auth, { token: 'mem_keychain_token', source: 'keychain' });
  });
});
