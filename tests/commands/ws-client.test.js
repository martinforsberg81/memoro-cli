import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  buildWsUrl,
  nextBackoff,
  __test__,
} from '../../src/commands/ws-client.js';

describe('buildWsUrl', () => {
  test('upgrades https → wss', () => {
    const url = buildWsUrl('https://meetmemoro.app', 'mem_abc', 'sess_xyz');
    assert.match(url, /^wss:\/\/meetmemoro\.app\/api\/sessions\/ws\?/);
  });

  test('upgrades http → ws', () => {
    const url = buildWsUrl('http://localhost:8787', 'mem_abc', 'sess_xyz');
    assert.match(url, /^ws:\/\/localhost:8787\/api\/sessions\/ws\?/);
  });

  test('carries token + coding_session_id as query params', () => {
    const u = new URL(buildWsUrl('https://x', 'mem_abc', 'sess_xyz'));
    assert.equal(u.searchParams.get('token'), 'mem_abc');
    assert.equal(u.searchParams.get('coding_session_id'), 'sess_xyz');
  });

  test('handles trailing slash in apiUrl', () => {
    const url = buildWsUrl('https://x/', 'mem_a', 'sess_b');
    assert.match(url, /^wss:\/\/x\/api\/sessions\/ws\?/);
  });
});

describe('nextBackoff', () => {
  test('doubles up to the cap', () => {
    assert.equal(nextBackoff(1_000), 2_000);
    assert.equal(nextBackoff(2_000), 4_000);
    assert.equal(nextBackoff(4_000), 8_000);
    assert.equal(nextBackoff(8_000), 16_000);
    assert.equal(nextBackoff(16_000), 30_000);
    assert.equal(nextBackoff(30_000), 30_000);
  });

  test('starts at INITIAL when given 0 or undefined', () => {
    assert.equal(nextBackoff(0), 2_000);
    assert.equal(nextBackoff(undefined), 2_000);
  });
});

describe('ws-client constants', () => {
  test('INITIAL_BACKOFF_MS is 1s', () => {
    assert.equal(__test__.INITIAL_BACKOFF_MS, 1_000);
  });

  test('MAX_BACKOFF_MS is 30s', () => {
    assert.equal(__test__.MAX_BACKOFF_MS, 30_000);
  });

  test('COMMAND_TIMEOUT_MS is 30s', () => {
    assert.equal(__test__.COMMAND_TIMEOUT_MS, 30_000);
  });
});
