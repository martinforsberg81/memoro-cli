import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  createDispatchMessageHandler,
  createWrapWsHandlers,
} from '../../src/mc/wrap-ws.js';

describe('createDispatchMessageHandler', () => {
  test('rejects missing or blank messages', async () => {
    const handler = createDispatchMessageHandler();
    await assert.rejects(
      () => handler({}),
      /message required/,
    );
    await assert.rejects(
      () => handler({ message: '   ' }),
      /message required/,
    );
  });

  test('delivers the message verbatim and reports delivery time', async () => {
    const delivered = [];
    const handler = createDispatchMessageHandler({
      deliver: (message) => delivered.push(message),
      now: () => new Date('2026-06-04T12:00:00.000Z'),
    });

    const result = await handler({ message: 'hello\nthere ' });

    assert.deepEqual(delivered, ['hello\nthere ']);
    assert.deepEqual(result, {
      ok: true,
      delivered_at: '2026-06-04T12:00:00.000Z',
    });
  });
});

describe('createWrapWsHandlers', () => {
  test('returns dispatch_message and fetch_transcript handlers', async () => {
    const delivered = [];
    const handlers = createWrapWsHandlers({
      source: 'codex',
      deliver: (message) => delivered.push(message),
      now: () => new Date('2026-06-04T12:00:00.000Z'),
    });

    assert.equal(typeof handlers.dispatch_message, 'function');
    assert.equal(typeof handlers.fetch_transcript, 'function');

    const result = await handlers.dispatch_message({ message: 'ship it' });
    assert.deepEqual(delivered, ['ship it']);
    assert.equal(result.delivered_at, '2026-06-04T12:00:00.000Z');

    await assert.rejects(
      () => handlers.fetch_transcript({}),
      /transcript_path was not supplied/,
    );
  });
});
