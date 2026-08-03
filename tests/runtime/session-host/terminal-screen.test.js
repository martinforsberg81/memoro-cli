import assert from 'node:assert/strict';
import test from 'node:test';

import { TerminalScreen } from '../../../src/runtime/session-host/terminal-screen.js';

test('reconstructs normal and alternate terminal screens across byte boundaries', async () => {
  const screen = new TerminalScreen({ cols: 40, rows: 10, scrollbackLines: 20 });
  try {
    screen.append(Buffer.from('normal screen\r\n'), 1);
    screen.append(Buffer.from('\u001b[?1049'), 2);
    screen.append(Buffer.from('h\u001b[2J\u001b[Halternate '), 3);
    const rocket = Buffer.from('🚀', 'utf8');
    screen.append(rocket.subarray(0, 2), 4);
    screen.append(rocket.subarray(2), 5);
    const alternate = await screen.snapshot();
    assert.equal(alternate.through_sequence, 5);
    assert.equal(alternate.cols, 40);
    assert.equal(alternate.rows, 10);
    assert.ok(alternate.ansi.startsWith('\u001b[2J\u001b[H'));
    assert.match(alternate.ansi, /alternate/u);
    assert.match(alternate.ansi, /🚀/u);

    screen.append(Buffer.from('\u001b[?1049l'), 6);
    const normal = await screen.snapshot();
    assert.equal(normal.through_sequence, 6);
    assert.match(normal.ansi, /normal screen/u);
  } finally {
    screen.dispose();
  }
});

test('serializes bounded scrollback and deterministic resize state', async () => {
  const screen = new TerminalScreen({
    cols: 30,
    rows: 6,
    scrollbackLines: 12,
    maxSnapshotBytes: 64 * 1024,
  });
  try {
    for (let index = 1; index <= 80; index += 1) {
      screen.append(Buffer.from(`line-${index}\r\n`), index);
      if (index % 10 === 0) await screen.snapshot();
    }
    const resized = await screen.resize(50, 12);
    assert.equal(resized.cols, 50);
    assert.equal(resized.rows, 12);
    assert.equal(resized.through_sequence, 80);
    assert.ok(resized.bytes <= 64 * 1024);
    assert.ok(screen.status().scrollback_lines <= 12);
    assert.equal(screen.status().pending_bytes, 0);
  } finally {
    screen.dispose();
  }
});

test('fails boundedly instead of growing an unbounded parser queue', () => {
  const screen = new TerminalScreen({
    cols: 80,
    rows: 24,
    maxPendingBytes: 64 * 1024,
  });
  try {
    const result = screen.append(Buffer.alloc(64 * 1024 + 1, 0x61), 1);
    assert.deepEqual(result, {
      ok: false,
      reason: 'terminal-parser-overflow',
      pending_bytes: 0,
    });
    assert.equal(screen.status().pending_bytes, 0);
  } finally {
    screen.dispose();
  }
});

