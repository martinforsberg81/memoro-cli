/**
 * `--model` pass-through per adapter.
 *
 * mc validates nothing about model names — the raw value reaches the tool,
 * and the tool's own error is the answer to a name that does not exist. What
 * mc does own is the argv shape: where the flag sits relative to the resume
 * verb and the positional id differs per tool, and getting it wrong is a
 * launch that ignores the flag without saying so.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as claude from '../../src/adapters/claude-code.js';
import * as codex from '../../src/adapters/codex.js';

describe('model args', () => {
  it('claude takes --model, appended after --resume', () => {
    assert.deepEqual(claude.modelArgs('opus'), ['--model', 'opus']);
    assert.deepEqual(
      claude.resumeArgs({ sessionId: 'abc-123', model: 'opus' }),
      ['--resume', 'abc-123', '--model', 'opus'],
    );
  });

  it('codex takes -m, before the positional session id', () => {
    assert.deepEqual(codex.modelArgs('gpt-5.3-codex'), ['-m', 'gpt-5.3-codex']);
    assert.deepEqual(
      codex.resumeArgs({ sessionId: 'abc-123', model: 'gpt-5.3-codex' }),
      ['resume', '-m', 'gpt-5.3-codex', 'abc-123'],
    );
  });

  // Parallel-operation guarantee: without a model, resume argv is
  // byte-for-byte what it was before the flag existed.
  it('without a model, resume args are exactly what they always were', () => {
    assert.deepEqual(claude.resumeArgs({ sessionId: 'abc-123' }), ['--resume', 'abc-123']);
    assert.deepEqual(codex.resumeArgs({ sessionId: 'abc-123' }), ['resume', 'abc-123']);
  });

  it('nothing to say produces no args at all', () => {
    for (const adapter of [claude, codex]) {
      assert.deepEqual(adapter.modelArgs(null), []);
      assert.deepEqual(adapter.modelArgs(''), []);
      assert.deepEqual(adapter.modelArgs(42), []);
    }
    assert.equal(claude.resumeArgs({}), null);
    assert.equal(codex.resumeArgs({ model: 'opus' }), null);
  });
});
