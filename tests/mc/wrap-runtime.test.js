import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { join } from 'node:path';

import {
  buildHeartbeatBase,
  buildHeartbeatPayload,
  buildSessionMeta,
  buildWrapExitRegistryPatch,
  buildWrapLookupIdentity,
  buildWrapStartRegistryPatch,
  resolveCodingSessionIdForWrap,
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
      tool: 'codex',
      source: 'codex',
      toolSessionId: 'cx_123',
      transcriptPath: '/tmp/codex.jsonl',
      now: new Date('2026-06-04T10:00:00.000Z'),
    });
    assert.deepEqual(meta, {
      runtime_manifest_version: 1,
      cleanup_owner: 'mc',
      coding_session_id: 'sess_abc123',
      label: 'audit',
      tool: 'codex',
      source: 'codex',
      tool_session_id: 'cx_123',
      tool_transcript_path: '/tmp/codex.jsonl',
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
      source_id: 'local:host-a',
      source_kind: 'local',
      source_name: 'host-a',
      cloud_session_id: null,
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

  test('adds only a validated metadata projection to the heartbeat', () => {
    const projection = {
      contract_version: 'mc-session-projection-v1',
      status: 'active',
      reason_code: 'recent_output',
      observed_at: '2026-06-04T10:00:00.000Z',
      classifier_version: 'mc-session-projector-v1',
      classification_basis: 'runtime_fallback',
      runtime: null,
      git: null,
    };
    const payload = buildHeartbeatPayload({
      base: { coding_session_id: 'sess_abc123' },
      now: Date.parse('2026-06-04T10:00:00.000Z'),
      excerptMax: 10,
      extractExcerpt: () => '',
      sessionProjection: projection,
    });
    assert.deepEqual(payload.session_projection, projection);

    const rejected = buildHeartbeatPayload({
      base: { coding_session_id: 'sess_abc123' },
      now: Date.parse('2026-06-04T10:00:00.000Z'),
      excerptMax: 10,
      extractExcerpt: () => '',
      sessionProjection: { ...projection, raw_output: 'secret' },
    });
    assert.equal(Object.hasOwn(rejected, 'session_projection'), false);
  });
});

describe('wrap coding session identity', () => {
  test('named sessions reuse the registry coding_session_id without minting', async () => {
    let called = false;
    const res = await resolveCodingSessionIdForWrap({
      sessionName: 'data',
      registryEntry: { name: 'data', coding_session_id: 'sess_registry' },
      repoIdentity: 'git@github.com:acme/memoro.git',
      machineId: 'host-a',
      lookupOrMint: async () => {
        called = true;
        return 'sess_new';
      },
    });
    assert.equal(res.codingSessionId, 'sess_registry');
    assert.equal(res.source, 'registry');
    assert.equal(called, false);
  });

  test('named sessions mint through a stable per-session lookup key', async () => {
    const seen = [];
    const res = await resolveCodingSessionIdForWrap({
      sessionName: 'data',
      registryEntry: { name: 'data', coding_session_id: null },
      repoIdentity: 'git@github.com:acme/memoro.git',
      machineId: 'host-a',
      nowMs: 123,
      pid: 456,
      lookupOrMint: async (identity) => {
        seen.push(identity);
        return 'sess_stable';
      },
    });
    assert.equal(res.codingSessionId, 'sess_stable');
    assert.equal(res.source, 'stable-session-name');
    assert.deepEqual(seen, [{
      repoIdentity: 'git@github.com:acme/memoro.git',
      machineId: 'host-a',
      llmSessionId: 'mc-session:data',
    }]);
  });

  test('bare mc keeps per-runtime lookup identity', () => {
    assert.deepEqual(buildWrapLookupIdentity({
      repoIdentity: 'origin',
      machineId: 'host-a',
      nowMs: 123,
      pid: 456,
    }), {
      repoIdentity: 'origin',
      machineId: 'host-a',
      llmSessionId: 'mc-123-456',
    });
  });
});

describe('wrap registry lifecycle patches', () => {
  test('start patch marks named sessions live without dropping stable id', () => {
    const patch = buildWrapStartRegistryPatch({
      sessionName: 'data',
      codingSessionId: 'sess_abc123',
      tool: 'codex',
      heartbeatSource: 'codex',
      repoContext,
      cwd: '/repo/memoro',
      machineId: 'host-a',
      pid: 12345,
      now: new Date('2026-06-04T10:00:00.000Z'),
    });
    assert.deepEqual(patch, {
      name: 'data',
      coding_session_id: 'sess_abc123',
      session_state: 'live',
      last_activity: '2026-06-04T10:00:00.000Z',
      last_started_at: '2026-06-04T10:00:00.000Z',
      last_pid: 12345,
      machine_id: 'host-a',
      tool: 'codex',
      source: 'codex',
      branch: 'main',
      worktree_path: '/repo/memoro',
    });
  });

  test('exit patch marks clean exits idle and failed exits dead', () => {
    assert.equal(buildWrapExitRegistryPatch({
      sessionName: 'data',
      codingSessionId: 'sess_abc123',
      exitCode: 0,
      now: new Date('2026-06-04T10:00:00.000Z'),
    }).session_state, 'idle');
    assert.equal(buildWrapExitRegistryPatch({
      sessionName: 'data',
      codingSessionId: 'sess_abc123',
      exitCode: 2,
      now: new Date('2026-06-04T10:00:00.000Z'),
    }).session_state, 'dead');
  });

  test('registry patches are skipped for unnamed bare mc', () => {
    assert.equal(buildWrapStartRegistryPatch({
      sessionName: null,
      codingSessionId: 'sess_abc123',
    }), null);
    assert.equal(buildWrapExitRegistryPatch({
      sessionName: null,
      codingSessionId: 'sess_abc123',
    }), null);
  });
});
