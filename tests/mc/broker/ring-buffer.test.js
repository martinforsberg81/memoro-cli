import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { RingBuffer } from '../../../src/mc/broker/ring-buffer.js';

describe('RingBuffer', () => {
  test('replays chunks in append order', () => {
    const buffer = new RingBuffer({ maxBytes: 1024 });

    buffer.append('abc');
    buffer.append(Buffer.from('def'));
    buffer.append('ghi');

    assert.equal(buffer.toString(), 'abcdefghi');
    assert.deepEqual(buffer.replay(), Buffer.from('abcdefghi'));
    assert.equal(buffer.byteLength, 9);
  });

  test('truncates old bytes when the buffer exceeds maxBytes', () => {
    const buffer = new RingBuffer({ maxBytes: 5 });

    buffer.append('abc');
    buffer.append('def');
    buffer.append('ghi');

    assert.equal(buffer.toString(), 'efghi');
    assert.equal(buffer.byteLength, 5);
  });

  test('keeps the tail of a single oversized chunk', () => {
    const buffer = new RingBuffer({ maxBytes: 4 });

    buffer.append('abcdef');

    assert.equal(buffer.toString(), 'cdef');
    assert.equal(buffer.byteLength, 4);
  });

  test('ignores nullish and empty chunks', () => {
    const buffer = new RingBuffer({ maxBytes: 8 });

    buffer.append(null);
    buffer.append(undefined);
    buffer.append('');

    assert.equal(buffer.toString(), '');
    assert.equal(buffer.byteLength, 0);
  });

  test('requires a positive maxBytes', () => {
    assert.throws(() => new RingBuffer({ maxBytes: 0 }), /maxBytes/);
    assert.throws(() => new RingBuffer({ maxBytes: -1 }), /maxBytes/);
    assert.throws(() => new RingBuffer({ maxBytes: 1.5 }), /maxBytes/);
  });
});

