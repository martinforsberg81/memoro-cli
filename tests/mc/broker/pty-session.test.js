import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { PtySession } from '../../../src/mc/broker/pty-session.js';

function makeFakePtyFactory() {
  const calls = [];
  let dataHandler = null;
  let exitHandler = null;
  const writes = [];
  const resizes = [];
  const kills = [];

  const pty = {
    pid: 4242,
    onData(handler) {
      dataHandler = handler;
    },
    onExit(handler) {
      exitHandler = handler;
    },
    write(data) {
      writes.push(data);
    },
    resize(cols, rows) {
      resizes.push({ cols, rows });
    },
    kill(signal) {
      kills.push(signal);
    },
  };

  return {
    calls,
    writes,
    resizes,
    kills,
    factory: {
      spawn(bin, args, options) {
        calls.push({ bin, args, options });
        return pty;
      },
    },
    emitData(data) {
      dataHandler?.(data);
    },
    emitExit(event) {
      exitHandler?.(event);
    },
  };
}

function makeSession(overrides = {}) {
  const fake = makeFakePtyFactory();
  let now = 1_000;
  const session = new PtySession({
    id: 'sess_test',
    name: 'test',
    cwd: '/repo',
    tool: 'codex',
    launchSpec: {
      bin: 'codex',
      args: (argv) => ['--wrapped', ...argv],
    },
    argv: ['--foo'],
    cols: 100,
    rows: 40,
    termName: 'xterm-test',
    env: { TEST_ENV: '1' },
    ptyFactory: fake.factory,
    clock: () => now,
    ringBytes: 8,
    ...overrides,
  });

  return {
    session,
    fake,
    tick(ms = 1) {
      now += ms;
      return now;
    },
  };
}

function makeManualTimers() {
  const timers = new Map();
  let next = 1;
  return {
    timers,
    setTimeoutFn(fn, ms) {
      const id = next++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeoutFn(id) {
      timers.delete(id);
    },
    fireAll() {
      const pending = [...timers.values()];
      timers.clear();
      for (const timer of pending) timer.fn();
    },
  };
}

describe('PtySession', () => {
  test('starts the configured PTY process', () => {
    const { session, fake } = makeSession();

    session.start();

    assert.deepEqual(fake.calls, [{
      bin: 'codex',
      args: ['--wrapped', '--foo'],
      options: {
        name: 'xterm-test',
        cols: 100,
        rows: 40,
        cwd: '/repo',
        env: { TEST_ENV: '1' },
      },
    }]);
    assert.equal(session.status().pty_pid, 4242);
    assert.equal(session.status().started_at, new Date(1_000).toISOString());
  });

  test('uses launchSpec.spawn when an adapter needs to override the process plan', () => {
    const { session, fake } = makeSession({
      launchSpec: {
        bin: '/x/codex',
        args: () => assert.fail('spawn override should own args rendering'),
        spawn: (argv, opts) => {
          assert.deepEqual(argv, ['--foo']);
          assert.equal(opts.codexDeviceAuthBeforeLaunch, true);
          return {
            bin: '/bin/sh',
            args: ['-c', 'login then exec', 'mc-codex', '/x/codex', ...argv],
          };
        },
      },
      launchOptions: { codexDeviceAuthBeforeLaunch: true },
    });

    session.start();

    assert.deepEqual(fake.calls[0], {
      bin: '/bin/sh',
      args: ['-c', 'login then exec', 'mc-codex', '/x/codex', '--foo'],
      options: {
        name: 'xterm-test',
        cols: 100,
        rows: 40,
        cwd: '/repo',
        env: { TEST_ENV: '1' },
      },
    });
  });

  test('captures PTY output and broadcasts data events', () => {
    const { session, fake, tick } = makeSession();
    const seen = [];

    session.on('data', (data) => seen.push(data));
    session.start();
    tick(10);
    fake.emitData('abc');
    tick(10);
    fake.emitData('defghi');

    assert.deepEqual(seen, ['abc', 'defghi']);
    assert.equal(session.recentOutput(), 'bcdefghi');
    assert.equal(session.lastOutputAt, 1_020);
    assert.equal(session.status().last_output_at, new Date(1_020).toISOString());
  });

  test('writes raw input and dispatched messages with carriage return', () => {
    const { session, fake, tick } = makeSession();

    session.start();
    tick(5);
    session.write('raw');
    tick(5);
    session.writeDispatchedMessage('hello');

    assert.deepEqual(fake.writes, ['raw', 'hello\r']);
    assert.equal(session.lastInputAt, 1_010);
  });

  test('dispatched messages honor adapter-specific submit enter count', () => {
    const timers = makeManualTimers();
    const { session, fake, tick } = makeSession({
      launchSpec: {
        bin: 'codex',
        args: (argv) => ['--wrapped', ...argv],
        submitEnterCount: 2,
        submitEnterDelayMs: 42,
        setTimeoutFn: timers.setTimeoutFn,
      },
    });

    session.start();
    tick(5);
    session.writeDispatchedMessage('ship it');

    assert.deepEqual(fake.writes, ['ship it\r']);
    assert.equal(timers.timers.size, 1);
    assert.equal(session.lastInputAt, 1_005);
    timers.fireAll();
    assert.deepEqual(fake.writes, ['ship it\r', '\r']);
  });

  test('forwards terminal resize to the PTY', () => {
    const { session, fake } = makeSession();

    session.start();
    session.resize(120, 33);

    assert.deepEqual(fake.resizes, [{ cols: 120, rows: 33 }]);
    assert.equal(session.status().pty_pid, 4242);
  });

  test('emits exit notification and stores exit status', () => {
    const { session, fake, tick } = makeSession();
    const exits = [];

    session.on('exit', (event) => exits.push(event));
    session.start();
    tick(25);
    fake.emitExit({ exitCode: 7, signal: null });

    assert.deepEqual(exits, [{ exitCode: 7, signal: null }]);
    assert.deepEqual(session.status().exit, {
      code: 7,
      signal: null,
      at: new Date(1_025).toISOString(),
    });
  });

  test('forwards kill signal to the PTY', () => {
    const { session, fake } = makeSession();

    session.start();
    session.kill('SIGTERM');

    assert.deepEqual(fake.kills, ['SIGTERM']);
  });

  test('deferred-pty startup message is sent after first output, not as argv', () => {
    const timers = makeManualTimers();
    const { session, fake } = makeSession({
      launchSpec: {
        bin: '/x/codex',
        startupMessageDelivery: 'deferred-pty',
        submitEnterCount: 2,
        submitEnterDelayMs: 5,
        args: (argv, opts) => {
          assert.equal(opts.startupMessage, null);
          return argv;
        },
      },
      argv: [],
      launchOptions: { startupMessage: 'grounding' },
      startupMessageDelayMs: 10,
      startupMessageSetTimeoutFn: timers.setTimeoutFn,
      startupMessageClearTimeoutFn: timers.clearTimeoutFn,
    });

    session.start();

    assert.deepEqual(fake.calls[0].args, []);
    assert.deepEqual(fake.writes, []);

    fake.emitData('ready');
    assert.equal(timers.timers.size, 1);
    timers.fireAll();

    assert.deepEqual(fake.writes, ['grounding\r']);
  });

  test('exit cancels a pending deferred startup message', () => {
    const timers = makeManualTimers();
    const { session, fake } = makeSession({
      launchSpec: {
        bin: '/x/codex',
        startupMessageDelivery: 'deferred-pty',
        args: (argv) => argv,
      },
      launchOptions: { startupMessage: 'grounding' },
      startupMessageSetTimeoutFn: timers.setTimeoutFn,
      startupMessageClearTimeoutFn: timers.clearTimeoutFn,
    });

    session.start();
    fake.emitData('ready');
    assert.equal(timers.timers.size, 1);

    fake.emitExit({ exitCode: 0 });
    assert.equal(timers.timers.size, 0);
    timers.fireAll();
    assert.deepEqual(fake.writes, []);
  });

  test('handoff is omitted from adapter argv and acknowledged after PTY delivery', async () => {
    const timers = makeManualTimers();
    const { session, fake } = makeSession({
      launchSpec: {
        bin: '/x/claude',
        startupMessageDelivery: 'launch-args',
        args: (argv, options) => {
          assert.equal(options.handoffUserMessage, null);
          return argv;
        },
      },
      argv: ['--resume', 'native-a'],
      launchOptions: { handoffUserMessage: 'handoff one' },
      startupMessageDelayMs: 10,
      startupMessageSetTimeoutFn: timers.setTimeoutFn,
      startupMessageClearTimeoutFn: timers.clearTimeoutFn,
    });

    session.start();
    const delivered = session.waitForHandoffDelivery();
    assert.deepEqual(fake.calls[0].args, ['--resume', 'native-a']);
    assert.deepEqual(fake.writes, []);
    fake.emitData('ready');
    timers.fireAll();

    assert.deepEqual(fake.writes, ['handoff one\r']);
    assert.deepEqual(await delivered, { ok: true });
  });

  test('provider exit before handoff delivery resolves a fail-closed acknowledgement', async () => {
    const timers = makeManualTimers();
    const { session, fake } = makeSession({
      launchOptions: { handoffUserMessage: 'handoff one' },
      startupMessageSetTimeoutFn: timers.setTimeoutFn,
      startupMessageClearTimeoutFn: timers.clearTimeoutFn,
    });

    session.start();
    const delivered = session.waitForHandoffDelivery();
    fake.emitData('starting');
    fake.emitExit({ exitCode: 1 });

    assert.deepEqual(await delivered, {
      ok: false,
      reason: 'provider-exited-before-handoff-delivery',
    });
    assert.deepEqual(fake.writes, []);
  });
});
