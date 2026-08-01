import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fetchStrictHandoffContext,
  persistSessionHandoff,
  renderHandoffUserMessage,
  validateHandoffContext,
} from '../../src/mc/handoff-client.js';

const digest1 = 'a'.repeat(64);
const digest2 = 'b'.repeat(64);

function row(sequence = 1, overrides = {}) {
  return {
    contract_version: 'mc-session-handoff-v1',
    sequence,
    digest: sequence === 1 ? digest1 : digest2,
    parent_digest: sequence === 1 ? null : digest1,
    source: {
      kind: 'local',
      id: 'device:laptop',
      tool: sequence === 1 ? 'claude-code' : 'codex',
      runtime_generation: `generation-${sequence}`,
    },
    workspace: {
      anchor: {
        repo_id: 'repo_memoro',
        ref: '1'.repeat(40),
        branch: 'sess/handoff',
      },
      digest: 'c'.repeat(64),
    },
    content: {
      goal: 'Complete the provider handoff.',
      state: 'The source provider ended with one changed workspace path.',
      changed_paths: ['src/mc/handoff.js'],
    },
    scanner: {
      version: 'mc-server-handoff-scanner-v1',
      result: 'clean',
      redaction_count: 0,
    },
    created_at: '2026-07-28T12:00:00.000Z',
    ...overrides,
  };
}

function context(consumedSequence = 0, rows = [row(1)]) {
  const latest = rows.at(-1)?.sequence || consumedSequence;
  return {
    continuity: {
      contract_version: 'mc-session-handoff-v1',
      capability: 'session_handoff_v1',
      status: 'ready',
      consumed_sequence: consumedSequence,
      latest_sequence: latest,
      latest_digest: rows.at(-1)?.digest || (consumedSequence ? digest1 : null),
    },
    session_handoffs: rows,
  };
}

test('strict context requires a ready contiguous chain after the exact cursor', () => {
  const valid = validateHandoffContext(context(0, [row(1), row(2)]), {
    codingSessionId: 'sess_context1',
    consumedSequence: 0,
  });
  assert.equal(valid.ok, true);
  assert.deepEqual(valid.handoffs.map((item) => item.sequence), [1, 2]);
  assert.equal(valid.continuity.latestDigest, digest2);

  const gap = context(0, [row(1), row(2, { sequence: 3 })]);
  assert.equal(validateHandoffContext(gap, {
    codingSessionId: 'sess_context1',
    consumedSequence: 0,
  }).code, 'handoff-chain-invalid');

  const unavailable = context(1, []);
  unavailable.continuity.status = 'handoff_chain_gap';
  assert.equal(validateHandoffContext(unavailable, {
    codingSessionId: 'sess_context1',
    consumedSequence: 1,
  }).code, 'handoff-continuity-handoff_chain_gap');
});

test('legacy context without handoff fields reports an unavailable capability', () => {
  assert.deepEqual(validateHandoffContext({
    version: 'mc-context-v1',
    repo: null,
    session: null,
    session_continuity: [],
  }, {
    codingSessionId: 'sess_context1',
    consumedSequence: 0,
  }), {
    ok: false,
    code: 'handoff-capability-unavailable',
  });

  assert.deepEqual(validateHandoffContext({
    version: 'mc-context-v1',
    session_continuity: [],
    continuity: {},
  }, {
    codingSessionId: 'sess_context1',
    consumedSequence: 0,
  }), {
    ok: false,
    code: 'handoff-context-invalid',
  });
});

test('strict context client sends the provider cursor and never soft-degrades', async () => {
  const calls = [];
  const result = await fetchStrictHandoffContext({
    apiUrl: 'https://meetmemoro.test',
    token: 'token-in-memory',
    codingSessionId: 'sess_context1',
    consumedSequence: 1,
    repoId: 'repo_memoro',
    tool: 'codex',
    memoroFetch: async (apiUrl, path, options) => {
      calls.push({ apiUrl, path, options });
      return { context: context(1, []) };
    },
  });
  assert.equal(result.ok, true);
  assert.match(calls[0].path, /consumed_handoff_sequence=1/);
  assert.equal(calls[0].options.token, 'token-in-memory');

  assert.deepEqual(await fetchStrictHandoffContext({
    apiUrl: 'https://meetmemoro.test',
    token: 'token-in-memory',
    codingSessionId: 'sess_context1',
    consumedSequence: 1,
    memoroFetch: async () => { throw new Error('secret response'); },
  }), { ok: false, code: 'handoff-context-unavailable' });
});

test('handoff POST accepts only the exact sequence and server digest response', async () => {
  const handoff = { sequence: 2 };
  const ok = await persistSessionHandoff({
    apiUrl: 'https://meetmemoro.test',
    token: 'token-in-memory',
    handoff,
    memoroFetch: async (_apiUrl, path, options) => {
      assert.equal(path, '/api/sessions/handoff');
      assert.equal(options.body, handoff);
      return { ok: true, sequence: 2, digest: digest2, duplicate: false };
    },
  });
  assert.deepEqual(ok, {
    ok: true, sequence: 2, digest: digest2, duplicate: false,
  });
  assert.equal((await persistSessionHandoff({
    apiUrl: 'https://meetmemoro.test',
    token: 'token-in-memory',
    handoff,
    memoroFetch: async () => ({ ok: true, sequence: 3, digest: digest2, duplicate: false }),
  })).code, 'handoff-post-response-invalid');
});

test('handoff POST separates a server refusal from an unreachable server', async () => {
  const post = (memoroFetch) => persistSessionHandoff({
    apiUrl: 'https://meetmemoro.test',
    token: 'token-in-memory',
    handoff: { sequence: 1 },
    memoroFetch,
  });
  const refusal = (status, error) => async () => {
    const err = new Error(`Memoro ${status}: ${error}`);
    err.status = status;
    err.data = { ok: false, error };
    throw err;
  };

  // The status is what makes a refusal actionable: a wrong token scope, an
  // unsealed source generation and a rate limit are three different repairs.
  assert.equal((await post(refusal(403, 'local mc API token required'))).code, 'handoff-post-rejected-403');
  assert.equal((await post(refusal(403, 'Session source is not a sealed generation'))).code, 'handoff-post-rejected-403');
  assert.equal((await post(refusal(429, 'Too many requests'))).code, 'handoff-post-rejected-429');
  assert.equal((await post(refusal(409, 'Session handoff conflicts with current chain'))).code, 'handoff-post-rejected-409');

  // A transport failure carries no status and stays distinguishable.
  assert.equal((await post(async () => { throw new Error('network down'); })).code, 'handoff-post-unavailable');

  // The code is derived from the status alone: a server message — even one
  // carrying a credential — never reaches it.
  const leaked = await post(refusal(403, 'token mem_abcdefghijklmnop rejected'));
  assert.equal(leaked.code, 'handoff-post-rejected-403');
});

test('renderer emits only bounded user-level fields and fails closed on credentials', () => {
  const rendered = renderHandoffUserMessage([row(1), row(2)]);
  assert.equal(rendered.ok, true);
  assert.match(rendered.message, /ordinary user-level continuity/);
  assert.match(rendered.message, /Handoff 1 from claude-code/);
  assert.match(rendered.message, /Handoff 2 from codex/);
  assert.doesNotMatch(rendered.message, /device:laptop|generation-|[a-f]{64}/);

  const secret = row(1);
  secret.content.goal = 'Use mem_abcdefghijklmnop now';
  assert.equal(renderHandoffUserMessage([secret]).ok, false);
});
