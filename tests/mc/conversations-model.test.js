/**
 * The model a conversation ran on, read from its own transcript.
 *
 * This is the persistence mechanism for `--model` in the work world: nothing
 * is stored, the transcript is the record. These fixtures mirror the real
 * shapes on disk — Claude stamps `message.model` on assistant entries (and
 * `<synthetic>` on ones the model never produced), Codex writes a
 * `turn_context` per turn with `payload.model`.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { conversationModel, lastModel } from '../../src/mc/conversations.js';

function transcript(lines) {
  const dir = mkdtempSync(join(tmpdir(), 'mc-model-'));
  const path = join(dir, 'transcript.jsonl');
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  return path;
}

describe('conversation model from transcript', () => {
  it('claude: the last assistant turn names the model', () => {
    const path = transcript([
      { type: 'user', message: { content: 'hello' } },
      { type: 'assistant', message: { model: 'claude-sonnet-4', content: [] } },
      { type: 'assistant', message: { model: 'claude-fable-5', content: [] } },
    ]);
    assert.equal(conversationModel({ tool: 'claude-code', path }), 'claude-fable-5');
  });

  it('claude: synthetic entries are not an answer', () => {
    const path = transcript([
      { type: 'assistant', message: { model: 'claude-fable-5', content: [] } },
      { type: 'assistant', message: { model: '<synthetic>', content: [] } },
    ]);
    assert.equal(conversationModel({ tool: 'claude-code', path }), 'claude-fable-5');
  });

  it('codex: the last turn_context wins when the model changed mid-way', () => {
    const path = transcript([
      { type: 'turn_context', payload: { model: 'gpt-5.2-codex', cwd: '/x' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: 'hi' } },
      { type: 'turn_context', payload: { model: 'gpt-5.3-codex-spark', cwd: '/x' } },
    ]);
    assert.equal(conversationModel({ tool: 'codex', path }), 'gpt-5.3-codex-spark');
  });

  it('a transcript that never names one yields nothing, not a guess', () => {
    const path = transcript([
      { type: 'user', message: { content: 'hello' } },
    ]);
    assert.equal(conversationModel({ tool: 'claude-code', path }), null);
    assert.equal(conversationModel({ tool: 'codex', path: null }), null);
    assert.equal(conversationModel({ tool: 'codex', path: '/nowhere/at/all.jsonl' }), null);
  });

  it('lastModel answers the same question over already-parsed entries', () => {
    const entries = [
      { type: 'turn_context', payload: { model: 'gpt-5.3-codex' } },
      { type: 'assistant', message: { model: 'claude-fable-5' } },
    ];
    assert.equal(lastModel('codex', entries), 'gpt-5.3-codex');
    assert.equal(lastModel('claude-code', entries), 'claude-fable-5');
    assert.equal(lastModel('claude-code', []), null);
  });
});
