import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  CLEANED_CONVERSATION_MAX_BYTES,
  parseTranscript,
  buildSessionPayload,
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

  test('captures safe tool activity alongside messages', () => {
    const lines = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will inspect the file.' },
          { type: 'tool_use', name: 'Read', input: { file_path: 'src/foo.js' } },
        ],
        timestamp: '2026-04-21T10:00:00Z',
      },
    ].map(line => JSON.stringify(line)).join('\n');

    const out = parseTranscript(lines);
    assert.equal(out.activities.length, 1);
    assert.deepEqual(out.activities[0], {
      kind: 'tool_call',
      actor: 'assistant',
      tool_name: 'Read',
      summary: 'Read on src/foo.js',
      safe_metadata: { file_path: 'src/foo.js' },
      at: '2026-04-21T10:00:00Z',
    });
  });

  test('handles malformed lines gracefully', () => {
    const input = 'not json\n{"role":"user","content":"hi"}\nalso not json';
    const out = parseTranscript(input);
    assert.equal(out.messages.length, 1);
    assert.equal(out.messages[0].content, 'hi');
  });

  test('parses Codex JSONL message events', () => {
    const lines = [
      {
        timestamp: '2026-04-23T10:00:00Z',
        type: 'session_meta',
        payload: {
          id: 'cx_1',
          timestamp: '2026-04-23T10:00:00Z',
          cwd: '/tmp/repo',
          cli_version: '0.101.0',
        },
      },
      {
        timestamp: '2026-04-23T10:00:05Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'inspect the failing test' }],
        },
      },
      {
        timestamp: '2026-04-23T10:00:15Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'I checked the test and found the null case.' }],
        },
      },
    ].map(l => JSON.stringify(l)).join('\n');

    const out = parseTranscript(lines, { tool: 'codex' });
    assert.equal(out.sessionId, 'cx_1');
    assert.equal(out.cwd, '/tmp/repo');
    assert.equal(out.toolVersion, '0.101.0');
    assert.equal(out.modelProvider, 'openai');
    assert.equal(out.messages.length, 2);
    assert.deepEqual(out.messages.map(m => m.role), ['user', 'assistant']);
    assert.equal(out.messages[0].content, 'inspect the failing test');
  });

  test('returns empty messages for empty input', () => {
    assert.deepEqual(parseTranscript('').messages, []);
  });
});

describe('buildSessionPayload', () => {
  test('builds a cleaned conversation payload from Claude-style turns', () => {
    const parsed = {
      messages: [
        { role: 'user', content: 'do the thing', at: '2026-04-21T10:00:00Z' },
        { role: 'assistant', content: '[tool: Edit] made the change', at: '2026-04-21T10:00:05Z' },
      ],
      startedAt: '2026-04-21T10:00:00Z',
      endedAt: '2026-04-21T10:05:00Z',
      sessionId: 's_1',
    };
    const payload = buildSessionPayload({
      parsed,
      repoHint: 'memoro',
      toolVersion: '1.2.3',
      source: 'claude-code',
      codingSessionId: 'sess_payload1',
    });

    assert.equal(payload.source, 'claude-code');
    assert.equal(payload.session_id, 's_1');
    assert.equal(payload.coding_session_id, 'sess_payload1');
    assert.equal(payload.repo_hint, 'memoro');
    assert.equal(payload.tool_version, '1.2.3');
    assert.deepEqual(payload.cleaned_conversation, [
      {
        kind: 'message',
        role: 'user',
        content: 'do the thing',
        at: '2026-04-21T10:00:00Z',
      },
      {
        kind: 'message',
        role: 'assistant',
        content: '[tool: Edit] made the change',
        at: '2026-04-21T10:00:05Z',
      },
    ]);
  });

  test('builds a cleaned conversation payload from Codex transcript output', () => {
    const raw = [
      {
        timestamp: '2026-04-23T10:00:00Z',
        type: 'session_meta',
        payload: {
          id: 'cx_1',
          cwd: '/tmp/repo',
          cli_version: '0.101.0',
        },
      },
      {
        timestamp: '2026-04-23T10:00:05Z',
        type: 'turn_context',
        payload: {
          model: 'gpt-5.4',
        },
      },
      {
        timestamp: '2026-04-23T10:00:05Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Check the flaky retry test.' }],
        },
      },
      {
        timestamp: '2026-04-23T10:00:15Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'I found the retry assertion race and tightened the wait.' }],
        },
      },
    ].map(line => JSON.stringify(line)).join('\n');

    const parsed = parseTranscript(raw, { tool: 'codex' });
    const payload = buildSessionPayload({
      parsed,
      source: 'codex',
      toolVersion: parsed.toolVersion,
    });

    assert.equal(payload.source, 'codex');
    assert.equal(payload.session_id, 'cx_1');
    assert.equal(payload.tool_version, '0.101.0');
    assert.equal(parsed.modelProvider, 'openai');
    assert.equal(parsed.modelName, 'gpt-5.4');
    assert.deepEqual(payload.cleaned_conversation, [
      {
        kind: 'message',
        role: 'user',
        content: 'Check the flaky retry test.',
        at: '2026-04-23T10:00:05Z',
      },
      {
        kind: 'message',
        role: 'assistant',
        content: 'I found the retry assertion race and tightened the wait.',
        at: '2026-04-23T10:00:15Z',
      },
    ]);
  });

  test('a payload under the byte budget is not marked truncated', () => {
    const payload = buildSessionPayload({
      parsed: {
        messages: [{ role: 'user', content: 'small', at: '2026-04-21T10:00:00Z' }],
        sessionId: 's_small',
      },
    });
    assert.equal(payload.conversation_truncated, undefined);
    assert.equal(payload.conversation_dropped, undefined);
  });

  test('an oversized conversation is bounded newest-first with truncation metadata', () => {
    const chunk = 'x'.repeat(1024);
    const messages = Array.from({ length: 600 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `${i}:${chunk}`,
      at: `2026-04-21T10:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z`,
    }));
    const payload = buildSessionPayload({
      parsed: { messages, sessionId: 's_big' },
    });

    const bytes = Buffer.byteLength(JSON.stringify(payload.cleaned_conversation), 'utf8');
    assert.ok(bytes <= CLEANED_CONVERSATION_MAX_BYTES, `bounded payload is ${bytes} bytes`);
    assert.equal(payload.conversation_truncated, true);
    const kept = payload.cleaned_conversation;
    // Newest entries survive; the oldest are what gets dropped.
    assert.equal(kept[kept.length - 1].content, messages[messages.length - 1].content);
    assert.equal(payload.conversation_dropped.messages, messages.length - kept.length);
    assert.equal(payload.conversation_dropped.activities, 0);
  });

  test('a single entry larger than the whole budget is cut to fit, not dropped', () => {
    const payload = buildSessionPayload({
      parsed: {
        messages: [
          { role: 'user', content: 'old context', at: '2026-04-21T10:00:00Z' },
          { role: 'assistant', content: 'y'.repeat(400 * 1024), at: '2026-04-21T10:00:05Z' },
        ],
        sessionId: 's_huge',
      },
    });

    assert.equal(payload.cleaned_conversation.length, 1);
    assert.equal(payload.cleaned_conversation[0].content_truncated, true);
    const bytes = Buffer.byteLength(JSON.stringify(payload.cleaned_conversation), 'utf8');
    assert.ok(bytes <= CLEANED_CONVERSATION_MAX_BYTES, `truncated entry payload is ${bytes} bytes`);
    assert.equal(payload.conversation_truncated, true);
    assert.equal(payload.conversation_dropped.messages, 1);
  });
});
