import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { BrokerSessionManager } from '../../../src/mc/broker/session-manager.js';

function makeFakePtyFactory() {
  const ptys = [];
  const calls = [];
  const factory = {
    spawn(bin, args, options) {
      let dataHandler = null;
      let exitHandler = null;
      const pty = {
        pid: 9000 + ptys.length,
        writes: [],
        resizes: [],
        kills: [],
        onData(handler) { dataHandler = handler; },
        onExit(handler) { exitHandler = handler; },
        write(data) { this.writes.push(data); },
        resize(cols, rows) { this.resizes.push({ cols, rows }); },
        kill(signal) { this.kills.push(signal); },
        emitData(data) { dataHandler?.(data); },
        emitExit(event) { exitHandler?.(event); },
      };
      calls.push({ bin, args, options });
      ptys.push(pty);
      return pty;
    },
  };
  return { factory, calls, ptys };
}

function launchSpec(bin = 'claude') {
  return {
    bin,
    args: (argv) => ['--wrapped', ...argv],
  };
}

function makeManager() {
  const fake = makeFakePtyFactory();
  let now = 1_000;
  const manager = new BrokerSessionManager({
    ptyFactory: fake.factory,
    clock: () => now,
  });
  return {
    manager,
    fake,
    tick(ms = 1) {
      now += ms;
      return now;
    },
  };
}

describe('BrokerSessionManager', () => {
  test('launches a PTY session and lists it as live + attachable', () => {
    const { manager, fake } = makeManager();

    const status = manager.launch({
      id: 'sess_a',
      name: 'a',
      cwd: '/repo/a',
      tool: 'claude',
      launchSpec: launchSpec(),
      argv: ['--resume'],
      env: { A: '1' },
    });

    assert.equal(status.id, 'sess_a');
    assert.equal(status.session_state, 'live');
    assert.equal(status.attachable, true);
    assert.equal(status.pty_pid, 9000);
    assert.deepEqual(manager.list().map((s) => s.id), ['sess_a']);
    assert.deepEqual(fake.calls[0].args, ['--wrapped', '--resume']);
  });

  test('rejects duplicate ids and unknown sessions', () => {
    const { manager } = makeManager();
    const spec = { id: 'sess_a', cwd: '/repo', launchSpec: launchSpec() };

    manager.launch(spec);

    assert.throws(() => manager.launch(spec), /already exists/);
    assert.throws(() => manager.write('missing', 'x'), /unknown broker session/);
  });

  test('emits output and exit events with the session id', () => {
    const { manager, fake, tick } = makeManager();
    const dataEvents = [];
    const exitEvents = [];
    manager.on('data', (event) => dataEvents.push(event));
    manager.on('exit', (event) => exitEvents.push(event));

    manager.launch({ id: 'sess_a', cwd: '/repo', launchSpec: launchSpec() });
    const session = manager.get('sess_a');
    tick(10);
    fake.ptys[0].emitData('hello');
    tick(10);
    fake.ptys[0].emitExit({ exitCode: 0, signal: null });

    assert.deepEqual(dataEvents, [{ id: 'sess_a', data: 'hello' }]);
    assert.equal(exitEvents.length, 1);
    assert.equal(exitEvents[0].id, 'sess_a');
    assert.deepEqual(exitEvents[0].event, { exitCode: 0, signal: null });
    assert.equal(exitEvents[0].session, session);
    assert.equal(manager.status('sess_a').session_state, 'dead');
    assert.equal(manager.status('sess_a').attachable, false);
  });

  test('forwards write, dispatch, resize, and stop to the owned session', () => {
    const { manager, fake } = makeManager();

    manager.launch({ id: 'sess_a', cwd: '/repo', launchSpec: launchSpec() });
    manager.write('sess_a', 'raw');
    manager.dispatch('sess_a', 'prompt');
    manager.resize('sess_a', 120, 40);
    manager.stop('sess_a', 'SIGHUP');

    assert.deepEqual(fake.ptys[0].writes, ['raw', 'prompt\r']);
    assert.deepEqual(fake.ptys[0].resizes, [{ cols: 120, rows: 40 }]);
    assert.deepEqual(fake.ptys[0].kills, ['SIGHUP']);
  });

  test('remove drops a session from the manager', () => {
    const { manager } = makeManager();

    manager.launch({ id: 'sess_a', cwd: '/repo', launchSpec: launchSpec() });

    assert.equal(manager.remove('sess_a'), true);
    assert.equal(manager.status('sess_a'), null);
    assert.deepEqual(manager.list(), []);
  });

  test('spawn failure does not leave a half-registered session', () => {
    const manager = new BrokerSessionManager({
      ptyFactory: {
        spawn() {
          throw new Error('spawn failed');
        },
      },
    });

    assert.throws(() => {
      manager.launch({ id: 'sess_a', cwd: '/repo', launchSpec: launchSpec() });
    }, /spawn failed/);
    assert.equal(manager.status('sess_a'), null);
    assert.deepEqual(manager.list(), []);
  });
});
