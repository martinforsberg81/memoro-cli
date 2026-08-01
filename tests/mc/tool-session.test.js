import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import * as codexAdapter from '../../src/adapters/codex.js';
import * as claudeAdapter from '../../src/adapters/claude-code.js';
import {
  buildNativeResumeArgv,
  mintToolSessionForLaunch,
  resolveToolSessionForResume,
  toolSessionSource,
} from '../../src/mc/tool-session.js';
import { LOCAL_AUTH_MODES } from '../../src/mc/local-auth-mode.js';

describe('mc provider-native tool sessions', () => {
  test('uses a stored tool_session_id before transcript lookup', async () => {
    let lookedUp = false;
    const resolved = await resolveToolSessionForResume({
      entry: {
        name: 'data',
        tool: 'codex',
        tool_session_id: 'cx_stored',
        tool_session_source: 'codex',
        tool_transcript_path: '/tmp/codex.jsonl',
      },
      launchTool: { id: 'codex', shortName: 'codex', adapter: codexAdapter },
      deps: {
        findLatestTranscriptForTool: async () => {
          lookedUp = true;
          return null;
        },
      },
    });

    assert.equal(resolved.ok, true);
    assert.equal(resolved.sessionId, 'cx_stored');
    assert.equal(resolved.source, 'codex');
    assert.equal(resolved.transcriptPath, '/tmp/codex.jsonl');
    assert.equal(resolved.from, 'registry');
    assert.equal(lookedUp, false);
  });

  test('repairs a stored session whose transcript path was not persisted', async () => {
    const resolved = await resolveToolSessionForResume({
      entry: {
        name: 'data',
        tool: 'codex',
        worktree_path: '/repo/data',
        tool_session_id: 'cx_stored',
        tool_session_source: 'codex',
        tool_transcript_path: null,
      },
      launchTool: { id: 'codex', shortName: 'codex', adapter: codexAdapter },
      deps: {
        findTranscriptForToolSession: async ({ sessionId }) => ({
          path: '/tmp/codex.jsonl',
          sessionId,
        }),
      },
    });

    assert.deepEqual(resolved, {
      ok: true,
      source: 'codex',
      sessionId: 'cx_stored',
      transcriptPath: '/tmp/codex.jsonl',
      from: 'transcript-repaired',
    });
  });

  test('does not repair from a transcript belonging to another session', async () => {
    const resolved = await resolveToolSessionForResume({
      entry: {
        tool: 'codex',
        worktree_path: '/repo/data',
        tool_session_id: 'cx_stored',
        tool_session_source: 'codex',
      },
      launchTool: { id: 'codex', shortName: 'codex', adapter: codexAdapter },
      deps: {
        findTranscriptForToolSession: async () => ({
          path: '/tmp/other.jsonl',
          sessionId: 'cx_other',
        }),
      },
    });

    assert.equal(resolved.ok, true);
    assert.equal(resolved.sessionId, 'cx_stored');
    assert.equal(resolved.transcriptPath, null);
    assert.equal(resolved.from, 'registry');
  });

  test('discovers an old provider session id from the latest matching transcript', async () => {
    const calls = [];
    const resolved = await resolveToolSessionForResume({
      entry: {
        name: 'data',
        tool: 'claude',
        worktree_path: '/repo/data',
      },
      launchTool: { id: 'claude-code', shortName: 'claude', adapter: claudeAdapter },
      deps: {
        findLatestTranscriptForTool: async (args) => {
          calls.push(args);
          return {
            path: '/tmp/claude.jsonl',
            sessionId: 'cl_discovered',
          };
        },
      },
    });

    assert.equal(resolved.ok, true);
    assert.equal(resolved.sessionId, 'cl_discovered');
    assert.equal(resolved.source, 'claude-code');
    assert.equal(resolved.transcriptPath, '/tmp/claude.jsonl');
    assert.equal(resolved.from, 'transcript');
    assert.equal(calls[0].source, 'claude-code');
    assert.equal(calls[0].cwd, '/repo/data');
  });

  test('uses only the selected provider projection and never reuses another provider native id', async () => {
    let lookedUp = false;
    const resolved = await resolveToolSessionForResume({
      entry: {
        tool: 'claude',
        provider_sessions: {
          schema: 1,
          providers: {
            codex: { session_id: 'cx_a', transcript_path: null, runtime_generation: null, last_consumed_handoff_sequence: 3 },
            'claude-code': { session_id: 'cl_b', transcript_path: '/tmp/claude.jsonl', runtime_generation: null, last_consumed_handoff_sequence: 7 },
          },
        },
      },
      launchTool: { id: 'claude-code', shortName: 'claude', adapter: claudeAdapter },
      deps: { findLatestTranscriptForTool: async () => { lookedUp = true; return null; } },
    });
    assert.equal(resolved.sessionId, 'cl_b');
    assert.equal(lookedUp, false);
  });

  test('does not fall back to another provider legacy id when the selected projection is absent', async () => {
    const resolved = await resolveToolSessionForResume({
      entry: {
        tool: 'claude',
        tool_session_id: 'cx_legacy',
        tool_session_source: 'codex',
        provider_sessions: {
          schema: 1,
          providers: {
            codex: {
              session_id: 'cx_a',
              transcript_path: null,
              runtime_generation: 'gen-a',
              last_consumed_handoff_sequence: 3,
            },
          },
        },
      },
      launchTool: { id: 'claude-code', shortName: 'claude', adapter: claudeAdapter },
      deps: {
        findLatestTranscriptForTool: async ({ source }) => {
          assert.equal(source, 'claude-code');
          return null;
        },
      },
    });
    assert.deepEqual(resolved, {
      ok: false,
      reason: 'no-tool-session-id',
      source: 'claude-code',
      sessionId: null,
      transcriptPath: null,
    });
  });

  test('does not borrow a legacy transcript path for a selected provider projection', async () => {
    const resolved = await resolveToolSessionForResume({
      entry: {
        tool: 'claude',
        tool_transcript_path: '/tmp/codex.jsonl',
        provider_sessions: {
          schema: 1,
          providers: {
            'claude-code': {
              session_id: 'cl_b',
              transcript_path: null,
              runtime_generation: null,
              last_consumed_handoff_sequence: 0,
            },
          },
        },
      },
      launchTool: { id: 'claude-code', shortName: 'claude', adapter: claudeAdapter },
    });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.sessionId, 'cl_b');
    assert.equal(resolved.transcriptPath, null);
  });

  test('rejects unsafe legacy and discovered provider session data', async () => {
    const unsafeLegacy = await resolveToolSessionForResume({
      entry: { tool: 'codex', provider_session_id: '../unsafe' },
      launchTool: { id: 'codex', shortName: 'codex', adapter: codexAdapter },
      deps: {
        findTranscriptForToolSession: async () => assert.fail('invalid id must not reach lookup'),
      },
    });
    assert.equal(unsafeLegacy.ok, false);
    assert.equal(unsafeLegacy.reason, 'invalid-provider-session');

    const paddedLegacy = await resolveToolSessionForResume({
      entry: { tool: 'codex', provider_session_id: ' cx_padded' },
      launchTool: { id: 'codex', shortName: 'codex', adapter: codexAdapter },
    });
    assert.equal(paddedLegacy.ok, false);
    assert.equal(paddedLegacy.reason, 'invalid-provider-session');

    const unsafeDiscovered = await resolveToolSessionForResume({
      entry: { tool: 'codex', worktree_path: '/repo/data' },
      launchTool: { id: 'codex', shortName: 'codex', adapter: codexAdapter },
      deps: {
        findLatestTranscriptForTool: async () => ({
          path: 'relative/transcript.jsonl',
          sessionId: 'cx_discovered',
        }),
      },
    });
    assert.equal(unsafeDiscovered.ok, false);
    assert.equal(unsafeDiscovered.reason, 'invalid-provider-session');

    const paddedDiscovered = await resolveToolSessionForResume({
      entry: { tool: 'codex', worktree_path: '/repo/data' },
      launchTool: { id: 'codex', shortName: 'codex', adapter: codexAdapter },
      deps: {
        findLatestTranscriptForTool: async () => ({
          path: ' /tmp/transcript.jsonl',
          sessionId: 'cx_discovered',
        }),
      },
    });
    assert.equal(paddedDiscovered.ok, false);
    assert.equal(paddedDiscovered.reason, 'invalid-provider-session');
  });

  test('invalid provider projections fail closed instead of falling back to legacy ids', async () => {
    const resolved = await resolveToolSessionForResume({
      entry: { tool: 'codex', tool_session_id: 'cx_legacy', provider_sessions: { schema: 2, providers: {} } },
      launchTool: { id: 'codex', shortName: 'codex', adapter: codexAdapter },
    });
    assert.deepEqual(resolved, {
      ok: false, reason: 'provider-sessions-invalid', source: 'codex', sessionId: null, transcriptPath: null,
    });
  });

  test('builds adapter-native resume argv without a cross-provider prompt', () => {
    assert.deepEqual(buildNativeResumeArgv({
      entry: { tool: 'codex' },
      launchTool: { id: 'codex', adapter: codexAdapter },
      sessionId: 'cx_123',
    }), { ok: true, argv: ['resume', 'cx_123'] });

    assert.deepEqual(buildNativeResumeArgv({
      entry: { tool: 'claude' },
      launchTool: { id: 'claude-code', adapter: claudeAdapter },
      sessionId: 'cl_123',
    }), { ok: true, argv: ['--resume', 'cl_123'] });
  });

  test('normalizes tool sources for transcript lookup', () => {
    assert.equal(toolSessionSource({ entry: { tool: 'claude' } }), 'claude-code');
    assert.equal(toolSessionSource({ entry: { tool: 'codex' } }), 'codex');
  });

  test('mints a claude session id with launch argv and source at native launch', () => {
    const id = '3e6fc8d2-1ad9-4428-a351-8f7abfa088a6';
    const minted = mintToolSessionForLaunch({
      launchTool: { id: 'claude-code', shortName: 'claude', adapter: claudeAdapter },
      localAuthMode: LOCAL_AUTH_MODES.NATIVE,
      uuid: () => id,
    });
    assert.deepEqual(minted, {
      sessionId: id,
      source: 'claude-code',
      argv: ['--session-id', id],
    });
  });

  test('does not mint for adapters without newSessionArgs', () => {
    assert.equal(mintToolSessionForLaunch({
      launchTool: { id: 'codex', shortName: 'codex', adapter: codexAdapter },
      localAuthMode: LOCAL_AUTH_MODES.NATIVE,
    }), null);
    assert.equal(mintToolSessionForLaunch({ launchTool: null }), null);
    assert.equal(mintToolSessionForLaunch(), null);
  });

  test('does not mint outside native custody', () => {
    assert.equal(mintToolSessionForLaunch({
      launchTool: { id: 'claude-code', shortName: 'claude', adapter: claudeAdapter },
      localAuthMode: LOCAL_AUTH_MODES.MANAGED_PORTABLE,
    }), null);
  });
});
