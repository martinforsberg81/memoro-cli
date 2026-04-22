import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { Readable } from 'node:stream';

import { parseHookEvent, readHookEvent } from '../src/lib/hook-event.js';

describe('parseHookEvent', () => {
  test('returns parsed object for valid JSON', () => {
    const ev = parseHookEvent('{"transcript_path":"/tmp/x.jsonl","session_id":"s1"}');
    assert.equal(ev.transcript_path, '/tmp/x.jsonl');
    assert.equal(ev.session_id, 's1');
  });

  test('returns null for empty input', () => {
    assert.equal(parseHookEvent(''), null);
    assert.equal(parseHookEvent(null), null);
    assert.equal(parseHookEvent(undefined), null);
  });

  test('returns null for malformed JSON', () => {
    assert.equal(parseHookEvent('{not json'), null);
  });

  test('returns null for non-object JSON (e.g. number, string, array)', () => {
    assert.equal(parseHookEvent('42'), null);
    assert.equal(parseHookEvent('"hi"'), null);
    // Arrays are objects in JS — allowed through — but hook events are always
    // objects in practice; asserting current behavior:
    assert.deepEqual(parseHookEvent('[1,2]'), [1, 2]);
  });
});

describe('readHookEvent', () => {
  test('returns null when stdin is a TTY', async () => {
    const fakeTty = Object.assign(Readable.from([]), { isTTY: true });
    const ev = await readHookEvent({ stdin: fakeTty });
    assert.equal(ev, null);
  });

  test('reads and parses JSON from a piped stdin', async () => {
    const payload = '{"transcript_path":"/var/log/t.jsonl","hook_event_name":"SessionEnd"}';
    const piped = Readable.from([Buffer.from(payload)]);
    piped.isTTY = false;
    const ev = await readHookEvent({ stdin: piped });
    assert.equal(ev.transcript_path, '/var/log/t.jsonl');
    assert.equal(ev.hook_event_name, 'SessionEnd');
  });

  test('returns null for empty piped stdin', async () => {
    const piped = Readable.from([]);
    piped.isTTY = false;
    const ev = await readHookEvent({ stdin: piped });
    assert.equal(ev, null);
  });
});
