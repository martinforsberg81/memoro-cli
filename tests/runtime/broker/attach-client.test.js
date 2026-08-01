import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test, { describe } from 'node:test';

import { attachBrokerSession } from '../../../src/runtime/broker/attach-client.js';

const controllerCapability = 'b'.repeat(64);

function makeSocket() {
  const socket = new EventEmitter();
  socket.writes = [];
  socket.destroyed = false;
  socket.write = (chunk) => { socket.writes.push(chunk); };
  socket.destroy = () => { socket.destroyed = true; };
  return socket;
}

function makeStream({ tty = false, columns = 80, rows = 24 } = {}) {
  const stream = new EventEmitter();
  let output = '';
  stream.isTTY = tty;
  stream.columns = columns;
  stream.rows = rows;
  stream.rawModes = [];
  stream.resumed = false;
  stream.paused = false;
  stream.write = (chunk) => {
    output += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
  };
  stream.setRawMode = (value) => { stream.rawModes.push(value); };
  stream.resume = () => { stream.resumed = true; };
  stream.pause = () => { stream.paused = true; };
  stream.output = () => output;
  return stream;
}

describe('attachBrokerSession', () => {
  test('performs the attach handshake and bridges terminal input/output', async () => {
    const socket = makeSocket();
    const stdin = makeStream({ tty: true });
    const stdout = makeStream({ columns: 90, rows: 30 });
    const stderr = makeStream();
    const resizeRequests = [];

    const promise = attachBrokerSession({
      id: 'sess_a',
      controllerCapability,
      socketPath: '/tmp/broker.sock',
      connect: (path) => {
        assert.equal(path, '/tmp/broker.sock');
        return socket;
      },
      request: async (message) => { resizeRequests.push(message); return { ok: true }; },
      stdin,
      stdout,
      stderr,
    });

    socket.emit('connect');
    assert.deepEqual(JSON.parse(socket.writes[0]), {
      type: 'attach_session',
      id: 'sess_a',
      session_controller_capability: controllerCapability,
      writer: true,
      cols: 90,
      rows: 30,
      mode: 'write',
    });

    socket.emit('data', Buffer.from('{"ok":true}\nhello'));
    assert.deepEqual(stdin.rawModes, [true]);
    assert.equal(stdin.resumed, true);
    assert.equal(stdout.output(), 'hello');

    stdin.emit('data', 'x');
    assert.equal(socket.writes[1], 'x');

    stdout.columns = 120;
    stdout.rows = 40;
    stdout.emit('resize');
    await Promise.resolve();
    assert.deepEqual(resizeRequests, [{
      type: 'resize_session',
      id: 'sess_a',
      session_controller_capability: controllerCapability,
      cols: 120,
      rows: 40,
    }]);

    socket.emit('data', Buffer.from(' world'));
    assert.equal(stdout.output(), 'hello world');
    socket.emit('end');

    assert.equal(await promise, 0);
    assert.deepEqual(stdin.rawModes, [true, false]);
    assert.equal(stdin.paused, true);
  });

  test('returns exit code 1 on broker attach refusal', async () => {
    const socket = makeSocket();
    const stdin = makeStream({ tty: true });
    const stdout = makeStream();
    const stderr = makeStream();

    const promise = attachBrokerSession({
      id: 'sess_a',
      controllerCapability,
      connect: () => socket,
      stdin,
      stdout,
      stderr,
    });

    socket.emit('connect');
    socket.emit('data', Buffer.from('{"ok":false,"error":"missing session"}\n'));

    assert.equal(await promise, 1);
    assert.match(stderr.output(), /missing session/);
    assert.deepEqual(stdin.rawModes, []);
  });

  test('does not surface legacy read-only attach status', async () => {
    const socket = makeSocket();
    const stdin = makeStream({ tty: true });
    const stdout = makeStream();
    const stderr = makeStream();

    const promise = attachBrokerSession({
      id: 'sess_a',
      controllerCapability,
      connect: () => socket,
      stdin,
      stdout,
      stderr,
    });

    socket.emit('connect');
    socket.emit('data', Buffer.from('{"ok":true,"writer":false}\n'));
    socket.emit('end');

    assert.equal(await promise, 0);
    assert.equal(stderr.output(), '');
  });

  test('missing id is a usage error without opening a socket', async () => {
    const stderr = makeStream();
    const code = await attachBrokerSession({
      stderr,
      connect: () => assert.fail('must not connect'),
    });

    assert.equal(code, 2);
    assert.match(stderr.output(), /session id required/);
  });
});
