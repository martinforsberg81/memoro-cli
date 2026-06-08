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
});

