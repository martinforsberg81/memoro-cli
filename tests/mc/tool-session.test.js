import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import * as codexAdapter from '../../src/adapters/codex.js';
import * as claudeAdapter from '../../src/adapters/claude-code.js';
import {
  buildNativeResumeArgv,
  resolveToolSessionForResume,
  toolSessionSource,
} from '../../src/mc/tool-session.js';

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
});
