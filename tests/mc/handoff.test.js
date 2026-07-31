import assert from 'node:assert/strict';
import test from 'node:test';

import { buildHandoff, createDefenceInDepthScanner, discoverHandoffTranscript } from '../../src/mc/handoff.js';

const base = {
  codingSessionId: 'sess_abcdef',
  sequence: 2,
  parentDigest: 'a'.repeat(64),
  source: { kind: 'local', id: 'local:host-a', tool: 'claude-code', runtimeGeneration: 'gen-a' },
  workspace: { anchor: { repoId: 'repo_abc', ref: 'main', branch: 'sess_handoff' }, digest: 'b'.repeat(64) },
  content: {
    goal: 'Finish the provider handoff foundation.',
    state: 'Registry migration is complete.',
    decisions: ['Preserve provider identities.'],
    nextActions: ['Add broker journal in H3.'],
    risks: ['H2 authority remains unavailable.'],
    changedPaths: ['src/mc/registry.js'],
  },
};

test('buildHandoff emits an exact Worker v1 golden candidate without a client digest', () => {
  const one = buildHandoff(base);
  const two = buildHandoff(base);
  assert.equal(one.ok, true);
  assert.deepEqual(one, two);
  assert.deepEqual(Object.keys(one.handoff).sort(), [
    'coding_session_id', 'content', 'contract_version', 'parent_digest',
    'scanner', 'sequence', 'source', 'workspace',
  ]);
  assert.equal('digest' in one.handoff, false);
  assert.equal(isWorkerV1Wire(one.handoff), true);
  assert.deepEqual(buildHandoff({ ...base, rawTranscript: 'must never be accepted' }), { ok: false, code: 'handoff-invalid-input' });
});

function isWorkerV1Wire(value) {
  const hasExactKeys = (object, keys) => object && typeof object === 'object'
    && JSON.stringify(Object.keys(object).sort()) === JSON.stringify([...keys].sort());
  const validSafeText = (text, maxBytes) => typeof text === 'string' && text.length > 0
    && text.trim() === text && Buffer.byteLength(text) <= maxBytes && !/[\0-\x1f\x7f]/.test(text);
  if (!hasExactKeys(value, ['coding_session_id', 'content', 'contract_version', 'parent_digest', 'scanner', 'sequence', 'source', 'workspace'])) return false;
  if (value.contract_version !== 'mc-session-handoff-v1' || !/^sess_[A-Za-z0-9_-]{6,}$/.test(value.coding_session_id)
    || !Number.isSafeInteger(value.sequence) || value.sequence < 1
    || (value.sequence === 1 ? value.parent_digest !== null : !/^[a-f0-9]{64}$/.test(value.parent_digest || ''))) return false;
  if (!hasExactKeys(value.source, ['kind', 'id', 'runtime_generation', 'tool']) || value.source.kind !== 'local'
    || !/^[A-Za-z0-9._:-]{1,128}$/.test(value.source.id) || !/^[A-Za-z0-9._:-]{1,128}$/.test(value.source.runtime_generation)
    || !['codex', 'claude-code'].includes(value.source.tool)) return false;
  if (!hasExactKeys(value.workspace, ['anchor', 'digest']) || !/^[a-f0-9]{64}$/.test(value.workspace.digest)
    || !['repo_id', 'ref', 'branch'].every((key) => key in value.workspace.anchor)
    || !/^[A-Za-z0-9._:-]{1,128}$/.test(value.workspace.anchor.repo_id)
    || !validSafeText(value.workspace.anchor.ref, 256) || !validSafeText(value.workspace.anchor.branch, 256)) return false;
  if (!hasExactKeys(value.scanner, ['redaction_count', 'result', 'version']) || value.scanner.version !== 'mc-handoff-scanner-v1'
    || value.scanner.result !== 'clean' || value.scanner.redaction_count !== 0) return false;
  const content = value.content;
  if (!content || !Object.keys(content).length || Object.keys(content).some((key) => !['goal', 'state', 'decisions', 'next_actions', 'risks', 'changed_paths'].includes(key))) return false;
  return (!('goal' in content) || validSafeText(content.goal, 2048))
    && (!('state' in content) || validSafeText(content.state, 2048))
    && ['decisions', 'next_actions', 'risks'].every((key) => !Object.hasOwn(content, key)
      || (Array.isArray(content[key]) && content[key].length > 0 && content[key].length <= 12 && content[key].every((item) => validSafeText(item, 512))))
    && (!Object.hasOwn(content, 'changed_paths') || (Array.isArray(content.changed_paths) && content.changed_paths.length > 0));
}

test('sequence one allows null parent and optional content lists, but content needs a semantic value', () => {
  const first = buildHandoff({ ...base, sequence: 1, parentDigest: null, content: { goal: 'Start safely.' } });
  assert.equal(first.ok, true);
  assert.deepEqual(first.handoff.content, { goal: 'Start safely.' });
  assert.equal(isWorkerV1Wire(first.handoff), true);
  assert.equal(buildHandoff({ ...base, workspace: { anchor: { repoId: 'repo_abc', ref: 'refs/heads/feature/handoff', branch: 'sess/handoff' }, digest: 'b'.repeat(64) } }).ok, true);
  assert.deepEqual(buildHandoff({ ...base, content: {} }), { ok: false, code: 'handoff-invalid-input' });
  assert.deepEqual(buildHandoff({ ...base, content: { changedPaths: ['/absolute'] } }), { ok: false, code: 'handoff-invalid-input' });
  assert.deepEqual(buildHandoff({ ...base, content: { changedPaths: ['src/../secret'] } }), { ok: false, code: 'handoff-invalid-input' });
});

test('scanner fails closed on raw, encoded, split, opaque, uncertain, and throwing content without echoing it', () => {
  const canary = 'handoff-canary-123456';
  const scanner = createDefenceInDepthScanner({ canaries: [canary] });
  for (const value of [canary, Buffer.from(canary).toString('base64'), Buffer.from(canary).toString('hex'), 'handoff canary 123456']) {
    assert.deepEqual(buildHandoff({ ...base, content: { goal: value } }, { scan: scanner }), { ok: false, code: 'handoff-content-rejected' });
  }
  for (const value of ['sk-live-secret-123456789', 'Bearer opaque-token-value', 'access_token=opaque']) {
    assert.equal(buildHandoff({ ...base, content: { goal: value } }).ok, false);
  }
  assert.deepEqual(buildHandoff({ ...base, content: { goal: 'a'.repeat(80) } }), { ok: false, code: 'handoff-scan-uncertain' });
  assert.equal(buildHandoff({ ...base, content: { goal: 'password UI and API key settings' } }).ok, true);
  assert.deepEqual(buildHandoff(base, { scan: () => ({ ok: false, uncertain: true }) }), { ok: false, code: 'handoff-scan-uncertain' });
  assert.deepEqual(buildHandoff(base, { scan: () => { throw new Error(canary); } }), { ok: false, code: 'handoff-scan-failed' });
});

test('discoverHandoffTranscript uses only injected exact ID and generation evidence', async () => {
  const success = await discoverHandoffTranscript({
    provider: 'claude', expectedSessionId: 'cl_1', runtimeGeneration: 'gen-1',
    find: async (input) => ({ sessionId: input.expectedSessionId, runtimeGeneration: input.runtimeGeneration }),
  });
  assert.equal(success.ok, true);
  for (const found of [null, { sessionId: 'other', runtimeGeneration: 'gen-1' }, { sessionId: 'cl_1' }, { sessionId: 'cl_1', runtimeGeneration: 'gen-other' }]) {
    const result = await discoverHandoffTranscript({ provider: 'claude-code', expectedSessionId: 'cl_1', runtimeGeneration: 'gen-1', find: async () => found });
    assert.equal(result.ok, false);
  }
  assert.deepEqual(await discoverHandoffTranscript({ provider: 'codex', expectedSessionId: 'cx_1', runtimeGeneration: 'gen-1', find: async () => { throw new Error('secret'); } }), { ok: false, code: 'handoff-transcript-unavailable' });
});
