import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { parseArgs, runBrokerWith } from '../../../src/mc/commands/broker.js';

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
      rawArgv: ['status', '--json'],
    });
  });

  test('parses daemon mode', () => {
    const opts = parseArgs(['--daemon', '--ready-file', '/tmp/ready']);
    assert.equal(opts.daemon, true);
    assert.equal(opts.verb, 'daemon');
    assert.equal(opts.readyFile, '/tmp/ready');
  });

  test('parses cloud connect mode', () => {
    const opts = parseArgs(['connect', '--once', '--json']);
    assert.equal(opts.verb, 'connect');
    assert.equal(opts.once, true);
    assert.equal(opts.json, true);
  });

  test('rejects unknown flags and extra positionals', () => {
    assert.match(parseArgs(['--wat']).error, /unknown flag/);
    assert.match(parseArgs(['start', 'extra']).error, /unexpected arg/);
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
      request: async () => ({ ok: true, broker: { pid: 9, uptime_ms: 10 } }),
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
        return { ok: true, broker: { pid: 77, uptime_ms: 0 } };
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
    const code = await runBrokerWith({ verb: 'connect', json: true, once: true }, {
      request: async () => assert.fail('must not request directly'),
      spawnDaemon: () => assert.fail('must not spawn'),
      runDaemon: () => assert.fail('must not daemon'),
      connectCloud: async (opts) => {
        connected = opts;
        return { ok: true, once: true, machine_id: 'machine' };
      },
      sleep: async () => {},
      stdout: streams.stdout,
      stderr: streams.stderr,
    });

    assert.equal(code, 0);
    assert.equal(connected.once, true);
    assert.equal(JSON.parse(streams.out()).machine_id, 'machine');
  });
});
