import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import {
  attachLocalSessionTerminal,
  readLocalSessionScreen,
  sendLocalSessionInput,
} from '../../../src/runtime/session-host/terminal-client.js';
import { validateClientFrame, validateServerFrame } from '../../../src/runtime/session-host/protocol.js';

const mcSessionId = 'mcs_000000000000000000000001';
const generationId = 'mcg_000000000000000000000001';

test('attach forwards input and resize to one exact local runtime client', async () => {
  const stdin = new FakeTerminal();
  const stdout = new FakeTerminal({ columns: 100, rows: 30 });
  const stderr = new FakeTerminal();
  let client;
  const attached = attachLocalSessionTerminal({
    mcSessionId,
    generationId,
    stdin,
    stdout,
    stderr,
    clientFactory: (options) => {
      client = new FakeClient(options, { exitOnConnect: true });
      return client;
    },
  });
  await Promise.resolve();
  stdin.emit('data', Buffer.from('hello'));
  stdout.columns = 120;
  stdout.rows = 40;
  stdout.emit('resize');
  const result = await attached;

  assert.deepEqual(client.identity, { mcSessionId, generationId, cols: 100, rows: 30 });
  assert.deepEqual(client.inputs.map((item) => item.toString()), ['hello']);
  assert.deepEqual(client.resizes, [[120, 40]]);
  assert.equal(client.detached, true);
  assert.deepEqual(result, {
    ok: true,
    code: 0,
    reason: 'exit',
    exit: { exit_code: 0, signal: null },
  });
});

test('attach observes an exit delivered with the initial screen before connect resolves', async () => {
  const result = await attachLocalSessionTerminal({
    mcSessionId,
    generationId,
    stdin: new FakeTerminal(),
    stdout: new FakeTerminal(),
    stderr: new FakeTerminal(),
    clientFactory: (options) => new FakeClient(options, { exitBeforeResolve: true }),
  });

  assert.deepEqual(result, {
    ok: true,
    code: 7,
    reason: 'exit',
    exit: { exit_code: 7, signal: null },
  });
});

test('send and read use the same socket client without a liveness protocol', async () => {
  let sender;
  const sent = await sendLocalSessionInput({
    mcSessionId,
    generationId,
    message: 'Continue',
    tool: 'codex',
    wait: async () => {},
    clientFactory: (options) => {
      sender = new FakeClient(options);
      return sender;
    },
  });
  assert.equal(sent.ok, true);
  assert.deepEqual(sender.inputs, ['Continue\r', '\r']);
  assert.equal(sender.detached, true);

  const read = await readLocalSessionScreen({
    mcSessionId,
    generationId,
    last: 2,
    clientFactory: (options) => new FakeClient(options, { screen: 'one\ntwo\nthree' }),
  });
  assert.deepEqual(read, {
    ok: true,
    mc_session_id: mcSessionId,
    generation_id: generationId,
    text: 'two\nthree',
  });

  const heartbeatRequest = ['pi', 'ng'].join('');
  const heartbeatResponse = ['po', 'ng'].join('');
  assert.equal(validateClientFrame({ v: 1, type: heartbeatResponse }).ok, false);
  assert.equal(validateServerFrame({ v: 1, type: heartbeatRequest }).ok, false);
});

class FakeClient extends EventEmitter {
  constructor(options, { exitOnConnect = false, exitBeforeResolve = false, screen = null } = {}) {
    super();
    this.identity = {
      mcSessionId: options.mcSessionId,
      generationId: options.generationId,
      cols: options.cols,
      rows: options.rows,
    };
    this.output = options.output;
    this.exitOnConnect = exitOnConnect;
    this.exitBeforeResolve = exitBeforeResolve;
    this.exitFrame = null;
    this.closed = false;
    this.screen = screen;
    this.inputs = [];
    this.resizes = [];
    this.detached = false;
  }

  async connect() {
    if (this.screen !== null) this.output.write(Buffer.from(this.screen));
    if (this.exitBeforeResolve) this.exitFrame = { exit_code: 7, signal: null };
    if (this.exitOnConnect) {
      setImmediate(() => this.emit('exit', { exit_code: 0, signal: null }));
    }
  }

  input(value) { this.inputs.push(value); }
  resize(cols, rows) { this.resizes.push([cols, rows]); }
  detach() { this.detached = true; }
}

class FakeTerminal extends EventEmitter {
  constructor({ columns = 80, rows = 24 } = {}) {
    super();
    this.columns = columns;
    this.rows = rows;
    this.isTTY = false;
    this.chunks = [];
  }

  write(chunk) { this.chunks.push(Buffer.from(chunk)); return true; }
  resume() {}
  pause() {}
}
