import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { RuntimeClientQueue } from '../../../src/runtime/session-host/client-queue.js';
import {
  SESSION_HOST_PROTOCOL_VERSION,
  SessionHostFrameDecoder,
  encodeSessionHostFrame,
  validateClientFrame,
  validateServerFrame,
} from '../../../src/runtime/session-host/protocol.js';

const mcSessionId = 'mcs_000000000000000000000001';
const generationId = 'mcg_000000000000000000000001';

test('decodes split frames and rejects cross-session or payload-shaped extensions', () => {
  const attach = {
    v: SESSION_HOST_PROTOCOL_VERSION,
    type: 'attach',
    mc_session_id: mcSessionId,
    generation_id: generationId,
    cols: 80,
    rows: 24,
  };
  const encoded = encodeSessionHostFrame(attach, { direction: 'client' });
  const decoder = new SessionHostFrameDecoder({ direction: 'client' });
  assert.deepEqual(decoder.push(encoded.subarray(0, 7)), []);
  assert.deepEqual(decoder.push(encoded.subarray(7)), [attach]);
  assert.equal(validateClientFrame({ ...attach, argv: ['forbidden'] }).ok, false);
  assert.equal(validateClientFrame({ ...attach, environment: {} }).ok, false);
  assert.equal(validateClientFrame({ ...attach, transcript: 'forbidden' }).ok, false);
  assert.throws(() => decoder.push(Buffer.alloc(1024 * 1024 + 1)),
    (error) => error.reason === 'frame-too-large');
});

test('validates screen and output frames without exposing transport authority', () => {
  const screen = {
    v: SESSION_HOST_PROTOCOL_VERSION,
    type: 'screen',
    mc_session_id: mcSessionId,
    generation_id: generationId,
    sequence: 12,
    cols: 80,
    rows: 24,
    ansi_base64: Buffer.from('\u001b[2J\u001b[Hready').toString('base64'),
    scrollback_truncated: false,
  };
  assert.equal(validateServerFrame(screen).ok, true);
  assert.equal(validateServerFrame({ ...screen, socket_path: '/forbidden' }).ok, false);
  assert.equal(validateServerFrame({ ...screen, credential: 'forbidden' }).ok, false);
  const status = {
    v: SESSION_HOST_PROTOCOL_VERSION,
    type: 'status',
    mc_session_id: mcSessionId,
    generation_id: generationId,
    state: 'live',
    process_pid: 123,
    clients: 1,
    screen: {
      cols: 80,
      rows: 24,
      parsed_sequence: 12,
      pending_bytes: 0,
      pending_operations: 0,
      scrollback_lines: 20,
    },
  };
  assert.equal(validateServerFrame(status).ok, true);
  assert.equal(validateServerFrame({
    ...status,
    screen: { ...status.screen, socket_path: '/forbidden' },
  }).ok, false);
});

test('honors socket backpressure and disconnects only the overflowing client', () => {
  const socket = new FakeSocket({ writable: false });
  const reasons = [];
  const queue = new RuntimeClientQueue({
    socket,
    maxQueuedBytes: 64 * 1024,
    maxQueuedFrames: 8,
    onDisconnect: (reason) => reasons.push(reason),
  });
  assert.equal(queue.send(outputFrame(1, 1024)), true);
  assert.equal(queue.status().blocked, true);
  for (let sequence = 2; sequence <= 8 && !queue.status().closed; sequence += 1) {
    queue.send(outputFrame(sequence, 12 * 1024));
  }
  assert.equal(queue.status().closed, true);
  assert.equal(queue.status().reason, 'slow-client-overflow');
  assert.equal(socket.destroyed, true);
  assert.deepEqual(reasons, ['slow-client-overflow']);
});

test('drains queued frames in order when a client becomes writable', () => {
  const socket = new FakeSocket({ writable: false });
  const queue = new RuntimeClientQueue({ socket });
  queue.send(outputFrame(1, 8));
  queue.send(outputFrame(2, 8));
  queue.send(outputFrame(3, 8));
  socket.writable = true;
  socket.emit('drain');
  const decoder = new SessionHostFrameDecoder({ direction: 'server' });
  const frames = socket.writes.flatMap((chunk) => decoder.push(chunk));
  assert.deepEqual(frames.map((frame) => frame.sequence), [1, 2, 3]);
  assert.equal(queue.status().queued_bytes, 0);
});

function outputFrame(sequence, bytes) {
  return {
    v: SESSION_HOST_PROTOCOL_VERSION,
    type: 'output',
    mc_session_id: mcSessionId,
    generation_id: generationId,
    sequence,
    data_base64: Buffer.alloc(bytes, 0x61).toString('base64'),
  };
}

class FakeSocket extends EventEmitter {
  constructor({ writable }) {
    super();
    this.writable = writable;
    this.writableLength = 0;
    this.writes = [];
    this.destroyed = false;
  }

  write(data) {
    this.writes.push(Buffer.from(data));
    this.writableLength = this.writable ? 0 : this.writes.reduce((sum, item) => sum + item.length, 0);
    return this.writable;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('close');
  }
}
