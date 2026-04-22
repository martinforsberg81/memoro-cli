import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  parseTranscript,
  buildDistillPrompt,
} from '../src/lib/distill.js';

describe('parseTranscript', () => {
  test('parses standard Claude Code JSONL', () => {
    const lines = [
      { role: 'user', content: 'look at the queue', timestamp: '2026-04-21T10:00:00Z', sessionId: 's_1' },
      { role: 'assistant', content: 'sure, reading the file', timestamp: '2026-04-21T10:00:05Z' },
      { role: 'user', content: [{ type: 'text', text: 'fix the dedup' }], timestamp: '2026-04-21T10:05:00Z' },
    ].map(l => JSON.stringify(l)).join('\n');
    const out = parseTranscript(lines);
    assert.equal(out.sessionId, 's_1');
    assert.equal(out.startedAt, '2026-04-21T10:00:00Z');
    assert.equal(out.endedAt, '2026-04-21T10:05:00Z');
    assert.equal(out.messages.length, 3);
    assert.deepEqual(out.messages.map(m => m.role), ['user', 'assistant', 'user']);
    assert.equal(out.messages[2].content, 'fix the dedup');
  });

  test('opaquely summarises tool_use and tool_result blocks', () => {
    const line = JSON.stringify({
      role: 'assistant',
      content: [
        { type: 'text', text: 'I will grep the codebase.' },
        { type: 'tool_use', name: 'Grep', input: { pattern: 'foo' } },
        { type: 'tool_result', content: [{ type: 'text', text: 'SECRET TOOL OUTPUT' }] },
        { type: 'text', text: 'Found it.' },
      ],
      timestamp: '2026-04-21T10:00:00Z',
    });
    const out = parseTranscript(line);
    assert.equal(out.messages.length, 1);
    const content = out.messages[0].content;
    assert.match(content, /I will grep/);
    assert.match(content, /\[tool: Grep\]/);
    assert.match(content, /\[tool result\]/);
    // Critical: the raw tool output NEVER appears in the parsed output
    assert.doesNotMatch(content, /SECRET TOOL OUTPUT/);
  });

  test('handles malformed lines gracefully', () => {
    const input = 'not json\n{"role":"user","content":"hi"}\nalso not json';
    const out = parseTranscript(input);
    assert.equal(out.messages.length, 1);
    assert.equal(out.messages[0].content, 'hi');
  });

  test('returns empty messages for empty input', () => {
    assert.deepEqual(parseTranscript('').messages, []);
  });
});

describe('buildDistillPrompt', () => {
  test('produces a prompt that mentions schema, includes conversation, and forbids code bodies', () => {
    const parsed = {
      messages: [
        { role: 'user', content: 'do the thing' },
        { role: 'assistant', content: '[tool: Edit] made the change' },
      ],
      startedAt: '2026-04-21T10:00:00Z',
      endedAt: '2026-04-21T10:05:00Z',
      sessionId: 's_1',
    };
    const prompt = buildDistillPrompt(parsed, { repoHint: 'memoro' });
    assert.match(prompt.system, /user_turns/);
    assert.match(prompt.system, /open_threads/);
    assert.match(prompt.system, /no markdown fences/i);
    assert.match(prompt.user, /do the thing/);
    assert.equal(prompt.meta.sessionId, 's_1');
    assert.equal(prompt.meta.repoHint, 'memoro');
  });
});
