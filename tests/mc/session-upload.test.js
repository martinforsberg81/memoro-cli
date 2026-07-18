import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  buildSessionUploadArgs,
  findLatestTranscriptForTool,
  scheduleSessionUpload,
} from '../../src/mc/session-upload.js';

describe('mc session upload scheduler', () => {
  test('resolves Claude transcripts via the Claude finder', async () => {
    const found = await findLatestTranscriptForTool({
      source: 'claude-code',
      cwd: '/repo',
      newerThanMs: 10,
      deps: {
        findLatestClaudeSession: async (args) => ({ path: '/t.jsonl', args }),
      },
    });

    assert.equal(found.path, '/t.jsonl');
    assert.deepEqual(found.args, { cwd: '/repo', newerThanMs: 10 });
  });

  test('resolves Codex transcripts via the Codex finder', async () => {
    const found = await findLatestTranscriptForTool({
      source: 'codex',
      cwd: '/repo',
      newerThanMs: 10,
      deps: {
        findLatestCodexSession: async (args) => ({ path: '/c.jsonl', args }),
      },
    });

    assert.equal(found.path, '/c.jsonl');
    assert.deepEqual(found.args, { cwd: '/repo', newerThanMs: 10 });
  });

  test('buildSessionUploadArgs targets bin.js directly with --yes', () => {
    assert.deepEqual(buildSessionUploadArgs({
      binJs: '/pkg/src/bin.js',
      transcriptPath: '/tmp/t.jsonl',
      source: 'claude-code',
      repoHint: 'repo',
      codingSessionId: 'sess_upload1',
      toolVersion: '1.2.3',
    }), [
      '/pkg/src/bin.js',
      'session',
      'upload',
      '/tmp/t.jsonl',
      '--tool',
      'claude-code',
      '--yes',
      '--repo',
      'repo',
      '--coding-session-id',
      'sess_upload1',
      '--tool-version',
      '1.2.3',
    ]);
  });

  test('scheduleSessionUpload returns no-transcript without spawning', async () => {
    let spawned = false;
    const result = await scheduleSessionUpload({
      source: 'claude-code',
      cwd: '/repo',
      deps: {
        findLatestClaudeSession: async () => null,
        spawn: () => { spawned = true; },
      },
    });

    assert.deepEqual(result, { ok: false, reason: 'no-transcript' });
    assert.equal(spawned, false);
  });

  test('scheduleSessionUpload spawns a detached upload child in the repo cwd', async () => {
    const calls = [];
    const previousToken = process.env.MEMORO_TOKEN;
    process.env.MEMORO_TOKEN = 'mem_runtime_secret';
    try {
      const result = await scheduleSessionUpload({
        source: 'claude-code',
        cwd: '/repo',
        repoHint: 'repo',
        codingSessionId: 'sess_upload1',
        deps: {
          binJs: '/pkg/src/bin.js',
          logPath: '/tmp/memoro-test-hook.log',
          findLatestClaudeSession: async () => ({ path: '/tmp/t.jsonl', cwd: '/repo' }),
          openSync: () => 99,
          spawn: (bin, args, opts) => {
            calls.push({ bin, args, opts });
            return { pid: 123, unref() { calls.push({ unref: true }); } };
          },
        },
      });

      assert.equal(result.ok, true);
      assert.equal(result.transcriptPath, '/tmp/t.jsonl');
      assert.equal(calls[0].bin, process.execPath);
      assert.deepEqual(calls[0].args.slice(0, 7), [
        '/pkg/src/bin.js',
        'session',
        'upload',
        '/tmp/t.jsonl',
        '--tool',
        'claude-code',
        '--yes',
      ]);
      assert.equal(calls[0].opts.detached, true);
      assert.equal(calls[0].opts.cwd, '/repo');
      assert.ok(calls[0].args.includes('--coding-session-id'));
      assert.equal(calls[0].args[calls[0].args.indexOf('--coding-session-id') + 1], 'sess_upload1');
      assert.equal(calls[0].opts.env.MEMORO_TOKEN, undefined);
      assert.equal(calls[1].unref, true);
    } finally {
      if (previousToken === undefined) delete process.env.MEMORO_TOKEN;
      else process.env.MEMORO_TOKEN = previousToken;
    }
  });
});
