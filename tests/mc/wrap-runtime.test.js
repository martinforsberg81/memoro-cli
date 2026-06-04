import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { join } from 'node:path';

import {
  buildHeartbeatBase,
  buildHeartbeatPayload,
  buildSessionMeta,
  wrapRuntimePaths,
} from '../../src/mc/wrap-runtime.js';

const repoContext = {
  remoteUrl: 'git@github.com:acme/memoro.git',
  toplevel: '/repo/memoro',
  branch: 'main',
};

describe('wrapRuntimePaths', () => {
  test('derives sock + meta paths under mcDir', () => {
    const out = wrapRuntimePaths({ mcDir: '/tmp/mc', codingSessionId: 'sess_abc123' });
    assert.equal(out.sockPath, join('/tmp/mc', 'sess_abc123.sock'));
    assert.equal(out.metaPath, join('/tmp/mc', 'sess_abc123.json'));
  });

  test('fails high when required fields are missing', () => {
    assert.throws(() => wrapRuntimePaths({ codingSessionId: 'sess_x' }), /mcDir required/);
    assert.throws(() => wrapRuntimePaths({ mcDir: '/tmp/mc' }), /codingSessionId required/);
  });
});

describe('buildSessionMeta', () => {
  test('builds the local session metadata written beside the socket', () => {
    const meta = buildSessionMeta({
      codingSessionId: 'sess_abc123',
      label: 'audit',
      sockPath: '/tmp/mc/sess_abc123.sock',
      repoContext,
      cwd: '/repo/memoro',
      pid: 12345,
      now: new Date('2026-06-04T10:00:00.000Z'),
    });
    assert.deepEqual(meta, {
      coding_session_id: 'sess_abc123',
      label: 'audit',
      sock_path: '/tmp/mc/sess_abc123.sock',
      repo: 'memoro',
      branch: 'main',
      cwd: '/repo/memoro',
      started_at: '2026-06-04T10:00:00.000Z',
      pid: 12345,
    });
  });
});

describe('buildHeartbeatBase', () => {
  test('builds coordinator heartbeat identity fields', () => {
    const base = buildHeartbeatBase({
      codingSessionId: 'sess_abc123',
      machineId: 'host-a',
      heartbeatSource: 'codex',
      repoContext,
      label: 'audit',
    });
    assert.deepEqual(base, {
      coding_session_id: 'sess_abc123',
      machine_id: 'host-a',
      source: 'codex',
      repo: 'memoro',
      branch: 'main',
      files_touched_since_last: [],
      last_user_excerpt: '',
      label: 'audit',
    });
  });

  test('omits label when unset', () => {
    const base = buildHeartbeatBase({
      codingSessionId: 'sess_abc123',
      machineId: 'host-a',
      heartbeatSource: 'claude-code',
      repoContext,
    });
    assert.equal('label' in base, false);
  });
});

describe('buildHeartbeatPayload', () => {
  test('adds assistant excerpt, idle seconds, and timestamp to base payload', () => {
    const payload = buildHeartbeatPayload({
      base: {
        coding_session_id: 'sess_abc123',
        machine_id: 'host-a',
      },
      outputBuffer: 'abcdef',
      lastOutputAt: Date.parse('2026-06-04T10:00:00.000Z'),
      now: Date.parse('2026-06-04T10:00:07.900Z'),
      excerptMax: 3,
      extractExcerpt: (text, max) => text.slice(-max),
    });
    assert.deepEqual(payload, {
      coding_session_id: 'sess_abc123',
      machine_id: 'host-a',
      last_assistant_excerpt: 'def',
      idle_seconds: 7,
      at: '2026-06-04T10:00:07.900Z',
    });
  });

  test('clamps negative idle seconds to zero', () => {
    const payload = buildHeartbeatPayload({
      base: { coding_session_id: 'sess_abc123' },
      outputBuffer: '',
      lastOutputAt: Date.parse('2026-06-04T10:00:10.000Z'),
      now: Date.parse('2026-06-04T10:00:00.000Z'),
      excerptMax: 10,
      extractExcerpt: () => '',
    });
    assert.equal(payload.idle_seconds, 0);
  });
});
