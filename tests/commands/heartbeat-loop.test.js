import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { pidFilePath, __test__ } from '../../src/commands/heartbeat-loop.js';

describe('pidFilePath', () => {
  test('sanitizes the llm session id for filesystem safety', () => {
    const file = pidFilePath('abc/123:weird id');
    assert.equal(
      file,
      join(homedir(), '.memoro', 'heartbeat-abc_123_weird_id.pid'),
    );
  });

  test('preserves safe characters', () => {
    const file = pidFilePath('llm-session_42');
    assert.equal(
      file,
      join(homedir(), '.memoro', 'heartbeat-llm-session_42.pid'),
    );
  });

  test('truncates very long ids', () => {
    const long = 'x'.repeat(200);
    const file = pidFilePath(long);
    const base = file.split('/').pop();
    // 'heartbeat-' + 80 chars + '.pid' = 94
    assert.equal(base.length, 'heartbeat-'.length + 80 + '.pid'.length);
  });
});

describe('heartbeat-loop constants', () => {
  test('TICK_INTERVAL_MS is 60s', () => {
    assert.equal(__test__.TICK_INTERVAL_MS, 60_000);
  });

  test('RETRY_INTERVAL_MS is 5 min', () => {
    assert.equal(__test__.RETRY_INTERVAL_MS, 5 * 60 * 1000);
  });

  test('MAX_ATTEMPTS is 3 (initial + 2 retries)', () => {
    assert.equal(__test__.MAX_ATTEMPTS, 3);
  });
});

describe('parseFlags', () => {
  test('extracts --tool', () => {
    const { flags } = __test__.parseFlags(['--tool', 'claude-code']);
    assert.equal(flags.tool, 'claude-code');
  });

  test('extracts --background / -b', () => {
    assert.equal(__test__.parseFlags(['--background']).flags.background, true);
    assert.equal(__test__.parseFlags(['-b']).flags.background, true);
  });

  test('extracts --from-event-file', () => {
    const { flags } = __test__.parseFlags(['--from-event-file', '/tmp/x.json']);
    assert.equal(flags.fromEventFile, '/tmp/x.json');
  });

  test('skips unknown bare positional args', () => {
    const { flags } = __test__.parseFlags(['random', '--tool', 'codex']);
    assert.equal(flags.tool, 'codex');
  });
});
