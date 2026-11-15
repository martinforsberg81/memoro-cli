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

import { conversationModel, lastModel, listConversations } from '../../src/mc/conversations.js';
import { agyStore } from './_helpers/agy-store.js';

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

  it('a model pushed out of the near tail by one huge entry is still found', () => {
    // 300 KB of model-less filler after the last model-naming entry: the
    // 256 KB near tail sees none of it, and the wider second look must.
    const filler = { type: 'user', message: { content: 'x'.repeat(1024) } };
    const path = transcript([
      { type: 'assistant', message: { model: 'claude-fable-5', content: [] } },
      ...Array.from({ length: 300 }, () => filler),
    ]);
    assert.equal(conversationModel({ tool: 'claude-code', path }), 'claude-fable-5');
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

describe('agy: the model and the listing come from its own transcript and database', () => {
  const A = '11111111-2222-3333-4444-555555555555';
  const B = '66666666-7777-8888-9999-000000000000';
  const C = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const D = 'dddddddd-1111-2222-3333-444444444444';
  const AREA = '/work/plan/example';
  const NONCE = '0a0b0c0d-1111-4222-8333-444455556666';

  it('the last planner response that names a model wins; a user step or an empty one is not an answer', () => {
    const entries = [
      { type: 'PLANNER_RESPONSE', model: 'gemini-4-argon-high', content: 'a' },
      { type: 'USER_INPUT', content: 'again' },
      { type: 'PLANNER_RESPONSE', model: 'gemini-4-flash', content: 'b' },
      { type: 'PLANNER_RESPONSE', content: 'c' },
      { type: 'GENERIC', model: 'not-this-one' },
    ];
    assert.equal(lastModel('antigravity-cli', entries), 'gemini-4-flash');
    assert.equal(lastModel('antigravity-cli', [{ type: 'USER_INPUT', content: 'x' }]), null);
    assert.equal(lastModel('antigravity-cli', []), null);
  });

  it('conversationModel reads it from the transcript file', () => {
    const store = agyStore();
    const { path } = store.addConversation({ id: A, workspace: AREA, model: 'gemini-4-argon-high' });
    assert.equal(conversationModel({ tool: 'antigravity-cli', path }), 'gemini-4-argon-high');
    const none = store.addConversation({ id: B, workspace: AREA });
    assert.equal(conversationModel({ tool: 'antigravity-cli', path: none.path }), null);
  });

  it('lists a conversation under the canonical tool id, with its nonce, label and workspace', () => {
    const store = agyStore();
    store.addConversation({ id: A, workspace: AREA, content: store.opening({ launch: NONCE, role: 'plan', programme: 'example', words: 'fix the build' }) });
    const [item, ...rest] = listConversations(AREA, store.env).filter((entry) => entry.tool === 'antigravity-cli');
    assert.equal(rest.length, 0);
    assert.equal(item.id, A);
    assert.equal(item.cwd, AREA);
    assert.equal(item.nonce, NONCE);
    assert.match(item.label, /fix the build/u);
    assert.ok(item.bytes > 0 && item.updated_ms > 0 && item.created_ms > 0);
  });

  it('a conversation with no readable database, no workspace, another workspace or a non-id name is not listed', () => {
    const store = agyStore();
    store.addConversation({ id: A, workspace: AREA });
    store.addConversation({ id: B, workspace: AREA, db: false });
    store.addConversation({ id: C, workspaces: [] });
    store.addConversation({ id: D, workspace: '/work/plan/other' });
    store.addConversation({ id: 'not-a-conversation', workspace: AREA });
    store.addConversation({ id: '99999999-0000-0000-0000-000000000000', workspace: AREA, blob: Buffer.from('not a protobuf at all') });
    const listed = listConversations(AREA, store.env).filter((entry) => entry.tool === 'antigravity-cli').map((entry) => entry.id);
    assert.deepEqual(listed, [A]);
  });

  it('a workspace inside the area lists the conversation; a sibling that shares a prefix does not', () => {
    const store = agyStore();
    store.addConversation({ id: A, workspace: `${AREA}/memoro-cli` });
    store.addConversation({ id: B, workspace: `${AREA}-two` });
    const listed = listConversations(AREA, store.env).filter((entry) => entry.tool === 'antigravity-cli').map((entry) => entry.id);
    assert.deepEqual(listed, [A]);
  });

  it('an unmarked conversation lists with no nonce, and a quoted marker is not one', () => {
    const store = agyStore();
    store.addConversation({ id: A, workspace: AREA, content: 'plain words' });
    store.addConversation({ id: B, workspace: AREA, content: `<USER_REQUEST>\nlook: ${store.opening({ launch: NONCE })}\n</USER_REQUEST>` });
    const nonces = Object.fromEntries(listConversations(AREA, store.env).filter((entry) => entry.tool === 'antigravity-cli').map((entry) => [entry.id, entry.nonce]));
    assert.deepEqual(nonces, { [A]: null, [B]: null });
  });
});
