import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFetchTranscriptHandler } from '../../../src/commands/handlers/fetch-transcript.js';

const SAMPLE_CC_JSONL = [
  JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }),
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] } }),
].join('\n');

describe('createFetchTranscriptHandler', () => {
  test('throws when transcriptPath was not supplied', async () => {
    const handler = createFetchTranscriptHandler({ transcriptPath: null });
    await assert.rejects(
      () => handler({}),
      /transcript_path was not supplied/,
    );
  });

  test('throws when the file does not exist', async () => {
    const handler = createFetchTranscriptHandler({ transcriptPath: '/no/such/file.jsonl' });
    await assert.rejects(
      () => handler({}),
      /transcript file not found/,
    );
  });

  test('reads and parses a JSONL transcript into messages', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'memoro-cli-tx-'));
    try {
      const file = join(dir, 't.jsonl');
      await writeFile(file, SAMPLE_CC_JSONL);
      const handler = createFetchTranscriptHandler({ transcriptPath: file });
      const out = await handler({});
      assert.equal(out.source, 'claude-code');
      assert.ok(Array.isArray(out.messages));
      assert.ok(out.messages.length >= 2);
      const roles = out.messages.map((m) => m.role);
      assert.ok(roles.includes('user'));
      assert.ok(roles.includes('assistant'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('preserves the source label used at construction', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'memoro-cli-tx-codex-'));
    try {
      const file = join(dir, 't.jsonl');
      await writeFile(file, SAMPLE_CC_JSONL);
      const handler = createFetchTranscriptHandler({
        transcriptPath: file,
        source: 'codex',
      });
      const out = await handler({});
      assert.equal(out.source, 'codex');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('reuses parsed output while the transcript file is unchanged', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'memoro-cli-tx-cache-'));
    try {
      const file = join(dir, 't.jsonl');
      await writeFile(file, SAMPLE_CC_JSONL);
      const handler = createFetchTranscriptHandler({ transcriptPath: file });
      const first = await handler({});
      const second = await handler({});
      assert.equal(second, first);

      await writeFile(file, [
        SAMPLE_CC_JSONL,
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'one more' } }),
      ].join('\n'));
      const changed = await handler({});
      assert.notEqual(changed, first);
      assert.equal(changed.messages.at(-1).content, 'one more');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('returns null metadata fields when transcript lacks them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'memoro-cli-tx-bare-'));
    try {
      const file = join(dir, 't.jsonl');
      await writeFile(file, SAMPLE_CC_JSONL);
      const handler = createFetchTranscriptHandler({ transcriptPath: file });
      const out = await handler({});
      // Sample has no cwd / session_id / version metadata.
      assert.equal(out.session_id, null);
      assert.equal(out.cwd, null);
      assert.equal(out.tool_version, null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
